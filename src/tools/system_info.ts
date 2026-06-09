/**
 * Private Scout Board endpoints for system information and status queries.
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

// ── system_info ───────────────────────────────────────────────────────────────

const systemInfoSchema = z.object({
  action: z
    .enum([
      'status_summary',
      'device_count',
      'device_distribution',
      'device_image_files',
      'recovery_settings',
      'db_diags',
      'system_check',
      'tree_filter',
      'missed_notifications',
      'auth_user',
    ])
    .describe(
      'status_summary=overall system status; ' +
        'device_count=number of devices with optional filter and inOverview flag; ' +
        'device_distribution=device distribution stats; ' +
        'device_image_files=list available device image files; ' +
        'recovery_settings=read recovery configuration; ' +
        'db_diags=database layer diagnostics; ' +
        'system_check=run a system health check; ' +
        'tree_filter=search the OU tree by value; ' +
        'missed_notifications=fetch any missed notifications; ' +
        'auth_user=get the currently authenticated user info',
    ),

  // device_count optional fields
  filter: z
    .string()
    .optional()
    .describe(
      'JSON array filter string for device_count, e.g. \'[{"name":"LastContact","filter":"1"}]\'',
    ),
  in_overview: z.boolean().optional().describe('Only count devices shown in overview (device_count)'),

  // tree_filter required field
  search_value: z.string().optional().describe('Search string for tree_filter action'),
});

type SystemInfoInput = z.infer<typeof systemInfoSchema>;

async function systemInfoExecute(raw: unknown): Promise<McpToolResult> {
  const input = systemInfoSchema.parse(raw) as SystemInfoInput;
  const client = getClient();
  const tool = 'system_info';

  try {
    switch (input.action) {
      case 'status_summary': {
        const path = '/api/v1/statussummary';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'device_count': {
        const qs = new URLSearchParams();
        if (input.filter !== undefined) qs.set('filter', input.filter);
        if (input.in_overview !== undefined) qs.set('inOverview', String(input.in_overview));
        const qsStr = qs.toString() ? `?${qs.toString()}` : '';
        const path = `/api/v1/devicecount${qsStr}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'device_distribution': {
        const path = '/api/v1/devicedistribution';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'device_image_files': {
        const path = '/api/v1/deviceimagefiles';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'recovery_settings': {
        const path = '/api/v1/recoverySettings';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'db_diags': {
        const path = '/api/v1/dblayerdiags';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'system_check': {
        const path = '/api/v1/systemcheck?action=SYSTEM.SYSTEM_CHECK';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'tree_filter': {
        if (!input.search_value) return fail('tree_filter requires search_value');
        const body = { searchValue: input.search_value };
        const path = '/api/v1/treefilter';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'missed_notifications': {
        const path = '/api/v1/missednotifications';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'auth_user': {
        const path = '/api/v1/auth/user';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`system_info failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const systemInfoTool = {
  name: 'system_info',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Query Scout Board system information and status. ' +
    'Actions: status_summary (overall system status), device_count (device count with optional filter/inOverview), ' +
    'device_distribution (distribution statistics), device_image_files (available image files), ' +
    'recovery_settings (recovery configuration), db_diags (database layer diagnostics), ' +
    'system_check (run system health check), tree_filter (search OU tree by search_value), ' +
    'missed_notifications (fetch missed notifications), auth_user (current authenticated user).',
  inputSchema: zodToJsonSchema(systemInfoSchema),
  execute: systemInfoExecute,
};
