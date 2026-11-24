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
  auditLog,
  checkAuditPurgeAllowed,
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

/**
 * Table ids accepted by the server (SBD-UI api/helpers/generic/dbCleanUp.helper.ts:14-20).
 * Id 1 = ADMIN_LOGS is the Scout Board activity log (audit trail) and is hard-gated.
 */
export const DB_CLEANUP_TABLES: Readonly<Record<number, string>> = {
  0: 'ALARMS',
  1: 'ADMIN_LOGS',
  2: 'DEVICE_LIST',
  3: 'COMMAND_HISTORY',
  4: 'COMMAND_RESULTS',
};
export const ADMIN_LOGS_TABLE_ID = 1;

export interface CleanupFilterEntry {
  id: number;
  from: string | number;
  to: string | number;
}

/**
 * Parse + validate the JSON filter string into [{id, from, to}]. The server maps this to
 * {Type, Oldest, Newest}; an empty/absent filter has UNVERIFIED semantics (possibly "everything"),
 * so for deletes an empty array and entries without a bounded from/to range are refused.
 */
export function parseCleanupFilter(raw: string, opts: { requireRange: boolean }): CleanupFilterEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('filter must be a JSON array string, e.g. [{"id":0,"from":"2020-01-01","to":"2024-01-01"}]');
  }
  if (!Array.isArray(parsed)) throw new Error('filter must be a JSON array of {id, from, to} objects');
  if (opts.requireRange && parsed.length === 0) {
    throw new Error('delete requires a non-empty filter (an empty filter could purge everything)');
  }
  return parsed.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const id = o['id'];
    if (typeof id !== 'number' || !Number.isInteger(id) || !(id in DB_CLEANUP_TABLES)) {
      throw new Error(
        `filter[${i}].id must be one of ${Object.entries(DB_CLEANUP_TABLES).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      );
    }
    const from = o['from'];
    const to = o['to'];
    const okVal = (v: unknown): v is string | number =>
      (typeof v === 'string' && v.length > 0) || typeof v === 'number';
    if (opts.requireRange && (!okVal(from) || !okVal(to))) {
      throw new Error(`filter[${i}] needs both "from" and "to" (a bounded date range) for delete`);
    }
    return { id, from: from as string | number, to: to as string | number };
  });
}

const dbCleanupSchema = z.object({
  action: z
    .enum(['list', 'delete'])
    .describe(
      'list=list database cleanup entries (row counts and oldest/newest per table), optionally filtered; ' +
        'delete=DESTRUCTIVE: permanently purge records in the given date range (requires confirm=true)',
    ),

  filter: z
    .string()
    .optional()
    .describe(
      'JSON array string of {id, from, to}. id = table: 0 ALARMS, 1 ADMIN_LOGS (activity log — refused unless ' +
        'SCOUT_ALLOW_AUDIT_PURGE=true), 2 DEVICE_LIST, 3 COMMAND_HISTORY, 4 COMMAND_RESULTS. ' +
        'Example: [{"id":0,"from":"2020-01-01","to":"2024-01-01"}]. ' +
        'For list: defaults to []. For delete: required, non-empty, each entry needs from and to.',
    ),

  confirm: z
    .boolean()
    .optional()
    .describe('Must be true to execute delete (required safety guard for destructive operation)'),

  confirm_audit_purge: z
    .boolean()
    .optional()
    .describe(
      'Additional explicit confirmation, required in addition to confirm when the filter contains id 1 ' +
        '(ADMIN_LOGS) and the operator set SCOUT_ALLOW_AUDIT_PURGE=true.',
    ),
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
        try {
          parseCleanupFilter(filterValue, { requireRange: false });
        } catch (e) {
          return fail(`db_cleanup: ${e instanceof Error ? e.message : String(e)}`);
        }
        const path = `/api/v1/dbCleanUp?filter=${encodeURIComponent(filterValue)}`;
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.filter) return fail('db_cleanup action=delete requires filter to specify which records to delete');
        let entries: CleanupFilterEntry[];
        try {
          entries = parseCleanupFilter(input.filter, { requireRange: true });
        } catch (e) {
          return fail(`db_cleanup: ${e instanceof Error ? e.message : String(e)}`);
        }
        const touchesAuditLog = entries.some((e) => e.id === ADMIN_LOGS_TABLE_ID);
        // Hard refusal first, before any prompt: purging the activity log is never reachable
        // by default, whatever mode or confirm flag is given.
        if (touchesAuditLog) {
          checkAuditPurgeAllowed('db_cleanup(delete)');
          if (input.confirm_audit_purge !== true) {
            return fail(
              'db_cleanup blocked: the filter includes ADMIN_LOGS (id 1, the activity log). Pass ' +
                'confirm_audit_purge=true in addition to confirm=true to purge it.',
            );
          }
        }
        const tables = entries.map((e) => `${DB_CLEANUP_TABLES[e.id]} [${e.from} .. ${e.to}]`).join('; ');
        const delOutcome = await confirmDestructiveAction(
          { server: ctx?.server },
          {
            opName: 'db_cleanup(delete)',
            summary: `Permanently purge database records: ${tables}.${touchesAuditLog ? ' INCLUDES THE ACTIVITY LOG.' : ''}`,
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
          return ok({ status: 'dry_run', action: input.action, filter: entries, message: modeCheck.dryRunNotice });
        }
        // POST /api/v1/dbCleanUp {filter:[{id,from,to}]} (SBD-UI api/routes/v1/generic/dbCleanUp.route.ts:13;
        // controllers/generic/dbCleanUp.controller.ts). There is no DELETE verb on this route.
        const path = '/api/v1/dbCleanUp';
        const body = { filter: entries };
        log(tool, 'POST', path, body);
        try {
          const data = await client.rawRequest<unknown>('POST', path, body, {
            mutating: true,
            opName: 'db_cleanup(delete)',
          });
          if (isDryRunSkip(data)) return ok({ status: 'dry_run', action: input.action, message: data.notice });
          auditLog({
            opName: 'db_cleanup(delete)',
            target: tables,
            operation: 'dbCleanUp',
            result: 'allowed',
            gate: null,
            ...(touchesAuditLog ? { detail: 'ADMIN_LOGS purge' } : {}),
          });
          logOk(tool);
          return ok(data);
        } catch (e) {
          auditLog({
            opName: 'db_cleanup(delete)',
            target: tables,
            operation: 'dbCleanUp',
            result: 'error',
            gate: null,
            detail: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
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
    'Inspect and purge Scout Board database tables by date range. ' +
    'Actions: list (GET: per-table row counts and oldest/newest, optional JSON filter), ' +
    'delete (DESTRUCTIVE: POST {filter:[{id,from,to}]}, id 0 ALARMS, 2 DEVICE_LIST, 3 COMMAND_HISTORY, 4 COMMAND_RESULTS — ' +
    'requires confirm=true and a bounded from/to range). ' +
    'id 1 (ADMIN_LOGS, the activity log) is refused unless the operator sets SCOUT_ALLOW_AUDIT_PURGE=true and the call also passes confirm_audit_purge=true.',
  inputSchema: zodToJsonSchema(dbCleanupSchema),
  execute: dbCleanupExecute,
};
