import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';

const ruleManageSchema = z.object({
  action: z.enum([
    'list', 'get', 'create', 'update', 'delete',
    'validate',
    'link_label', 'update_label_priority', 'unlink_label',
  ]).describe(
    'list/get/create/update/delete=CRUD on rules; validate=check expression syntax; ' +
    'link_label/update_label_priority/unlink_label=manage label associations',
  ),
  ruleId: z.guid().optional().describe('Rule UUID (required for get/update/delete/link_label/update_label_priority/unlink_label)'),
  labelId: z.guid().optional().describe('Label UUID (required for link_label/update_label_priority/unlink_label)'),
  body: z.record(z.string(), z.unknown()).optional().describe('Request body for create/update/validate/link_label/update_label_priority'),
});

type RuleManageInput = z.infer<typeof ruleManageSchema>;

async function ruleManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = ruleManageSchema.parse(raw) as RuleManageInput;
  const client = getClient();

  try {
    switch (input.action) {
      case 'list': {
        const data = await client.request<unknown>('GET', '/api/v1/rules');
        return ok(data);
      }
      case 'get': {
        if (!input.ruleId) return fail('ruleId is required for action=get');
        const data = await client.request<unknown>('GET', `/api/v1/rules/${input.ruleId}`);
        return ok(data);
      }
      case 'create': {
        const modeCheck = checkMutationAllowed('rule_manage(create)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('POST', '/api/v1/rules', input.body, {
          mutating: true,
          opName: 'rule_manage(create)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'update': {
        if (!input.ruleId) return fail('ruleId is required for action=update');
        const modeCheck = checkMutationAllowed('rule_manage(update)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, ruleId: input.ruleId, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('PUT', `/api/v1/rules/${input.ruleId}`, input.body, {
          mutating: true,
          opName: 'rule_manage(update)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'delete': {
        if (!input.ruleId) return fail('ruleId is required for action=delete');
        const modeCheck = checkMutationAllowed('rule_manage(delete)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, ruleId: input.ruleId, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('DELETE', `/api/v1/rules/${input.ruleId}`, undefined, {
          mutating: true,
          opName: 'rule_manage(delete)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'validate': {
        // validate is a read/check operation — does not mutate rule state.
        const data = await client.request<unknown>('POST', '/api/v1/rules/validate', input.body);
        return ok(data);
      }
      case 'link_label': {
        if (!input.ruleId) return fail('ruleId is required for action=link_label');
        const modeCheck = checkMutationAllowed('rule_manage(link_label)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, ruleId: input.ruleId, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('POST', `/api/v1/rules/${input.ruleId}/labels`, input.body, {
          mutating: true,
          opName: 'rule_manage(link_label)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'update_label_priority': {
        if (!input.ruleId) return fail('ruleId is required for action=update_label_priority');
        if (!input.labelId) return fail('labelId is required for action=update_label_priority');
        const modeCheck = checkMutationAllowed('rule_manage(update_label_priority)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, ruleId: input.ruleId, labelId: input.labelId, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>(
          'PUT',
          `/api/v1/rules/${input.ruleId}/labels/${input.labelId}`,
          input.body,
          { mutating: true, opName: 'rule_manage(update_label_priority)' },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'unlink_label': {
        if (!input.ruleId) return fail('ruleId is required for action=unlink_label');
        if (!input.labelId) return fail('labelId is required for action=unlink_label');
        const modeCheck = checkMutationAllowed('rule_manage(unlink_label)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, ruleId: input.ruleId, labelId: input.labelId, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>(
          'DELETE',
          `/api/v1/rules/${input.ruleId}/labels/${input.labelId}`,
          undefined,
          { mutating: true, opName: 'rule_manage(unlink_label)' },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`rule_manage blocked: ${err.message}`);
    return fail(`rule_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ruleManageTool = {
  name: 'rule_manage',
  description:
    'Manage dynamic configuration rules in Scout Board. Rules use condition expressions to assign labels to devices. ' +
    'Actions: list, get, create, update, delete, validate (expression syntax check), link_label, update_label_priority, unlink_label.',
  inputSchema: toInputSchema(ruleManageSchema),
  execute: ruleManageExecute,
};
