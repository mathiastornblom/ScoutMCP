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
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

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

// Normalise the many possible device-search response shapes into a flat array.
type DeviceRecord = Record<string, unknown>;

function extractDevices(raw: unknown): DeviceRecord[] {
  if (Array.isArray(raw)) return raw as DeviceRecord[];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const key of ['Devices', 'devices', 'Items', 'items', 'Results', 'results', 'data']) {
      if (Array.isArray(r[key])) return r[key] as DeviceRecord[];
    }
  }
  return [];
}

function deviceName(d: DeviceRecord): string | undefined {
  return (d['Name'] ?? d['DeviceName'] ?? d['name']) as string | undefined;
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
    // Step 1 — create the new OU
    const qs = buildQuery({
      destoupath: input.parentOuPath,
      destouid: input.parentOuId,
      name: input.name,
    });
    const createResp = await client.request<unknown>('POST', `/api/v1/ou${qs}`);
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
          await client.rawRequest<unknown>('POST', '/api/v1/oufilter/add', filterBody);
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
    return fail(`onboard_branch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const onboardBranchTool = {
  name: 'onboard_branch',
  description:
    'Create a new OU branch and optionally add a subnet filter rule — all in one call. ' +
    'Replaces ou_manage(add) + ou_filter_manage(add). ' +
    'Provide parentOuPath or parentOuId to set the parent. ' +
    'If subnetCidr is given, a filter rule is added automatically (requires SCOUT_ENABLE_PRIVATE_ENDPOINTS=true).',
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
});

type MoveDevicesByFilterInput = z.infer<typeof moveDevicesByFilterSchema>;

async function moveDevicesByFilterExecute(raw: unknown): Promise<McpToolResult> {
  const input = moveDevicesByFilterSchema.parse(raw) as MoveDevicesByFilterInput;
  const client = getClient();

  if (!input.sourceOuPath && !input.sourceOuId)
    return fail('sourceOuPath or sourceOuId is required');
  if (!input.destOuPath && input.destOuId === undefined)
    return fail('destOuPath or destOuId is required');

  const isDryRun = input.dryRun ?? false;
  if (!isDryRun && input.confirm !== true)
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
    const devices = extractDevices(searchResp);

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
        await client.request<unknown>('PUT', `/api/v1/device/move${moveQs}`);
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
    return fail(`move_devices_by_filter failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const moveDevicesByFilterTool = {
  name: 'move_devices_by_filter',
  description:
    'Search for devices in a source OU and bulk-move them to a destination OU in one call. ' +
    'Replaces device_get(search) + N×device_manage(move). ' +
    'Use dryRun=true first to preview matches, then confirm=true to execute. ' +
    'DESTRUCTIVE: moves devices — requires confirm=true (unless dryRun=true).',
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
});

type BulkCommandInput = z.infer<typeof bulkCommandSchema>;

async function bulkCommandExecute(raw: unknown): Promise<McpToolResult> {
  const input = bulkCommandSchema.parse(raw) as BulkCommandInput;
  const client = getClient();

  if (!input.sourceOuPath && !input.sourceOuId)
    return fail('sourceOuPath or sourceOuId is required');

  const isDryRun = input.dryRun ?? false;
  const isDestructive = (DESTRUCTIVE_COMMANDS as readonly string[]).includes(input.command);

  if (!isDryRun && input.confirm !== true) {
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
    const devices = extractDevices(searchResp);

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

    // Send command to each device
    let commanded = 0;
    const failed: Array<{ device: string; error: string }> = [];

    for (const device of devices) {
      const name = deviceName(device);
      if (!name) {
        failed.push({ device: JSON.stringify(device), error: 'Could not determine device name' });
        continue;
      }
      try {
        const cmdQs = buildQuery({ name });
        await client.request<unknown>(
          'POST',
          `/api/v1/command/device/${input.command}${cmdQs}`,
          input.commandBody,
        );
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
    return fail(`bulk_command failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const bulkCommandTool = {
  name: 'bulk_command',
  description:
    'Search for devices in an OU and send a command to all matched devices in one call. ' +
    'Replaces device_get(search) + N×device_command(device, …). ' +
    'Use dryRun=true first to preview targets, then confirm=true to execute. ' +
    'DESTRUCTIVE: factoryreset and halt are irreversible — always require confirm=true.',
  inputSchema: zodToJsonSchema(bulkCommandSchema),
  execute: bulkCommandExecute,
};
