/**
 * config_resolve — §2.2 of the upgrade spec.
 *
 * Computes the effective eLux config for a device or OU, with per-key provenance, by
 * fetching each layer in the precedence chain (factory default → base → OU chain
 * root→target → device override → advanced file entries) and folding them via
 * src/rsop.ts. Entirely read-only: every call below is a plain GET, no `mutating: true`.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef, getOuChain } from '../resolver.js';
import { loadEluxConfigSchema } from '../schema/eluxConfig.js';
import {
  foldConfigLayers,
  renderResolvedTable,
  type ConfigLayerRef,
  type ConfigLayerValues,
  type ResolvedConfigKey,
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
 * Advanced file entries (step 5 of §2.1) and label/rule dynamic config (step 7, phase two)
 * are intentionally not fetched here — there is no generic Scout endpoint enumerating
 * "advanced file entries that apply to this section" independent of the section's own
 * config_get response, so step 5 is represented as a no-op fold (advanced entries that
 * surface through config_get are already captured by the OU/device layers above); this is
 * a known simplification, see the gaps list in the final report.
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
  const dev = normalizeConfigPayload(data) as Record<string, unknown>;

  const ouPath = String(dev['OUPath'] ?? dev['ouPath'] ?? '');
  const ouId = Number(dev['OUID'] ?? dev['ouId'] ?? NaN);
  if (!ouPath && isNaN(ouId)) {
    throw new Error(`Could not determine OU for device "${ref}" — device record had no OUPath/OUID field.`);
  }

  const resolvedOu = ouPath ? await resolveOuRef(ouPath) : await resolveOuRef(ouId);

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

    if (input.render === 'table') {
      return ok({
        target: input.target,
        ref: input.ref,
        resolvedOuPath: resolved.ouPath,
        table: renderResolvedTable(rows),
      });
    }

    return ok({
      target: input.target,
      ref: input.ref,
      resolvedOuPath: resolved.ouPath,
      section: input.section ?? 'all',
      keyCount: rows.length,
      keys: rows,
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
  inputSchema: zodToJsonSchema(configResolveSchema),
  execute: configResolveExecute,
};

export { targetRefSchema };
