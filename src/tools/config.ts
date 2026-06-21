import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import {
  checkMutationAllowed,
  checkBaseWriteAllowed,
  checkBlastRadius,
  isDryRunSkip,
  GuardrailError,
} from '../safety/guardrails.js';
import { validateConfigWrite, formatViolations, formatWarnings } from '../validation.js';
import { resolveTargetRef, resolveEffectiveConfig } from './config_resolve.js';
import { foldConfigLayers, type ResolvedConfigKey } from '../rsop.js';
import { loadEluxConfigSchema } from '../schema/eluxConfig.js';
import { getOuChain } from '../resolver.js';

// Section examples (not exhaustive — API accepts any valid section string):
// general, firmware, display, hardware, security, userauthentication, diagnostics,
// multimedia, mirror, drives, keyboardmouse, powermanagement, powermanagement/eco,
// powermanagement/ecoworking, powermanagement/performance, powermanagement/performanceworking,
// desktop/language, desktop/pictures, desktop/colors, desktop/timesettings,
// desktop/shortcutkeys, desktop/advancedsettings, network, network/lan, network/wlan,
// network/apn, network/vpn, printer, inheritance, export, import

const configGetSchema = z.object({
  target: z.enum(['base', 'ou', 'device']),
  section: z.string().describe(
    'Config section path, e.g. general, firmware, network/lan, desktop/language, powermanagement/eco',
  ),
  // OU identification (target=ou)
  ouPath: z.string().optional().describe('OU path (target=ou)'),
  ouId: z.number().int().optional().describe('OU ID (target=ou)'),
  // Device identification (target=device)
  name: z.string().optional().describe('Device name (target=device)'),
  mac: z.string().optional().describe('Device MAC (target=device)'),
  id: z.string().optional().describe('Device ID (target=device)'),
  clientid: z.string().optional().describe('Client identifier UUID (target=device)'),
  // Extra properties
  properties: z.string().optional().describe('Comma-separated extra properties'),
});

type ConfigGetInput = z.infer<typeof configGetSchema>;

function buildConfigQs(input: ConfigGetInput): string {
  if (input.target === 'ou') {
    return buildQuery({ path: input.ouPath, id: input.ouId, properties: input.properties });
  }
  if (input.target === 'device') {
    return buildQuery({
      name: input.name,
      mac: input.mac,
      id: input.id,
      clientid: input.clientid,
      properties: input.properties,
    });
  }
  return input.properties ? buildQuery({ properties: input.properties }) : '';
}

