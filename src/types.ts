import { z } from 'zod';

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
