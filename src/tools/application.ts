import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';
import { gateOuWrite } from '../safety/ou_gate.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';

// ── app_list ──────────────────────────────────────────────────────────────────

const appListSchema = z.object({
  scope: z.enum(['base', 'ou']).describe('base=global applications; ou=OU-scoped applications'),
  ouPath: z.string().optional().describe('OU path (required when scope=ou)'),
  ouId: z.number().int().optional().describe('OU ID (alternative to ouPath when scope=ou)'),
});

type AppListInput = z.infer<typeof appListSchema>;

async function appListExecute(raw: unknown): Promise<McpToolResult> {
  const input = appListSchema.parse(raw) as AppListInput;
  const client = getClient();

  try {
    if (input.scope === 'base') {
      const data = await client.request<unknown>('GET', '/api/v1/applications/base');
      return ok(data);
    }
    if (!input.ouPath && input.ouId === undefined) {
      return fail('ouPath or ouId is required when scope=ou');
    }
    const qs = buildQuery({ ouPath: input.ouPath, ouId: input.ouId });
    const data = await client.request<unknown>('GET', `/api/v1/applications/ou${qs}`);
    return ok(data);
  } catch (err) {
    return fail(`app_list failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const appListTool = {
  name: 'app_list',
  description: 'List applications from Scout Board. scope=base for global apps, scope=ou for OU-scoped apps (requires ouPath or ouId).',
  inputSchema: zodToJsonSchema(appListSchema),
  execute: appListExecute,
};

// ── app_manage ────────────────────────────────────────────────────────────────

const appManageSchema = z.object({
  action: z.enum(['create', 'delete', 'copy', 'move', 'get_inheritance', 'set_inheritance']).describe(
    'create=add new app; delete=remove app; copy/move=between base and OU; get/set inheritance=app inheritance settings',
  ),
  scope: z.enum(['base', 'ou']).optional().describe('Target scope for create/delete'),
  applicationType: z.string().optional().describe('Application type (e.g. citrix, rdp) — required for action=create'),
  appId: z.number().int().optional().describe('Application ID (required for delete)'),
  ouPath: z.string().optional().describe('OU path for ou-scoped actions'),
  ouId: z.number().int().optional().describe('OU ID for ou-scoped actions'),
  body: z.record(z.unknown()).optional().describe('Request body for create/copy/move/set_inheritance'),
});

type AppManageInput = z.infer<typeof appManageSchema>;

async function appManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = appManageSchema.parse(raw) as AppManageInput;
  const client = getClient();

  try {
    switch (input.action) {
      case 'create': {
        if (!input.scope) return fail('scope is required for action=create');
        if (!input.applicationType) return fail('applicationType is required for action=create');
        const opName = 'app_manage(create)';
        const modeCheck = checkMutationAllowed(opName);
        // scope=ou writes into one OU: resolve/gate it and send only its id. scope=base is global
        // (not OU-scoped) and sends no OU at all.
        const ou = input.scope === 'ou' ? await gateApplicationOu(opName, input, 'target OU') : undefined;
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        if (ou) await assertOuPathUnchanged(ou.ouid, ou.path);
        const qs = ou ? buildQuery({ id: ou.ouid }) : '';
        const data = await client.request<unknown>(
          'POST',
          `/api/v1/applications/${input.scope}/${input.applicationType}${qs}`,
          input.body,
          { mutating: true, opName },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'delete': {
        if (!input.scope) return fail('scope is required for action=delete');
        if (input.appId === undefined) return fail('appId is required for action=delete');
        const opName = 'app_manage(delete)';
        const modeCheck = checkMutationAllowed(opName);
        const ou = input.scope === 'ou' ? await gateApplicationOu(opName, input, 'target OU') : undefined;
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, appId: input.appId, message: modeCheck.dryRunNotice });
        if (ou) await assertOuPathUnchanged(ou.ouid, ou.path);
        const qs = buildQuery({ appId: input.appId, id: ou?.ouid });
        const data = await client.request<unknown>('DELETE', `/api/v1/applications/${input.scope}${qs}`, undefined, {
          mutating: true,
          opName,
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'copy':
      case 'move': {
        const opName = `app_manage(${input.action})`;
        if (input.appId === undefined) return fail(`appId is required for action=${input.action}`);
        // The request body is validated down to {targetOu}; it is never forwarded verbatim.
        const targetOuRaw = input.body?.['targetOu'];
        if (typeof targetOuRaw !== 'number' || !Number.isInteger(targetOuRaw)) {
          return fail(`body.targetOu (integer OU id) is required for action=${input.action}`);
        }
        const modeCheck = checkMutationAllowed(opName);
        // Source OU: a move removes the app from it, so it is gated like a write; a copy only reads it.
        const src = await gateApplicationOu(opName, input, 'source OU', input.action === 'copy');
        const dst = await gateOuWrite(opName, [targetOuRaw], 'target OU');
        if (!dst) throw new Error('target OU unresolved');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        await assertOuPathUnchanged(src.ouid, src.path);
        await assertOuPathUnchanged(dst.ouid, dst.path);
        const qs = buildQuery({ appId: input.appId, ouId: src.ouid });
        const data = await client.request<unknown>('POST', `/api/v1/applications/${input.action}${qs}`, { targetOu: dst.ouid }, {
          mutating: true,
          opName,
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'get_inheritance': {
        const qs = buildQuery({ ouPath: input.ouPath, ouId: input.ouId });
        const data = await client.request<unknown>('GET', `/api/v1/applications/inheritance${qs}`);
        return ok(data);
      }

      case 'set_inheritance': {
        const opName = 'app_manage(set_inheritance)';
        const useParent = input.body?.['useParentApps'];
        if (typeof useParent !== 'boolean') return fail('body.useParentApps (boolean) is required for action=set_inheritance');
        const modeCheck = checkMutationAllowed(opName);
        const ou = await gateApplicationOu(opName, input, 'target OU');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        await assertOuPathUnchanged(ou.ouid, ou.path);
        const qs = buildQuery({ id: ou.ouid });
        const data = await client.request<unknown>('POST', `/api/v1/applications/inheritance${qs}`, { useParentApps: useParent }, {
          mutating: true,
          opName,
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`app_manage blocked: ${err.message}`);
    return fail(`app_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Resolves/gates the OU named by ouPath/ouId (must agree); refuses (audited) when neither is given. */
async function gateApplicationOu(opName: string, input: AppManageInput, label: string, resolveOnly = false): Promise<OuMatch> {
  const ou = await gateOuWrite(opName, [input.ouPath, input.ouId], label, {
    skipProtectedCheck: resolveOnly,
    requiredMessage: `ouPath or ouId is required (${label}); refusing rather than leaving the OU to the server.`,
  });
  if (!ou) throw new Error(`${label} unresolved`);
  return ou;
}

export const appManageTool = {
  name: 'app_manage',
  description:
    'Create, delete, copy, move, or configure inheritance for Scout Board applications. ' +
    'DESTRUCTIVE: action=delete permanently removes an application. ' +
    'OU-scoped writes (scope=ou, copy/move, set_inheritance) resolve the OU from the live tree and are checked against SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS; only the resolved OU id is sent.',
  inputSchema: zodToJsonSchema(appManageSchema),
  execute: appManageExecute,
};
