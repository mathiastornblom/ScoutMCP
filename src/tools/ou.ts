import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function assertTestScope(path: string): string | null {
  if (process.env.SCOUT_ENV !== 'test') return null;
  const testRoot = process.env.SCOUT_TEST_OU_PATH;
  if (!testRoot) return 'SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test';
  if (!path.startsWith(testRoot)) {
    return `Target path "${path}" is outside SCOUT_TEST_OU_PATH "${testRoot}". Blocked in test mode.`;
  }
  return null;
}

// ── ou_get ────────────────────────────────────────────────────────────────────

const ouGetSchema = z.object({
  mode: z.enum(['get', 'root', 'search', 'subordinate', 'structure', 'device_status']).describe(
    'get=single OU by path/id; root=root OU; search=search OUs by term; subordinate=direct children; structure=full tree; device_status=device statuses in OU',
  ),
  // get / subordinate / structure
  path: z.string().optional().describe('OU path (e.g. /Enterprise/SubOU)'),
  id: z.number().int().optional().describe('OU numeric ID'),
  properties: z.string().optional().describe('Comma-separated list of extra properties to return'),
  // search
  searchTerm: z.string().optional().describe('Search term (required for mode=search)'),
  searchFields: z.string().optional().describe('Comma-separated fields to search in'),
  // structure
  onlyFirstLevel: z.boolean().optional().describe('Return only first level of structure tree'),
  // device_status
  ouPath: z.string().optional().describe('OU path for device_status mode'),
  ouId: z.string().optional().describe('OU ID for device_status mode'),
  includeSubOus: z.boolean().optional().describe('Include sub-OUs in device_status results'),
});

type OuGetInput = z.infer<typeof ouGetSchema>;

