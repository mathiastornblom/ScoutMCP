import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

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
});

type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;

async function configUpdateExecute(raw: unknown): Promise<McpToolResult> {
  const input = configUpdateSchema.parse(raw) as ConfigUpdateInput;
  const client = getClient();

  // Bulk path: fan out one update per device ID in parallel
  if (input.deviceIds && input.deviceIds.length > 0) {
    if (input.target !== 'device') {
      return fail('deviceIds is only valid when target=device');
    }
    const results = await Promise.all(
      input.deviceIds.map(async (devId) => {
        const qs = buildQuery({ id: devId });
        try {
          const data = await client.request<unknown>(
            'POST',
            `/api/v1/configuration/device/${input.section}${qs}`,
            input.body,
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
    });
  }

  // Single target path
  let qs = '';
  if (input.target === 'ou') {
    qs = buildQuery({ path: input.ouPath, id: input.ouId });
  } else if (input.target === 'device') {
    qs = buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid });
  }

  try {
    const data = await client.request<unknown>(
      'POST',
      `/api/v1/configuration/${input.target}/${input.section}${qs}`,
      input.body,
    );
    return ok(data);
  } catch (err) {
    return fail(`config_update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const configUpdateTool = {
  name: 'config_update',
  description:
    'Write configuration to Scout Board for base, OU, or device scope. ' +
    'Provide target, section, and body with the configuration fields to update. ' +
    'For bulk device updates, pass deviceIds (array of numeric IDs) to apply the same config body to multiple devices in parallel. ' +
    'Changes take effect when the device syncs.',
  inputSchema: zodToJsonSchema(configUpdateSchema),
  execute: configUpdateExecute,
};

// ── config_compare ────────────────────────────────────────────────────────────

const configCompareSchema = z.object({
  deviceIds: z.array(z.string()).min(2).max(500).describe(
    'Numeric device IDs to compare (get these from device_get mode=search). Min 2, max 500.',
  ),
  section: z.string().describe(
    'Config section to compare across devices, e.g. firmware, network/lan, general',
  ),
});

type ConfigCompareInput = z.infer<typeof configCompareSchema>;

async function configCompareExecute(raw: unknown): Promise<McpToolResult> {
  const input = configCompareSchema.parse(raw) as ConfigCompareInput;
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
    section: input.section,
    totalDevices: input.deviceIds.length,
    groupCount: groupList.length,
    uniform: groupList.length === 1 && errors.length === 0,
    groups: groupList,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

export const configCompareTool = {
  name: 'config_compare',
  description:
    'Compare a config section across multiple devices in one call. ' +
    'Fetches the given section for each device ID in parallel, then groups devices by identical config. ' +
    'Returns: uniform=true if all devices share the same config, otherwise a list of groups with their differing configs. ' +
    'Typical workflow: device_get mode=search → collect DeviceIDs → config_compare → config_update with deviceIds to fix outliers.',
  inputSchema: zodToJsonSchema(configCompareSchema),
  execute: configCompareExecute,
};
