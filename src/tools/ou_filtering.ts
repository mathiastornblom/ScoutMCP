/**
 * Private Scout Board endpoints for OU filter rules and new device enrollment options.
 *
 * These endpoints are NOT in the public OpenAPI spec and were discovered from UI traffic.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true — if that flag is absent or
 * false, the tools are not registered and will not appear in the tool list.
 *
 * Three filter types (FilterType in the API):
 *   FilterType: 1  Subnet filter      — matches device by IP network (SubnetAddress field)
 *   FilterType: 2  User-defined filter — matches device by ELUX_* property expression (CustomFilter field, max 4000 chars)
 *   FilterType: 4  Rule filter        — condition string + visual-builder blocks, stored in CustomFilter as the JSON
 *                                       envelope {"conditionString","filterBlocks"} (envelope max 65535 chars, condition max 32768)
 *   (FilterType 3 = Follow-Me-Desktop shares the table and is deliberately NOT reachable here.)
 *   Source: SBD-UI api/external/validations/ouFilter.validations.ts:28-45,120-140; api/external/helpers/ouFilter.helper.ts:69,97-104,277-292.
 *
 * Field name mapping (MCP → API):
 *   ou_id          → OUID
 *   entry_id       → EntryId
 *   subnet_address → SubnetAddress   (FilterType 1)
 *   custom_filter  → CustomFilter    (FilterType 2)
 *   rule_condition → CustomFilter envelope conditionString (FilterType 4)
 *   rule_blocks    → CustomFilter envelope filterBlocks    (FilterType 4)
 *   active         → Active
 *   order          → OrderNumber
 */

import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';
import { checkMutationAllowed, isDryRunSkip, GuardrailError } from '../safety/guardrails.js';
import { gateOuWrite, ouListsConfigured, refuseOuWrite } from '../safety/ou_gate.js';
import { assertOuPathUnchanged, type OuMatch } from '../resolver.js';

// ── Logging helper ────────────────────────────────────────────────────────────

function log(tool: string, method: string, path: string, body?: unknown): void {
  const bodyStr = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
  process.stderr.write(`[scout-mcp/${tool}] ${method} /rest${path}${bodyStr}\n`);
}

function logOk(tool: string): void {
  process.stderr.write(`[scout-mcp/${tool}] response: 2xx\n`);
}

