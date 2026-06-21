import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';

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
        const modeCheck = checkMutationAllowed('app_manage(create)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>(
          'POST',
          `/api/v1/applications/${input.scope}/${input.applicationType}`,
          input.body,
          { mutating: true, opName: 'app_manage(create)' },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'delete': {
        if (!input.scope) return fail('scope is required for action=delete');
        if (input.appId === undefined) return fail('appId is required for action=delete');
        const modeCheck = checkMutationAllowed('app_manage(delete)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, appId: input.appId, message: modeCheck.dryRunNotice });
        const qs = buildQuery({ appId: input.appId, ouPath: input.ouPath, ouId: input.ouId });
        const data = await client.request<unknown>('DELETE', `/api/v1/applications/${input.scope}${qs}`, undefined, {
          mutating: true,
          opName: 'app_manage(delete)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'copy': {
        const modeCheck = checkMutationAllowed('app_manage(copy)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('POST', '/api/v1/applications/copy', input.body, {
          mutating: true,
          opName: 'app_manage(copy)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }

      case 'move': {
        const modeCheck = checkMutationAllowed('app_manage(move)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('POST', '/api/v1/applications/move', input.body, {
          mutating: true,
          opName: 'app_manage(move)',
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
        const modeCheck = checkMutationAllowed('app_manage(set_inheritance)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const qs = buildQuery({ ouPath: input.ouPath, ouId: input.ouId });
        const data = await client.request<unknown>('POST', `/api/v1/applications/inheritance${qs}`, input.body, {
          mutating: true,
          opName: 'app_manage(set_inheritance)',
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

export const appManageTool = {
  name: 'app_manage',
  description:
    'Create, delete, copy, move, or configure inheritance for Scout Board applications. ' +
    'DESTRUCTIVE: action=delete permanently removes an application.',
  inputSchema: zodToJsonSchema(appManageSchema),
  execute: appManageExecute,
};
