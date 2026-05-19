import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

const ruleManageSchema = z.object({
  action: z.enum([
    'list', 'get', 'create', 'update', 'delete',
    'validate',
    'link_label', 'update_label_priority', 'unlink_label',
  ]).describe(
    'list/get/create/update/delete=CRUD on rules; validate=check expression syntax; ' +
    'link_label/update_label_priority/unlink_label=manage label associations',
  ),
  ruleId: z.string().uuid().optional().describe('Rule UUID (required for get/update/delete/link_label/update_label_priority/unlink_label)'),
  labelId: z.string().uuid().optional().describe('Label UUID (required for link_label/update_label_priority/unlink_label)'),
  body: z.record(z.unknown()).optional().describe('Request body for create/update/validate/link_label/update_label_priority'),
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
        const data = await client.request<unknown>('POST', '/api/v1/rules', input.body);
        return ok(data);
      }
      case 'update': {
        if (!input.ruleId) return fail('ruleId is required for action=update');
        const data = await client.request<unknown>('PUT', `/api/v1/rules/${input.ruleId}`, input.body);
        return ok(data);
      }
      case 'delete': {
        if (!input.ruleId) return fail('ruleId is required for action=delete');
        const data = await client.request<unknown>('DELETE', `/api/v1/rules/${input.ruleId}`);
        return ok(data);
      }
      case 'validate': {
        const data = await client.request<unknown>('POST', '/api/v1/rules/validate', input.body);
        return ok(data);
      }
      case 'link_label': {
        if (!input.ruleId) return fail('ruleId is required for action=link_label');
        const data = await client.request<unknown>('POST', `/api/v1/rules/${input.ruleId}/labels`, input.body);
        return ok(data);
      }
      case 'update_label_priority': {
        if (!input.ruleId) return fail('ruleId is required for action=update_label_priority');
        if (!input.labelId) return fail('labelId is required for action=update_label_priority');
        const data = await client.request<unknown>(
          'PUT',
          `/api/v1/rules/${input.ruleId}/labels/${input.labelId}`,
          input.body,
        );
        return ok(data);
      }
      case 'unlink_label': {
        if (!input.ruleId) return fail('ruleId is required for action=unlink_label');
        if (!input.labelId) return fail('labelId is required for action=unlink_label');
        const data = await client.request<unknown>(
          'DELETE',
          `/api/v1/rules/${input.ruleId}/labels/${input.labelId}`,
        );
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`rule_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ruleManageTool = {
  name: 'rule_manage',
  description:
    'Manage dynamic configuration rules in Scout Board. Rules use condition expressions to assign labels to devices. ' +
    'Actions: list, get, create, update, delete, validate (expression syntax check), link_label, update_label_priority, unlink_label.',
  inputSchema: zodToJsonSchema(ruleManageSchema),
  execute: ruleManageExecute,
};
