import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { resolveConfig } from '../session.js';
import { ok, fail, buildQuery, type McpToolResult, type HealthCheckResponse } from '../types.js';

const inputSchema = z.object({
  mode: z.enum(['ping', 'healthcheck']).describe(
    'ping = unauthenticated availability check; healthcheck = authenticated system status',
  ),
  license: z.boolean().optional().describe('Include license info in healthcheck response'),
  subscription: z.boolean().optional().describe('Include subscription info in healthcheck response'),
  scoutServer: z.boolean().optional().describe('Include Scout server info in healthcheck response'),
  scoutKeepAlive: z.boolean().optional().describe('Include keep-alive server info in healthcheck response'),
  scoutDatabase: z.boolean().optional().describe('Include database info in healthcheck response'),
});

type Input = z.infer<typeof inputSchema>;

async function execute(raw: unknown): Promise<McpToolResult> {
  const input = inputSchema.parse(raw) as Input;

  if (input.mode === 'ping') {
    try {
      const available = await pingDirect();
      return ok({ available });
    } catch (err) {
      return fail(`Ping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // healthcheck — requires authentication
  const client = getClient();
  const qs = buildQuery({
    license: input.license,
    subscription: input.subscription,
    scoutServer: input.scoutServer,
    scoutKeepAlive: input.scoutKeepAlive,
    scoutDatabase: input.scoutDatabase,
  });

  try {
    const data = await client.request<HealthCheckResponse>('GET', `/api/v1/healthcheck${qs}`);
    return ok(data);
  } catch (err) {
    return fail(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pingDirect(): Promise<boolean> {
  const config = resolveConfig();
  if (!config) throw new Error('Scout is not configured. Call scout_configure first.');

  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const ignoreTls = config.ignoreTls ?? false;
  const timeoutMs = parseInt(process.env.SCOUT_REQUEST_TIMEOUT_MS ?? '30000', 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatcher: any | undefined;
  if (ignoreTls) {
    const undici = await import('undici');
    dispatcher = new undici.Agent({ connect: { rejectUnauthorized: false } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { fetch: uFetch } = await import('undici');
    const res = await uFetch(`${baseUrl}/rest/api/v1/ping`, {
      method: 'GET',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as Parameters<typeof uFetch>[1]);
    // Any HTTP response means the API layer is reachable; only network errors throw
    void res;
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export const healthCheckTool = {
  name: 'health_check',
  description:
    'Check Scout Board server availability. Use mode=ping for a quick unauthenticated check, or mode=healthcheck for authenticated system status including optional license, subscription, server, and database details.',
  inputSchema: zodToJsonSchema(inputSchema),
  execute,
};
