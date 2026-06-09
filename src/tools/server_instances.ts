/**
 * Private Scout Board endpoints for server instance management.
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

// ── server_instances ──────────────────────────────────────────────────────────

const serverInstancesSchema = z.object({
  action: z
    .enum(['list', 'delete', 'modify'])
    .describe(
      'list=list all server instances; ' +
        'delete=DESTRUCTIVE: delete a server instance by entity_id; ' +
        'modify=DESTRUCTIVE: update a server instance by entity_id (requires at least one of: cpu_threshold, license_threshold, ip_address, ip_name, use_balancer, instance_type)',
    ),

  entity_id: z
    .number()
    .int()
    .optional()
    .describe('Numeric EntityID of the server instance (required for delete and modify)'),

  // modify optional fields
  cpu_threshold: z
    .number()
    .optional()
    .describe('CPU usage threshold percentage (modify)'),
  license_threshold: z
    .number()
    .optional()
    .describe('License usage threshold percentage (modify)'),
  ip_address: z.string().optional().describe('IP address of the server instance (modify)'),
  ip_name: z.string().optional().describe('Hostname or DNS name of the server instance (modify)'),
  use_balancer: z.boolean().optional().describe('Whether to use load balancing for this instance (modify)'),
  instance_type: z.number().int().optional().describe('Numeric instance type identifier (modify)'),
});

type ServerInstancesInput = z.infer<typeof serverInstancesSchema>;

async function serverInstancesExecute(raw: unknown): Promise<McpToolResult> {
  const input = serverInstancesSchema.parse(raw) as ServerInstancesInput;
  const client = getClient();
  const tool = 'server_instances';

  try {
    switch (input.action) {
      case 'list': {
        const path = '/api/v1/ui/instances';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (input.entity_id === undefined) return fail('delete requires entity_id');
        const body = { EntityID: input.entity_id };
        const path = '/api/v1/ui/instances';
        log(tool, 'DELETE', path, body);
        const data = await client.rawRequest<unknown>('DELETE', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'modify': {
        if (input.entity_id === undefined) return fail('modify requires entity_id');
        const body: Record<string, unknown> = { EntityID: input.entity_id };
        if (input.cpu_threshold !== undefined) body['cpuThreshold'] = input.cpu_threshold;
        if (input.license_threshold !== undefined) body['licenseThreshold'] = input.license_threshold;
        if (input.ip_address !== undefined) body['IPAddress'] = input.ip_address;
        if (input.ip_name !== undefined) body['IPName'] = input.ip_name;
        if (input.use_balancer !== undefined) body['useBalancer'] = input.use_balancer;
        if (input.instance_type !== undefined) body['instanceType'] = input.instance_type;
        // Require at least one field besides EntityID
        if (Object.keys(body).length <= 1)
          return fail(
            'modify requires at least one of: cpu_threshold, license_threshold, ip_address, ip_name, use_balancer, instance_type',
          );
        const path = '/api/v1/ui/instances';
        log(tool, 'PUT', path, body);
        const data = await client.rawRequest<unknown>('PUT', path, body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`server_instances failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const serverInstancesTool = {
  name: 'server_instances',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board server instances (multi-instance / load-balancer configuration). ' +
    'Actions: list (all server instances), ' +
    'delete (DESTRUCTIVE: remove an instance by entity_id), ' +
    'modify (DESTRUCTIVE: update instance properties by entity_id — at least one of: ' +
    'cpu_threshold, license_threshold, ip_address, ip_name, use_balancer, instance_type).',
  inputSchema: zodToJsonSchema(serverInstancesSchema),
  execute: serverInstancesExecute,
};
