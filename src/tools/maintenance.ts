import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';

const maintenanceWindowManageSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  maintenanceWindowId: z.string().optional().describe('Maintenance window ID (required for update/delete)'),
  body: z.record(z.string(), z.unknown()).optional().describe('Maintenance window fields for create/update'),
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
        const modeCheck = checkMutationAllowed('maintenance_window_manage(create)');
        if (!modeCheck.proceed) return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        const data = await client.request<unknown>('POST', '/api/v1/maintenanceWindows', input.body, {
          mutating: true,
          opName: 'maintenance_window_manage(create)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'update': {
        if (!input.maintenanceWindowId) return fail('maintenanceWindowId is required for action=update');
        const modeCheck = checkMutationAllowed('maintenance_window_manage(update)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, maintenanceWindowId: input.maintenanceWindowId, message: modeCheck.dryRunNotice });
        }
        const data = await client.request<unknown>(
          'PUT',
          `/api/v1/maintenanceWindows/${input.maintenanceWindowId}`,
          input.body,
          { mutating: true, opName: 'maintenance_window_manage(update)' },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
      case 'delete': {
        if (!input.maintenanceWindowId) return fail('maintenanceWindowId is required for action=delete');
        const modeCheck = checkMutationAllowed('maintenance_window_manage(delete)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, maintenanceWindowId: input.maintenanceWindowId, message: modeCheck.dryRunNotice });
        }
        const data = await client.request<unknown>(
          'DELETE',
          `/api/v1/maintenanceWindows/${input.maintenanceWindowId}`,
          undefined,
          { mutating: true, opName: 'maintenance_window_manage(delete)' },
        );
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`maintenance_window_manage blocked: ${err.message}`);
    return fail(`maintenance_window_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const maintenanceWindowManageTool = {
  name: 'maintenance_window_manage',
  description:
    'Manage maintenance windows in Scout Board. Maintenance windows define time periods when device updates and commands are allowed. ' +
    'Actions: list, create, update, delete.',
  inputSchema: toInputSchema(maintenanceWindowManageSchema),
  execute: maintenanceWindowManageExecute,
};
