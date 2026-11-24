import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef, invalidateOuCache, resolveOuForWriteGate, assertOuPathUnchanged, type OuMatch } from '../resolver.js';
import { gateOuWrite } from '../safety/ou_gate.js';
import { enrich } from '../enricher.js';
import { isNotFound } from '../fuzzy.js';
import { getWorkingOu } from '../context.js';
import { checkMutationAllowed, checkOuWriteAllowed, isDryRunSkip, auditLog, GuardrailError } from '../safety/guardrails.js';
import { assessDeviceWriteResult } from '../device_result.js';
import { extractSearchDevices } from '../devices.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the OU path a device currently sits in, by fetching the single-device record and
 * resolving its OU id against a FRESH OU tree. Used by action=move to identify the *source* OU
 * before issuing the move: moving a device OUT of a protected OU changes what config it inherits
 * just as much as moving one in, so the protected-OU gate must see both sides.
 *
 * FAILS CLOSED: every failure (request error, device not found, record without a numeric
 * OUID, OU id not in the tree, tree unparseable) throws a GuardrailError - the move is refused.
 * There is no "undefined" return and no swallowing catch: an unknown source OU is not "unprotected".
 * Only the OUID field is accepted; GroupID (seen on /api/v1/devices rows) is NOT assumed to be
 * the OU id without live proof, so if the single-device record lacks OUID the move is refused.
 */
