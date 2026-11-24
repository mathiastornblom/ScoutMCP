/**
 * Composite workflow tools — multi-step Scout Board operations compressed into
 * single tool calls.
 *
 * BEFORE these tools existed, common tasks required several round-trips:
 *   onboard_branch:       ou_manage(add) + ou_filter_manage(add)          → 2 calls → 1
 *   move_devices_by_filter: device_get(search) + N×device_manage(move)   → N+1 calls → 1
 *   bulk_command:           device_get(search) + N×device_command(…)     → N+1 calls → 1
 *
 * Safety conventions shared by all three tools:
 *   • dryRun=true  — lists what would be affected without touching anything
 *   • confirm=true — required for any destructive or large write operation
 *   • Max 500 devices per bulk operation (raise searchTerm specificity to narrow)
 *   • SCOUT_ENV=test enforces SCOUT_TEST_OU_PATH scope on all write targets
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult, type ToolContext } from '../types.js';
import { confirmDestructiveAction, supportsElicitation } from '../elicitation.js';
import { resolveOuRef } from '../resolver.js';
import {
  checkMutationAllowed,
  checkBlastRadius,
  checkOuWriteAllowed,
  isDryRunSkip,
  GuardrailError,
  auditLog,
} from '../safety/guardrails.js';
import { parseSearchDevices, extractSearchDevices, deviceName, deviceOuId, type DeviceRecord } from '../devices.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

const MAX_BULK = 500;

function testScopeError(path: string, label: string): string | null {
  if (process.env.SCOUT_ENV !== 'test') return null;
  const root = process.env.SCOUT_TEST_OU_PATH;
  if (!root) return 'SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test';
  if (!path.startsWith(root))
    return `${label} "${path}" is outside SCOUT_TEST_OU_PATH "${root}". Blocked in test mode.`;
  return null;
}

/**
 * Parses a device-search response and throws (rather than returning an empty array) if the
 * envelope doesn't match the documented `/api/v1/device/search` schema. Used by callers
 * (move_devices_by_filter) where treating "couldn't parse the response" the same as "zero
 * devices matched" would mean a safety gate downstream silently runs against an empty set
 * instead of refusing — see resolveDistinctSourceOuPathsOrThrow below for why that matters.
 */
function extractDevicesOrThrow(raw: unknown): DeviceRecord[] {
  const parsed = parseSearchDevices(raw);
  if (!parsed.ok) {
    auditLog({
      opName: 'move_devices_by_filter',
      target: 'unknown',
      result: 'refused',
      gate: 'unresolvable-source-ou',
      detail: `device search response unparseable: ${parsed.reason}`,
    });
    throw new GuardrailError(
      `Could not parse the device search response (${parsed.reason}). Refusing to proceed: ` +
        'the protected-OU check requires a reliable device list to resolve source OUs from, ' +
        'and an unparseable response must not be treated as "no devices matched."',
      'unresolvable-source-ou',
    );
  }
  return parsed.devices;
}

/**
 * Resolves the distinct set of OU paths that the matched devices currently sit in, by
 * reading each device's OUID and resolving it against the OU tree (deduplicated, in
 * parallel). Used so move_devices_by_filter can run the protected-OU gate against every
 * *actual* source OU touched by the move — not just the search-root sourceOuPath/sourceOuId
 * the caller passed in, which (with includeSubOus=true) may not itself be the OU any
 * individual matched device lives in.
 *
 * FAILS CLOSED: unlike a generic best-effort lookup, this throws (refusing the whole bulk
 * move) if there are matched devices but NONE of them yield a resolvable OU id — that
 * combination means the protected-OU gate cannot evaluate any source OU at all, and
 * proceeding would move devices with zero source-side protected-OU checks, defeating the
 * gate entirely. The documented `/api/v1/device/search` response schema does not guarantee
 * device records carry an OU id field, so this is not a hypothetical: a perfectly normal,
 * well-formed response can legitimately have no per-device OU id.
 *
 * A *partial* resolution (some devices' OUIDs resolve, some don't) is still treated as a
 * failure for the same reason — an unresolved device's source OU is exactly the kind of
 * gap the gate exists to catch, so silently checking only the OUs we happened to resolve
 * would be a narrower version of the same fail-open bug.
 */
