/**
 * RSoP (Resultant Set of Policy) engine — §2 of the upgrade spec.
 *
 * Computes the effective eLux config a device (or OU) actually runs, with per-key
 * provenance, by folding the precedence chain:
 *
 *   1. Factory default        (schema/elux-config.json via src/schema/eluxConfig.ts)
 *   2. Base config            (config_get target=base)
 *   3. OU chain, root → leaf  (config_get target=ou, one fetch per ancestor OU)
 *   4. Device-level override  (config_get target=device)            [target=device only]
 *   5. Advanced file entries  (themselves inheriting — folded the same way as 2-4)
 *   6. Files-for-transfer     (presence only, not merged into effectiveValue)
 *   7. Label/rule dynamic     (phase two — emitted as `conditional` stubs only)
 *
 * Design notes:
 * - This module is transport-agnostic: it takes a `ConfigLayerSource` rather than calling
 *   getClient() directly, so the merge algorithm can be unit-tested with a synthetic OU
 *   tree and fixture config layers (no live Scout Board, no network). The MCP tool layer
 *   (src/tools/config_resolve.ts) supplies the real Scout-backed source.
 * - "setAt" is a level path string: "factory-default", "base", or an OU path / device
 *   identifier — whichever level last set the key, walked outermost (least specific) to
 *   innermost (most specific) so later layers always win.
 * - isExplicitDefault is computed against the schema default (src/schema/eluxConfig.ts),
 *   never hardcoded — a key set at any level to a value that happens to equal the schema's
 *   documented default is still flagged true, distinct from isOverride (which is about
 *   precedence, not value equality).
 */

import { loadEluxConfigSchema, type EluxConfigEntry } from './schema/eluxConfig.js';

// ── Types ───────────────────────────────────────────────────────────────────────

/** A single config layer's raw key/value pairs for one section, as returned by config_get. */
export type ConfigLayerValues = Record<string, unknown>;

/** Identifies one layer in the precedence chain for provenance labelling. */
export interface ConfigLayerRef {
  /** Human-readable level label used as `setAt`, e.g. "factory-default", "base", "/Enterprise". */
  level: string;
  /** Raw key → value map for this layer at the requested section. Empty object if the layer has no data. */
  values: ConfigLayerValues;
}

/** Per-key resolution result returned by resolveConfig(). */
export interface ResolvedConfigKey {
  section: string;
  key: string;
  effectiveValue: unknown;
  /** Level path that set the effective value: "factory-default", "base", an OU path, or "device". */
  setAt: string;
  /** True if a more-specific layer overrode a less-specific one for this key. */
  isOverride: boolean;
  /** The value the effective value overrode, if isOverride is true. */
  overridesValue?: unknown;
  /** True if effectiveValue equals the schema-documented factory default, regardless of setAt. */
  isExplicitDefault: boolean;
  /** Phase-two stub — present only when a label/rule is detected but not resolved concretely. */
  conditional?: { rule: string; wouldSetTo: unknown };
}

export interface ResolveConfigOptions {
  /** Restrict resolution to a single schema section (e.g. "Security"). Omit to resolve all sections. */
  section?: string;
}

// ── Core merge algorithm ─────────────────────────────────────────────────────────

/**
 * Folds an ordered list of config layers (outermost/least-specific first) into a single
 * provenance-annotated result set, scoped to the given schema entries.
 *
 * `layers` must already be in precedence order: factory-default is NOT included here —
 * callers pass it as the schema defaults separately via `schemaEntries`, and this function
 * seeds the fold with "factory-default" as the lowest layer before applying `layers` on top.
 *
 * IMPORTANT: `schemaEntries` must contain at most one entry per bare key name (i.e. callers
 * should scope to a single section, or otherwise guarantee key-name uniqueness) — layer
 * values are keyed by bare key name (as returned by config_get for a given section), so a
 * cross-section key collision in `schemaEntries` is ambiguous and will throw rather than
 * silently guess the wrong section.
 */