async function resolveCurrentDeviceOuPath(
  client: ReturnType<typeof getClient>,
  identifiers: { name?: string; mac?: string; id?: string; clientid?: string },
): Promise<string> {
  const refuse = (detail: string): never => {
    auditLog({
      opName: 'device_manage(move)',
      target: identifiers.name ?? identifiers.mac ?? identifiers.id ?? identifiers.clientid ?? 'unknown',
      result: 'refused',
      gate: 'unresolvable-source-ou',
      detail,
    });
    throw new GuardrailError(
      `Could not determine the source OU of the device (${detail}). Refusing to move: the protected-OU ` +
        'check cannot run against an unknown source OU.',
      'unresolvable-source-ou',
    );
  };
  let data: Record<string, unknown> | undefined;
  try {
    const qs = buildQuery({
      name: identifiers.name,
      mac: identifiers.mac,
      id: identifiers.id,
      clientid: identifiers.clientid,
    });
    data = await client.request<Record<string, unknown>>('GET', `/api/v1/device${qs}`);
  } catch (err) {
    return refuse(`device lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ouId = data?.['OUID'];
  if (typeof ouId !== 'number' || !Number.isInteger(ouId)) {
    return refuse('device record has no numeric OUID field');
  }
  try {
    return (await resolveOuForWriteGate(ouId)).path;
  } catch (err) {
    return refuse(`OU ${ouId} could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── device_get ────────────────────────────────────────────────────────────────

const deviceGetSchema = z.object({
  mode: z.enum(['get', 'search', 'search_with_config', 'status', 'configOrigins']).describe(
    'get=single device by identifier; search=devices in OU; ' +
    'search_with_config=search + fetch a config section for each result in one call (eliminates N+1 round-trips); ' +
    'status=device runtime status; configOrigins=config inheritance origins',
  ),

  // Single device identification (get / status / configOrigins)
  name: z.string().optional().describe('Device name'),
  mac: z.string().optional().describe('Device MAC address'),
  id: z.string().optional().describe('Device numeric ID'),
  clientid: z.string().optional().describe('Client identifier (UUID)'),
  properties: z.string().optional().describe('Comma-separated extra properties to return (mode=get only)'),

  // search / search_with_config — OU can be identified by name/ref, explicit path, explicit id, or working OU context
  ouRef: z.string().optional().describe(
    'OU to search in — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over ouPath/ouId for natural-language requests.',
  ),
  ouPath: z.string().optional().describe(
    'OU path to search in; defaults to working OU if not provided (set via scout_context)',
  ),
  ouId: z.string().optional().describe('OU ID to search in — use ouRef for name-based lookup'),
  searchTerm: z.string().optional().describe('Search term (required for mode=search and search_with_config)'),
  searchFields: z.string().optional().describe('Comma-separated device fields to evaluate during search'),
  includeSubOus: z.boolean().optional().describe('Include devices from sub-OUs in search'),
  limit: z.number().int().min(1).max(10000).optional().describe('Max results for search (default 100, max 10000)'),

  // search_with_config only
  configSection: z.string().optional().describe(
    'Config section to fetch for each device (required for mode=search_with_config). ' +
    'E.g. firmware, network/lan, general, desktop/language',
  ),
});

type DeviceGetInput = z.infer<typeof deviceGetSchema>;

async function deviceGetExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceGetSchema.parse(raw) as DeviceGetInput;
  const client = getClient();

  try {
    switch (input.mode) {
      case 'get': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          properties: input.properties,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device${qs}`);
        return ok(await enrich(data));
      }

      case 'search': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search');

        // Resolve OU: ouRef → id lookup; ouPath → explicit; working OU → fallback
        let searchOuPath = input.ouPath ?? getWorkingOu()?.path;
        let searchOuId = input.ouId;

        if (input.ouRef !== undefined) {
          const match = await resolveOuRef(input.ouRef);
          searchOuId = String(match.ouid);
          searchOuPath = undefined; // prefer ID over path
        }

        if (!searchOuPath && !searchOuId) {
          return fail(
            'ouPath, ouId, or ouRef is required for mode=search. ' +
            'Set a working OU with scout_context action=set_ou to use it as default.',
          );
        }

        // Note: `properties` is intentionally excluded — the search endpoint
        // ignores it and returns empty objects when it is present.
        const qs = buildQuery({
          ouPath: searchOuPath,
          ouId: searchOuId,
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          includeSubOus: input.includeSubOus,
          limit: input.limit,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
        return ok(await enrich(data));
      }

      case 'search_with_config': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search_with_config');
        if (!input.configSection) return fail('configSection is required for mode=search_with_config');

        let searchOuPath = input.ouPath ?? getWorkingOu()?.path;
        let searchOuId = input.ouId;

        if (input.ouRef !== undefined) {
          const match = await resolveOuRef(input.ouRef);
          searchOuId = String(match.ouid);
          searchOuPath = undefined;
        }

        if (!searchOuPath && !searchOuId) {
          return fail(
            'ouPath, ouId, or ouRef is required for mode=search_with_config. ' +
            'Set a working OU with scout_context action=set_ou to use it as default.',
          );
        }

        const searchQs = buildQuery({
          ouPath: searchOuPath,
          ouId: searchOuId,
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          includeSubOus: input.includeSubOus,
          limit: input.limit,
        });
        const searchData = await client.request<unknown>('GET', `/api/v1/device/search${searchQs}`);
        const devices = extractSearchDevices(searchData);

        if (devices.length === 0) {
          return ok({ count: 0, section: input.configSection, devices: [] });
        }

        // Fan out config fetches in parallel — one request per device
        const section = input.configSection;
        const results = await Promise.all(
          devices.map(async (device) => {
            const devId = (device['DeviceID'] ?? device['id']) as string | number | undefined;
            const enrichedDevice = await enrich(device);
            if (devId === undefined) {
              return { device: enrichedDevice, config: null, configError: 'no DeviceID in search result' };
            }
            try {
              const config = await client.request<unknown>(
                'GET',
                `/api/v1/configuration/device/${section}${buildQuery({ id: String(devId) })}`,
              );
              return { device: enrichedDevice, config };
            } catch (err) {
              return {
                device: enrichedDevice,
                config: null,
                configError: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );

        return ok({ count: results.length, section, devices: results });
      }

      case 'status': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/status${qs}`);
        return ok(await enrich(data));
      }

      case 'configOrigins': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        const data = await client.request<unknown>('GET', `/api/v1/device/configOrigins${qs}`);
        return ok(await enrich(data));
      }
    }
  } catch (err) {
    const baseMsg = `device_get failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err) && (input.mode === 'get' || input.mode === 'status' || input.mode === 'configOrigins')) {
      const identifier = input.name ?? input.mac ?? input.id ?? input.clientid;
      const hint = identifier
        ? `\n\nHint: device "${identifier}" was not found. Use device_get mode=search with ouPath and searchTerm to locate devices by partial name.`
        : '';
      return fail(baseMsg + hint);
    }
    return fail(baseMsg);
  }
}

export const deviceGetTool = {
  name: 'device_get',
  description:
    'Read device information from Scout Board. Modes: get (single device by name/mac/id/clientid), ' +
    'search (list devices in an OU by search term), ' +
    'search_with_config (search + fetch a config section for every matched device in one call — use this instead of search + N×config_get), ' +
    'status (runtime status and activation state), configOrigins (configuration inheritance origins). ' +
    'For search modes, use ouRef to identify the OU by name instead of needing the exact path or ID.',
  inputSchema: zodToJsonSchema(deviceGetSchema),
  execute: deviceGetExecute,
};

/**
 * Compare what a device delete/move was asked to do with what the server reports and surface any
 * gap in BOTH the tool result and the audit log. Only annotates when something is off, so the
 * normal success payload is unchanged.
 */
function withWriteVerification(
  action: 'delete' | 'move',
  target: string | undefined,
  requestedIds: string[],
  data: unknown,
  enriched: unknown,
): unknown {
  const a = assessDeviceWriteResult(data, requestedIds);
  if (a.confirmed && a.droppedIds.length === 0) return enriched;
  auditLog({
    opName: `device_manage(${action})`,
    target: target ?? 'unknown',
    operation: action,
    result: 'error',
    gate: null,
    detail: `partial/unconfirmed: dropped=[${a.droppedIds.join(',')}] ${a.note ?? ''}`.trim(),
  });
  const base = enriched !== null && typeof enriched === 'object' && !Array.isArray(enriched)
    ? (enriched as Record<string, unknown>)
    : { result: enriched };
  return { ...base, mcpWarning: a.note, droppedDeviceIds: a.droppedIds };
}

// ── device_manage ─────────────────────────────────────────────────────────────

const deviceManageSchema = z.object({
  action: z.enum(['add', 'rename', 'delete', 'move']).describe('Operation to perform'),

  // Device identification
  name: z.string().optional().describe('Device name (identifier for rename/delete/move)'),
  mac: z.string().optional().describe('Device MAC address'),
  id: z.string().optional().describe('Device numeric ID'),
  clientid: z.string().optional().describe('Client identifier (UUID)'),

  // add / move — destination OU (use destouRef for name-based lookup)
  destouRef: z.string().optional().describe(
    'Destination OU — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over destoupath/destouid.',
  ),
  destoupath: z.string().optional().describe(
    'Destination OU path (add/move); defaults to working OU if not provided (set via scout_context)',
  ),
  destouid: z.number().int().optional().describe('Destination OU ID (add/move) — use destouRef for name-based lookup'),

  // add
  newDeviceName: z.string().optional().describe('Name for the new device (action=add)'),
  newDeviceMac: z.string().optional().describe('MAC address for the new device (action=add)'),

  // rename
  newname: z.string().optional().describe('New device name (action=rename)'),
});

type DeviceManageInput = z.infer<typeof deviceManageSchema>;

async function deviceManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = deviceManageSchema.parse(raw) as DeviceManageInput;
  const client = getClient();

  // Destructive guard: delete is blocked entirely in test mode
  if (input.action === 'delete' && process.env.SCOUT_ENV === 'test') {
    return fail(
      'device_manage action=delete is disabled in SCOUT_ENV=test to prevent accidental deletion. ' +
        'Set SCOUT_ENV=production to delete devices, or verify the device is in SCOUT_TEST_OU_PATH manually.',
    );
  }

  try {
    // Gate 1: mode tiers — all device_manage actions are mutating.
    const modeCheck = checkMutationAllowed(`device_manage(${input.action})`);

    // Gate 6 (+ test scope): protected/allowed OU lists and SCOUT_ENV=test scope. action=move
    // changes which config an existing device inherits on BOTH ends of the move - moving a device
    // out of a protected OU changes its effective config just as much as moving one in - so both
    // the resolved destination and the device's current (source) OU are checked. The destination
    // is resolved from a FRESH tree: every supplied reference (destouRef / destoupath / destouid)
    // must name the same OU, the gates run on the RESOLVED canonical path, and the request below
    // carries ONLY the resolved id, so the gated OU and the written OU are identical by
    // construction. The working OU is a fallback only when no explicit destination was given.
    // add/move with no destination at all is refused here (audited), not left to the server.
    let destMatch: OuMatch | undefined;
    let resolvedDestId: number | undefined;
    if (input.action === 'move' || input.action === 'add') {
      const noExplicitDest =
        input.destouRef === undefined && input.destoupath === undefined && input.destouid === undefined;
      destMatch = await gateOuWrite(
        `device_manage(${input.action})`,
        input.destouRef !== undefined
          ? [input.destouRef]
          : noExplicitDest
            ? [getWorkingOu()?.path]
            : [input.destoupath, input.destouid],
        'destination OU',
        {
          requiredMessage:
            `device_manage(${input.action}) requires a destination OU (destouRef, destoupath or destouid, ` +
            'or a working OU set with scout_context); refusing rather than leaving the destination to the server.',
        },
      );
      resolvedDestId = destMatch?.ouid;
    }
    if (input.action === 'move') {
      const sourcePath = await resolveCurrentDeviceOuPath(client, {
        name: input.name,
        mac: input.mac,
        id: input.id,
        clientid: input.clientid,
      });
      checkOuWriteAllowed({ targetPath: sourcePath });
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        action: input.action,
        target: input.name ?? input.mac ?? input.id ?? input.clientid,
        message: modeCheck.dryRunNotice,
      });
    }

    // Re-assert, immediately before the mutating call, that the gated destination still has the
    // gated path (a concurrent rename/move must not slip through).
    if (destMatch) await assertOuPathUnchanged(destMatch.ouid, destMatch.path);

    let data: unknown;

    switch (input.action) {
      case 'add': {
        if (!input.newDeviceName) return fail('newDeviceName is required for action=add');
        if (!input.newDeviceMac) return fail('newDeviceMac is required for action=add');
        const qs = buildQuery({
          destouid: resolvedDestId,
          name: input.newDeviceName,
          mac: input.newDeviceMac,
        });
        data = await client.request<unknown>('POST', `/api/v1/device${qs}`, undefined, {
          mutating: true,
          opName: 'device_manage(add)',
        });
        if (isDryRunSkip(data)) break;
        return ok(await enrich(data));
      }

      case 'rename': {
        if (!input.newname) return fail('newname is required for action=rename');
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          newname: input.newname,
        });
        data = await client.request<unknown>('PUT', `/api/v1/device${qs}`, undefined, {
          mutating: true,
          opName: 'device_manage(rename)',
        });
        if (isDryRunSkip(data)) break;
        return ok(data);
      }

      case 'delete': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
        });
        data = await client.request<unknown>('DELETE', `/api/v1/device${qs}`, undefined, {
          mutating: true,
          opName: 'device_manage(delete)',
        });
        if (isDryRunSkip(data)) break;
        return ok(withWriteVerification('delete', input.name ?? input.mac ?? input.id ?? input.clientid, input.id ? [input.id] : [], data, data));
      }

      case 'move': {
        const qs = buildQuery({
          name: input.name,
          mac: input.mac,
          id: input.id,
          clientid: input.clientid,
          destouid: resolvedDestId,
        });
        data = await client.request<unknown>('PUT', `/api/v1/device/move${qs}`, undefined, {
          mutating: true,
          opName: 'device_manage(move)',
        });
        if (isDryRunSkip(data)) break;
        return ok(withWriteVerification('move', input.name ?? input.mac ?? input.id ?? input.clientid, input.id ? [input.id] : [], data, await enrich(data)));
      }
    }

    if (isDryRunSkip(data)) {
      return ok({ status: 'dry_run', action: input.action, message: data.notice });
    }
    return ok(data);
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`device_manage blocked: ${err.message}`);
    const baseMsg = `device_manage failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err)) {
      const identifier = input.name ?? input.mac ?? input.id ?? input.clientid;
      const hint = identifier
        ? `\n\nHint: device "${identifier}" was not found. Use device_get mode=search with ouPath and searchTerm to locate devices by partial name.`
        : '';
      return fail(baseMsg + hint);
    }
    return fail(baseMsg);
  } finally {
    if (input.action === 'add' || input.action === 'move') invalidateOuCache();
  }
}

export const deviceManageTool = {
  name: 'device_manage',
  description:
    'Add, rename, delete, or move devices in Scout Board. ' +
    'Use destouRef to specify the destination OU by name, partial name, path, or ID — no need to look up IDs first. ' +
    'DESTRUCTIVE: action=delete permanently removes a device from Scout Board. ' +
    'In SCOUT_ENV=test mode, delete is blocked entirely; add and move are restricted to paths under SCOUT_TEST_OU_PATH. ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing).',
  inputSchema: zodToJsonSchema(deviceManageSchema),
  execute: deviceManageExecute,
};
