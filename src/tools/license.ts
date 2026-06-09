/**
 * Private Scout Board endpoints for license management.
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

// ── license_manage ────────────────────────────────────────────────────────────

const licenseManageSchema = z.object({
  action: z
    .enum(['get', 'check_availability', 'reconfigure'])
    .describe(
      'get=read current license information; ' +
        'check_availability=check if a license server is reachable (requires license_server); ' +
        'reconfigure=DESTRUCTIVE: reconfigure the license server (requires license_server, selfsigned, optional thumbprint)',
    ),

  license_server: z
    .string()
    .optional()
    .describe('License server URL or hostname (required for check_availability and reconfigure)'),

  selfsigned: z
    .boolean()
    .optional()
    .describe('Whether the license server uses a self-signed certificate (required for reconfigure)'),

  thumbprint: z
    .string()
    .optional()
    .describe('Certificate thumbprint for the license server (optional for reconfigure)'),
});

type LicenseManageInput = z.infer<typeof licenseManageSchema>;

async function licenseManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = licenseManageSchema.parse(raw) as LicenseManageInput;
  const client = getClient();
  const tool = 'license_manage';

  try {
    switch (input.action) {
      case 'get': {
        const path = '/api/v1/license/licenseinfo';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'check_availability': {
        if (!input.license_server) return fail('check_availability requires license_server');
        const qs = `?licenseServer=${encodeURIComponent(input.license_server)}`;
        const path = `/api/v1/license/checkLsAvailability${qs}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'reconfigure': {
        if (!input.license_server) return fail('reconfigure requires license_server');
        if (input.selfsigned === undefined) return fail('reconfigure requires selfsigned (boolean)');
        const body: Record<string, unknown> = {
          licenseServer: input.license_server,
          selfsigned: input.selfsigned,
        };
        if (input.thumbprint !== undefined) body['thumbprint'] = input.thumbprint;
        const path = '/api/v1/license/reConfigure';
        log(tool, 'PUT', path, body);
        const data = await client.rawRequest<unknown>('PUT', path, body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`license_manage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const licenseManageTool = {
  name: 'license_manage',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board license configuration. ' +
    'Actions: get (current license information), ' +
    'check_availability (check if license server is reachable — requires license_server), ' +
    'reconfigure (DESTRUCTIVE: update license server configuration — requires license_server, selfsigned, optional thumbprint).',
  inputSchema: zodToJsonSchema(licenseManageSchema),
  execute: licenseManageExecute,
};
