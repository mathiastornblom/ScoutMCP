/**
 * config_resolve — §2.2 of the upgrade spec.
 *
 * Computes the effective eLux config for a device or OU, with per-key provenance, by
 * fetching each layer in the precedence chain (factory default → base → OU chain
 * root→target → device override → advanced file entries) and folding them via
 * src/rsop.ts. Entirely read-only: every call below is a plain GET, no `mutating: true`.
 */

import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { readDeviceOuId, parseSingleDevice } from '../devices.js';
import { resolveOuRef, getOuChain } from '../resolver.js';
import { loadEluxConfigSchema } from '../schema/eluxConfig.js';
import {
  foldConfigLayers,
  renderResolvedTable,
  type ConfigLayerRef,
  type ConfigLayerValues,
  type ResolvedConfigKey,
  type AdvancedLayerRef,
  type ResolvedAdvancedResult,
  parseAdvancedFileEntries,
  foldAdvancedLayers,
} from '../rsop.js';

/**
 * Maps a schema section name (as used in schema/elux-config.json, e.g. "Security") to the
 * Scout config_get section path (e.g. "security"). This is a best-effort lowercase mapping
 * for the common case; sections with no direct API equivalent (e.g. "!NETDRIVE!#",
 * "Browser<1-N>") are resolved via the advanced-file-entries layer instead, not config_get,
 * and are skipped here.
 */
