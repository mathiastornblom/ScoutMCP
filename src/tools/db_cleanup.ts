/**
 * Private Scout Board endpoint for database cleanup inspection.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult, type ToolContext } from '../types.js';
import { confirmDestructiveAction } from '../elicitation.js';
import {
  checkMutationAllowed,
  checkPrivateWriteAllowedInProduction,
  isDryRunSkip,
  GuardrailError,
} from '../safety/guardrails.js';

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

// ── db_cleanup ────────────────────────────────────────────────────────────────

const dbCleanupSchema = z.object({
  action: z
    .enum(['list', 'delete'])
    .describe(
      'list=list database cleanup entries, optionally filtered; ' +
        'delete=DESTRUCTIVE: permanently delete records matching filter (requires confirm=true)',
    ),

  filter: z
    .string()
    .optional()
    .describe(
      'JSON array filter string, e.g. \'[{"name":"SomeField","filter":"value"}]\'. ' +
        'For list: defaults to empty filter (returns all entries). ' +
        'For delete: required — specifies which records to delete.',
    ),

  confirm: z
    .boolean()
    .optional()
    .describe('Must be true to execute delete (required safety guard for destructive operation)'),
});

type DbCleanupInput = z.infer<typeof dbCleanupSchema>;

async function dbCleanupExecute(raw: unknown, ctx?: ToolContext): Promise<McpToolResult> {
  const input = dbCleanupSchema.parse(raw) as DbCleanupInput;
  const client = getClient();
  const tool = 'db_cleanup';

  try {
    switch (input.action) {
      case 'list': {
        const filterValue = input.filter !== undefined ? input.filter : '[]';
        const path = `/api/v1/dbCleanUp?filter=${encodeURIComponent(filterValue)}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.filter) return fail('db_cleanup action=delete requires filter to specify which records to delete');
        const delOutcome = await confirmDestructiveAction(
          { server: ctx?.server },
          {
            opName: 'db_cleanup(delete)',
            summary: `Permanently delete database records matching filter: ${input.filter}`,
            confirmFlag: input.confirm,
          },
        );
        if (!delOutcome.proceed) return fail(`db_cleanup blocked: ${delOutcome.reason}`);
        // Gate 7: private-endpoint writes are hard-disabled in SCOUT_MODE=write (production)
        // by default, even with SCOUT_ENABLE_PRIVATE_ENDPOINTS=true — db_cleanup(delete) is
        // one of the explicitly named high-risk endpoints for this gate.
        checkPrivateWriteAllowedInProduction('db_cleanup(delete)');
        // Gate 1: mode tiers — db_cleanup(delete) is a destructive, irreversible operation.
        const modeCheck = checkMutationAllowed('db_cleanup(delete)');
        if (!modeCheck.proceed) {
          return ok({ status: 'dry_run', action: input.action, filter: input.filter, message: modeCheck.dryRunNotice });
        }
        const path = `/api/v1/dbCleanUp?filter=${encodeURIComponent(input.filter)}`;
        log(tool, 'DELETE', path);
        const data = await client.rawRequest<unknown>('DELETE', path, undefined, {
          mutating: true,
          opName: 'db_cleanup(delete)',
        });
        if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    if (err instanceof GuardrailError) {
      logErr(tool, err);
      return fail(`db_cleanup blocked: ${err.message}`);
    }
    logErr(tool, err);
    return fail(`db_cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const dbCleanupTool = {
  name: 'db_cleanup',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Inspect and clean up Scout Board database records. ' +
    'Actions: list (fetch cleanup records, optionally filtered via a JSON array string; defaults to all entries), ' +
    'delete (DESTRUCTIVE: permanently delete records matching filter — requires confirm=true and filter).',
  inputSchema: zodToJsonSchema(dbCleanupSchema),
  execute: dbCleanupExecute,
};
