/**
 * Private Scout Board endpoints for admin and permission management.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

// ── Logging helpers ───────────────────────────────────────────────────────────

function log(tool: string, method: string, path: string, body?: unknown): void {
  const bodyStr = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
  process.stderr.write(`[scout-mcp/${tool}] ${method} ${path}${bodyStr}\n`);
}

function logOk(tool: string): void {
  process.stderr.write(`[scout-mcp/${tool}] response: 2xx\n`);
}

function logErr(tool: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scout-mcp/${tool}] error: ${msg}\n`);
}

// ── admin_manage ──────────────────────────────────────────────────────────────

const adminManageSchema = z.object({
  action: z
    .enum(['list', 'permissions', 'advanced_rights', 'configuration_rights', 'update_rights'])
    .describe(
      'list=list all admins; ' +
        'permissions=list UI permission definitions; ' +
        'advanced_rights=get advanced options rights for the current user; ' +
        'configuration_rights=get rights for a configuration type (requires type, type_id); ' +
        'update_rights=trigger a user rights update (optional force_update flag, defaults to true)',
    ),

  // configuration_rights fields
  type: z
    .string()
    .optional()
    .describe('Configuration type identifier (required for configuration_rights)'),
  type_id: z
    .number()
    .int()
    .optional()
    .describe('Numeric configuration type ID (required for configuration_rights)'),

  // update_rights fields
  force_update: z
    .boolean()
    .optional()
    .describe('Force a rights update regardless of cache state (update_rights, default true)'),
});

type AdminManageInput = z.infer<typeof adminManageSchema>;

async function adminManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = adminManageSchema.parse(raw) as AdminManageInput;
  const client = getClient();
  const tool = 'admin_manage';

  try {
    switch (input.action) {
      case 'list': {
        const path = '/api/v1/admins';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'permissions': {
        const path = '/api/v1/permissions';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'advanced_rights': {
        const path = '/api/v1/advancedOptionsRights';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'configuration_rights': {
        if (!input.type) return fail('configuration_rights requires type');
        if (input.type_id === undefined) return fail('configuration_rights requires type_id');
        const qs = `?type=${encodeURIComponent(input.type)}&typeId=${encodeURIComponent(String(input.type_id))}`;
        const path = `/api/v1/configuration/rights${qs}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'update_rights': {
        const forceUpdate = input.force_update !== undefined ? input.force_update : true;
        const qs = `?forceUpdate=${encodeURIComponent(String(forceUpdate))}`;
        const path = `/api/v1/updateuserrights${qs}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`admin_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const adminManageTool = {
  name: 'admin_manage',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Query Scout Board admin accounts and permission definitions. ' +
    'Actions: list (all admin accounts), permissions (UI permission list), ' +
    'advanced_rights (advanced options rights for the current user), ' +
    'configuration_rights (rights for a given type + type_id), ' +
    'update_rights (trigger user rights refresh, optional force_update flag defaults to true).',
  inputSchema: zodToJsonSchema(adminManageSchema),
  execute: adminManageExecute,
};
