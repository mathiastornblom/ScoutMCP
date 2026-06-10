import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef } from '../resolver.js';
import { enrich } from '../enricher.js';
import { isNotFound } from '../fuzzy.js';
import { getWorkingOu } from '../context.js';

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

  // search — OU can be identified by name/ref, explicit path, explicit id, or working OU context
  ouRef: z.string().optional().describe(
    'OU to search in — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over ouPath/ouId for natural-language requests.',
  ),
  ouPath: z.string().optional().describe(
    'OU path to search in; defaults to working OU if not provided (set via scout_context)',
  ),
  ouId: z.string().optional().describe('OU ID to search in — use ouRef for name-based lookup'),
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
        return ok(await enrich(data));
      }

      case 'search': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search');

        // Resolve OU: ouRef → id lookup; ouPath → explicit; working OU → fallback
        let searchOuPath = input.ouPath ?? getWorkingOu()?.path;
        let searchOuId = input.ouId;

        if (input.ouRef !== undefined) {
          const match = await resolveOuRef(input.ouRef);
          searchOuId = String(match.ouid);
          searchOuPath = undefined; // prefer ID over path
        }

        if (!searchOuPath && !searchOuId) {
          return fail(
            'ouPath, ouId, or ouRef is required for mode=search. ' +
            'Set a working OU with scout_context action=set_ou to use it as default.',
          );
        }

        const qs = buildQuery({
          ouPath: searchOuPath,
          ouId: searchOuId,
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          properties: input.properties,
          includeSubOus: input.includeSubOus,
          limit: input.limit,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
        return ok(await enrich(data));
      }

      case 'status': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/status${qs}`);
        return ok(await enrich(data));
      }

      case 'configOrigins': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/configOrigins${qs}`);
        return ok(await enrich(data));
      }
    }
  } catch (err) {
    const baseMsg = `device_get failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err) && (input.mode === 'get' || input.mode === 'status' || input.mode === 'configOrigins')) {
      const identifier = input.name ?? input.mac ?? input.id ?? input.clientid;
      const hint = identifier
        ? `\n\nHint: device "${identifier}" was not found. Use device_get mode=search with ouPath and searchTerm to locate devices by partial name.`
        : '';
      return fail(baseMsg + hint);
    }
    return fail(baseMsg);
  }
}

export const deviceGetTool = {
  name: 'device_get',
  description:
    'Read device information from Scout Board. Modes: get (single device by name/mac/id/clientid), search (list devices in an OU by search term), status (runtime status and activation state), configOrigins (configuration inheritance origins). ' +
    'For mode=search, use ouRef to identify the OU by name instead of needing the exact path or ID.',
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

  // add / move — destination OU (use destouRef for name-based lookup)
  destouRef: z.string().optional().describe(
    'Destination OU — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over destoupath/destouid.',
  ),
  destoupath: z.string().optional().describe(
    'Destination OU path (add/move); defaults to working OU if not provided (set via scout_context)',
  ),
  destouid: z.number().int().optional().describe('Destination OU ID (add/move) — use destouRef for name-based lookup'),

  // add
  newDeviceName: z.string().optional().describe('Name for the new device (action=add)'),
  newDeviceMac: z.string().optional().describe('MAC address for the new device (action=add)'),

  // rename
  newname: z.string().optional().describe('New device name (action=rename)'),
});

type DeviceManageInput = z.infer<typeof deviceManageSchema>;

async function deviceManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceManageSchema.parse(raw) as DeviceManageInput;
  const client = getClient();

  // Destructive guard: delete is blocked entirely in test mode
  if (input.action === 'delete' && process.env.SCOUT_ENV === 'test') {
    return fail(
      'device_manage action=delete is disabled in SCOUT_ENV=test to prevent accidental deletion. ' +
        'Set SCOUT_ENV=production to delete devices, or verify the device is in SCOUT_TEST_OU_PATH manually.',
    );
  }

  try {
    // Resolve destination OU: destouRef wins; otherwise explicit args with working OU fallback
    let resolvedDestPath: string | undefined;
    let resolvedDestId: number | undefined = input.destouid;

    if (input.destouRef !== undefined) {
      const match = await resolveOuRef(input.destouRef);
      resolvedDestId = match.ouid;
    } else {
      resolvedDestPath =
        input.destoupath ?? ((input.action === 'add' || input.action === 'move') ? getWorkingOu()?.path : undefined);
    }

    // Scope guard for add/move
    if (input.action === 'add' || input.action === 'move') {
      const checkPath = resolvedDestPath ?? (resolvedDestId !== undefined ? String(resolvedDestId) : undefined);
      if (checkPath) {
        const err = assertTestScope(checkPath);
        if (err) return fail(err);
      }
    }

    switch (input.action) {
      case 'add': {
        if (!input.newDeviceName) return fail('newDeviceName is required for action=add');
        if (!input.newDeviceMac) return fail('newDeviceMac is required for action=add');
        const qs = buildQuery({
          destoupath: resolvedDestPath,
          destouid: resolvedDestId,
          name: input.newDeviceName,
          mac: input.newDeviceMac,
        });
        const data = await client.request<unknown>('POST', `/api/v1/device${qs}`);
        return ok(await enrich(data));
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
          destoupath: resolvedDestPath,
          destouid: resolvedDestId,
        });
        const data = await client.request<unknown>('PUT', `/api/v1/device/move${qs}`);
        return ok(await enrich(data));
      }
    }
  } catch (err) {
    const baseMsg = `device_manage failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err)) {
      const identifier = input.name ?? input.mac ?? input.id ?? input.clientid;
      const hint = identifier
        ? `\n\nHint: device "${identifier}" was not found. Use device_get mode=search with ouPath and searchTerm to locate devices by partial name.`
        : '';
      return fail(baseMsg + hint);
    }
    return fail(baseMsg);
  }
}

export const deviceManageTool = {
  name: 'device_manage',
  description:
    'Add, rename, delete, or move devices in Scout Board. ' +
    'Use destouRef to specify the destination OU by name, partial name, path, or ID — no need to look up IDs first. ' +
    'DESTRUCTIVE: action=delete permanently removes a device from Scout Board. ' +
    'In SCOUT_ENV=test mode, delete is blocked entirely; add and move are restricted to paths under SCOUT_TEST_OU_PATH.',
  inputSchema: zodToJsonSchema(deviceManageSchema),
  execute: deviceManageExecute,
};
