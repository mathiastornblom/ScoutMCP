/**
 * Private Scout Board endpoints for OU filter rules and new device enrollment options.
 *
 * These endpoints are NOT in the public OpenAPI spec and were discovered from UI traffic.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true — if that flag is absent or
 * false, the tools are not registered and will not appear in the tool list.
 *
 * Field name mapping (MCP → API):
 *   ou_id            → OUID
 *   entry_id         → EntryId
 *   subnet_address   → SubnetAddress
 *   filter_type      → FilterType
 *   active           → Active
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
  entry_id: z.number().int().optional().describe('Filter entry ID — required for modify and delete'),
  filter_type: z.number().int().optional().describe('Filter type (1 = IP subnet)'),
  subnet_address: z.string().optional().describe('Subnet in CIDR notation, e.g. "192.168.1.0/24"'),
  active: z.boolean().optional().describe('Whether the filter entry is active'),
  ou_id: z.number().int().optional().describe('Numeric ID of the target OU'),
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
        const body: Record<string, unknown> = {};
        if (input.ou_filter_type !== undefined) body['OUFilterType'] = input.ou_filter_type;
        if (input.ou_filter_ignore_default !== undefined)
          body['OUFilterIgnoreDefault'] = input.ou_filter_ignore_default;
        if (Object.keys(body).length === 0)
          return fail('set_settings requires at least one of: ou_filter_type, ou_filter_ignore_default');
        log(tool, 'POST', '/api/v1/oufilter/setSettings', body);
        const data = await client.rawRequest<unknown>('POST', '/api/v1/oufilter/setSettings', body);
        logOk(tool);
        return ok(data);
      }

      case 'add': {
        if (!input.entries || input.entries.length === 0)
          return fail('add requires at least one entry in entries[]');
        const requestValues = input.entries.map((e) => {
          const entry: Record<string, unknown> = {};
          if (e.filter_type !== undefined) entry['FilterType'] = e.filter_type;
          if (e.subnet_address !== undefined) entry['SubnetAddress'] = e.subnet_address;
          if (e.active !== undefined) entry['Active'] = e.active;
          if (e.ou_id !== undefined) entry['OUID'] = e.ou_id;
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
          if (e.filter_type !== undefined) entry['FilterType'] = e.filter_type;
          if (e.subnet_address !== undefined) entry['SubnetAddress'] = e.subnet_address;
          if (e.active !== undefined) entry['Active'] = e.active;
          if (e.ou_id !== undefined) entry['OUID'] = e.ou_id;
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
    'Actions: get_settings (read global filter config), list (all filter rules), ' +
    'set_settings (update OUFilterType / OUFilterIgnoreDefault), ' +
    'add (new filter rules with subnet_address, filter_type, active, ou_id), ' +
    'modify (update existing rules by entry_id), ' +
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
