import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

const maintenanceWindowManageSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  maintenanceWindowId: z.string().optional().describe('Maintenance window ID (required for update/delete)'),
  body: z.record(z.unknown()).optional().describe('Maintenance window fields for create/update'),
});

type MaintenanceWindowManageInput = z.infer<typeof maintenanceWindowManageSchema>;

async function maintenanceWindowManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = maintenanceWindowManageSchema.parse(raw) as MaintenanceWindowManageInput;
  const client = getClient();

  try {
    switch (input.action) {
      case 'list': {
        const data = await client.request<unknown>('GET', '/api/v1/maintenanceWindows');
        return ok(data);
      }
      case 'create': {
        const data = await client.request<unknown>('POST', '/api/v1/maintenanceWindows', input.body);
        return ok(data);
      }
      case 'update': {
        if (!input.maintenanceWindowId) return fail('maintenanceWindowId is required for action=update');
        const data = await client.request<unknown>(
          'PUT',
          `/api/v1/maintenanceWindows/${input.maintenanceWindowId}`,
          input.body,
        );
        return ok(data);
      }
      case 'delete': {
        if (!input.maintenanceWindowId) return fail('maintenanceWindowId is required for action=delete');
        const data = await client.request<unknown>(
          'DELETE',
          `/api/v1/maintenanceWindows/${input.maintenanceWindowId}`,
        );
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`maintenance_window_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const maintenanceWindowManageTool = {
  name: 'maintenance_window_manage',
  description:
    'Manage maintenance windows in Scout Board. Maintenance windows define time periods when device updates and commands are allowed. ' +
    'Actions: list, create, update, delete.',
  inputSchema: zodToJsonSchema(maintenanceWindowManageSchema),
  execute: maintenanceWindowManageExecute,
};
