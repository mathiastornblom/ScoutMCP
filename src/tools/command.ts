import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult, type ToolContext } from '../types.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';
import { gateOuWrite, gateOuSubtree, sanitizeOuBody, gateSingleDeviceSource, sourceOuChecksActive } from '../safety/ou_gate.js';
import { getProgressReporter } from '../progress.js';
import { confirmDestructiveAction } from '../elicitation.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';
import { checkOuRightPreflight, DEVICE_COMMAND_RIGHTS } from '../safety/preflight.js';

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

async function deviceCommandExecute(raw: unknown, ctx?: ToolContext): Promise<McpToolResult> {
  const input = deviceCommandSchema.parse(raw) as DeviceCommandInput;
  const opName = `device_command(${input.command})`;
  const client = getClient();
  const path = `/api/v1/command/${input.target}/${input.command}`;

  // device target: identity goes in query params
  let qs =
    input.target === 'device'
      ? buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid })
      : '';

  try {
    // Gate 1: mode tiers — every device_command invocation sends a command that
    // changes device state (restart, halt, factoryreset, custom payloads, etc).
    // read-only throws here, before any resolution or confirmation prompt.
    const modeCheck = checkMutationAllowed(opName);

    let body = input.body;

    // target=ou: the OU is the write scope (the command reaches every device under it). Resolve ALL
    // supplied references (ouRef, body.ouId, body.ouPath) from a fresh tree - they must agree -
    // gate the RESOLVED path (SCOUT_ENV=test scope, SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS; with
    // includeSubOus also every sub-OU), and send ONLY the resolved id (body.ouPath is dropped and
    // a body.ouId can no longer override the gated ouRef).
    // target=device|devicelist|ddg cannot be tied to an OU from the input alone (see README).
    let ou: OuMatch | undefined;
    if (input.target === 'ou') {
      const sb = sanitizeOuBody(input.body, { generic: true });
      ou = await gateOuWrite(
        opName,
        [input.ouRef, ...sb.ouRefs],
        'target OU',
        { requiredMessage: 'target=ou requires ouRef (or an OU key in body); refusing rather than leaving the OU to the server.' },
      );
      if (!ou) throw new Error('target OU unresolved');
      if (sb.subOusRequested) await gateOuSubtree(opName, ou);
      // Every OU-ish body key (any case/separator/Unicode variant, any depth) is dropped; only the
      // canonical resolved ouId and a normalised boolean includeSubOus are sent.
      body = { ...sb.body, ouId: ou.ouid, ...(sb.hasSubOusKey ? { includeSubOus: sb.subOusRequested } : {}) };
      qs = buildQuery({ id: ou.ouid });
    }

    // target=device: map the device to its current OU (OUID/GroupID, confirmed against a fresh tree)
    // and apply the protected/allowed lists + test scope. Only when a list or SCOUT_ENV=test is
    // active (otherwise no gate could fire); then any failure to determine the OU refuses.
    // devicelist/ddg still cannot be tied to one OU (README known gaps).
    if (input.target === 'device' && sourceOuChecksActive()) {
      await gateSingleDeviceSource(client, opName, {
        name: input.name, mac: input.mac, id: input.id, clientid: input.clientid,
      });
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        target: input.target,
        command: input.command,
        message: modeCheck.dryRunNotice,
      });
    }

    // ourights preflight (UX aid only; explicit-false refuses, anything else proceeds).
    // Only target=ou has a known OU id; other scopes are skipped. Runs after all gates above.
    const neededRight = DEVICE_COMMAND_RIGHTS[input.command];
    if (neededRight !== undefined) {
      await checkOuRightPreflight({
        opName,
        target: `ou:${ou?.path ?? 'ou'}`,
        ouId: ou?.ouid,
        requiredRight: neededRight,
      });
    }

    // Security: require explicit confirmation for irreversible commands. Real elicitation
    // prompt if the client supports it, otherwise the confirm:true fallback. Runs after the
    // gates (so the user is never asked to confirm something that is refused anyway) and names
    // the RESOLVED OU.
    if (input.command === 'factoryreset' || input.command === 'halt') {
      const target =
        input.target === 'device'
          ? (input.name ?? input.mac ?? input.id ?? input.clientid ?? '(unspecified device)')
          : ou
            ? `OU "${ou.path}" (id ${ou.ouid})`
            : `${input.target} scope`;
      const outcome = await confirmDestructiveAction(
        { server: ctx?.server },
        {
          opName,
          summary: `Send irreversible command "${input.command}" to ${target}.`,
          confirmFlag: input.confirm,
        },
      );
      if (!outcome.proceed) {
        return fail(`device_command blocked: ${outcome.reason}`);
      }
    }

    // Re-assert, after the prompt and immediately before the write, that the gated OU still has the gated path.
    if (ou) await assertOuPathUnchanged(ou.ouid, ou.path);

    const data = await client.request<unknown>('POST', `${path}${qs}`, body, {
      mutating: true,
      opName,
    });
    if (isDryRunSkip(data)) {
      return ok({ status: 'dry_run', target: input.target, command: input.command, message: data.notice });
    }
    return ok(data);
  } catch (err) {
    if (err instanceof GuardrailError) {
      // Preflight audit-logs its own refusal.
      return fail(`device_command blocked: ${err.message}`);
    }
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

async function deviceDiagnosticsExecute(raw: unknown, _ctx?: ToolContext): Promise<McpToolResult> {
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
        await reporter.report(0, maxPolls, 'Triggering diagnostics collection…');
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
          await reporter.report(attempt, maxPolls, `Polling diagnostics — attempt ${attempt}/${maxPolls}`);

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
          await reporter.report(maxPolls, maxPolls, statusMsg || 'Diagnostics ready.');

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