async function configGetExecute(raw: unknown): Promise<McpToolResult> {
  const input = configGetSchema.parse(raw) as ConfigGetInput;
  const client = getClient();
  const qs = buildConfigQs(input);

  try {
    const data = await client.request<unknown>('GET', `/api/v1/configuration/${input.target}/${input.section}${qs}`);
    return ok(data);
  } catch (err) {
    return fail(`config_get failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const configGetTool = {
  name: 'config_get',
  description:
    'Read configuration from Scout Board for base, OU, or device scope. ' +
    'Provide target (base|ou|device) and section (e.g. general, firmware, network/lan). ' +
    'Requires ouPath/ouId for target=ou, device identifier for target=device.',
  inputSchema: zodToJsonSchema(configGetSchema),
  execute: configGetExecute,
};

// ── config_update ─────────────────────────────────────────────────────────────

const configUpdateSchema = z.object({
  target: z.enum(['base', 'ou', 'device']),
  section: z.string().describe('Config section path (same values as config_get)'),
  body: z.record(z.unknown()).describe('Configuration payload to write'),
  // OU identification
  ouPath: z.string().optional(),
  ouId: z.number().int().optional(),
  // Device identification (single)
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional(),
  // Bulk device update — write the same body to multiple devices in parallel
  deviceIds: z.array(z.string()).min(1).max(500).optional().describe(
    'Apply the same config body to multiple devices by numeric ID in parallel (target=device only). ' +
    'Returns per-device success/failure. Max 500 devices.',
  ),
  overrideBlastRadius: z.boolean().optional().describe(
    'Set true to proceed when the number of affected devices exceeds SCOUT_MAX_BLAST_RADIUS ' +
    '(still capped by a hard ceiling — see config_update tool description).',
  ),
  confirm: z.boolean().optional().describe(
    'Required when the write targets more than one device (deviceIds) or an OU scope (target=ou). ' +
    'Fleet-wide writes are exactly the failure mode the safety layer exists to prevent — pass ' +
    'confirm=true only after reviewing the affected count and section/body.',
  ),
  skipValidation: z.boolean().optional().describe(
    'Set true to bypass §3 schema validation (unknown-key / out-of-range checks) for this write. ' +
    'Use sparingly — intended for sections the eLux config schema does not cover.',
  ),
});

type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;

/** Best-effort lookup of a device's running eLux build, for the sinceVersion warning (§3).
 *  Returns undefined if the device/version cannot be determined — callers must treat that
 *  as "skip the warning", never as a guessed version. */
async function lookupRunningEluxVersion(client: ReturnType<typeof getClient>, ref: {
  name?: string; mac?: string; id?: string; clientid?: string;
}): Promise<string | undefined> {
  try {
    const qs = buildQuery({ name: ref.name, mac: ref.mac, id: ref.id, clientid: ref.clientid, properties: 'ELUX_VERSION,FirmwareVersion' });
    const data = await client.request<unknown>('GET', `/api/v1/device${qs}`);
    const obj = data as Record<string, unknown>;
    const flat = (obj?.['response'] as Record<string, unknown> | undefined)?.['status'] as Record<string, unknown> | undefined;
    const msg = (flat?.['msg'] as Record<string, unknown> | undefined) ?? obj;
    const version = msg?.['ELUX_VERSION'] ?? msg?.['FirmwareVersion'] ?? msg?.['EluxVersion'];
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

async function configUpdateExecute(raw: unknown): Promise<McpToolResult> {
  const input = configUpdateSchema.parse(raw) as ConfigUpdateInput;
  const client = getClient();
  let warningLines: string[] = [];

  try {
    // Gate 1: mode tiers — read-only blocks outright, dry-run is handled per-branch below
    // so we can still report what WOULD happen.
    const modeCheck = checkMutationAllowed('config_update');

    // Gate 2: Base scope writes require explicit arming, independent of SCOUT_MODE.
    checkBaseWriteAllowed({
      isBaseOrRoot: input.target === 'base',
      label: 'Base config scope (inherits to the entire fleet)',
    });

    // §3 pre-write validation — runs before any write path below, regardless of bulk/single.
    if (!input.skipValidation) {
      const runningVersion =
        input.target === 'device' && !input.deviceIds
          ? await lookupRunningEluxVersion(client, input)
          : undefined;
      const validation = validateConfigWrite(input.section, input.body, runningVersion);
      if (!validation.valid) {
        return fail(`config_update blocked by schema validation:\n${formatViolations(validation.violations)}`);
      }
      warningLines = formatWarnings(validation.warnings);
    }

    // Fleet-wide write gate — OU scope or multi-device bulk requires explicit confirm=true.
    // (No elicitation capability is exposed by src/session.ts/src/index.ts today, so this
    // falls back to the existing confirm:true flag pattern used elsewhere in this codebase,
    // per §3.3 of the spec.)
    const isFleetWide = input.target === 'ou' || (input.deviceIds && input.deviceIds.length > 1);
    if (isFleetWide && input.confirm !== true) {
      const affected = input.deviceIds ? input.deviceIds.length : 'the entire OU (and its inheriting devices)';
      return fail(
        `config_update blocked: this write targets ${input.target === 'ou' ? 'an OU scope' : `${affected} devices`}, ` +
          'which is a fleet-wide change. Pass confirm=true to proceed after reviewing the scope, section, and body.',
      );
    }

    // Bulk path: fan out one update per device ID in parallel
    if (input.deviceIds && input.deviceIds.length > 0) {
      if (input.target !== 'device') {
        return fail('deviceIds is only valid when target=device');
      }

      // Gate 3: blast-radius cap on bulk device updates.
      checkBlastRadius({
        affectedCount: input.deviceIds.length,
        overrideBlastRadius: input.overrideBlastRadius,
      });

      if (!modeCheck.proceed) {
        return ok({
          status: 'dry_run',
          section: input.section,
          target: input.target,
          wouldUpdate: input.deviceIds,
          message: modeCheck.dryRunNotice,
          ...(warningLines.length > 0 ? { warnings: warningLines } : {}),
        });
      }

      const results = await Promise.all(
        input.deviceIds.map(async (devId) => {
          const qs = buildQuery({ id: devId });
          try {
            const data = await client.request<unknown>(
              'POST',
              `/api/v1/configuration/device/${input.section}${qs}`,
              input.body,
              { mutating: true, opName: 'config_update' },
            );
            return { id: devId, success: true, data };
          } catch (err) {
            return { id: devId, success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      const successful = results.filter((r) => r.success).length;
      return ok({
        section: input.section,
        total: results.length,
        successful,
        failed: results.length - successful,
        results,
        ...(warningLines.length > 0 ? { warnings: warningLines } : {}),
      });
    }

    // Single target path — affects at most one OU/device/base scope (count = 1, never
    // exceeds the default cap), so no blast-radius check needed here.
    let qs = '';
    if (input.target === 'ou') {
      qs = buildQuery({ path: input.ouPath, id: input.ouId });
    } else if (input.target === 'device') {
      qs = buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid });
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        target: input.target,
        section: input.section,
        message: modeCheck.dryRunNotice,
        ...(warningLines.length > 0 ? { warnings: warningLines } : {}),
      });
    }

    const data = await client.request<unknown>(
      'POST',
      `/api/v1/configuration/${input.target}/${input.section}${qs}`,
      input.body,
      { mutating: true, opName: 'config_update' },
    );
    if (isDryRunSkip(data)) {
      return ok({ status: 'dry_run', target: input.target, section: input.section, message: data.notice });
    }
    if (warningLines.length === 0) return ok(data);
    return ok({ result: data, warnings: warningLines });
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`config_update blocked: ${err.message}`);
    return fail(`config_update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const configUpdateTool = {
  name: 'config_update',
  description:
    'Write configuration to Scout Board for base, OU, or device scope. ' +
    'Provide target, section, and body with the configuration fields to update. ' +
    'For bulk device updates, pass deviceIds (array of numeric IDs) to apply the same config body to multiple devices in parallel. ' +
    'Changes take effect when the device syncs. ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing, write performs the call); ' +
    'target=base requires SCOUT_ALLOW_BASE_WRITES=true (Base config inherits to the entire fleet); ' +
    'bulk deviceIds writes are capped by SCOUT_MAX_BLAST_RADIUS (default 25, hard ceiling 500) — pass overrideBlastRadius=true to exceed the cap up to the ceiling. ' +
    'Every write is validated against the eLux config schema (unknown keys fail with a "did you mean" suggestion, ' +
    'out-of-range values fail with the allowed range, newer-sinceVersion keys warn but do not block) unless skipValidation=true. ' +
    'Fleet-wide writes (target=ou, or deviceIds with more than one device) require confirm=true.',
  inputSchema: zodToJsonSchema(configUpdateSchema),
  execute: configUpdateExecute,
};

// ── config_compare ────────────────────────────────────────────────────────────

const configCompareSchema = z.object({
  mode: z.enum(['device-device', 'device-ou', 'device-base', 'ou-ou', 'ou-parent']).optional().describe(
    'device-device (default, existing behavior): compare a config section across 2+ devices by raw config_get equality. ' +
    'device-ou: compare a single device\'s effective (RSoP) config against an OU\'s effective config. ' +
    'device-base: compare a single device\'s effective config against Base config. ' +
    'ou-ou: compare two OUs\' effective config. ' +
    'ou-parent: compare one OU against its immediate parent — "what this level changed".',
  ),
  // device-device (existing) — raw config_get equality grouping across many devices
  deviceIds: z.array(z.string()).min(2).max(500).optional().describe(
    'device-device mode only: numeric device IDs to compare (get these from device_get mode=search). Min 2, max 500.',
  ),
  // Inheritance-aware modes — single left/right refs, resolved via RSoP
  leftRef: z.string().optional().describe(
    'Inheritance-aware modes: left-hand side reference. device-ou/device-base/ou-ou/ou-parent: device ID/name or OU name/path/ID as appropriate.',
  ),
  rightRef: z.string().optional().describe(
    'Inheritance-aware modes: right-hand side reference (omit for device-base and ou-parent — the right side is implicit).',
  ),
  section: z.string().describe(
    'Config section to compare. device-device: a config_get section path (e.g. firmware, network/lan). ' +
    'Inheritance-aware modes: a schema section name (e.g. "Security", "Global") — omit to compare all sections.',
  ).optional(),
});

type ConfigCompareInput = z.infer<typeof configCompareSchema>;

async function configCompareExecute(raw: unknown): Promise<McpToolResult> {
  const input = configCompareSchema.parse(raw) as ConfigCompareInput;
  const mode = input.mode ?? 'device-device';

  if (mode === 'device-device') {
    return configCompareDeviceDevice(input);
  }
  return configCompareInheritanceAware(mode, input);
}

// ── device-device (existing behavior, unchanged) ────────────────────────────────

async function configCompareDeviceDevice(input: ConfigCompareInput): Promise<McpToolResult> {
  if (!input.deviceIds || input.deviceIds.length < 2) {
    return fail('device-device mode requires deviceIds (min 2, max 500)');
  }
  if (!input.section) {
    return fail('section is required');
  }
  const client = getClient();

  // Fetch config for all devices in parallel
  const fetched = await Promise.all(
    input.deviceIds.map(async (id) => {
      const qs = buildQuery({ id });
      try {
        const config = await client.request<unknown>(
          'GET',
          `/api/v1/configuration/device/${input.section}${qs}`,
        );
        return { id, config, error: null };
      } catch (err) {
        return { id, config: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const errors = fetched.filter((r) => r.error !== null).map((r) => ({ id: r.id, error: r.error! }));

  // Group devices by identical config (stable JSON key)
  const groups = new Map<string, { config: unknown; deviceIds: string[] }>();
  for (const r of fetched) {
    if (r.error || r.config === null) continue;
    const key = JSON.stringify(r.config);
    const existing = groups.get(key);
    if (existing) {
      existing.deviceIds.push(r.id);
    } else {
      groups.set(key, { config: r.config, deviceIds: [r.id] });
    }
  }

  // Sort groups largest-first (majority config first)
  const groupList = Array.from(groups.values()).sort((a, b) => b.deviceIds.length - a.deviceIds.length);

  return ok({
    mode: 'device-device',
    section: input.section,
    totalDevices: input.deviceIds.length,
    groupCount: groupList.length,
    uniform: groupList.length === 1 && errors.length === 0,
    groups: groupList,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

// ── Inheritance-aware modes (§2.3) — read-only, RSoP-backed ──────────────────────

interface CompareSide {
  label: string;
  rows: ResolvedConfigKey[];
}

/** Symmetric diff between two resolved-key sets: keys present on only one side, and keys
 *  with differing effective values. Each entry is annotated with both sides' setAt. */
function diffResolvedSides(left: CompareSide, right: CompareSide) {
  const leftMap = new Map(left.rows.map((r) => [`${r.section}.${r.key}`, r]));
  const rightMap = new Map(right.rows.map((r) => [`${r.section}.${r.key}`, r]));
  const allIds = new Set([...leftMap.keys(), ...rightMap.keys()]);

  const onlyLeft: Array<{ section: string; key: string; setAt: string; value: unknown }> = [];
  const onlyRight: Array<{ section: string; key: string; setAt: string; value: unknown }> = [];
  const differing: Array<{
    section: string;
    key: string;
    leftValue: unknown;
    leftSetAt: string;
    rightValue: unknown;
    rightSetAt: string;
  }> = [];
  let identicalCount = 0;

  for (const id of allIds) {
    const l = leftMap.get(id);
    const r = rightMap.get(id);
    if (l && !r) {
      onlyLeft.push({ section: l.section, key: l.key, setAt: l.setAt, value: l.effectiveValue });
    } else if (!l && r) {
      onlyRight.push({ section: r.section, key: r.key, setAt: r.setAt, value: r.effectiveValue });
    } else if (l && r) {
      if (JSON.stringify(l.effectiveValue) !== JSON.stringify(r.effectiveValue)) {
        differing.push({
          section: l.section,
          key: l.key,
          leftValue: l.effectiveValue,
          leftSetAt: l.setAt,
          rightValue: r.effectiveValue,
          rightSetAt: r.setAt,
        });
      } else {
        identicalCount++;
      }
    }
  }

  return {
    left: left.label,
    right: right.label,
    identicalCount,
    onlyLeft,
    onlyRight,
    differing,
    uniform: onlyLeft.length === 0 && onlyRight.length === 0 && differing.length === 0,
  };
}

async function configCompareInheritanceAware(
  mode: 'device-ou' | 'device-base' | 'ou-ou' | 'ou-parent',
  input: ConfigCompareInput,
): Promise<McpToolResult> {
  if (!input.leftRef) return fail(`${mode} mode requires leftRef`);

  try {
    if (mode === 'device-base') {
      const leftResolved = await resolveTargetRef('device', input.leftRef);
      const leftRows = await resolveEffectiveConfig(leftResolved, input.section);
      const rightRows = await resolveBaseOnlyRows(input.section);
      const diff = diffResolvedSides(
        { label: `device:${input.leftRef}`, rows: leftRows },
        { label: 'base', rows: rightRows },
      );
      return ok({ mode, ...diff });
    }

    if (mode === 'device-ou') {
      if (!input.rightRef) return fail('device-ou mode requires rightRef (the OU to compare against)');
      const leftResolved = await resolveTargetRef('device', input.leftRef);
      const rightResolved = await resolveTargetRef('ou', input.rightRef);
      const leftRows = await resolveEffectiveConfig(leftResolved, input.section);
      const rightRows = await resolveEffectiveConfig(rightResolved, input.section);
      const diff = diffResolvedSides(
        { label: `device:${input.leftRef}`, rows: leftRows },
        { label: `ou:${rightResolved.ouPath}`, rows: rightRows },
      );
      return ok({ mode, ...diff });
    }

    if (mode === 'ou-ou') {
      if (!input.rightRef) return fail('ou-ou mode requires rightRef');
      const leftResolved = await resolveTargetRef('ou', input.leftRef);
      const rightResolved = await resolveTargetRef('ou', input.rightRef);
      const leftRows = await resolveEffectiveConfig(leftResolved, input.section);
      const rightRows = await resolveEffectiveConfig(rightResolved, input.section);
      const diff = diffResolvedSides(
        { label: `ou:${leftResolved.ouPath}`, rows: leftRows },
        { label: `ou:${rightResolved.ouPath}`, rows: rightRows },
      );
      return ok({ mode, ...diff });
    }

    // ou-parent: "what this level changed" — diff the OU against its immediate parent in the chain.
    const chain = await getOuChain(input.leftRef);
    if (chain.length < 2) {
      return fail(
        `ou-parent: "${input.leftRef}" resolved to the root OU, which has no parent to diff against.`,
      );
    }
    const target = chain[chain.length - 1]!;
    const parent = chain[chain.length - 2]!;
    const leftResolved = await resolveTargetRef('ou', String(target.ouid));
    const rightResolved = await resolveTargetRef('ou', String(parent.ouid));
    const leftRows = await resolveEffectiveConfig(leftResolved, input.section);
    const rightRows = await resolveEffectiveConfig(rightResolved, input.section);
    const diff = diffResolvedSides(
      { label: `ou:${target.path}`, rows: leftRows },
      { label: `ou:${parent.path} (parent)`, rows: rightRows },
    );
    return ok({ mode, ...diff });
  } catch (err) {
    return fail(`config_compare (${mode}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Resolves effective config as seen from Base scope only (no OU/device layers on top). */
async function resolveBaseOnlyRows(section?: string): Promise<ResolvedConfigKey[]> {
  // Base has no OU chain or device override — reuse resolveEffectiveConfig with an ouId
  // that getOuChain will refuse to expand productively isn't ideal, so instead we just
  // call resolveEffectiveConfig against the root OU path "/" with target='ou' and rely on
  // the fact that Base is layer 0 inside buildLayersForSection regardless of target — the
  // OU-chain and device layers above it will be empty for the root for any OU without
  // further overrides, which over-represents "base" as "base+root OU". To keep this exact,
  // we instead resolve only the base layer directly via the schema fold, bypassing OU/device.
  const allEntries = loadEluxConfigSchema();
  const sections = section ? [section] : [...new Set(allEntries.map((e) => e.section))];
  const client = getClient();
  const rows: ResolvedConfigKey[] = [];
  for (const schemaSection of sections) {
    const apiSection = schemaSection.toLowerCase();
    if (/[!<>#]/.test(schemaSection)) continue;
    let values: Record<string, unknown> = {};
    try {
      const data = await client.request<unknown>('GET', `/api/v1/configuration/base/${apiSection}`);
      values = normalizeForBase(data);
    } catch {
      values = {};
    }
    const scopedEntries = allEntries.filter((e) => e.section === schemaSection);
    rows.push(...foldConfigLayers(scopedEntries, [{ level: 'base', values }]));
  }
  return rows;
}

function normalizeForBase(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  const response = obj['response'];
  if (response && typeof response === 'object') {
    const status = (response as Record<string, unknown>)['status'];
    if (status && typeof status === 'object') {
      const msg = (status as Record<string, unknown>)['msg'];
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) return msg as Record<string, unknown>;
    }
  }
  return obj;
}

export const configCompareTool = {
  name: 'config_compare',
  description:
    'Compare config across devices and/or OUs. ' +
    'mode=device-device (default): compare a raw config section across 2+ devices by equality grouping. ' +
    'mode=device-ou / device-base / ou-ou / ou-parent: inheritance-aware comparison using the RSoP engine — ' +
    'returns a symmetric diff (keys present on only one side, keys with differing effective values), each ' +
    'annotated with setAt (which level set that value). Entirely read-only.',
  inputSchema: zodToJsonSchema(configCompareSchema),
  execute: configCompareExecute,
};
