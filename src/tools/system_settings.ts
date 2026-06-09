/**
 * Private Scout Board endpoints for system settings management.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

// ── Logging helpers ───────────────────────────────────────────────────────────

function log(tool: string, method: string, path: string, body?: unknown): void {
  const bodyStr = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
  process.stderr.write(`[scout-mcp/${tool}] ${method} ${path}${bodyStr}\n`);
}

function logOk(tool: string): void {
  process.stderr.write(`[scout-mcp/${tool}] response: 2xx\n`);
}

function logErr(tool: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scout-mcp/${tool}] error: ${msg}\n`);
}

// ── system_settings ───────────────────────────────────────────────────────────

const systemSettingsSchema = z.object({
  action: z
    .enum([
      'get_logging',
      'set_logging',
      'get_discover',
      'set_discover',
      'get_retain_local_config',
      'set_retain_local_config',
      'get_device_name_options',
      'set_device_password',
    ])
    .describe(
      'get_logging=read logging options; ' +
        'set_logging=update logging options (at least one of: log_enabled, log_keep_alive, log_level, max_log_files, max_log_file_size); ' +
        'get_discover=read discover options; ' +
        'set_discover=update discover options (at least one of: discover_ping_time, discover_collect_time); ' +
        'get_retain_local_config=read retain local config setting; ' +
        'set_retain_local_config=set retain_local_configuration (required); ' +
        'get_device_name_options=read device name options; ' +
        'set_device_password=DESTRUCTIVE: change device password (requires old_password, new_password, scout_board_id)',
    ),

  // set_logging fields
  log_enabled: z.boolean().optional().describe('Enable or disable logging (set_logging)'),
  log_keep_alive: z.boolean().optional().describe('Keep-alive logging flag (set_logging)'),
  log_level: z.string().optional().describe('Log level string, e.g. "INFO" or "DEBUG" (set_logging)'),
  max_log_files: z.number().int().optional().describe('Maximum number of log files to retain (set_logging)'),
  max_log_file_size: z.number().int().optional().describe('Maximum size per log file in bytes (set_logging)'),

  // set_discover fields
  discover_ping_time: z.number().int().optional().describe('Ping interval in seconds for discovery (set_discover)'),
  discover_collect_time: z
    .number()
    .int()
    .optional()
    .describe('Collect time in seconds for discovery (set_discover)'),

  // set_retain_local_config field
  retain_local_configuration: z
    .boolean()
    .optional()
    .describe('Whether to retain local configuration on devices (set_retain_local_config)'),

  // set_device_password fields
  old_password: z.string().optional().describe('Current device password (set_device_password)'),
  new_password: z.string().optional().describe('New device password (set_device_password)'),
  scout_board_id: z.string().optional().describe('Scout Board ID to update password for (set_device_password)'),
});

type SystemSettingsInput = z.infer<typeof systemSettingsSchema>;

async function systemSettingsExecute(raw: unknown): Promise<McpToolResult> {
  const input = systemSettingsSchema.parse(raw) as SystemSettingsInput;
  const client = getClient();
  const tool = 'system_settings';

  try {
    switch (input.action) {
      case 'get_logging': {
        const path = '/api/v1/loggingOptions';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'set_logging': {
        const body: Record<string, unknown> = {};
        if (input.log_enabled !== undefined) body['LogEnabled'] = input.log_enabled;
        if (input.log_keep_alive !== undefined) body['LogKeepAlive'] = input.log_keep_alive;
        if (input.log_level !== undefined) body['logLevel'] = input.log_level;
        if (input.max_log_files !== undefined) body['maxLogFiles'] = input.max_log_files;
        if (input.max_log_file_size !== undefined) body['maxLogFileSize'] = input.max_log_file_size;
        if (Object.keys(body).length === 0)
          return fail(
            'set_logging requires at least one of: log_enabled, log_keep_alive, log_level, max_log_files, max_log_file_size',
          );
        const path = '/api/v1/loggingOptions/set';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'get_discover': {
        const path = '/api/v1/discoverOptions';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'set_discover': {
        const body: Record<string, unknown> = {};
        if (input.discover_ping_time !== undefined) body['DiscoverPingTime'] = input.discover_ping_time;
        if (input.discover_collect_time !== undefined)
          body['DiscoverCollectTime'] = input.discover_collect_time;
        if (Object.keys(body).length === 0)
          return fail('set_discover requires at least one of: discover_ping_time, discover_collect_time');
        const path = '/api/v1/discoverOptions/set';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'get_retain_local_config': {
        const path = '/api/v1/retainLocalConfig';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'set_retain_local_config': {
        if (input.retain_local_configuration === undefined)
          return fail('set_retain_local_config requires retain_local_configuration (boolean)');
        const body = { RetainLocalConfiguration: input.retain_local_configuration };
        const path = '/api/v1/retainLocalConfig/set';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'get_device_name_options': {
        const path = '/api/v1/deviceNameOptions';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'set_device_password': {
        if (!input.old_password) return fail('set_device_password requires old_password');
        if (!input.new_password) return fail('set_device_password requires new_password');
        if (!input.scout_board_id) return fail('set_device_password requires scout_board_id');
        const body = {
          oldPassword: input.old_password,
          newPassword: input.new_password,
          scoutBoardId: input.scout_board_id,
        };
        const path = '/api/v1/devicePassword/set';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`system_settings failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const systemSettingsTool = {
  name: 'system_settings',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board system settings: logging, discovery, retain-local-config, device name options, and device password. ' +
    'Actions: get_logging/set_logging (logging options), get_discover/set_discover (discovery timing), ' +
    'get_retain_local_config/set_retain_local_config (retain local config flag), ' +
    'get_device_name_options (device naming configuration), ' +
    'set_device_password (DESTRUCTIVE: change device password — requires old_password, new_password, scout_board_id).',
  inputSchema: zodToJsonSchema(systemSettingsSchema),
  execute: systemSettingsExecute,
};
