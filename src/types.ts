import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

// ── Common Zod primitives ─────────────────────────────────────────────────────

export const OuPath = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('/'), { message: 'OU path must start with /' });

export const MacAddress = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'Invalid MAC address format');

// ── Shared API response shapes ────────────────────────────────────────────────

export interface ApiOkResponse {
  message: string;
}

export interface HealthCheckResponse {
  message: string;
  response?: Record<string, unknown>;
}

// ── MCP tool contract ─────────────────────────────────────────────────────────

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Per-call context passed to tool execute() functions, in addition to their parsed input.
 * Optional on every tool's signature so existing tools that don't need it keep compiling
 * unchanged — only tools that need elicitation or progress notifications read it.
 *
 *   - `server`: the live MCP Server instance. Used to check
 *     `server.getClientCapabilities()?.elicitation` and to call `server.elicitInput(...)`
 *     (see src/elicitation.ts) for real confirmation prompts.
 *   - `progressToken`: taken from the originating request's `_meta.progressToken` (per the
 *     MCP spec — see node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
 *     `ProgressNotificationParamsSchema`). Present only if the calling client opted in to
 *     progress notifications for this request; absent otherwise.
 *   - `sendProgress`: convenience wrapper that sends a `notifications/progress` message tied
 *     to `progressToken`, and is a no-op (resolves immediately, never throws) when no token
 *     was supplied — see src/progress.ts.
 */
export interface ToolContext {
  server?: Server;
  progressToken?: string | number;
  sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}

/**
 * Structural type for the tool registry in index.ts. `execute`'s second parameter is
 * optional so tools that don't need ctx (the vast majority) keep their existing
 * `(raw: unknown) => Promise<McpToolResult>` signature and remain assignable here without
 * modification — only tools that read ctx (elicitation, progress) declare it explicitly.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (raw: unknown, ctx?: ToolContext) => Promise<McpToolResult>;
}

export function ok(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function fail(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ── URL query string builder ──────────────────────────────────────────────────

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `?${qs}`;
}