function logErr(tool: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scout-mcp/${tool}] error: ${msg}\n`);
}


// ── OU write gate for filter entries ──────────────────────────────────────────

/** True when a filter entry's CURRENT OU must be looked up (modify/delete name only an entry_id). */
function needsEntryOuLookup(): boolean {
  return ouListsConfigured() || process.env.SCOUT_ENV === 'test';
}

/**
 * Resolves the OU an existing filter entry belongs to, from GET /api/v1/oufilter (row fields
 * EntryId / OUID). FAILS CLOSED (audited refusal): a list that is not an array, a missing entry, or
 * a row without an integer OUID means the entry's OU is unknown, which is not "unprotected".
 */
async function currentEntryOuId(opName: string, entryId: number, rows: unknown): Promise<number> {
  const row = Array.isArray(rows)
    ? rows.find((r) => r !== null && typeof r === 'object' && (r as Record<string, unknown>)['EntryId'] === entryId)
    : undefined;
  const ouid = row ? (row as Record<string, unknown>)['OUID'] : undefined;
  if (typeof ouid !== 'number' || !Number.isInteger(ouid)) {
    return refuseOuWrite(
      opName,
      `entry:${entryId}`,
      `Could not determine which OU filter entry ${entryId} belongs to (no row with an integer OUID in GET /api/v1/oufilter). ` +
        'Refusing: the protected-OU check cannot run against an unknown OU.',
      'unresolvable-source-ou',
    );
  }
  return ouid;
}

/**
 * Gates every OU a set of filter entries touches (the entry's new ou_id and, for modify/delete when
 * protection is configured, its current OU). Returns the resolved OUs so the caller can re-assert
 * their paths right before the write. Wire entries get the RESOLVED id.
 */
async function gateFilterEntries(
  opName: string,
  action: 'add' | 'modify' | 'delete',
  entries: FilterEntryInput[],
  wire: Array<Record<string, unknown>> | undefined,
  client: ReturnType<typeof getClient>,
): Promise<OuMatch[]> {
  const gated = new Map<number, OuMatch>();
  let rows: unknown;
  let rowsLoaded = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.ou_id !== undefined || action === 'add') {
      const m = await gateOuWrite(opName, [e.ou_id], 'filter entry OU', {
        requiredMessage: 'every add entry must name its OU via ou_id; refusing rather than leaving the OU to the server.',
      });
      if (m) {
        gated.set(m.ouid, m);
        if (wire && wire[i]) wire[i]['OUID'] = m.ouid;
      }
    }
    if (action !== 'add' && needsEntryOuLookup()) {
      if (!rowsLoaded) {
        rows = await client.rawRequest<unknown>('GET', '/api/v1/oufilter');
        rowsLoaded = true;
      }
      const cur = await currentEntryOuId(opName, e.entry_id as number, rows);
      const m = await gateOuWrite(opName, [cur], 'current filter entry OU');
      if (m) gated.set(m.ouid, m);
    }
  }
  return [...gated.values()];
}

// ── ou_filter_manage ──────────────────────────────────────────────────────────

/** ScoutServer reads an expression row through a 4001-char buffer and silently truncates longer text. */
export const MAX_EXPRESSION_LENGTH = 4000;
/** Cap on the bare condition (kept below the envelope cap so it always fits once wrapped). */
export const MAX_CONDITION_LENGTH = 32768;
/** Cap on the marshalled {"conditionString","filterBlocks"} envelope ScoutServer loads for a rule. */
export const MAX_RULE_ENVELOPE_LENGTH = 65535;

/** Same marshalling as the server's buildRuleEnvelope (api/external/helpers/ouFilter.helper.ts:97-104). */
export function buildRuleEnvelope(condition: string, blocks: unknown[] | undefined): string {
  return JSON.stringify({ conditionString: condition, filterBlocks: blocks ?? [] });
}

export interface FilterEntryInput {
  entry_id?: number;
  subnet_address?: string;
  custom_filter?: string;
  rule_condition?: string;
  rule_blocks?: Array<Record<string, unknown>>;
  active?: boolean;
  ou_id?: number;
  order?: number;
}

/**
 * Validate and translate one MCP entry into the wire entry. Throws Error with a user-facing message.
 * Types 1 (subnet) and 2 (expression) keep their existing mapping; type 4 (rule) is new.
 */
export function buildFilterWireEntry(e: FilterEntryInput, mode: 'add' | 'modify'): Record<string, unknown> {
  const kinds = [e.subnet_address, e.custom_filter, e.rule_condition].filter((v) => v !== undefined && v !== '').length;
  const entry: Record<string, unknown> = mode === 'modify' ? { EntryId: e.entry_id } : {};
  const isSubnet = mode === 'add' ? Boolean(e.subnet_address) : e.subnet_address !== undefined;
  const isRule = e.rule_condition !== undefined;
  if (isRule && (e.subnet_address !== undefined || e.custom_filter !== undefined)) {
    throw new Error('A rule entry (rule_condition) cannot be combined with subnet_address or custom_filter');
  }
  if (e.rule_blocks !== undefined && !isRule) {
    throw new Error('rule_blocks is only valid together with rule_condition');
  }
  if (mode === 'add' && kinds === 0) {
    throw new Error(
      'Each add entry must include either subnet_address (subnet filter), custom_filter (user-defined filter) ' +
        'or rule_condition (rule filter)',
    );
  }
  if (isRule) {
    const cond = e.rule_condition as string;
    if (cond.length === 0) throw new Error('rule_condition must not be empty');
    if (cond.length > MAX_CONDITION_LENGTH) {
      throw new Error(`rule_condition must not exceed ${MAX_CONDITION_LENGTH} characters (got ${cond.length})`);
    }
    const envelope = buildRuleEnvelope(cond, e.rule_blocks);
    if (envelope.length > MAX_RULE_ENVELOPE_LENGTH) {
      throw new Error(
        `rule condition + blocks marshal to ${envelope.length} characters, over the ${MAX_RULE_ENVELOPE_LENGTH} ` +
          'limit of the buffer ScoutServer loads them through',
      );
    }
    if (mode === 'add' && (e.ou_id === undefined || e.active === undefined)) {
      throw new Error('A rule entry requires ou_id and active when added');
    }
    entry['FilterType'] = 4;
    entry['CustomFilter'] = envelope;
    // Rule rows carry their priority as Sequence on the wire (helper toWireEntry, ouFilter.helper.ts:291).
    if (e.order !== undefined) entry['Sequence'] = e.order;
  } else if (isSubnet) {
    entry['FilterType'] = 1;
    entry['SubnetAddress'] = e.subnet_address;
    if (e.order !== undefined) entry['OrderNumber'] = e.order;
  } else if (mode === 'add' || e.custom_filter !== undefined) {
    const expr = e.custom_filter as string;
    if (expr.length > MAX_EXPRESSION_LENGTH) {
      throw new Error(
        `custom_filter must not exceed ${MAX_EXPRESSION_LENGTH} characters (got ${expr.length}); ScoutServer silently truncates longer expressions`,
      );
    }
    entry['FilterType'] = 2;
    entry['CustomFilter'] = expr;
    if (e.order !== undefined) entry['OrderNumber'] = e.order;
  } else if (e.order !== undefined) {
    entry['OrderNumber'] = e.order;
  }
  if (e.active !== undefined) entry['Active'] = e.active;
  if (e.ou_id !== undefined) entry['OUID'] = e.ou_id;
  return entry;
}

const filterEntrySchema = z.object({
  entry_id: z.number().int().optional().describe(
    'Filter entry ID — required for modify and delete',
  ),

  // Subnet filter (FilterType 1)
  subnet_address: z.string().optional().describe(
    'CIDR network address for a subnet filter, e.g. "192.168.1.0/24". ' +
    'Provide this field (instead of custom_filter) to create/update a subnet-based rule.',
  ),

  // User-defined filter (FilterType 2)
  custom_filter: z.string().optional().describe(
    'Property expression for a user-defined filter, matched against the device at enrollment. ' +
    'Format: PROPERTY = value. ' +
    'The = operator is the documented comparison operator. ' +
    'Operators != > < may also work but are not in the official documentation (Scout 2605). ' +
    'Prefix matching is built in — "ELUX_HOSTNAME=PC" matches all hostnames starting with "PC"; ' +
    'no explicit wildcard character is needed or supported. ' +
    'Combine multiple conditions within one expression using AND / OR (uppercase required): ' +
    '"ELUX_HOSTNAME=PC AND ELUX_OSVERSION=2603". ' +
    'Nest complex expressions with escaped brackets: "\\(ELUX_A=x OR ELUX_A=y\\) AND ELUX_B=z". ' +
    'Available properties: ' +
    'ELUX_IP (IP address), ELUX_MAC (MAC address), ' +
    'ELUX_NETADDR (network address, e.g. "192.168.1.0"), ' +
    'ELUX_NETCIDR (prefix length as integer, e.g. "24"), ' +
    'ELUX_NETMASK (netmask, e.g. "255.255.255.0"), ' +
    'ELUX_BROADCAST (broadcast address), ELUX_DOMAIN (DNS domain), ' +
    'ELUX_HOSTNAME (hostname), ' +
    'ELUX_SERIAL (serial number), ELUX_DEVICETYPE (device model), ' +
    'ELUX_PRODUCT (BIOS product name), ELUX_SUPPLIER (manufacturer), ' +
    'ELUX_BIOS (BIOS version), ELUX_CPU (CPU frequency MHz), ' +
    'ELUX_MEMORY (RAM in MiB), ELUX_FLASH (system disk name), ' +
    'ELUX_FLASHSIZE (storage in MiB), ELUX_GRAPHICS (GPU name(s)), ' +
    'ELUX_OSNAME (OS name), ELUX_OSVERSION (OS version), ' +
    'ELUX_KERNEL (kernel version), ELUX_IDF (firmware image name). ' +
    'Multiple filter entries targeting the same OU are ANDed at evaluation time. ' +
    'Provide this field (instead of subnet_address) to create/update a user-defined rule.',
  ),

  // Rule filter (FilterType 4)
  rule_condition: z.string().optional().describe(
    'Condition string of a rule filter (FilterType 4), max 32768 characters. Cannot be combined with ' +
    'subnet_address/custom_filter. Requires ou_id and active when adding. The server stores it in the ' +
    'CustomFilter column as the JSON envelope {"conditionString","filterBlocks"} (max 65535 characters in total).',
  ),
  rule_blocks: z.array(z.record(z.string(), z.unknown())).optional().describe(
    'Visual-builder blocks stored verbatim next to rule_condition (array of objects; defaults to []). ' +
    'Only valid together with rule_condition.',
  ),

  active: z.boolean().optional().describe('Whether the filter entry is active'),
  ou_id: z.number().int().optional().describe('Numeric ID of the destination OU'),
  order: z.number().int().optional().describe('Sequence number for rule evaluation order'),
});

const ouFilterManageSchema = z.object({
  action: z
    .enum(['get_settings', 'list', 'set_settings', 'add', 'modify', 'delete'])
    .describe(
      'get_settings=read global OU filter settings; ' +
        'list=list all OU filter rules; ' +
        'set_settings=update global filter type and ignore-default flag; ' +
        'add=add new filter rule entries; ' +
        'modify=update existing entries by entry_id; ' +
        'delete=remove entries by entry_id',
    ),

  // set_settings fields
  ou_filter_type: z
    .number()
    .int()
    .optional()
    .describe('OUFilterType value (set_settings). 1 = IP subnet filtering.'),
  ou_filter_ignore_default: z
    .boolean()
    .optional()
    .describe('OUFilterIgnoreDefault flag (set_settings)'),

  // add / modify / delete entries
  entries: z
    .array(filterEntrySchema)
    .optional()
    .describe('One or more filter rule entries (required for add, modify, delete)'),
});

type OuFilterManageInput = z.infer<typeof ouFilterManageSchema>;

async function ouFilterManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouFilterManageSchema.parse(raw) as OuFilterManageInput;
  const client = getClient();
  const tool = 'ou_filter_manage';

  try {
    switch (input.action) {
      case 'get_settings': {
        log(tool, 'GET', '/api/v1/oufilter/settings');
        const data = await client.rawRequest<unknown>('GET', '/api/v1/oufilter/settings');
        logOk(tool);
        return ok(data);
      }

      case 'list': {
        log(tool, 'GET', '/api/v1/oufilter');
        const data = await client.rawRequest<unknown>('GET', '/api/v1/oufilter');
        logOk(tool);
        return ok(data);
      }

      case 'set_settings': {
        if (input.ou_filter_type === undefined && input.ou_filter_ignore_default === undefined)
          return fail('set_settings requires at least one of: ou_filter_type, ou_filter_ignore_default');
        const modeCheck = checkMutationAllowed('ou_filter_manage(set_settings)');
        // Both fields must be sent together — read current values and merge.
        log(tool, 'GET', '/api/v1/oufilter/settings');
        const current = await client.rawRequest<Array<{ OUFilterType: number; OUFilterIgnoreDefault: number }>>(
          'GET', '/api/v1/oufilter/settings',
        );
        const existing = Array.isArray(current) ? current[0] : current as { OUFilterType: number; OUFilterIgnoreDefault: number };
        const body = {
          OUFilterType: input.ou_filter_type ?? existing.OUFilterType,
          OUFilterIgnoreDefault: input.ou_filter_ignore_default ?? Boolean(existing.OUFilterIgnoreDefault),
        };
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, wouldSet: body, message: modeCheck.dryRunNotice });
        }
        log(tool, 'POST', '/api/v1/oufilter/setSettings', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/setSettings', body, {
          mutating: true,
          opName: 'ou_filter_manage(set_settings)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }

      case 'add': {
        if (!input.entries || input.entries.length === 0)
          return fail('add requires at least one entry in entries[]');
        let requestValues: Array<Record<string, unknown>>;
        try {
          requestValues = input.entries.map((e) => buildFilterWireEntry(e, 'add'));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        const modeCheck = checkMutationAllowed('ou_filter_manage(add)');
        const gatedOus = await gateFilterEntries('ou_filter_manage(add)', 'add', input.entries, requestValues, client);
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        }
        for (const m of gatedOus) await assertOuPathUnchanged(m.ouid, m.path);
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/add', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/add', body, {
          mutating: true,
          opName: 'ou_filter_manage(add)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }

      case 'modify': {
        if (!input.entries || input.entries.length === 0)
          return fail('modify requires at least one entry in entries[]');
        const missingId = input.entries.find((e) => e.entry_id === undefined);
        if (missingId) return fail('Every entry in modify must include entry_id');
        let requestValues: Array<Record<string, unknown>>;
        try {
          requestValues = input.entries.map((e) => buildFilterWireEntry(e, 'modify'));
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
        const modeCheck = checkMutationAllowed('ou_filter_manage(modify)');
        const gatedOus = await gateFilterEntries('ou_filter_manage(modify)', 'modify', input.entries, requestValues, client);
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        }
        for (const m of gatedOus) await assertOuPathUnchanged(m.ouid, m.path);
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/modify', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/modify', body, {
          mutating: true,
          opName: 'ou_filter_manage(modify)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.entries || input.entries.length === 0)
          return fail('delete requires at least one entry in entries[]');
        const missingId = input.entries.find((e) => e.entry_id === undefined);
        if (missingId) return fail('Every entry in delete must include entry_id');
        const modeCheck = checkMutationAllowed('ou_filter_manage(delete)');
        const gatedOus = await gateFilterEntries('ou_filter_manage(delete)', 'delete', input.entries, undefined, client);
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, message: modeCheck.dryRunNotice });
        }
        for (const m of gatedOus) await assertOuPathUnchanged(m.ouid, m.path);
        const requestValues = input.entries.map((e) => ({ EntryId: e.entry_id }));
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/delete', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/delete', body, {
          mutating: true,
          opName: 'ou_filter_manage(delete)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) {
      logErr(tool, err);
      return fail(`ou_filter_manage blocked: ${err.message}`);
    }
    logErr(tool, err);
    return fail(`ou_filter_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ouFilterManageTool = {
  name: 'ou_filter_manage',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board OU filter rules and global settings. ' +
    'Three filter rule types are supported: ' +
    '(1) Subnet filter (FilterType 1) — matches enrolling devices by IP network; uses subnet_address e.g. "192.168.1.0/24". ' +
    '(2) User-defined filter (FilterType 2) — matches by ELUX_* device property expression; uses custom_filter e.g. "ELUX_NETADDR=192.168.1.0". ' +
    '(4) Rule filter (FilterType 4) — rule_condition (max 32768 chars) + optional rule_blocks; requires ou_id and active on add; stored as a JSON envelope capped at 65535 chars. ' +
    'custom_filter is capped at 4000 characters (the server silently truncates longer text). ' +
    'custom_filter format: PROPERTY = value. ' +
    'Combine conditions with AND / OR (uppercase): "ELUX_HOSTNAME=PC AND ELUX_OSVERSION=2603". ' +
    'Prefix matching is built in — no wildcard character needed. ' +
    'Operators != > < may work but are not in the official Scout 2605 documentation. ' +
    'Available properties: ELUX_IP, ELUX_MAC, ELUX_NETADDR, ELUX_NETCIDR, ' +
    'ELUX_NETMASK, ELUX_BROADCAST, ELUX_DOMAIN, ELUX_HOSTNAME, ELUX_SERIAL, ELUX_DEVICETYPE, ' +
    'ELUX_PRODUCT, ELUX_SUPPLIER, ELUX_BIOS, ELUX_CPU, ELUX_MEMORY, ELUX_FLASH, ELUX_FLASHSIZE, ' +
    'ELUX_GRAPHICS, ELUX_OSNAME, ELUX_OSVERSION, ELUX_KERNEL, ELUX_IDF. ' +
    'Multiple rules targeting the same OU are ANDed at evaluation time. ' +
    'Actions: get_settings, list, set_settings, ' +
    'add (each entry requires subnet_address OR custom_filter OR rule_condition; optional: active, ou_id, order), ' +
    'modify (update rules by entry_id — optional: subnet_address, custom_filter, active, ou_id, order), ' +
    'delete (remove rules by entry_id). ' +
    'DESTRUCTIVE: modify/delete/set_settings permanently alter OU filter configuration.',
  inputSchema: toInputSchema(ouFilterManageSchema),
  execute: ouFilterManageExecute,
};

