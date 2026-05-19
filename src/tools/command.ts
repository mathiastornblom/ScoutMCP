import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

// ── device_command ────────────────────────────────────────────────────────────

const deviceCommandSchema = z.object({
  target: z.enum(['device', 'devicelist', 'ou', 'ddg']).describe(
    'Scope: device=single device; devicelist=explicit list; ou=all devices in OU; ddg=dynamic device group',
  ),
  command: z.enum([
    'restart', 'halt', 'start', 'factoryreset',
    'update', 'updateuefi', 'custom', 'predefined', 'delivery', 'message',
  ]),

  // --- device target: identify by query param ---
  name: z.string().optional().describe('Device name (target=device)'),
  mac: z.string().optional().describe('Device MAC (target=device)'),
  id: z.string().optional().describe('Device ID (target=device)'),
  clientid: z.string().optional().describe('Client identifier UUID (target=device)'),

  // --- body: scheduling / inform user ---
  body: z.record(z.unknown()).optional().describe(
    'Optional JSON body: InformUser fields (informUser.title/text/...) and/or Schedule fields',
  ),

  // Safety confirmation required for irreversible commands
  confirm: z.boolean().optional().describe(
    'Must be true for command=factoryreset or command=halt. Protects against accidental invocation.',
  ),
});

type DeviceCommandInput = z.infer<typeof deviceCommandSchema>;

async function deviceCommandExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceCommandSchema.parse(raw) as DeviceCommandInput;

  // Security: require explicit confirmation for irreversible commands
  if ((input.command === 'factoryreset' || input.command === 'halt') && input.confirm !== true) {
    return fail(
      `command=${input.command} is irreversible and requires confirm=true to proceed. ` +
        'Set confirm: true only after verifying the target device.',
    );
  }

  const client = getClient();
  const path = `/api/v1/command/${input.target}/${input.command}`;

  // device target: identity goes in query params
  const qs =
    input.target === 'device'
      ? buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid })
      : '';

  try {
    const data = await client.request<unknown>('POST', `${path}${qs}`, input.body);
    return ok(data);
  } catch (err) {
    return fail(`device_command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const deviceCommandTool = {
  name: 'device_command',
  description:
    'Send a command to a device, device list, OU, or DDG. ' +
    'Commands: restart, halt, start, factoryreset, update, updateuefi, custom, predefined, delivery, message. ' +
    'DESTRUCTIVE: factoryreset and halt require confirm=true. factoryreset wipes device configuration.',
  inputSchema: zodToJsonSchema(deviceCommandSchema),
  execute: deviceCommandExecute,
};

// ── device_diagnostics ────────────────────────────────────────────────────────

const deviceDiagnosticsSchema = z.object({
  action: z.enum(['trigger', 'poll', 'download_url']).describe(
    'trigger=start diagnostics collection; poll=check status; download_url=returns URL to fetch the ZIP (actual binary download not supported via MCP)',
  ),
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional().describe('Required for action=download_url'),
  diagnosticsFileId: z.string().optional().describe('Required for action=download_url (from poll response)'),
});

type DeviceDiagnosticsInput = z.infer<typeof deviceDiagnosticsSchema>;

async function deviceDiagnosticsExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceDiagnosticsSchema.parse(raw) as DeviceDiagnosticsInput;
  const client = getClient();
  const qs = buildQuery({
    name: input.name,
    mac: input.mac,
    id: input.id,
    clientid: input.clientid,
  });

  try {
    switch (input.action) {
      case 'trigger': {
        const data = await client.request<unknown>('GET', `/api/v1/command/device/diagnostics${qs}`);
        return ok(data);
      }
      case 'poll': {
        const data = await client.request<unknown>('GET', `/api/v1/command/device/diagnostics/poll${qs}`);
        return ok(data);
      }
      case 'download_url': {
        if (!input.clientid) return fail('clientid is required for action=download_url');
        if (!input.diagnosticsFileId) return fail('diagnosticsFileId is required for action=download_url');
        const baseUrl = process.env.SCOUT_BASE_URL?.replace(/\/$/, '');
        const url =
          `${baseUrl}/rest/api/v1/command/device/diagnostics/download` +
          `?clientid=${encodeURIComponent(input.clientid)}&diagnosticsFileId=${encodeURIComponent(input.diagnosticsFileId)}`;
        return ok({ downloadUrl: url, note: 'Fetch this URL with the ScoutBoardAuthJWT cookie to download the ZIP.' });
      }
    }
  } catch (err) {
    return fail(`device_diagnostics failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const deviceDiagnosticsTool = {
  name: 'device_diagnostics',
  description:
    'Collect device diagnostics asynchronously. Workflow: trigger → poll until ready → download_url to get the ZIP download link. ' +
    'The download_url action returns a URL; binary download must be done by the caller using the auth cookie.',
  inputSchema: zodToJsonSchema(deviceDiagnosticsSchema),
  execute: deviceDiagnosticsExecute,
};
