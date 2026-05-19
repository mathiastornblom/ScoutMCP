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
  // Device identification
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional(),
});

type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;

async function configUpdateExecute(raw: unknown): Promise<McpToolResult> {
  const input = configUpdateSchema.parse(raw) as ConfigUpdateInput;
  const client = getClient();

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
    'Changes take effect when the device syncs.',
  inputSchema: zodToJsonSchema(configUpdateSchema),
  execute: configUpdateExecute,
};
