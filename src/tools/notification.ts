import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';
import {
  gateOuWrite, gateOuSubtree, sanitizeOuBody, gateSingleDeviceSource, sourceOuChecksActive,
  gateDeviceListSources, refuseDdgWhenGated, gateRelocationDestination, type DeviceListGate,
} from '../safety/ou_gate.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';

/** Documented request-body keys per POST /notification/devicelist/<type> (openapi.json), besides clientIds (destinationOU is gated separately). DELETE bodies carry clientIds only. */
const DEVICELIST_SET_KEYS: Record<string, readonly string[]> = {
  configurationupdate: [],
  delivery: ['deliverCompleteImage', 'informUser'],
  updateuefi: ['informUser', 'overwriteIdenticalOrHigherVersion'],
  updatefirmware: ['formatBeforeUpdate', 'informUser'],
  devicerelocation: ['checkServerAvailability', 'destinationScoutServer', 'relocateWithLicenses', 'retainLocalConfiguration'],
};

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
    let body = input.body;
    // Relocation (set) while gates are active: destinationOU is required and gated as a write target for
    // device / devicelist / ou (an omitted one would mean the server default OU); only the resolved id is sent.
    let destination: OuMatch | undefined;
    let rawBody = input.body;
    if (input.type === 'devicerelocation' && input.action === 'set' && sourceOuChecksActive() &&
        (input.target === 'device' || input.target === 'devicelist' || input.target === 'ou')) {
      const g = await gateRelocationDestination(opName, input.body);
      destination = g.destination;
      rawBody = g.rest;
    }
    if (input.target === 'ou') {
      const sb = sanitizeOuBody(rawBody, { generic: true });
      ou = await gateOuWrite(opName, [input.ouPath, input.ouId, ...sb.ouRefs], 'target OU', {
        requiredMessage: 'target=ou requires ouPath or ouId; refusing rather than leaving the OU to the server.',
      });
      if (!ou) throw new Error('target OU unresolved');
      if (sb.subOusRequested) await gateOuSubtree(opName, ou);
      body = { ...sb.body, ...(destination ? { destinationOU: destination.ouid } : {}), ...(sb.hasSubOusKey ? { includeSubOus: sb.subOusRequested } : {}) };
      qs = buildQuery({ id: ou.ouid });
    }

    // target=devicelist: all clientIds looked up, every source OU gated (set AND delete); devicerelocation's
    // destinationOU is gated as a write target and replaced by the resolved id. target=ddg is refused while gated.
    // target=device: gate the device's current OU (see device_command).
    if (input.target === 'device' && sourceOuChecksActive()) {
      await gateSingleDeviceSource(client, opName, {
        name: input.name, mac: input.mac, id: input.id, clientid: input.clientid,
      });
    }

    let listGate: DeviceListGate | undefined;
    if (input.target === 'devicelist' && sourceOuChecksActive()) {
      const allowed = input.action === 'set' ? (DEVICELIST_SET_KEYS[input.type] ?? []) : [];
      listGate = await gateDeviceListSources(client, opName, rawBody, allowed);
      body = destination ? { ...listGate.body, destinationOU: destination.ouid } : listGate.body;
    }
    if (input.target === 'device' && destination) body = { ...(rawBody ?? {}), destinationOU: destination.ouid };
    if (input.target === 'ddg') refuseDdgWhenGated(opName);

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
    if (listGate) await listGate.recheck();
    const data = await client.request<unknown>(method, `${path}${qs}`, body, {
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
