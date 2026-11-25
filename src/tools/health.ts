import { MCP_SERVER_VERSION, MCP_BUILD } from '../version.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { resolveConfig } from '../session.js';
import { detectCapabilities } from '../compat/detect.js';
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
  capabilities: z
    .boolean()
    .optional()
    .describe('Include detected Scout version and per-feature capability availability (default true)'),
});

type Input = z.infer<typeof inputSchema>;

export interface HealthAssessment {
  state: 'ok' | 'degraded' | 'error';
  problems: string[];
}

/**
 * GET /rest/api/v1/healthcheck answers HTTP 200 even when it failed; the failure is in the body
 * (SBD-UI api/external/routes/healthcheck.route.ts:174-302): `{message:'not OK', response:'Internal server error'}`,
 * `scoutDBLayer:false` (license lookup failed) or `scoutDBLayer.status.result:1 'not available'`.
 * Component blocks use status.result 0 ok, 1 failing, 2 partial, 3 unknown.
 */
export function assessHealthBody(data: unknown): HealthAssessment {
  const problems: string[] = [];
  let state: HealthAssessment['state'] = 'ok';
  const bump = (to: 'degraded' | 'error'): void => {
    if (to === 'error' || state === 'ok') state = to;
  };
  if (data === null || typeof data !== 'object') {
    return { state: 'error', problems: ['healthcheck returned no JSON body'] };
  }
  const d = data as Record<string, unknown>;
  if (typeof d['message'] === 'string' && d['message'] !== 'OK') {
    bump('error');
    problems.push(`message: ${String(d['message']).slice(0, 100)}`);
  }
  const resp = d['response'];
  if (typeof resp === 'string') {
    bump('error');
    problems.push(`response: ${resp.slice(0, 200)}`);
    return { state, problems };
  }
  if (resp && typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    if (r['scoutDBLayer'] === false) {
      bump('error');
      problems.push('scoutDBLayer: license/database lookup failed (server returned false)');
    }
    const statusOf = (v: unknown): number | undefined => {
      const st = (v as { status?: { result?: unknown } } | null | undefined)?.status?.result;
      return typeof st === 'number' ? st : undefined;
    };
    if (statusOf(r['scoutDBLayer']) === 1) {
      bump('error');
      problems.push('scoutDBLayer: not available');
    }
    for (const k of ['scoutServer', 'scoutKeepAlive', 'scoutDatabase']) {
      const st = statusOf(r[k]);
      if (st === 1 || st === 2) {
        bump('degraded');
        problems.push(`${k}: ${st === 1 ? 'failing' : 'partially failing'}`);
      }
    }
  }
  return { state, problems };
}

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
    const assessment = assessHealthBody(data);
    if (assessment.state === 'error') {
      // HTTP 200 with the failure in the body — report it as an error, not as a healthy server.
      return fail(`Health check reports an error (HTTP 200, failure in body): ${assessment.problems.join('; ')}`);
    }
    const out: Record<string, unknown> = {
      ...data,
      healthState: assessment.state,
      // After the spread so a Scout response can never override our own version.
      mcpServerVersion: MCP_SERVER_VERSION,
      mcpBuild: MCP_BUILD,
    };
    if (assessment.problems.length > 0) out.healthProblems = assessment.problems;
    if (process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true') {
      out.systemcheckElias = await fetchEliasSystemcheck();
    }
    if (input.capabilities !== false) {
      // Never throws; version/capability detection is advisory and cannot fail the health check.
      const report = await detectCapabilities(client);
      out.scoutVersion = report.scoutVersion;
      out.versionSource = report.versionSource;
      out.versionConfidence = report.versionConfidence;
      out.specVersion = report.specVersion;
      out.capabilities = report.capabilities;
      if (report.disagreements.length > 0) out.capabilityDisagreements = report.disagreements;
    }
    return ok(out);
  } catch (err) {
    return fail(
      `Health check failed (scout-mcp ${MCP_BUILD.build}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface EliasSystemcheck {
  state: string;
  error?: string;
}

/**
 * PRIVATE endpoint GET /api/v1/systemcheck/elias (not in openapi.json); caller gates on
 * SCOUT_ENABLE_PRIVATE_ENDPOINTS=true. Never throws: any failure or unexpected shape is
 * reported as state 'unknown' so it cannot fail the surrounding health_check.
 */
export async function fetchEliasSystemcheck(): Promise<EliasSystemcheck> {
  try {
    const res = await getClient().rawRequest<unknown>('GET', '/api/v1/systemcheck/elias');
    const state = res !== null && typeof res === 'object' ? (res as Record<string, unknown>)['state'] : undefined;
    if (typeof state !== 'string') return { state: 'unknown', error: 'unexpected response shape' };
    return { state };
  } catch (err) {
    return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
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
