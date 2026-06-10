import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef } from '../resolver.js';
import { getProgressReporter } from '../progress.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // --- ou target: identify the OU ---
  ouRef: z.string().optional().describe(
    'Target OU (target=ou) — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically and injected as ouId into the request body. ' +
    'Examples: "Berlin", "/Enterprise/Germany/Berlin", "42".',
  ),

  // --- body: scheduling / inform user ---
  body: z.record(z.unknown()).optional().describe(
    'Optional JSON body: ouPath/ouId for target=ou (or use ouRef instead), ' +
    'InformUser fields (informUser.title/text/...), and/or Schedule fields',
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
    let body = input.body;

    // Resolve ouRef and inject into body for target=ou
    if (input.target === 'ou' && input.ouRef !== undefined) {
      const match = await resolveOuRef(input.ouRef);
      body = { ouId: match.ouid, ...body };
    }

    const data = await client.request<unknown>('POST', `${path}${qs}`, body);
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
    'For target=ou, use ouRef to identify the OU by name — it is automatically resolved and injected into the request. ' +
    'DESTRUCTIVE: factoryreset and halt require confirm=true. factoryreset wipes device configuration.',
  inputSchema: zodToJsonSchema(deviceCommandSchema),
  execute: deviceCommandExecute,
};

// ── device_diagnostics ────────────────────────────────────────────────────────

const deviceDiagnosticsSchema = z.object({
  action: z.enum(['trigger', 'poll', 'download_url', 'run']).describe(
    'trigger=start diagnostics collection; ' +
      'poll=check status (HTTP 202 means still in progress, 200 means done); ' +
      'download_url=returns URL to fetch the ZIP (actual binary download not supported via MCP); ' +
      'run=full auto-flow: trigger → poll until ready → return download URL ' +
      '(sends log notifications for each poll step; use timeout_s and poll_interval_s to tune)',
  ),
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional().describe('Required for action=download_url'),
  diagnosticsFileId: z.string().optional().describe('Required for action=download_url (from poll response)'),
  timeout_s: z
    .number()
    .int()
    .min(10)
    .max(600)
    .optional()
    .describe('Max seconds to wait for diagnostics to complete (action=run, default 300)'),
  poll_interval_s: z
    .number()
    .int()
    .min(3)
    .max(30)
    .optional()
    .describe('Seconds between poll attempts (action=run, default 5)'),
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

      case 'run': {
        const reporter = getProgressReporter();
        const timeoutMs = (input.timeout_s ?? 300) * 1000;
        const intervalMs = (input.poll_interval_s ?? 5) * 1000;
        const maxPolls = Math.ceil(timeoutMs / intervalMs);

        // Step 1: trigger
        await reporter.log('info', 'Triggering diagnostics collection…');
        await client.request<unknown>('GET', `/api/v1/command/device/diagnostics${qs}`);

        // Step 2: poll until done or timed out
        type PollResp = {
          code?: number;
          response?: {
            status?: { result?: number; msg?: string };
            diagnosticsFileId?: string | number;
            clientIdentifier?: string;
            downloadUrl?: string;
          };
        };

        for (let attempt = 1; attempt <= maxPolls; attempt++) {
          await sleep(intervalMs);
          await reporter.log('info', `Polling diagnostics — attempt ${attempt}/${maxPolls}…`);

          const poll = await client.request<PollResp>(
            'GET',
            `/api/v1/command/device/diagnostics/poll${qs}`,
          );

          const resp = poll?.response;
          const result = resp?.status?.result;
          const statusMsg = resp?.status?.msg ?? '';

          if (poll?.code === 202 || result === -1) {
            // Still in progress
            if (statusMsg) await reporter.log('info', `  Status: ${statusMsg}`);
            continue;
          }

          if (result === -2) {
            return fail(`Diagnostics failed: ${statusMsg || 'device unreachable or collection error'}`);
          }

          // result === 0 (or code === 200) → done
          const clientIdentifier = resp?.clientIdentifier ?? input.clientid;
          const fileId = resp?.diagnosticsFileId;
          await reporter.log('info', statusMsg ? `  ${statusMsg}` : '  Diagnostics ready.');

          if (clientIdentifier && fileId !== undefined) {
            const baseUrl = process.env.SCOUT_BASE_URL?.replace(/\/$/, '');
            const downloadUrl =
              `${baseUrl}/rest/api/v1/command/device/diagnostics/download` +
              `?clientid=${encodeURIComponent(String(clientIdentifier))}&diagnosticsFileId=${encodeURIComponent(String(fileId))}`;
            await reporter.log('info', 'Download URL ready.');
            return ok({
              ...poll,
              downloadUrl,
              note: 'Fetch this URL with the ScoutBoardAuthJWT cookie to download the ZIP.',
            });
          }

          return ok(poll);
        }

        const elapsedS = Math.round((maxPolls * intervalMs) / 1000);
        return fail(
          `Diagnostics timed out after ${elapsedS}s (${maxPolls} polls). ` +
            'Use action=poll to check status manually.',
        );
      }
    }
  } catch (err) {
    return fail(`device_diagnostics failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const deviceDiagnosticsTool = {
  name: 'device_diagnostics',
  description:
    'Collect device diagnostics asynchronously. ' +
    'Quick path: action=run — triggers collection, polls automatically, and returns the download URL in one call; ' +
    'sends log notifications (visible in the MCP client) for each poll step. ' +
    'Manual path: trigger → poll (repeat until HTTP 200) → download_url to get the ZIP link. ' +
    'Binary download must be performed by the caller using the ScoutBoardAuthJWT cookie.',
  inputSchema: zodToJsonSchema(deviceDiagnosticsSchema),
  execute: deviceDiagnosticsExecute,
};
