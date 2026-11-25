/**
 * Private Scout Board endpoints for admin and permission management.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult, type ToolContext } from '../types.js';
import { confirmDestructiveAction } from '../elicitation.js';
import {
  checkMutationAllowed,
  checkPrivateWriteAllowedInProduction,
  isDryRunSkip,
  auditLog,
  GuardrailError,
} from '../safety/guardrails.js';
import { gateOuWrite } from '../safety/ou_gate.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';

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

const rightEntrySchema = z.object({
  Id: z.number().int().describe('POLOBJ policy object id (menu right for menu_rights, base right for base_rights)'),
  Value: z
    .union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
    .describe('Access value: 0 or 1 (the server rejects anything else)'),
});

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
        'add_admin=PRIVILEGE-SENSITIVE: register a directory principal as admin via POST /admins/add (requires name; optional full_access, duplicate_from; requires confirm=true); ' +
        'update_admin=PRIVILEGE-SENSITIVE: modify the MAIN entry of an admin via POST /admins/modify (requires admin_id + at least one of root_ou, root_ou_fmd, menu_rights, base_rights; requires confirm=true); ' +
        'delete_admin=DESTRUCTIVE: delete an admin via DELETE /admins?adminName= (requires admin_name, confirm=true)',
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
  name: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Directory principal name to register as admin (add_admin) — becomes body.Name. Admins are directory users/groups; there is no password.'),
  username: z.string().max(256).optional().describe('DEPRECATED alias for name (add_admin).'),
  full_access: z.boolean().optional().describe('add_admin: grant full access (body.fullAccess). Privilege escalation — confirm required.'),
  duplicate_from: z
    .string()
    .max(256)
    .optional()
    .describe('add_admin: copy the rights of this existing admin (body.toBeDuplicatedAdmin)'),
  admin_id: z
    .number()
    .int()
    .optional()
    .describe('Numeric AdministratorID of the MAIN admin entry (update_admin; body.AdministratorID)'),
  admin_name: z.string().min(1).max(256).optional().describe('Admin name to delete (delete_admin; query adminName)'),
  root_ou: z.number().int().optional().describe('update_admin: new RootOu id'),
  root_ou_fmd: z.number().int().optional().describe('update_admin: new RootOUFMD id'),
  menu_rights: z.array(rightEntrySchema).optional().describe('update_admin: menuRightsArray [{Id, Value}]'),
  base_rights: z.array(rightEntrySchema).optional().describe('update_admin: baseRightsArray [{Id, Value}]'),
  confirm: z
    .boolean()
    .optional()
    .describe('Must be true (or confirmed via elicitation) to execute add_admin, update_admin or delete_admin'),

  // Fields of the old (non-functional) tool. Rejected with an explanation instead of silently dropped.
  password: z.string().optional().describe('REJECTED: admins have no password in Scout Board.'),
  display_name: z.string().optional().describe('REJECTED: not a Scout Board admin field.'),
  email: z.string().optional().describe('REJECTED: not a Scout Board admin field.'),
  domain: z.string().optional().describe('REJECTED: use name (principal, e.g. DOMAIN\\user).'),
  permission_ids: z.array(z.number().int()).optional().describe('REJECTED: use menu_rights / base_rights.'),
});

type AdminManageInput = z.infer<typeof adminManageSchema>;

const WRITE_ACTIONS = new Set(['add_admin', 'update_admin', 'delete_admin']);

/** Render rights entries as capped `Id=Value` pairs (first 30, then `+N more`). No secrets are involved. */
export function describeRights(label: string, entries: Array<{ Id: number; Value: number | string }> | undefined): string {
  if (!entries || entries.length === 0) return `${label}: none`;
  const shown = entries.slice(0, 30).map((e) => `${e.Id}=${e.Value}`).join(',');
  const more = entries.length > 30 ? ` +${entries.length - 30} more` : '';
  return `${label}: [${shown}${more}]`;
}

/** Audit one privileged admin write (result of the attempt), in addition to the gate's own entries. */
function auditAdminWrite(
  action: string,
  target: string,
  result: 'allowed' | 'error',
  detail?: string,
): void {
  auditLog({
    opName: `admin_manage(${action})`,
    target,
    operation: action,
    result,
    gate: null,
    ...(detail ? { detail } : {}),
  });
}

