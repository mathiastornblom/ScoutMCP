import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';

const labelManageSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete']),
  labelId: z.guid().optional().describe('Label UUID (required for get/update/delete)'),
  body: z.record(z.string(), z.unknown()).optional().describe('Label fields for create/update'),
});

type LabelManageInput = z.infer<typeof labelManageSchema>;

async function labelManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = labelManageSchema.parse(raw) as LabelManageInput;
  const client = getClient();

  try {
    switch (input.action) {
      case 'list': {
        const data = await client.request<unknown>('GET', '/api/v1/labels');
        return ok(data);
      }
      case 'get': {
        if (!input.labelId) return fail('labelId is required for action=get');
        const data = await client.request<unknown>('GET', `/api/v1/labels/${input.labelId}`);
        return ok(data);
      }
      case 'create': {
        const modeCheck = checkMutationAllowed('label_manage(create)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        }
        const data = await client.request<unknown>('POST', '/api/v1/labels', input.body, {
          mutating: true,
          opName: 'label_manage(create)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'update': {
        if (!input.labelId) return fail('labelId is required for action=update');
        const modeCheck = checkMutationAllowed('label_manage(update)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, labelId: input.labelId, message: modeCheck.dryRunNotice });
        }
        const data = await client.request<unknown>('PUT', `/api/v1/labels/${input.labelId}`, input.body, {
          mutating: true,
          opName: 'label_manage(update)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'delete': {
        if (!input.labelId) return fail('labelId is required for action=delete');
        const modeCheck = checkMutationAllowed('label_manage(delete)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, labelId: input.labelId, message: modeCheck.dryRunNotice });
        }
        const data = await client.request<unknown>('DELETE', `/api/v1/labels/${input.labelId}`, undefined, {
          mutating: true,
          opName: 'label_manage(delete)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`label_manage blocked: ${err.message}`);
    return fail(`label_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const labelManageTool = {
  name: 'label_manage',
  description:
    'Manage dynamic configuration labels in Scout Board. ' +
    'Actions: list, get, create, update, delete. Labels are used with Rules to drive dynamic device configuration.',
  inputSchema: toInputSchema(labelManageSchema),
  execute: labelManageExecute,
};
