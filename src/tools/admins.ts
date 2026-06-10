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
    .enum([
      'list',
      'permissions',
      'advanced_rights',
      'configuration_rights',
      'update_rights',
      'add_admin',
      'update_admin',
      'delete_admin',
    ])
    .describe(
      'list=list all admins; ' +
        'permissions=list UI permission definitions; ' +
        'advanced_rights=get advanced options rights for the current user; ' +
        'configuration_rights=get rights for a configuration type (requires type, type_id); ' +
        'update_rights=trigger a user rights update (optional force_update flag, defaults to true); ' +
        'add_admin=create a new admin account (requires username, password; optional display_name, email, domain, permission_ids); ' +
        'update_admin=update an existing admin account (requires admin_id; optional username, password, display_name, email, domain, permission_ids); ' +
        'delete_admin=DESTRUCTIVE: permanently delete an admin account (requires admin_id, confirm=true)',
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

  // add_admin / update_admin / delete_admin fields
  admin_id: z.number().int().optional().describe('Admin account numeric ID (update_admin, delete_admin)'),
  username: z.string().optional().describe('Login username (add_admin, update_admin)'),
  password: z.string().optional().describe('Account password (add_admin, update_admin)'),
  display_name: z.string().optional().describe('Display name shown in the UI (add_admin, update_admin)'),
  email: z.string().optional().describe('Email address (add_admin, update_admin)'),
  domain: z.string().optional().describe('Login domain if required (add_admin, update_admin)'),
  permission_ids: z
    .array(z.number().int())
    .optional()
    .describe('List of permission IDs to assign (add_admin, update_admin)'),
  confirm: z
    .boolean()
    .optional()
    .describe('Must be true to execute delete_admin (required safety guard for destructive operation)'),
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

      case 'add_admin': {
        if (!input.username) return fail('add_admin requires username');
        if (!input.password) return fail('add_admin requires password');
        const body: Record<string, unknown> = {
          username: input.username,
          password: input.password,
        };
        if (input.display_name !== undefined) body['displayName'] = input.display_name;
        if (input.email !== undefined) body['email'] = input.email;
        if (input.domain !== undefined) body['domain'] = input.domain;
        if (input.permission_ids !== undefined) body['permissionIds'] = input.permission_ids;
        const path = '/api/v1/admins';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'update_admin': {
        if (input.admin_id === undefined) return fail('update_admin requires admin_id');
        const body: Record<string, unknown> = { id: input.admin_id };
        if (input.username !== undefined) body['username'] = input.username;
        if (input.password !== undefined) body['password'] = input.password;
        if (input.display_name !== undefined) body['displayName'] = input.display_name;
        if (input.email !== undefined) body['email'] = input.email;
        if (input.domain !== undefined) body['domain'] = input.domain;
        if (input.permission_ids !== undefined) body['permissionIds'] = input.permission_ids;
        const path = '/api/v1/admins';
        log(tool, 'PUT', path, body);
        const data = await client.rawRequest<unknown>('PUT', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'delete_admin': {
        if (input.admin_id === undefined) return fail('delete_admin requires admin_id');
        if (!input.confirm) return fail('delete_admin requires confirm=true (destructive operation)');
        const path = `/api/v1/admins?id=${encodeURIComponent(String(input.admin_id))}`;
        log(tool, 'DELETE', path);
        const data = await client.rawRequest<unknown>('DELETE', path);
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
    'Manage Scout Board admin accounts and permissions. ' +
    'Read actions: list (all admin accounts), permissions (UI permission list), ' +
    'advanced_rights (advanced options rights for the current user), ' +
    'configuration_rights (rights for a given type + type_id), ' +
    'update_rights (trigger user rights refresh, optional force_update defaults to true). ' +
    'Write actions: add_admin (create admin — requires username, password; optional display_name, email, domain, permission_ids), ' +
    'update_admin (update admin — requires admin_id; optional fields as above), ' +
    'delete_admin (DESTRUCTIVE: remove admin account — requires admin_id and confirm=true).',
  inputSchema: zodToJsonSchema(adminManageSchema),
  execute: adminManageExecute,
};