async function resolveDistinctSourceOuPathsOrThrow(devices: DeviceRecord[]): Promise<string[]> {
  const idsByDevice = devices.map(deviceOuId);
  const unresolvedCount = idsByDevice.filter((id) => id === undefined).length;
  if (unresolvedCount > 0) {
    auditLog({
      opName: 'move_devices_by_filter',
      target: 'unknown',
      result: 'refused',
      gate: 'unresolvable-source-ou',
      detail: `${unresolvedCount} of ${devices.length} matched device(s) had no resolvable OU id`,
    });
    throw new GuardrailError(
      `Could not determine the source OU for ${unresolvedCount} of ${devices.length} matched device(s) ` +
        '(no OUID/ouId field on the device-search record). Refusing to proceed: the protected-OU ' +
        'check cannot run against an unresolvable source OU, and proceeding anyway would move ' +
        'devices with zero source-side protected-OU checks.',
      'unresolvable-source-ou',
    );
  }

  const ids = Array.from(new Set(idsByDevice.filter((id): id is number => id !== undefined)));
  const paths = await Promise.all(
    ids.map(async (id) => {
      try {
        const match = await resolveOuRef(id);
        return match.path;
      } catch (err) {
        auditLog({
          opName: 'move_devices_by_filter',
          target: `ouid:${id}`,
          result: 'refused',
          gate: 'unresolvable-source-ou',
          detail: `OU id ${id} found on a matched device could not be resolved against the OU tree: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        });
        throw new GuardrailError(
          `Could not resolve OU id ${id} (found on a matched device) against the OU tree: ` +
            `${err instanceof Error ? err.message : String(err)}. Refusing to proceed.`,
          'unresolvable-source-ou',
        );
      }
    }),
  );
  return Array.from(new Set(paths));
}

// ── onboard_branch ────────────────────────────────────────────────────────────

const onboardBranchSchema = z.object({
  name: z.string().describe('Name for the new OU (e.g. "03 - LU Berlin")'),

  parentOuPath: z.string().optional().describe('Full path of the parent OU (e.g. "/Enterprise/Germany")'),
  parentOuId: z.number().int().optional().describe('Numeric ID of the parent OU'),

  subnetCidr: z
    .string()
    .optional()
    .describe(
      'IP subnet in CIDR notation to auto-create an OU filter rule, e.g. "10.6.72.0/21". ' +
        'Requires SCOUT_ENABLE_PRIVATE_ENDPOINTS=true to apply the filter rule.',
    ),
  filterActive: z.boolean().optional().default(true).describe('Whether the filter rule is active (default true)'),
});

type OnboardBranchInput = z.infer<typeof onboardBranchSchema>;

async function onboardBranchExecute(raw: unknown): Promise<McpToolResult> {
  const input = onboardBranchSchema.parse(raw) as OnboardBranchInput;
  const client = getClient();

  if (!input.parentOuPath && input.parentOuId === undefined)
    return fail('parentOuPath or parentOuId is required');

  const parentPath = input.parentOuPath;
  if (parentPath) {
    const err = testScopeError(parentPath, 'Parent OU');
    if (err) return fail(err);
  }

  const steps: string[] = [];

  try {
    // Gate 1: mode tiers — onboard_branch is a multi-step composite write.
    const modeCheck = checkMutationAllowed('onboard_branch');
    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        wouldCreate: input.name,
        wouldAddFilter: input.subnetCidr ?? null,
        message: modeCheck.dryRunNotice,
      });
    }

    // Step 1 — create the new OU
    const qs = buildQuery({
      destoupath: input.parentOuPath,
      destouid: input.parentOuId,
      name: input.name,
    });
    const createResp = await client.request<unknown>('POST', `/api/v1/ou${qs}`, undefined, {
      mutating: true,
      opName: 'onboard_branch',
    });
    steps.push(`OU "${input.name}" created`);

    // Extract the new OU's ID from the creation response (best-effort)
    let newOuId: number | undefined;
    if (createResp && typeof createResp === 'object') {
      const r = createResp as Record<string, unknown>;
      const raw = r['OUID'] ?? r['ouId'] ?? r['Id'] ?? r['id'];
      if (typeof raw === 'number') newOuId = raw;
    }

    // Step 2 — if subnetCidr provided, add OU filter rule (private endpoint)
    if (input.subnetCidr) {
      if (newOuId === undefined) {
        steps.push(
          `SKIP: filter rule not added — could not extract OUID from creation response. ` +
            `Add manually with ou_filter_manage(action=add).`,
        );
      } else {
        try {
          const filterBody = {
            requestValues: [
              {
                FilterType: 1,
                SubnetAddress: input.subnetCidr,
                Active: input.filterActive ?? true,
                OUID: newOuId,
              },
            ],
          };
          await client.rawRequest<unknown>('POST', '/api/v1/oufilter/add', filterBody, {
            mutating: true,
            opName: 'onboard_branch(filter)',
          });
          steps.push(`Filter rule added: ${input.subnetCidr} → OUID ${newOuId}`);
        } catch (filterErr) {
          const msg = filterErr instanceof Error ? filterErr.message : String(filterErr);
          steps.push(
            `WARN: filter rule not added (${msg}). ` +
              `Check SCOUT_ENABLE_PRIVATE_ENDPOINTS=true or add manually with ou_filter_manage.`,
          );
        }
      }
    }

    return ok({ status: 'ok', steps, ouId: newOuId, response: createResp });
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`onboard_branch blocked: ${err.message}`);
    return fail(`onboard_branch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const onboardBranchTool = {
  name: 'onboard_branch',
  description:
    'Create a new OU branch and optionally add a subnet filter rule — all in one call. ' +
    'Replaces ou_manage(add) + ou_filter_manage(add). ' +
    'Provide parentOuPath or parentOuId to set the parent. ' +
    'If subnetCidr is given, a filter rule is added automatically (requires SCOUT_ENABLE_PRIVATE_ENDPOINTS=true). ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing).',
  inputSchema: zodToJsonSchema(onboardBranchSchema),
  execute: onboardBranchExecute,
};

// ── move_devices_by_filter ────────────────────────────────────────────────────

const moveDevicesByFilterSchema = z.object({
  sourceOuPath: z.string().optional().describe('OU path to search for devices'),
  sourceOuId: z.string().optional().describe('OU ID to search for devices'),
  searchTerm: z.string().describe(
    'Device search term — use "*" to match all devices, or a name fragment like "ThinClient"',
  ),
  includeSubOus: z.boolean().optional().describe('Include sub-OU devices in the search (default false)'),

  destOuPath: z.string().optional().describe('Destination OU path to move matched devices to'),
  destOuId: z.number().int().optional().describe('Destination OU numeric ID'),

  dryRun: z.boolean().optional().describe(
    'If true, list matched devices without moving them (default false). No confirm required.',
  ),
  confirm: z.boolean().optional().describe(
    'Must be true to actually perform the move (required when dryRun=false).',
  ),
  limit: z.number().int().min(1).max(MAX_BULK).optional().describe(
    `Max devices to process in one call (default 100, max ${MAX_BULK})`,
  ),
  overrideBlastRadius: z.boolean().optional().describe(
    'Set true to proceed when the number of matched devices exceeds SCOUT_MAX_BLAST_RADIUS ' +
    '(still capped by a hard ceiling).',
  ),
});

type MoveDevicesByFilterInput = z.infer<typeof moveDevicesByFilterSchema>;

async function moveDevicesByFilterExecute(raw: unknown, ctx?: ToolContext): Promise<McpToolResult> {
  const input = moveDevicesByFilterSchema.parse(raw) as MoveDevicesByFilterInput;
  const client = getClient();

  if (!input.sourceOuPath && !input.sourceOuId)
    return fail('sourceOuPath or sourceOuId is required');
  if (!input.destOuPath && input.destOuId === undefined)
    return fail('destOuPath or destOuId is required');

  const isDryRun = input.dryRun ?? false;
  // Cheap fail-fast for the non-elicitation, non-dry-run case: if the client doesn't support
  // elicitation, confirm=true must be present before we even bother searching. Clients that DO
  // support elicitation skip this early check — they get a real yes/no prompt after the device
  // search resolves the actual count, below (see confirmDestructiveAction call further down).
  if (!isDryRun && !supportsElicitation(ctx?.server) && input.confirm !== true)
    return fail(
      'confirm=true is required to move devices. ' +
        'Use dryRun=true first to preview what would be moved.',
    );

  // Test-scope guard on destination
  if (!isDryRun && input.destOuPath) {
    const err = testScopeError(input.destOuPath, 'Destination OU');
    if (err) return fail(err);
  }
  if (!isDryRun && input.sourceOuPath) {
    const err = testScopeError(input.sourceOuPath, 'Source OU');
    if (err) return fail(err);
  }

  try {
    // Search for devices
    const qs = buildQuery({
      ouPath: input.sourceOuPath,
      ouId: input.sourceOuId,
      searchTerm: input.searchTerm,
      includeSubOus: input.includeSubOus,
      limit: input.limit ?? 100,
    });
    const searchResp = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
    // Throws (rather than silently treating an unparseable response as "no matches") because
    // this tool's protected-OU gate (below) depends on resolving every matched device's
    // source OU — see extractDevicesOrThrow / resolveDistinctSourceOuPathsOrThrow.
    const devices = extractDevicesOrThrow(searchResp);

    if (devices.length === 0) {
      return ok({ status: 'ok', matched: 0, moved: 0, message: 'No devices matched the search criteria.' });
    }

    if (isDryRun) {
      return ok({
        status: 'dry_run',
        matched: devices.length,
        wouldMove: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message: `${devices.length} device(s) would be moved. Set dryRun=false and confirm=true to proceed.`,
      });
    }

    // Confirmation gate, now that the real matched-device count is known. If the client
    // supports elicitation, prompt with the actual count and destination; otherwise the
    // early confirm=true fail-fast above has already gated this.
    const moveOutcome = await confirmDestructiveAction(
      { server: ctx?.server },
      {
        opName: 'move_devices_by_filter',
        summary: `Move ${devices.length} device(s) to "${input.destOuPath ?? `OU id ${input.destOuId}`}".`,
        confirmFlag: input.confirm,
      },
    );
    if (!moveOutcome.proceed) {
      return fail(`move_devices_by_filter blocked: ${moveOutcome.reason}`);
    }

    // Gate 3: blast-radius cap, now that the device count is resolved.
    checkBlastRadius({ affectedCount: devices.length, overrideBlastRadius: input.overrideBlastRadius });

    // Gate 6: protected/allowed OU lists. A bulk move can touch many distinct source OUs
    // at once (the resolved matches under sourceOuPath/sourceOuId, recursively if
    // includeSubOus=true) plus a single destination — every one of those is checked, not
    // just the search root, because the search root the caller passed in is not
    // necessarily the OU any individual matched device actually lives in once sub-OUs are
    // included. The write is blocked if ANY resolved source OU or the destination is
    // protected (or, with an allow-list configured, not allowed).
    const destPathForGate =
      input.destOuPath ?? (input.destOuId !== undefined ? (await resolveOuRef(input.destOuId)).path : undefined);
    if (destPathForGate) {
      checkOuWriteAllowed({ targetPath: destPathForGate });
    }
    // Fail closed: resolveDistinctSourceOuPathsOrThrow throws (rather than returning []) if
    // any matched device's source OU can't be determined — see its doc comment. A thrown
    // error here is caught by this function's outer catch and surfaced as a refusal, the
    // same as any other guardrail gate, rather than letting the move proceed with zero
    // source-OU checks.
    const sourcePaths = await resolveDistinctSourceOuPathsOrThrow(devices);
    for (const sourcePath of sourcePaths) {
      checkOuWriteAllowed({ targetPath: sourcePath });
    }

    // Gate 1: mode tiers.
    const modeCheck = checkMutationAllowed('move_devices_by_filter');
    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        matched: devices.length,
        wouldMove: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message: modeCheck.dryRunNotice,
      });
    }

    // Move each device
    let moved = 0;
    const failed: Array<{ device: string; error: string }> = [];

    for (const device of devices) {
      const name = deviceName(device);
      if (!name) {
        failed.push({ device: JSON.stringify(device), error: 'Could not determine device name' });
        continue;
      }
      try {
        const moveQs = buildQuery({
          name,
          destoupath: input.destOuPath,
          destouid: input.destOuId,
        });
        const result = await client.request<unknown>('PUT', `/api/v1/device/move${moveQs}`, undefined, {
          mutating: true,
          opName: 'move_devices_by_filter',
        });
        if (isDryRunSkip(result)) continue;
        moved++;
      } catch (err) {
        failed.push({ device: name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return ok({
      status: failed.length === 0 ? 'ok' : 'partial',
      matched: devices.length,
      moved,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`move_devices_by_filter blocked: ${err.message}`);
    return fail(`move_devices_by_filter failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const moveDevicesByFilterTool = {
  name: 'move_devices_by_filter',
  description:
    'Search for devices in a source OU and bulk-move them to a destination OU in one call. ' +
    'Replaces device_get(search) + N×device_manage(move). ' +
    'Use dryRun=true first to preview matches, then confirm=true to execute. ' +
    'DESTRUCTIVE: moves devices — requires confirm=true (unless dryRun=true). ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing) and ' +
    'SCOUT_MAX_BLAST_RADIUS (default 25, hard ceiling 500) — pass overrideBlastRadius=true to exceed the cap up to the ceiling.',
  inputSchema: zodToJsonSchema(moveDevicesByFilterSchema),
  execute: moveDevicesByFilterExecute,
};

// ── bulk_command ──────────────────────────────────────────────────────────────

const DESTRUCTIVE_COMMANDS = ['factoryreset', 'halt'] as const;

const bulkCommandSchema = z.object({
  sourceOuPath: z.string().optional().describe('OU path to search for target devices'),
  sourceOuId: z.string().optional().describe('OU ID to search for target devices'),
  searchTerm: z.string().describe(
    'Device search term — "*" matches all, or a name fragment like "Thin"',
  ),
  includeSubOus: z.boolean().optional().describe('Include sub-OU devices in search (default false)'),

  command: z
    .enum(['restart', 'halt', 'start', 'factoryreset', 'update', 'updateuefi', 'custom', 'predefined', 'delivery', 'message'])
    .describe('Command to send to each matched device'),
  commandBody: z.record(z.unknown()).optional().describe(
    'Optional body fields for the command (InformUser, Schedule, custom payload, etc.)',
  ),

  dryRun: z.boolean().optional().describe(
    'If true, list matched devices without sending any command (default false).',
  ),
  confirm: z.boolean().optional().describe(
    'Must be true to actually send commands. Always required for factoryreset and halt.',
  ),
  limit: z.number().int().min(1).max(MAX_BULK).optional().describe(
    `Max devices to command in one call (default 100, max ${MAX_BULK})`,
  ),
  overrideBlastRadius: z.boolean().optional().describe(
    'Set true to proceed when the number of matched devices exceeds SCOUT_MAX_BLAST_RADIUS ' +
    '(still capped by a hard ceiling).',
  ),
});

type BulkCommandInput = z.infer<typeof bulkCommandSchema>;

async function bulkCommandExecute(raw: unknown, ctx?: ToolContext): Promise<McpToolResult> {
  const input = bulkCommandSchema.parse(raw) as BulkCommandInput;
  const client = getClient();

  if (!input.sourceOuPath && !input.sourceOuId)
    return fail('sourceOuPath or sourceOuId is required');

  const isDryRun = input.dryRun ?? false;
  const isDestructive = (DESTRUCTIVE_COMMANDS as readonly string[]).includes(input.command);

  // Cheap fail-fast for the non-elicitation, non-dry-run case (see move_devices_by_filter for
  // the same pattern). Clients that support elicitation get a real yes/no prompt after the
  // device search resolves the actual count, below.
  if (!isDryRun && !supportsElicitation(ctx?.server) && input.confirm !== true) {
    const hint = isDestructive
      ? `command=${input.command} is irreversible and`
      : `bulk_command`;
    return fail(
      `${hint} requires confirm=true. ` +
        'Use dryRun=true first to preview which devices would be targeted.',
    );
  }

  try {
    // Search for devices
    const qs = buildQuery({
      ouPath: input.sourceOuPath,
      ouId: input.sourceOuId,
      searchTerm: input.searchTerm,
      includeSubOus: input.includeSubOus,
      limit: input.limit ?? 100,
    });
    const searchResp = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
    // bulk_command has no source-OU protected check (it sends device commands, not OU
    // moves), so an unparseable response degrading to "no devices matched" is acceptable
    // here — unlike move_devices_by_filter, nothing downstream silently skips a safety gate
    // because of it.
    const devices = extractSearchDevices(searchResp);

    if (devices.length === 0) {
      return ok({ status: 'ok', matched: 0, commanded: 0, message: 'No devices matched.' });
    }

    if (isDryRun) {
      return ok({
        status: 'dry_run',
        matched: devices.length,
        command: input.command,
        wouldTarget: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message:
          `${devices.length} device(s) would receive "${input.command}". ` +
          'Set dryRun=false and confirm=true to proceed.',
      });
    }

    // Confirmation gate, now that the real matched-device count is known.
    const cmdOutcome = await confirmDestructiveAction(
      { server: ctx?.server },
      {
        opName: `bulk_command(${input.command})`,
        summary: `Send "${input.command}" to ${devices.length} device(s).${isDestructive ? ' This command is irreversible.' : ''}`,
        confirmFlag: input.confirm,
      },
    );
    if (!cmdOutcome.proceed) {
      return fail(`bulk_command blocked: ${cmdOutcome.reason}`);
    }

    // Gate 3: blast-radius cap, now that the device count is resolved.
    checkBlastRadius({ affectedCount: devices.length, overrideBlastRadius: input.overrideBlastRadius });

    // Gate 1: mode tiers.
    const modeCheck = checkMutationAllowed(`bulk_command(${input.command})`);
    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        matched: devices.length,
        command: input.command,
        wouldTarget: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message: modeCheck.dryRunNotice,
      });
    }

    // Send command to each device
    let commanded = 0;
    const failed: Array<{ device: string; error: string }> = [];
    let processed = 0;

    for (const device of devices) {
      processed++;
      if (ctx?.sendProgress) {
        await ctx.sendProgress(processed, devices.length, `${input.command}: device ${processed}/${devices.length}`);
      }
      const name = deviceName(device);
      if (!name) {
        failed.push({ device: JSON.stringify(device), error: 'Could not determine device name' });
        continue;
      }
      try {
        const cmdQs = buildQuery({ name });
        const result = await client.request<unknown>(
          'POST',
          `/api/v1/command/device/${input.command}${cmdQs}`,
          input.commandBody,
          { mutating: true, opName: `bulk_command(${input.command})` },
        );
        if (isDryRunSkip(result)) continue;
        commanded++;
      } catch (err) {
        failed.push({ device: name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return ok({
      status: failed.length === 0 ? 'ok' : 'partial',
      matched: devices.length,
      commanded,
      command: input.command,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`bulk_command blocked: ${err.message}`);
    return fail(`bulk_command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const bulkCommandTool = {
  name: 'bulk_command',
  description:
    'Search for devices in an OU and send a command to all matched devices in one call. ' +
    'Replaces device_get(search) + N×device_command(device, …). ' +
    'Use dryRun=true first to preview targets, then confirm=true to execute. ' +
    'DESTRUCTIVE: factoryreset and halt are irreversible — always require confirm=true. ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing) and ' +
    'SCOUT_MAX_BLAST_RADIUS (default 25, hard ceiling 500) — pass overrideBlastRadius=true to exceed the cap up to the ceiling.',
  inputSchema: zodToJsonSchema(bulkCommandSchema),
  execute: bulkCommandExecute,
};
