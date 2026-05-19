import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';

const notificationManageSchema = z.object({
  action: z.enum(['set', 'delete']).describe('set=enable notification; delete=cancel notification'),
  target: z.enum(['device', 'devicelist', 'ou', 'ddg']),
  type: z.enum(['configurationupdate', 'delivery', 'updateuefi', 'updatefirmware', 'devicerelocation']).describe(
    'Note: configurationupdate is only supported for target=device, devicelist, and ou (not ddg)',
  ),

  // Device identification (target=device)
  name: z.string().optional(),
  mac: z.string().optional(),
  id: z.string().optional(),
  clientid: z.string().optional(),

  // OU identification (target=ou)
  ouPath: z.string().optional().describe('OU path (target=ou)'),
  ouId: z.number().int().optional().describe('OU ID (target=ou)'),

  // Body for devicelist/ddg targets and delivery notifications
  body: z.record(z.unknown()).optional().describe(
    'Request body: for target=devicelist/ddg contains device list; for delivery type contains delivery options',
  ),
});

type NotificationManageInput = z.infer<typeof notificationManageSchema>;

async function notificationManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = notificationManageSchema.parse(raw) as NotificationManageInput;
  const client = getClient();

  const method = input.action === 'set' ? 'POST' : 'DELETE';
  const path = `/api/v1/notification/${input.target}/${input.type}`;

  let qs = '';
  if (input.target === 'device') {
    qs = buildQuery({ name: input.name, mac: input.mac, id: input.id, clientid: input.clientid });
  } else if (input.target === 'ou') {
    qs = buildQuery({ path: input.ouPath, ouid: input.ouId });
  }

  try {
    const data = await client.request<unknown>(method, `${path}${qs}`, input.body);
    return ok(data);
  } catch (err) {
    return fail(`notification_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const notificationManageTool = {
  name: 'notification_manage',
  description:
    'Set or delete notifications in Scout Board. Notifications trigger events on devices when configuration changes, firmware updates, deliveries, or device relocations occur. ' +
    'Targets: device (query params), devicelist/ddg (body with IDs), ou (query params). ' +
    'Types: configurationupdate, delivery, updateuefi, updatefirmware, devicerelocation.',
  inputSchema: zodToJsonSchema(notificationManageSchema),
  execute: notificationManageExecute,
};