async function ouGetExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouGetSchema.parse(raw) as OuGetInput;
  const client = getClient();

  try {
    switch (input.mode) {
      case 'root': {
        const data = await client.request<unknown>('GET', '/api/v1/ou/root');
        return ok(data);
      }

      case 'get': {
        const qs = buildQuery({ path: input.path, id: input.id, properties: input.properties });
        const data = await client.request<unknown>('GET', `/api/v1/ou${qs}`);
        return ok(data);
      }

      case 'search': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search');
        const qs = buildQuery({
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          properties: input.properties,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/search${qs}`);
        return ok(data);
      }

      case 'subordinate': {
        const qs = buildQuery({ path: input.path, id: input.id, properties: input.properties });
        const data = await client.request<unknown>('GET', `/api/v1/ou/subordinate${qs}`);
        return ok(data);
      }

      case 'structure': {
        const qs = buildQuery({
          path: input.path,
          id: input.id,
          onlyFirstLevel: input.onlyFirstLevel,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/structure${qs}`);
        return ok(data);
      }

      case 'device_status': {
        const qs = buildQuery({
          ouPath: input.ouPath ?? input.path,
          ouId: input.ouId ?? (input.id !== undefined ? String(input.id) : undefined),
          includeSubOus: input.includeSubOus,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/device/status${qs}`);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`ou_get failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ouGetTool = {
  name: 'ou_get',
  description:
    'Read OU information from Scout Board. Modes: get (single OU by path or id), root (root OU), search (find OUs by term), subordinate (direct children of an OU), structure (full tree view), device_status (status of devices in an OU).',
  inputSchema: zodToJsonSchema(ouGetSchema),
  execute: ouGetExecute,
};

// ── ou_manage ─────────────────────────────────────────────────────────────────

const ouManageSchema = z.object({
  action: z
    .enum(['add', 'rename', 'delete', 'move', 'converttobase', 'structure_export', 'structure_import'])
    .describe('Operation to perform'),

  // Target OU identification (add uses destoupath/destouid instead)
  path: z.string().optional().describe('Target OU path'),
  id: z.number().int().optional().describe('Target OU numeric ID'),

  // add
  destoupath: z.string().optional().describe('Destination OU path (add/move)'),
  destouid: z.number().int().optional().describe('Destination OU ID (add/move)'),
  name: z.string().optional().describe('New OU name (add) or current name for rename target'),

  // rename
  newname: z.string().optional().describe('New name for rename action'),

  // delete
  forceDeleteOUFilter: z.boolean().optional().describe('Delete affected OU filters when deleting OU'),

  // structure_export body fields
  ouId: z.number().int().optional().describe('OU ID to export (structure_export)'),
  exportOuStructure: z.boolean().optional(),
  exportDeviceConfig: z.boolean().optional(),
  exportAdvancedConfig: z.boolean().optional(),
  exportDevices: z.boolean().optional(),

  // structure_import body fields
  importPayload: z.record(z.unknown()).optional().describe('Export payload to import (structure_import)'),
  dryRun: z.boolean().optional().describe('Preview import without applying changes'),
});

type OuManageInput = z.infer<typeof ouManageSchema>;

async function ouManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouManageSchema.parse(raw) as OuManageInput;
  const client = getClient();

  // Destructive guard: delete and move can remove or rearrange OUs in test mode
  if (input.action === 'delete' && input.path) {
    const err = assertTestScope(input.path);
    if (err) return fail(err);
  }

  try {
    switch (input.action) {
      case 'add': {
        if (!input.name) return fail('name is required for action=add');
        const qs = buildQuery({ destoupath: input.destoupath, destouid: input.destouid, name: input.name });
        const data = await client.request<unknown>('POST', `/api/v1/ou${qs}`);
        return ok(data);
      }

      case 'rename': {
        if (!input.newname) return fail('newname is required for action=rename');
        const qs = buildQuery({ path: input.path, id: input.id, newname: input.newname });
        const data = await client.request<unknown>('PUT', `/api/v1/ou${qs}`);
        return ok(data);
      }

      case 'delete': {
        const qs = buildQuery({
          path: input.path,
          id: input.id,
          forceDeleteOUFilter: input.forceDeleteOUFilter,
        });
        const data = await client.request<unknown>('DELETE', `/api/v1/ou${qs}`);
        return ok(data);
      }

      case 'move': {
        const qs = buildQuery({
          path: input.path,
          id: input.id,
          destoupath: input.destoupath,
          destouid: input.destouid,
        });
        const data = await client.request<unknown>('PUT', `/api/v1/ou/move${qs}`);
        return ok(data);
      }

      case 'converttobase': {
        const qs = buildQuery({ path: input.path, id: input.id });
        const data = await client.request<unknown>('PUT', `/api/v1/ou/converttobase${qs}`);
        return ok(data);
      }

      case 'structure_export': {
        if (!input.ouId) return fail('ouId is required for action=structure_export');
        const body = {
          ouId: input.ouId,
          exportOuStructure: input.exportOuStructure,
          exportDeviceConfig: input.exportDeviceConfig,
          exportAdvancedConfig: input.exportAdvancedConfig,
          exportDevices: input.exportDevices,
        };
        const data = await client.request<unknown>('POST', '/api/v1/ou/structure/export', body);
        return ok(data);
      }

      case 'structure_import': {
        if (!input.importPayload) return fail('importPayload is required for action=structure_import');
        const body = { ...input.importPayload, dryRun: input.dryRun };
        const data = await client.request<unknown>('POST', '/api/v1/ou/structure/import', body);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`ou_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ouManageTool = {
  name: 'ou_manage',
  description:
    'Create, rename, delete, or move OUs in Scout Board, and export/import OU structures. ' +
    'DESTRUCTIVE: action=delete permanently removes an OU and all its contents. ' +
    'In SCOUT_ENV=test mode, delete operations are restricted to paths under SCOUT_TEST_OU_PATH.',
  inputSchema: zodToJsonSchema(ouManageSchema),
  execute: ouManageExecute,
};
