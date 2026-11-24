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
import { resolveOuRef, invalidateOuCache, assertOuPathUnchanged } from '../resolver.js';
import { gateOuWrite, gateOuSubtree, subOusRequested, sanitizeOuBody, resolveDeviceSourceOus, gateSourceOus, sourceOuChecksActive } from '../safety/ou_gate.js';
import {
  checkMutationAllowed,
  checkBlastRadius,
  checkOuWriteAllowed,
  isDryRunSkip,
  GuardrailError,
  auditLog,
} from '../safety/guardrails.js';
import { parseSearchDevices, extractSearchDevices, deviceName, type DeviceRecord } from '../devices.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

const MAX_BULK = 500;

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
  // Reads OUID and/or GroupID per row (strict ints, agreeing, uniform shape) and requires every id
  // to exist in a FRESH OU tree; any failure is audited and throws 'unresolvable-source-ou'.
  const sources = await resolveDeviceSourceOus('move_devices_by_filter', 'unknown', devices);
  return Array.from(new Set(sources.map((m) => m.path)));
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

  const steps: string[] = [];

  try {
    // Gate 1: mode tiers — onboard_branch is a multi-step composite write.
    const modeCheck = checkMutationAllowed('onboard_branch');

    // The parent OU is the write target (the new OU is created under it and inherits from it).
    // Resolve every supplied reference from a fresh tree (they must agree), run the
    // SCOUT_ENV=test scope and SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS on the RESOLVED path, and
    // send ONLY the resolved id. The filter rule added in step 2 targets the new OU, which sits
    // inside the gated parent.
    const parent = await gateOuWrite(
      'onboard_branch',
      [input.parentOuPath, input.parentOuId],
      'parent OU',
      { requiredMessage: 'parentOuPath or parentOuId is required' },
    );
    if (!parent) throw new Error('parent OU unresolved');

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        wouldCreate: input.name,
        parent: parent.path,
        wouldAddFilter: input.subnetCidr ?? null,
        message: modeCheck.dryRunNotice,
      });
    }

    // Re-assert, immediately before the mutating call, that the gated parent still has the gated path.
    await assertOuPathUnchanged(parent.ouid, parent.path);

    // Step 1 — create the new OU
    const qs = buildQuery({
      destouid: parent.ouid,
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

/** Devices moved/commanded between path re-assertions (one fresh OU-tree read per batch). */
const BATCH_SIZE = 25;

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

  try {
    // Gate 1: mode tiers. read-only throws here (before any search or prompt); dry-run is
    // reported after the confirmation/blast-radius steps below so the preview stays complete.
    const modeCheck = isDryRun ? { proceed: true } : checkMutationAllowed('move_devices_by_filter');

    // Resolve BOTH OUs once, from a fresh tree, and gate/scope them on the RESOLVED canonical
    // path (never the raw caller string). destOuPath and destOuId (if both given) must name the
    // same OU; the move requests send ONLY the resolved destination id, so the gated and the
    // written destination are identical. The source root is resolved for the SCOUT_ENV=test scope
    // and to search by its canonical path; the protected-OU check on the sources below runs on
    // every matched device's actual OU.
    const destMatch = await gateOuWrite(
      'move_devices_by_filter',
      [input.destOuPath, input.destOuId],
      'destination OU',
      { requiredMessage: 'destOuPath or destOuId is required' },
    );
    if (!destMatch) throw new Error('destOuPath or destOuId is required');
    const srcRoot = await gateOuWrite(
      'move_devices_by_filter',
      [input.sourceOuPath, input.sourceOuId],
      'source OU',
      { skipProtectedCheck: true, requiredMessage: 'sourceOuPath or sourceOuId is required' },
    );
    if (!srcRoot) throw new Error('sourceOuPath or sourceOuId is required');

    // Search for devices (read; by the canonical resolved path)
    const qs = buildQuery({
      ouPath: srcRoot.path,
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
        destination: destMatch.path,
        wouldMove: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message: `${devices.length} device(s) would be moved. Set dryRun=false and confirm=true to proceed.`,
      });
    }

    // Confirmation gate, now that the real matched-device count is known. The prompt names the
    // RESOLVED destination (canonical path and id), not the caller's raw input.
    const moveOutcome = await confirmDestructiveAction(
      { server: ctx?.server },
      {
        opName: 'move_devices_by_filter',
        summary: `Move ${devices.length} device(s) to "${destMatch.path}" (OU id ${destMatch.ouid}).`,
        confirmFlag: input.confirm,
      },
    );
    if (!moveOutcome.proceed) {
      return fail(`move_devices_by_filter blocked: ${moveOutcome.reason}`);
    }

    // Gate 3: blast-radius cap, now that the device count is resolved.
    checkBlastRadius({ affectedCount: devices.length, overrideBlastRadius: input.overrideBlastRadius });

    // Gate 6 (sources): a bulk move can touch many distinct source OUs at once (recursively if
    // includeSubOus=true) — every one of those is checked, not just the search root, because the
    // search root the caller passed in is not necessarily the OU any individual matched device
    // actually lives in. Fail closed: resolveDistinctSourceOuPathsOrThrow throws (rather than
    // returning []) if any matched device's source OU can't be determined — see its doc comment.
    // The id comes from the row's GroupID (live: the device's direct OU) and/or OUID, validated.
    const sourcePaths = await resolveDistinctSourceOuPathsOrThrow(devices);
    for (const sourcePath of sourcePaths) {
      checkOuWriteAllowed({ targetPath: sourcePath });
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        matched: devices.length,
        destination: destMatch.path,
        wouldMove: devices.map((d) => deviceName(d) ?? '(unknown)'),
        message: modeCheck.dryRunNotice,
      });
    }

    // Move each device, re-asserting the gated destination path before EACH batch (one fresh
    // tree read per BATCH_SIZE devices) so an out-of-band rename/move of the destination part-way
    // through a long loop stops the remaining moves instead of letting them through.
    let moved = 0;
    let aborted = false;
    const failed: Array<{ device: string; error: string }> = [];

    // The first assertion throws (nothing has been moved yet: a plain refusal); later ones abort the loop.
    await assertOuPathUnchanged(destMatch.ouid, destMatch.path);
    for (let i = 0; i < devices.length; i++) {
      if (i > 0 && i % BATCH_SIZE === 0) {
        try {
          await assertOuPathUnchanged(destMatch.ouid, destMatch.path);
        } catch (err) {
          auditLog({
            opName: 'move_devices_by_filter',
            target: destMatch.path,
            result: 'refused',
            gate: 'protected-ou',
            detail: `aborted before device ${i + 1}/${devices.length}: ${err instanceof Error ? err.message : String(err)}`,
          });
          failed.push({
            device: `${devices.length - i} remaining device(s)`,
            error: `aborted: ${err instanceof Error ? err.message : String(err)}`,
          });
          aborted = true;
          break;
        }
      }
      const device = devices[i];
      const name = deviceName(device);
      if (!name) {
        failed.push({ device: JSON.stringify(device), error: 'Could not determine device name' });
        continue;
      }
      try {
        const moveQs = buildQuery({
          name,
          destouid: destMatch.ouid,
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
      status: aborted ? 'aborted' : failed.length === 0 ? 'ok' : 'partial',
      matched: devices.length,
      moved,
      destination: destMatch.path,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`move_devices_by_filter blocked: ${err.message}`);
    return fail(`move_devices_by_filter failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    invalidateOuCache();
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
    // Gate 1: mode tiers. read-only throws here (before any search or prompt); dry-run is
    // reported after the confirmation/blast-radius steps below so the preview stays complete.
    const baseModeCheck = isDryRun ? { proceed: true } : checkMutationAllowed(`bulk_command(${input.command})`);

    // The source OU is the write scope (commands go to every device under it). Resolve it once
    // from a fresh tree (path/id must agree), gate it - and, with includeSubOus, every sub-OU - on
    // the RESOLVED path (SCOUT_ENV=test scope, SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS), and
    // search by that canonical path only.
    const cmdBody = sanitizeOuBody(input.commandBody, { generic: true });
    const srcRoot = await gateOuWrite(
      `bulk_command(${input.command})`,
      [input.sourceOuPath, input.sourceOuId, ...cmdBody.ouRefs],
      'source OU',
      { requiredMessage: 'sourceOuPath or sourceOuId is required' },
    );
    if (!srcRoot) throw new Error('sourceOuPath or sourceOuId is required');
    if (subOusRequested(input.includeSubOus)) await gateOuSubtree(`bulk_command(${input.command})`, srcRoot);

    // Search for devices
    const qs = buildQuery({
      ouPath: srcRoot.path,
      searchTerm: input.searchTerm,
      includeSubOus: input.includeSubOus,
      limit: input.limit ?? 100,
    });
    const searchResp = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
    // bulk_command has no per-device source-OU check (it sends device commands, not OU
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

    // Per-device source check (defence in depth beyond the gated root/subtree): when a list or
    // SCOUT_ENV=test is active, every matched device's own OU must resolve and pass the gates.
    if (sourceOuChecksActive()) {
      gateSourceOus(
        `bulk_command(${input.command})`,
        await resolveDeviceSourceOus(`bulk_command(${input.command})`, srcRoot.path, devices),
      );
    }

    const modeCheck = baseModeCheck;
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

    let aborted = false;
    // The first assertion throws (nothing sent yet: a plain refusal); later ones abort the loop.
    await assertOuPathUnchanged(srcRoot.ouid, srcRoot.path);
    for (const device of devices) {
      if (processed > 0 && processed % BATCH_SIZE === 0) {
        // Re-assert the gated source OU path before each batch (one fresh tree read per batch).
        try {
          await assertOuPathUnchanged(srcRoot.ouid, srcRoot.path);
        } catch (err) {
          auditLog({
            opName: `bulk_command(${input.command})`,
            target: srcRoot.path,
            result: 'refused',
            gate: 'protected-ou',
            detail: `aborted before device ${processed + 1}/${devices.length}: ${err instanceof Error ? err.message : String(err)}`,
          });
          failed.push({
            device: `${devices.length - processed} remaining device(s)`,
            error: `aborted: ${err instanceof Error ? err.message : String(err)}`,
          });
          aborted = true;
          break;
        }
      }
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
          input.commandBody === undefined ? undefined : cmdBody.body,
          { mutating: true, opName: `bulk_command(${input.command})` },
        );
        if (isDryRunSkip(result)) continue;
        commanded++;
      } catch (err) {
        failed.push({ device: name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return ok({
      status: aborted ? 'aborted' : failed.length === 0 ? 'ok' : 'partial',
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
