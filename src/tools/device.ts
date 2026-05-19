import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function assertTestScope(ouPath: string): string | null {
  if (process.env.SCOUT_ENV !== 'test') return null;
  const testRoot = process.env.SCOUT_TEST_OU_PATH;
  if (!testRoot) return 'SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test';
  if (!ouPath.startsWith(testRoot)) {
    return `Target OU "${ouPath}" is outside SCOUT_TEST_OU_PATH "${testRoot}". Blocked in test mode.`;
  }
  return null;
}

// ── device_get ────────────────────────────────────────────────────────────────

const deviceGetSchema = z.object({
  mode: z.enum(['get', 'search', 'status', 'configOrigins']).describe(
    'get=single device by identifier; search=devices in OU; status=device runtime status; configOrigins=config inheritance origins',
  ),

  // Single device identification (get / status / configOrigins)
  name: z.string().optional().describe('Device name'),
  mac: z.string().optional().describe('Device MAC address'),
  id: z.string().optional().describe('Device numeric ID'),
  clientid: z.string().optional().describe('Client identifier (UUID)'),
  properties: z.string().optional().describe('Comma-separated extra properties to return'),

  // search
  ouPath: z.string().optional().describe('OU path to search in (required for mode=search if ouId not given)'),
  ouId: z.string().optional().describe('OU ID to search in (required for mode=search if ouPath not given)'),
  searchTerm: z.string().optional().describe('Search term (required for mode=search)'),
  searchFields: z.string().optional().describe('Comma-separated device fields to evaluate during search'),
  includeSubOus: z.boolean().optional().describe('Include devices from sub-OUs in search'),
  limit: z.number().int().min(1).max(10000).optional().describe('Max results for search (default 100, max 10000)'),
});

type DeviceGetInput = z.infer<typeof deviceGetSchema>;

async function deviceGetExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceGetSchema.parse(raw) as DeviceGetInput;
  const client = getClient();

  try {
    switch (input.mode) {
      case 'get': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          properties: input.properties,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device${qs}`);
        return ok(data);
      }

      case 'search': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search');
        if (!input.ouPath && !input.ouId) return fail('ouPath or ouId is required for mode=search');
        const qs = buildQuery({
          ouPath: input.ouPath,
          ouId: input.ouId,
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          properties: input.properties,
          includeSubOus: input.includeSubOus,
          limit: input.limit,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
        return ok(data);
      }

      case 'status': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/status${qs}`);
        return ok(data);
      }

      case 'configOrigins': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/configOrigins${qs}`);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`device_get failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const deviceGetTool = {
  name: 'device_get',
  description:
    'Read device information from Scout Board. Modes: get (single device by name/mac/id/clientid), search (list devices in an OU by search term), status (runtime status and activation state), configOrigins (configuration inheritance origins).',
  inputSchema: zodToJsonSchema(deviceGetSchema),
  execute: deviceGetExecute,
};

// ── device_manage ─────────────────────────────────────────────────────────────

const deviceManageSchema = z.object({
  action: z.enum(['add', 'rename', 'delete', 'move']).describe('Operation to perform'),

  // Device identification
  name: z.string().optional().describe('Device name (identifier for rename/delete/move)'),
  mac: z.string().optional().describe('Device MAC address'),
  id: z.string().optional().describe('Device numeric ID'),
  clientid: z.string().optional().describe('Client identifier (UUID)'),

  // add
  destoupath: z.string().optional().describe('Destination OU path (add/move)'),
  destouid: z.number().int().optional().describe('Destination OU ID (add/move)'),
  newDeviceName: z.string().optional().describe('Name for the new device (action=add)'),
  newDeviceMac: z.string().optional().describe('MAC address for the new device (action=add)'),

  // rename
  newname: z.string().optional().describe('New device name (action=rename)'),
});

type DeviceManageInput = z.infer<typeof deviceManageSchema>;

async function deviceManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceManageSchema.parse(raw) as DeviceManageInput;
  const client = getClient();

  // Destructive guard: delete requires knowing which OU the device is in.
  // We guard by requiring destoupath for add operations that specify a test OU,
  // and by checking destoupath on move. For delete, check SCOUT_ENV only.
  if (input.action === 'delete' && process.env.SCOUT_ENV === 'test') {
    const testRoot = process.env.SCOUT_TEST_OU_PATH;
    if (!testRoot) {
      return fail('SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test');
    }
    // delete doesn't take an OU path — we can't verify scope without a lookup.
    // Require caller to confirm they know what they're doing in test mode.
    return fail(
      'device_manage action=delete is disabled in SCOUT_ENV=test to prevent accidental deletion. ' +
        'Set SCOUT_ENV=production to delete devices, or verify the device is in SCOUT_TEST_OU_PATH manually.',
    );
  }

  if ((input.action === 'add' || input.action === 'move') && input.destoupath) {
    const err = assertTestScope(input.destoupath);
    if (err) return fail(err);
  }

  try {
    switch (input.action) {
      case 'add': {
        if (!input.newDeviceName) return fail('newDeviceName is required for action=add');
        if (!input.newDeviceMac) return fail('newDeviceMac is required for action=add');
        const qs = buildQuery({
          destoupath: input.destoupath,
          destouid: input.destouid,
          name: input.newDeviceName,
          mac: input.newDeviceMac,
        });
        const data = await client.request<unknown>('POST', `/api/v1/device${qs}`);
        return ok(data);
      }

      case 'rename': {
        if (!input.newname) return fail('newname is required for action=rename');
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          newname: input.newname,
        });
        const data = await client.request<unknown>('PUT', `/api/v1/device${qs}`);
        return ok(data);
      }

      case 'delete': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('DELETE', `/api/v1/device${qs}`);
        return ok(data);
      }

      case 'move': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          destoupath: input.destoupath,
          destouid: input.destouid,
        });
        const data = await client.request<unknown>('PUT', `/api/v1/device/move${qs}`);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`device_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const deviceManageTool = {
  name: 'device_manage',
  description:
    'Add, rename, delete, or move devices in Scout Board. ' +
    'DESTRUCTIVE: action=delete permanently removes a device from Scout Board. ' +
    'In SCOUT_ENV=test mode, delete is blocked entirely; add and move are restricted to paths under SCOUT_TEST_OU_PATH.',
  inputSchema: zodToJsonSchema(deviceManageSchema),
  execute: deviceManageExecute,
};
