/**
 * `ourights` preflight — a UX / early-refusal aid, NOT a security boundary.
 *
 * The Scout Board UI asks `GET /api/v1/ourights?ouId=<id>` before offering writes. That
 * endpoint is PRIVATE (not in openapi.json), so the preflight only runs when
 * SCOUT_ENABLE_PRIVATE_ENDPOINTS=true. It lets us refuse a write early, with a clear
 * message, when the server already says the logged-in user lacks the right on the OU.
 *
 * Contract (Security review B2, .agents/design-review-lock-elias.md):
 *  - ONLY an explicit `false` for the needed right denies (GuardrailError gate
 *    'preflight', audit-logged as refused).
 *  - Everything else proceeds to the normal flow ("soft-fail open", one stderr line, never
 *    cached as denied): HTTP 404/405/501/403/401/5xx, network/timeout, unparseable body,
 *    missing or non-boolean right.
 *  - A `true` NEVER relaxes or skips any other gate (mode, kill switch, base, validation,
 *    confirm, blast radius, protected OUs). The server remains the only authority.
 *  - Read-only call (not `mutating`), so it does not count toward the circuit breaker.
 *  - Successful responses are cached <= 30 s per ouId; failures are never cached.
 *  - The operation -> right-name tables below come from one HAR capture and are best
 *    effort; verify on a live server before trusting a refusal message.
 */

import { getClient, ScoutError } from '../client.js';
import { auditLog, GuardrailError } from './guardrails.js';

// ── Tool operation → right name tables (keys of the ourights response) ───────────

/** device_command `command` → ourights flag. Unmapped commands are not preflighted. */
export const DEVICE_COMMAND_RIGHTS: Readonly<Record<string, string>> = {
  restart: 'restart',
  halt: 'shutdown',
  start: 'start',
  factoryreset: 'factoryReset',
  update: 'update',
  updateuefi: 'biosUpdate',
  custom: 'customCommand',
  predefined: 'predefinedCommands',
  delivery: 'delivery',
  message: 'msg',
};

/** ou_manage `action` → ourights flag. Unmapped actions (e.g. converttobase) are not preflighted. */
export const OU_MANAGE_RIGHTS: Readonly<Record<string, string>> = {
  add: 'addOu',
  rename: 'rename',
  delete: 'delete',
  move: 'move',
  structure_import: 'importOu',
};

/** config_update (target=ou) requires this flag. */
export const CONFIG_UPDATE_RIGHT = 'setup';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface PreflightParams {
  opName: string;
  /** Human label of the target for messages/audit, e.g. an OU path. */
  target: string;
  /** Target OU id. When undefined the preflight is skipped (rights are per-OU). */
  ouId: number | undefined;
  /** Right (top-level key of the ourights body) that must not be explicitly false. */
  requiredRight: string;
  /** Test seam: replaces the HTTP call. */
  fetchRights?: (ouId: number) => Promise<unknown>;
}

export type PreflightStatus = 'granted' | 'skipped-disabled' | 'skipped-no-ou' | 'soft-fail-open';

export interface PreflightOutcome {
  status: PreflightStatus;
  detail: string;
}

export const PREFLIGHT_CACHE_TTL_MS = 30_000;
const cache = new Map<number, { at: number; body: Record<string, unknown> }>();

/** Clears the rights cache (tests, and callers that change SCOUT_MODE). */
export function resetPreflightCache(): void {
  cache.clear();
}

export function isPrivatePreflightEnabled(): boolean {
  return process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true';
}

async function defaultFetchRights(ouId: number): Promise<unknown> {
  const qs = new URLSearchParams({ ouId: String(ouId) }).toString();
  return getClient().rawRequest<unknown>('GET', `/api/v1/ourights?${qs}`);
}

function softFail(p: PreflightParams, detail: string): PreflightOutcome {
  process.stderr.write(`[scout-mcp/preflight] ${p.opName}: ${detail}; proceeding (UX aid only)\n`);
  return { status: 'soft-fail-open', detail };
}

/**
 * Runs the ourights preflight. Resolves when the write may proceed; throws GuardrailError
 * (gate 'preflight') only when the server explicitly reports the right as false.
 */
export async function checkOuRightPreflight(p: PreflightParams): Promise<PreflightOutcome> {
  if (!isPrivatePreflightEnabled()) {
    return { status: 'skipped-disabled', detail: 'SCOUT_ENABLE_PRIVATE_ENDPOINTS is not true' };
  }
  if (p.ouId === undefined || !Number.isInteger(p.ouId) || p.ouId < 0) {
    return { status: 'skipped-no-ou', detail: 'target OU id unknown or not an integer' };
  }

  let body: Record<string, unknown> | undefined;
  const hit = cache.get(p.ouId);
  if (hit && Date.now() - hit.at <= PREFLIGHT_CACHE_TTL_MS) {
    body = hit.body;
  } else {
    let raw: unknown;
    try {
      raw = await (p.fetchRights ?? defaultFetchRights)(p.ouId);
    } catch (err) {
      // 404 = endpoint absent on this Scout release (see src/compat/registry.ts 'ourights-preflight').
      // Still proceed-on-unknown (Security B2): this only improves the log message.
      const hint = err instanceof ScoutError && err.statusCode === 404 ? ' - endpoint not available on this Scout release' : '';
      return softFail(p, `ourights unavailable (${err instanceof Error ? err.message : String(err)})${hint}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return softFail(p, 'ourights returned an unparseable/unexpected body');
    }
    body = raw as Record<string, unknown>;
    cache.set(p.ouId, { at: Date.now(), body });
  }

  const value = body[p.requiredRight];
  if (value === false) {
    auditLog({
      opName: p.opName,
      target: p.target,
      operation: 'ourights-preflight',
      result: 'refused',
      gate: 'preflight',
      detail: `ourights: right "${p.requiredRight}" is false`,
    });
    throw new GuardrailError(
      `Permission preflight: you lack the "${p.requiredRight}" right on OU ${p.ouId} (${p.target}); ${p.opName} was not sent. ` +
        'This is an early-refusal aid; the Scout server enforces rights itself.',
      'preflight',
    );
  }
  if (value === true) return { status: 'granted', detail: `right "${p.requiredRight}" granted` };
  return softFail(p, `right "${p.requiredRight}" absent or not boolean in ourights`);
}
