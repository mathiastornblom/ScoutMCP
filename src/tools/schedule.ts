import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

const scheduleManageSchema = z.object({
  action: z.enum(['get_ou', 'get_device', 'update', 'delete']).describe(
    'get_ou=schedules for an OU; get_device=schedules for a device; update=modify schedule; delete=remove schedule',
  ),
  // OU identification (get_ou)
  ouPath: z.string().optional().describe('OU path (action=get_ou)'),
  ouId: z.number().int().optional().describe('OU ID (action=get_ou)'),
  includeSubOus: z.boolean().optional().describe('Include sub-OU schedules (action=get_ou)'),
  // Device identification (get_device)
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional(),
  // Schedule operations (update/delete)
  scheduleId: z.number().int().optional().describe('Schedule job ID (required for update/delete)'),
  body: z.record(z.unknown()).optional().describe('Schedule update payload (action=update)'),
});

type ScheduleManageInput = z.infer<typeof scheduleManageSchema>;

async function scheduleManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = scheduleManageSchema.parse(raw) as ScheduleManageInput;
  const client = getClient();

  try {
    switch (input.action) {
      case 'get_ou': {
        const qs = buildQuery({ path: input.ouPath, ouid: input.ouId, includeSubOus: input.includeSubOus });
        const data = await client.request<unknown>('GET', `/api/v1/schedule/ou${qs}`);
        return ok(data);
      }
      case 'get_device': {
        const qs = buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid });
        const data = await client.request<unknown>('GET', `/api/v1/schedule/device${qs}`);
        return ok(data);
      }
      case 'update': {
        if (input.scheduleId === undefined) return fail('scheduleId is required for action=update');
        const qs = buildQuery({ scheduleId: input.scheduleId });
        const data = await client.request<unknown>('POST', `/api/v1/schedule/update${qs}`, input.body);
        return ok(data);
      }
      case 'delete': {
        if (input.scheduleId === undefined) return fail('scheduleId is required for action=delete');
        const qs = buildQuery({ scheduleId: input.scheduleId });
        const data = await client.request<unknown>('DELETE', `/api/v1/schedule/delete${qs}`);
        return ok(data);
      }
    }
  } catch (err) {
    return fail(`schedule_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const scheduleManageTool = {
  name: 'schedule_manage',
  description:
    'View and manage scheduled commands in Scout Board. ' +
    'Actions: get_ou (schedules for an OU), get_device (schedules for a device), update (modify schedule), delete (cancel schedule).',
  inputSchema: zodToJsonSchema(scheduleManageSchema),
  execute: scheduleManageExecute,
};