function schemaSectionToApiSection(section: string): string | null {
  if (/[!<>#]/.test(section)) return null; // Advanced/templated section names — not a config_get path.
  return section.toLowerCase();
}

/** Fetches one config_get layer (base, ou, or device) for a schema section. Returns {} on 404/error
 *  (best-effort — a layer with no override for that section is indistinguishable from "no data"). */
async function fetchLayerValues(
  target: 'base' | 'ou' | 'device',
  apiSection: string,
  ref: { ouPath?: string; ouId?: number; name?: string; mac?: string; id?: string; clientid?: string },
): Promise<ConfigLayerValues> {
  const client = getClient();
  try {
    const qs =
      target === 'ou'
        ? buildQuery({ path: ref.ouPath, id: ref.ouId })
        : target === 'device'
        ? buildQuery({ name: ref.name, mac: ref.mac, id: ref.id, clientid: ref.clientid })
        : '';
    const data = await client.request<unknown>('GET', `/api/v1/configuration/${target}/${apiSection}${qs}`);
    return normalizeConfigPayload(data);
  } catch {
    return {};
  }
}

/** Scout config_get responses vary in envelope shape across endpoints; unwrap to a flat key/value map. */
function normalizeConfigPayload(data: unknown): ConfigLayerValues {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  // Common envelope: { response: { status: { msg: {...} } } }
  const response = obj['response'];
  if (response && typeof response === 'object') {
    const status = (response as Record<string, unknown>)['status'];
    if (status && typeof status === 'object') {
      const msg = (status as Record<string, unknown>)['msg'];
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) return msg as ConfigLayerValues;
    }
  }
  return obj;
}

// ── Layer assembly ───────────────────────────────────────────────────────────────

export interface ResolveTargetRef {
  target: 'device' | 'ou';
  /** Resolved OU path of the target itself (device's OU, or the OU being resolved). */
  ouPath: string;
  ouId: number;
  /** Device identifier fields — present only when target=device. */
  device?: { name?: string; mac?: string; id?: string; clientid?: string };
}

/**
 * Builds the ordered ConfigLayerRef[] for one schema section against a resolved target,
 * per §2.1's precedence order: base → OU chain root→target → device override.
 *
 * Advanced file entries (step 5 of §2.1) are INI file/section/key entries in a separate
 * namespace and are resolved by resolveAdvancedFileEntries() below, not here. Label/rule
 * dynamic config (step 7, phase two) is not fetched.
 */
export async function buildLayersForSection(
  apiSection: string,
  resolved: ResolveTargetRef,
): Promise<ConfigLayerRef[]> {
  const layers: ConfigLayerRef[] = [];

  const base = await fetchLayerValues('base', apiSection, {});
  layers.push({ level: 'base', values: base });

  const chain = await getOuChain(resolved.ouId);
  for (const ou of chain) {
    const values = await fetchLayerValues('ou', apiSection, { ouPath: ou.path, ouId: ou.ouid });
    layers.push({ level: ou.path, values });
  }

  if (resolved.target === 'device' && resolved.device) {
    const values = await fetchLayerValues('device', apiSection, resolved.device);
    layers.push({ level: 'device', values });
  }

  return layers;
}

/**
 * Layer 5 of the RSoP chain: advanced file entries, from the PUBLIC
 * GET /api/v1/config/advanced/{base|ou|device}/fileEntries endpoints, folded base → OU
 * chain root→target → device. Fails closed: a layer whose request errors or whose body is
 * malformed is reported in `warnings` (complete=false), never silently treated as empty.
 */
export async function resolveAdvancedFileEntries(resolved: ResolveTargetRef): Promise<ResolvedAdvancedResult> {
  const client = getClient();
  const warnings: string[] = [];
  const layers: AdvancedLayerRef[] = [];

  async function load(level: string, path: string): Promise<void> {
    let raw: unknown;
    try {
      raw = await client.request<unknown>('GET', path);
    } catch (err) {
      warnings.push(
        `advanced file entries for "${level}": request failed (${err instanceof Error ? err.message : String(err)}); layer unavailable`,
      );
      return;
    }
    const parsed = parseAdvancedFileEntries(level, raw);
    warnings.push(...parsed.warnings);
    layers.push(parsed.layer);
  }

  try {
    await load('base', '/api/v1/config/advanced/base/fileEntries');
    const chain = await getOuChain(resolved.ouId);
    for (const ou of chain) {
      await load(ou.path, `/api/v1/config/advanced/ou/fileEntries${buildQuery({ path: ou.path, id: ou.ouid })}`);
    }
    if (resolved.target === 'device' && resolved.device) {
      await load('device', `/api/v1/config/advanced/device/fileEntries${buildQuery({ ...resolved.device })}`);
    }
  } catch (err) {
    warnings.push(`advanced file entries: could not enumerate layers (${err instanceof Error ? err.message : String(err)})`);
  }
  return foldAdvancedLayers(layers, warnings);
}

/** Resolves effective config for every API-mappable section in the schema (or one section). */
export async function resolveEffectiveConfig(
  resolved: ResolveTargetRef,
  section?: string,
): Promise<ResolvedConfigKey[]> {
  const allEntries = loadEluxConfigSchema();
  const sections = section
    ? [section]
    : [...new Set(allEntries.map((e) => e.section))];

  const results: ResolvedConfigKey[] = [];
  for (const schemaSection of sections) {
    const apiSection = schemaSectionToApiSection(schemaSection);
    if (!apiSection) continue; // Advanced/templated section — no direct config_get path.

    const scopedEntries = allEntries.filter((e) => e.section === schemaSection);
    const layers = await buildLayersForSection(apiSection, resolved);
    results.push(...foldConfigLayers(scopedEntries, layers));
  }
  return results;
}

// ── Target resolution helper (shared with config_compare) ───────────────────────

const targetRefSchema = z.object({
  target: z.enum(['device', 'ou']),
  ref: z.string().describe(
    'For target=ou: OU name, partial name, full path, or numeric ID (resolved via the OU resolver). ' +
      'For target=device: device numeric ID, name, MAC, or client UUID — numeric IDs are tried first.',
  ),
});

/** Resolves a {target, ref} pair into a ResolveTargetRef, fetching the device's OU when target=device. */
export async function resolveTargetRef(target: 'device' | 'ou', ref: string): Promise<ResolveTargetRef> {
  if (target === 'ou') {
    const ou = await resolveOuRef(ref);
    return { target: 'ou', ouPath: ou.path, ouId: ou.ouid };
  }

  // target=device — try numeric ID first, then name lookup via device search.
  const client = getClient();
  const isNumeric = /^\d+$/.test(ref.trim());
  const qs = isNumeric ? buildQuery({ id: ref }) : buildQuery({ name: ref });
  const data = await client.request<unknown>('GET', `/api/v1/device${qs}`);
  const single = parseSingleDevice(data);
  if (!single.ok) throw new Error(`Could not determine OU for device "${ref}" - ${single.reason}.`);
  const dev = single.row as Record<string, unknown>;

  const ouPath = String(dev['OUPath'] ?? dev['ouPath'] ?? '');
  let resolvedOu: Awaited<ReturnType<typeof resolveOuRef>>;
  if (ouPath) {
    resolvedOu = await resolveOuRef(ouPath);
  } else {
    // OUID and/or GroupID (the device's direct OU id; live-verified on search rows), validated as a
    // strict integer and then resolved against the OU tree (an id not in the tree throws).
    const id = readDeviceOuId(dev);
    if (!id.ok) {
      throw new Error(`Could not determine OU for device "${ref}" - ${id.reason} (and no OUPath).`);
    }
    resolvedOu = await resolveOuRef(id.id);
  }

  return {
    target: 'device',
    ouPath: resolvedOu.path,
    ouId: resolvedOu.ouid,
    device: isNumeric ? { id: ref } : { name: ref },
  };
}

// ── MCP tool: config_resolve ─────────────────────────────────────────────────────

const configResolveSchema = z.object({
  target: z.enum(['device', 'ou']).describe('Resolve effective config for a device, or for an OU as if a device sat there.'),
  ref: z.string().describe(
    'Device identifier (numeric ID or name) when target=device, or OU name/path/ID when target=ou.',
  ),
  section: z.string().optional().describe(
    'Restrict to one schema section (e.g. "Security", "Global"). Omit to resolve every mappable section — slower.',
  ),
  render: z.enum(['json', 'table']).optional().describe('table renders an ASCII gpresult-style table instead of JSON.'),
});

type ConfigResolveInput = z.infer<typeof configResolveSchema>;

async function configResolveExecute(raw: unknown): Promise<McpToolResult> {
  const input = configResolveSchema.parse(raw) as ConfigResolveInput;

  try {
    const resolved = await resolveTargetRef(input.target, input.ref);
    const rows = await resolveEffectiveConfig(resolved, input.section);
    const advanced = await resolveAdvancedFileEntries(resolved);

    if (input.render === 'table') {
      return ok({
        target: input.target,
        ref: input.ref,
        resolvedOuPath: resolved.ouPath,
        table: renderResolvedTable(rows),
        advancedFileEntries: advanced,
      });
    }

    return ok({
      target: input.target,
      ref: input.ref,
      resolvedOuPath: resolved.ouPath,
      section: input.section ?? 'all',
      keyCount: rows.length,
      keys: rows,
      advancedFileEntries: advanced,
    });
  } catch (err) {
    return fail(`config_resolve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const configResolveTool = {
  name: 'config_resolve',
  description:
    'Compute the effective (Resultant Set of Policy) eLux config for a device or OU, with per-key ' +
    'provenance: effectiveValue, setAt (factory-default, base, an OU path, or device), isOverride, ' +
    'overridesValue, and isExplicitDefault (computed against the eLux config schema). ' +
    'Read-only — no writes. Pass render="table" for an ASCII gpresult-style table. ' +
    'Restrict to one section (e.g. "Security") for faster resolution; omit to resolve all schema sections.',
  inputSchema: toInputSchema(configResolveSchema),
  execute: configResolveExecute,
};

export { targetRefSchema };