export function foldConfigLayers(
  schemaEntries: EluxConfigEntry[],
  layers: ConfigLayerRef[],
): ResolvedConfigKey[] {
  const bySectionKey = new Map<string, EluxConfigEntry>();
  const idByBareKey = new Map<string, string>();
  for (const e of schemaEntries) {
    const id = `${e.section}.${e.key}`;
    bySectionKey.set(id, e);
    if (idByBareKey.has(e.key)) {
      throw new Error(
        `foldConfigLayers: ambiguous bare key "${e.key}" appears in multiple sections ` +
          `(${idByBareKey.get(e.key)} and ${id}). Scope schemaEntries to a single section.`,
      );
    }
    idByBareKey.set(e.key, id);
  }

  // Seed per-key resolution state from schema defaults.
  const state = new Map<
    string,
    { section: string; key: string; value: unknown; setAt: string }
  >();
  for (const e of schemaEntries) {
    const id = `${e.section}.${e.key}`;
    state.set(id, {
      section: e.section,
      key: e.key,
      value: e.default === 'unset' ? undefined : e.default,
      setAt: 'factory-default',
    });
  }

  const overrideHistory = new Map<string, { setAt: string; previousValue: unknown }>();

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      const id = idByBareKey.get(key);
      if (!id) continue; // Unknown key for this section — RSoP display skips it; validation (§3) flags it.

      const prev = state.get(id)!;
      overrideHistory.set(id, { setAt: prev.setAt, previousValue: prev.value });
      state.set(id, { ...prev, value, setAt: layer.level });
    }
  }

  const results: ResolvedConfigKey[] = [];
  for (const [id, resolved] of state) {
    const entry = bySectionKey.get(id);
    const hist = overrideHistory.get(id);
    const isOverride = resolved.setAt !== 'factory-default';
    const isExplicitDefault =
      entry !== undefined && entry.default !== 'unset' && valuesEqual(resolved.value, entry.default);

    results.push({
      section: resolved.section,
      key: resolved.key,
      effectiveValue: resolved.value,
      setAt: resolved.setAt,
      isOverride,
      ...(isOverride && hist ? { overridesValue: hist.previousValue } : {}),
      isExplicitDefault,
    });
  }

  return results.sort((a, b) => (a.section + a.key).localeCompare(b.section + b.key));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Schema defaults are sometimes typed differently than live API values (e.g. "0" vs 0).
  return String(a) === String(b);
}

// ── ASCII gpresult-style table render ────────────────────────────────────────────

/** Renders resolved keys as an ASCII table similar to Windows `gpresult /r`. */
export function renderResolvedTable(rows: ResolvedConfigKey[]): string {
  if (rows.length === 0) return '(no keys resolved)';

  const headers = ['Section', 'Key', 'Effective Value', 'Set At', 'Override', 'Explicit Default'];
  const data = rows.map((r) => [
    r.section,
    r.key,
    formatCell(r.effectiveValue),
    r.setAt,
    r.isOverride ? 'yes' : 'no',
    r.isExplicitDefault ? 'yes' : 'no',
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const renderRow = (cells: string[]) =>
    '|' + cells.map((c, i) => ` ${c.padEnd(widths[i]!)} `).join('|') + '|';

  const lines = [sep, renderRow(headers), sep, ...data.map((row) => renderRow(row)), sep];
  return lines.join('\n');
}

function formatCell(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (value === null) return '(null)';
  return String(value);
}

// ── Convenience: resolve directly against the bundled schema ────────────────────

/**
 * Folds layers using the live schema/elux-config.json (via the cached loader), optionally
 * restricted to one section. This is the entry point the MCP tool layer uses; tests that
 * want a synthetic schema should call foldConfigLayers() directly instead.
 */
export function resolveAgainstSchema(
  layers: ConfigLayerRef[],
  opts: ResolveConfigOptions = {},
): ResolvedConfigKey[] {
  const all = loadEluxConfigSchema();
  const scoped = opts.section ? all.filter((e) => e.section === opts.section) : all;
  return foldConfigLayers(scoped, layers);
}