async function adminManageExecute(raw: unknown, ctx?: ToolContext): Promise<McpToolResult> {
  const input = adminManageSchema.parse(raw) as AdminManageInput;
  const client = getClient();
  const tool = 'admin_manage';

  if (WRITE_ACTIONS.has(input.action)) {
    const rejected = (
      [
        ['password', input.password],
        ['display_name', input.display_name],
        ['email', input.email],
        ['domain', input.domain],
        ['permission_ids', input.permission_ids],
      ] as const
    )
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (rejected.length > 0) {
      return fail(
        `${input.action}: ${rejected.join(', ')} not supported. Scout Board admins are directory principals ` +
          '(POST /admins/add {Name, fullAccess, toBeDuplicatedAdmin}; POST /admins/modify {AdministratorID, RootOu, ' +
          'RootOUFMD, menuRightsArray, baseRightsArray}; DELETE /admins?adminName=) — there is no password, e-mail or ' +
          'display-name field.',
      );
    }
  }

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
        // Private (/api/v1) GET, route is `authenticated('authorize')` only (SBD-UI routeDeclarations.ts:799-800):
        // it re-reads the CALLER's own rights into the server's per-session cache and writes nothing
        // persistent, so it is deliberately NOT behind the production private-write gate (that gate is for
        // data-changing high-risk endpoints). The mode gate still applies.
        // Triggers a server-side rights refresh — ambiguous side effects, treat as
        // mutating out of caution (per task instructions for this high-risk file).
        const modeCheck = checkMutationAllowed('admin_manage(update_rights)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        }
        const forceUpdate = input.force_update !== undefined ? input.force_update : true;
        const qs = `?forceUpdate=${encodeURIComponent(String(forceUpdate))}`;
        const path = `/api/v1/updateuserrights${qs}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path, undefined, {
          mutating: true,
          opName: 'admin_manage(update_rights)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }

      case 'add_admin': {
        const name = input.name ?? input.username;
        if (!name) return fail('add_admin requires name (the directory principal to register)');
        // Gates BEFORE the prompt: never ask a human to confirm something that will be refused.
        checkPrivateWriteAllowedInProduction('admin_manage(add_admin)');
        const modeCheck = checkMutationAllowed('admin_manage(add_admin)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, name, message: modeCheck.dryRunNotice });
        }
        const addDetail =
          `fullAccess=${input.full_access === true}` +
          `${input.duplicate_from ? `, duplicateFrom="${input.duplicate_from}"` : ''}`;
        const outcome = await confirmDestructiveAction(
          { server: ctx?.server },
          {
            opName: 'admin_manage(add_admin)',
            summary:
              `Register "${name}" as a Scout Board administrator` +
              `${input.full_access ? ' WITH FULL ACCESS' : ''}` +
              `${input.duplicate_from ? ` copying the rights of "${input.duplicate_from}"` : ''} (${addDetail}).`,
            confirmFlag: input.confirm,
          },
        );
        if (!outcome.proceed) return fail(`admin_manage blocked: ${outcome.reason}`);
        const body: Record<string, unknown> = { Name: name };
        if (input.full_access !== undefined) body['fullAccess'] = input.full_access;
        if (input.duplicate_from !== undefined) body['toBeDuplicatedAdmin'] = input.duplicate_from;
        const path = '/api/v1/admins/add';
        log(tool, 'POST', path, body);
        try {
          const data = await client.rawRequest<unknown>('POST', path, body, {
            mutating: true,
            opName: 'admin_manage(add_admin)',
          });
          if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
          auditAdminWrite('add_admin', name, 'allowed', addDetail);
          logOk(tool);
          return ok(data);
        } catch (e) {
          auditAdminWrite('add_admin', name, 'error', `${addDetail}; ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      }

      case 'update_admin': {
        if (input.admin_id === undefined) return fail('update_admin requires admin_id');
        if (
          input.root_ou === undefined &&
          input.root_ou_fmd === undefined &&
          input.menu_rights === undefined &&
          input.base_rights === undefined
        ) {
          return fail('update_admin requires at least one of root_ou, root_ou_fmd, menu_rights, base_rights');
        }
        checkPrivateWriteAllowedInProduction('admin_manage(update_admin)');
        const modeCheck = checkMutationAllowed('admin_manage(update_admin)');
        // root_ou / root_ou_fmd name OUs the administrator is rooted at (an access-control change on
        // that subtree): resolve each from a fresh tree, gate the RESOLVED path, send only the
        // resolved id.
        let rootOu: OuMatch | undefined;
        let rootOuFmd: OuMatch | undefined;
        if (input.root_ou !== undefined) rootOu = await gateOuWrite('admin_manage(update_admin)', [input.root_ou], 'root OU');
        if (input.root_ou_fmd !== undefined) {
          rootOuFmd = await gateOuWrite('admin_manage(update_admin)', [input.root_ou_fmd], 'root OU (follow-me desktop)');
        }
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, adminId: input.admin_id, message: modeCheck.dryRunNotice });
        }
        const updDetail = [
          `RootOu=${input.root_ou ?? 'unchanged'}`,
          `RootOUFMD=${input.root_ou_fmd ?? 'unchanged'}`,
          describeRights('menuRights', input.menu_rights),
          describeRights('baseRights', input.base_rights),
        ].join('; ');
        const outcome = await confirmDestructiveAction(
          { server: ctx?.server },
          {
            opName: 'admin_manage(update_admin)',
            summary: `Modify the main entry of administrator id ${input.admin_id}: ${updDetail}.`,
            confirmFlag: input.confirm,
          },
        );
        if (!outcome.proceed) return fail(`admin_manage blocked: ${outcome.reason}`);
        const body: Record<string, unknown> = { AdministratorID: input.admin_id };
        if (rootOu) body['RootOu'] = rootOu.ouid;
        if (rootOuFmd) body['RootOUFMD'] = rootOuFmd.ouid;
        // Re-assert (after the confirm prompt, right before the write) that the gated OUs keep their paths.
        if (rootOu) await assertOuPathUnchanged(rootOu.ouid, rootOu.path);
        if (rootOuFmd) await assertOuPathUnchanged(rootOuFmd.ouid, rootOuFmd.path);
        if (input.menu_rights !== undefined) body['menuRightsArray'] = input.menu_rights;
        if (input.base_rights !== undefined) body['baseRightsArray'] = input.base_rights;
        const path = '/api/v1/admins/modify';
        log(tool, 'POST', path, body);
        try {
          const data = await client.rawRequest<unknown>('POST', path, body, {
            mutating: true,
            opName: 'admin_manage(update_admin)',
          });
          if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
          auditAdminWrite('update_admin', `adminId=${input.admin_id}`, 'allowed', updDetail);
          logOk(tool);
          return ok(data);
        } catch (e) {
          auditAdminWrite('update_admin', `adminId=${input.admin_id}`, 'error', `${updDetail}; ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      }

      case 'delete_admin': {
        if (!input.admin_name) return fail('delete_admin requires admin_name (the server deletes by name, not id)');
        checkPrivateWriteAllowedInProduction('admin_manage(delete_admin)');
        const modeCheck = checkMutationAllowed('admin_manage(delete_admin)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, adminName: input.admin_name, message: modeCheck.dryRunNotice });
        }
        const delOutcome = await confirmDestructiveAction(
          { server: ctx?.server },
          {
            opName: 'admin_manage(delete_admin)',
            summary: `Permanently delete admin account "${input.admin_name}".`,
            confirmFlag: input.confirm,
          },
        );
        if (!delOutcome.proceed) return fail(`admin_manage blocked: ${delOutcome.reason}`);
        const path = `/api/v1/admins?adminName=${encodeURIComponent(input.admin_name)}`;
        log(tool, 'DELETE', path);
        try {
          const data = await client.rawRequest<unknown>('DELETE', path, undefined, {
            mutating: true,
            opName: 'admin_manage(delete_admin)',
          });
          if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
          auditAdminWrite('delete_admin', input.admin_name, 'allowed', `adminName="${input.admin_name}"`);
          logOk(tool);
          return ok(data);
        } catch (e) {
          auditAdminWrite('delete_admin', input.admin_name, 'error', e instanceof Error ? e.message : String(e));
          throw e;
        }
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) {
      logErr(tool, err);
      return fail(`admin_manage blocked: ${err.message}`);
    }
    logErr(tool, err);
    return fail(`admin_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const adminManageTool = {
  name: 'admin_manage',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board admin accounts and permissions. ' +
    'Read actions: list (GET /admins), permissions, advanced_rights, configuration_rights (type + type_id), ' +
    'update_rights (trigger user rights refresh, optional force_update defaults to true). ' +
    'PRIVILEGE-SENSITIVE write actions (confirm required, blocked in SCOUT_MODE=write unless ' +
    'SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true, audited): ' +
    'add_admin (POST /admins/add; name = directory principal, optional full_access, duplicate_from; no password exists), ' +
    'update_admin (POST /admins/modify; admin_id + root_ou/root_ou_fmd/menu_rights/base_rights; main entry only), ' +
    'delete_admin (DELETE /admins?adminName=; admin_name + confirm=true). ' +
    'Widening ELIAS rights needs a recent interactive sign-in (step-up) that an API token cannot provide; the server will refuse.',
  inputSchema: toInputSchema(adminManageSchema),
  execute: adminManageExecute,
};
