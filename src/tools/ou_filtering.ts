/**
 * Private Scout Board endpoints for OU filter rules and new device enrollment options.
 *
 * These endpoints are NOT in the public OpenAPI spec and were discovered from UI traffic.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true — if that flag is absent or
 * false, the tools are not registered and will not appear in the tool list.
 *
 * Two filter types (FilterType in the API):
 *   FilterType: 1  Subnet filter      — matches device by IP network (SubnetAddress field)
 *   FilterType: 2  User-defined filter — matches device by ELUX_* property expression (CustomFilter field)
 *
 * Field name mapping (MCP → API):
 *   ou_id          → OUID
 *   entry_id       → EntryId
 *   subnet_address → SubnetAddress   (FilterType 1)
 *   custom_filter  → CustomFilter    (FilterType 2)
 *   active         → Active
 *   order          → OrderNumber
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

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

// ── ou_filter_manage ──────────────────────────────────────────────────────────

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
    'Format: PROPERTY OPERATOR value. Supported operators: = (equals), != (not equals), ' +
    '> (greater than), < (less than). Wildcard * is supported in values, e.g. "Hostn*". ' +
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
    'Multiple entries for the same OU are ANDed at evaluation time. ' +
    'Provide this field (instead of subnet_address) to create/update a user-defined rule.',
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
        log(tool, 'POST', '/api/v1/oufilter/setSettings', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/setSettings', body);
        logOk(tool);
        return ok(data);
      }

      case 'add': {
        if (!input.entries || input.entries.length === 0)
          return fail('add requires at least one entry in entries[]');
        for (const e of input.entries) {
          if (!e.subnet_address && !e.custom_filter)
            return fail(
              'Each add entry must include either subnet_address (subnet filter) ' +
              'or custom_filter (user-defined filter)',
            );
        }
        const requestValues = input.entries.map((e) => {
          const entry: Record<string, unknown> = {};
          if (e.subnet_address) {
            // FilterType 1 = subnet filter
            entry['FilterType'] = 1;
            entry['SubnetAddress'] = e.subnet_address;
          } else {
            // FilterType 2 = user-defined expression filter
            entry['FilterType'] = 2;
            entry['CustomFilter'] = e.custom_filter;
          }
          if (e.active !== undefined) entry['Active'] = e.active;
          if (e.ou_id !== undefined) entry['OUID'] = e.ou_id;
          if (e.order !== undefined) entry['OrderNumber'] = e.order;
          return entry;
        });
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/add', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/add', body);
        logOk(tool);
        return ok(data);
      }

      case 'modify': {
        if (!input.entries || input.entries.length === 0)
          return fail('modify requires at least one entry in entries[]');
        const missingId = input.entries.find((e) => e.entry_id === undefined);
        if (missingId) return fail('Every entry in modify must include entry_id');
        const requestValues = input.entries.map((e) => {
          const entry: Record<string, unknown> = { EntryId: e.entry_id };
          if (e.subnet_address !== undefined) {
            entry['FilterType'] = 1;
            entry['SubnetAddress'] = e.subnet_address;
          } else if (e.custom_filter !== undefined) {
            entry['FilterType'] = 2;
            entry['CustomFilter'] = e.custom_filter;
          }
          if (e.active !== undefined) entry['Active'] = e.active;
          if (e.ou_id !== undefined) entry['OUID'] = e.ou_id;
          if (e.order !== undefined) entry['OrderNumber'] = e.order;
          return entry;
        });
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/modify', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/modify', body);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.entries || input.entries.length === 0)
          return fail('delete requires at least one entry in entries[]');
        const missingId = input.entries.find((e) => e.entry_id === undefined);
        if (missingId) return fail('Every entry in delete must include entry_id');
        const requestValues = input.entries.map((e) => ({ EntryId: e.entry_id }));
        const body = { requestValues };
        log(tool, 'POST', '/api/v1/oufilter/delete', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/delete', body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`ou_filter_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const ouFilterManageTool = {
  name: 'ou_filter_manage',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board OU filter rules and global settings. ' +
    'Two filter rule types are supported: ' +
    '(1) Subnet filter (FilterType 1) — matches enrolling devices by IP network; uses subnet_address e.g. "192.168.1.0/24". ' +
    '(2) User-defined filter (FilterType 2) — matches by ELUX_* device property expression; uses custom_filter e.g. "ELUX_NETADDR=192.168.1.0". ' +
    'custom_filter format: PROPERTY OPERATOR value. Operators: = != > <. Wildcards supported, e.g. "Hostn*". ' +
    'Available properties: ELUX_IP, ELUX_MAC, ELUX_NETADDR, ELUX_NETCIDR, ' +
    'ELUX_NETMASK, ELUX_BROADCAST, ELUX_DOMAIN, ELUX_HOSTNAME, ELUX_SERIAL, ELUX_DEVICETYPE, ' +
    'ELUX_PRODUCT, ELUX_SUPPLIER, ELUX_BIOS, ELUX_CPU, ELUX_MEMORY, ELUX_FLASH, ELUX_FLASHSIZE, ' +
    'ELUX_GRAPHICS, ELUX_OSNAME, ELUX_OSVERSION, ELUX_KERNEL, ELUX_IDF. ' +
    'Multiple rules targeting the same OU are ANDed at evaluation time. ' +
    'Actions: get_settings, list, set_settings, ' +
    'add (each entry requires subnet_address OR custom_filter; optional: active, ou_id, order), ' +
    'modify (update rules by entry_id — optional: subnet_address, custom_filter, active, ou_id, order), ' +
    'delete (remove rules by entry_id). ' +
    'DESTRUCTIVE: modify/delete/set_settings permanently alter OU filter configuration.',
  inputSchema: zodToJsonSchema(ouFilterManageSchema),
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
        log(tool, 'POST', '/api/v1/NewDeviceOptions/set', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/NewDeviceOptions/set', body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
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
  inputSchema: zodToJsonSchema(newDeviceOptionsSchema),
  execute: newDeviceOptionsExecute,
};