// ── new_device_options ────────────────────────────────────────────────────────

const newDeviceOptionsSchema = z.object({
  action: z
    .enum(['get', 'set'])
    .describe('get=read current new device enrollment settings; set=update one or more settings'),

  accept_only_known_devices: z
    .boolean()
    .optional()
    .describe('Only enroll pre-registered (known) devices — rejects unrecognised devices (set)'),
  default_ou: z
    .number()
    .int()
    .optional()
    .describe('Default OU ID to assign newly enrolling devices to (set)'),
  deactivate_new_devices: z
    .boolean()
    .optional()
    .describe('Deactivate new devices immediately on enrollment (set)'),
  allow_dynamic_ou_change: z
    .boolean()
    .optional()
    .describe('Allow devices to move between OUs dynamically (set)'),
});

type NewDeviceOptionsInput = z.infer<typeof newDeviceOptionsSchema>;

async function newDeviceOptionsExecute(raw: unknown): Promise<McpToolResult> {
  const input = newDeviceOptionsSchema.parse(raw) as NewDeviceOptionsInput;
  const client = getClient();
  const tool = 'new_device_options';

  try {
    switch (input.action) {
      case 'get': {
        log(tool, 'GET', '/api/v1/NewDeviceOptions');
        const data = await client.rawRequest<unknown>('GET', '/api/v1/NewDeviceOptions');
        logOk(tool);
        return ok(data);
      }

      case 'set': {
        const body: Record<string, unknown> = {};
        if (input.accept_only_known_devices !== undefined)
          body['AcceptOnlyKnownDevices'] = input.accept_only_known_devices;
        if (input.default_ou !== undefined) body['DefaultOU'] = input.default_ou;
        if (input.deactivate_new_devices !== undefined)
          body['DeactivateNewDevices'] = input.deactivate_new_devices;
        if (input.allow_dynamic_ou_change !== undefined)
          body['AllowDynamicOUChange'] = input.allow_dynamic_ou_change;
        if (Object.keys(body).length === 0)
          return fail(
            'set requires at least one of: accept_only_known_devices, default_ou, deactivate_new_devices, allow_dynamic_ou_change',
          );
        const modeCheck = checkMutationAllowed('new_device_options(set)');
        // default_ou names the OU newly enrolling devices land in: gate the RESOLVED OU, send only its id.
        let defaultOu: OuMatch | undefined;
        if (input.default_ou !== undefined) {
          defaultOu = await gateOuWrite('new_device_options(set)', [input.default_ou], 'default OU');
          if (defaultOu) body['DefaultOU'] = defaultOu.ouid;
        }
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, wouldSet: body, message: modeCheck.dryRunNotice });
        }
        if (defaultOu) await assertOuPathUnchanged(defaultOu.ouid, defaultOu.path);
        log(tool, 'POST', '/api/v1/NewDeviceOptions/set', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/NewDeviceOptions/set', body, {
          mutating: true,
          opName: 'new_device_options(set)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) {
      logErr(tool, err);
      return fail(`new_device_options blocked: ${err.message}`);
    }
    logErr(tool, err);
    return fail(`new_device_options failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const newDeviceOptionsTool = {
  name: 'new_device_options',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Read or update new device enrollment options for Scout Board. ' +
    'action=get returns current settings (accept_only_known_devices, default_ou, ' +
    'deactivate_new_devices, allow_dynamic_ou_change). ' +
    'action=set updates one or more settings. ' +
    'DESTRUCTIVE: set permanently changes how newly enrolling devices are handled.',
  inputSchema: toInputSchema(newDeviceOptionsSchema),
  execute: newDeviceOptionsExecute,
};
