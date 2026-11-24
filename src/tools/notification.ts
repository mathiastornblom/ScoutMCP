import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';
import { gateOuWrite, gateOuSubtree } from '../safety/ou_gate.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';

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
  }

  try {
    // Both set and delete mutate notification state for the target — gate both.
    const opName = `notification_manage(${input.action})`;
    const modeCheck = checkMutationAllowed(opName);

    // target=ou: the OU is the write scope. Resolve ouPath/ouId from a fresh tree (they must
    // agree), gate the RESOLVED path (and every sub-OU when body.includeSubOus is true), and send
    // ONLY the resolved id. devicelist/ddg/device targets cannot be tied to an OU from the input.
    let ou: OuMatch | undefined;
    if (input.target === 'ou') {
      ou = await gateOuWrite(opName, [input.ouPath, input.ouId], 'target OU', {
        requiredMessage: 'target=ou requires ouPath or ouId; refusing rather than leaving the OU to the server.',
      });
      if (!ou) throw new Error('target OU unresolved');
      if (input.body?.['includeSubOus'] === true) await gateOuSubtree(opName, ou);
      qs = buildQuery({ id: ou.ouid });
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        action: input.action,
        target: input.target,
        type: input.type,
        message: modeCheck.dryRunNotice,
      });
    }
    if (ou) await assertOuPathUnchanged(ou.ouid, ou.path);
    const data = await client.request<unknown>(method, `${path}${qs}`, input.body, {
      mutating: true,
      opName,
    });
    if (isDryRunSkip(data)) {
      return ok({ status: 'dry_run', action: input.action, message: data.notice });
    }
    return ok(data);
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`notification_manage blocked: ${err.message}`);
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
