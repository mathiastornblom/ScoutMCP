import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

const labelManageSchema = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'delete']),
  labelId: z.string().uuid().optional().describe('Label UUID (required for get/update/delete)'),
  body: z.record(z.unknown()).optional().describe('Label fields for create/update'),
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
        const data = await client.request<unknown>('POST', '/api/v1/labels', input.body);
        return ok(data);
      }
      case 'update': {
        if (!input.labelId) return fail('labelId is required for action=update');
        const data = await client.request<unknown>('PUT', `/api/v1/labels/${input.labelId}`, input.body);
        return ok(data);
      }
      case 'delete': {
        if (!input.labelId) return fail('labelId is required for action=delete');
        const data = await client.request<unknown>('DELETE', `/api/v1/labels/${input.labelId}`);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`label_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const labelManageTool = {
  name: 'label_manage',
  description:
    'Manage dynamic configuration labels in Scout Board. ' +
    'Actions: list, get, create, update, delete. Labels are used with Rules to drive dynamic device configuration.',
  inputSchema: zodToJsonSchema(labelManageSchema),
  execute: labelManageExecute,
};
