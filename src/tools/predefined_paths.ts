/**
 * Private Scout Board endpoints for predefined paths management.
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

// ── predefined_paths ──────────────────────────────────────────────────────────

const pathEntrySchema = z.object({
  Path: z.string().describe('The file system path to add as a predefined path'),
  Outdated: z.boolean().optional().describe('Whether this path is marked as outdated'),
});

const predefinedPathsSchema = z.object({
  action: z
    .enum(['list', 'add', 'delete'])
    .describe(
      'list=list all predefined paths; ' +
        'add=DESTRUCTIVE: add new predefined path entries (requires paths); ' +
        'delete=DESTRUCTIVE: delete predefined paths by EntryId (requires entry_ids)',
    ),

  paths: z
    .array(pathEntrySchema)
    .optional()
    .describe('Path entries to add (required for add action)'),

  entry_ids: z
    .array(z.number().int())
    .optional()
    .describe('List of EntryId values to delete (required for delete action)'),
});

type PredefinedPathsInput = z.infer<typeof predefinedPathsSchema>;

async function predefinedPathsExecute(raw: unknown): Promise<McpToolResult> {
  const input = predefinedPathsSchema.parse(raw) as PredefinedPathsInput;
  const client = getClient();
  const tool = 'predefined_paths';

  try {
    switch (input.action) {
      case 'list': {
        const apiPath = '/api/v1/predefinedPaths';
        log(tool, 'GET', apiPath);
        const data = await client.rawRequest<unknown>('GET', apiPath);
        logOk(tool);
        return ok(data);
      }

      case 'add': {
        if (!input.paths || input.paths.length === 0)
          return fail('add requires at least one entry in paths');
        const apiPath = '/api/v1/predefinedPaths/add';
        log(tool, 'POST', apiPath, input.paths);
        const data = await client.rawRequest<unknown>('POST', apiPath, input.paths);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.entry_ids || input.entry_ids.length === 0)
          return fail('delete requires at least one entry in entry_ids');
        const body = input.entry_ids.map((id) => ({ EntryId: id }));
        const apiPath = '/api/v1/predefinedPaths/delete';
        log(tool, 'POST', apiPath, body);
        const data = await client.rawRequest<unknown>('POST', apiPath, body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`predefined_paths failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const predefinedPathsTool = {
  name: 'predefined_paths',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board predefined file system paths. ' +
    'Actions: list (all predefined paths), ' +
    'add (DESTRUCTIVE: add new paths via paths array — each with Path and optional Outdated flag), ' +
    'delete (DESTRUCTIVE: remove paths by entry_ids array of EntryId numbers).',
  inputSchema: zodToJsonSchema(predefinedPathsSchema),
  execute: predefinedPathsExecute,
};
