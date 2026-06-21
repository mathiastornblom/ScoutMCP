/**
 * Safety guardrails — mode tiers, Base/root write-protection, and blast-radius caps.
 *
 * These are the first three gates of a larger write-safety program (see WS-D). They are
 * designed to be the single chokepoint every write-capable tool passes through, so that
 * later phases (audit log, circuit breaker, snapshot-before-mutate, confirmation tokens,
 * protected-OU deny list, kill switch) can be layered on here without re-auditing every
 * tool file individually.
 *
 * Placement rationale: these checks live in a standalone module (not inlined in
 * client.ts) so they can be unit-tested without a live Scout Board connection, and so
 * ScoutClient stays a thin HTTP/auth concern. client.ts calls into this module from a
 * single funnel point (the `mutating` option on request()/rawRequest()) rather than each
 * of the ~20 tool files duplicating env-var checks. Tools that need richer guardrails
 * (Base/root protection, blast-radius counting) call the dedicated helpers directly
 * before issuing the request, because only the tool layer knows the semantic scope
 * (base vs OU vs device) and the resolved device count — client.ts only sees an HTTP verb
 * and a path string, which isn't enough information to enforce gates 2 and 3 correctly.
 */

// ── Gate 1: Mode tiers ──────────────────────────────────────────────────────────

export type ScoutMode = 'read-only' | 'dry-run' | 'write';

const VALID_MODES: readonly ScoutMode[] = ['read-only', 'dry-run', 'write'];

/**
 * Current operating mode, read fresh from env on every call (no caching) so tests and
 * runtime config changes take effect immediately. Defaults to the safest tier.
 */
export function getScoutMode(): ScoutMode {
  const raw = process.env.SCOUT_MODE;
  if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
    return raw as ScoutMode;
  }
  return 'read-only';
}

export class GuardrailError extends Error {
  constructor(
    message: string,
    public readonly gate: 'mode' | 'base-write' | 'blast-radius',
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export interface MutationCheckResult {
  /** True if the mutating HTTP call should actually be issued. */
  proceed: boolean;
  /** Present when proceed=false but this is an expected dry-run skip, not an error. */
  dryRunNotice?: string;
}

/**
 * Sentinel returned by ScoutClient.request()/rawRequest() in place of the real response
 * when SCOUT_MODE=dry-run skipped a mutating call. Tools should check `isDryRunSkip()`
 * before treating the return value as real API data.
 */
export const DRY_RUN_SKIP_MARKER = '__scout_dry_run_skip__' as const;

export interface DryRunSkip {
  [DRY_RUN_SKIP_MARKER]: true;
  notice: string;
}

export function isDryRunSkip(value: unknown): value is DryRunSkip {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[DRY_RUN_SKIP_MARKER] === true
  );
}

/**
 * Gate 1 enforcement point. Call this immediately before any state-changing HTTP call.
 *
 * - read-only: throws GuardrailError — the call must never be issued.
 * - dry-run: returns proceed=false with a notice — caller should execute the read/plan
 *   portion of the operation (e.g. resolve targets, count devices) and report what WOULD
 *   happen, but must skip the actual mutating request.
 * - write: returns proceed=true — the mutating call is permitted to go through (subject
 *   to gates 2 and 3 below).
 */
export function checkMutationAllowed(opName: string): MutationCheckResult {
  const mode = getScoutMode();

  if (mode === 'read-only') {
    throw new GuardrailError(
      `Blocked by SCOUT_MODE=read-only: "${opName}" would mutate Scout Board state. ` +
        'Set SCOUT_MODE=dry-run to preview, or SCOUT_MODE=write to allow mutations.',
      'mode',
    );
  }

  if (mode === 'dry-run') {
    return {
      proceed: false,
      dryRunNotice: `SCOUT_MODE=dry-run: "${opName}" was planned but not executed. Set SCOUT_MODE=write to perform it.`,
    };
  }

  return { proceed: true };
}

// ── Gate 2: Base/root write-protection ──────────────────────────────────────────

export interface WriteScope {
  /** True if this write targets Base config scope (config_update target=base) or the root OU. */
  isBaseOrRoot: boolean;
  /** Human-readable description of the scope, used in error messages. */
  label: string;
}

/**
 * Determine whether a config-write target represents Base scope. Base config inherits to
 * every device in the fleet, so writes here have the largest possible blast radius of any
 * single operation in this API.
 */
export function isBaseConfigTarget(target: 'base' | 'ou' | 'device'): boolean {
  return target === 'base';
}

/**
 * Determine whether an OU-scoped write targets the root OU. The root OU is represented in
 * this codebase as the OU returned by GET /api/v1/ou/root (see src/tools/ou.ts mode=root)
 * — callers that resolve an OU path/id should compare against that root OU's id/path
 * before calling this, since the API itself doesn't tag a request as "root" by syntax
 * alone (a root write is just an ou-scoped write whose path/id happens to match root).
 */
export function isRootOuTarget(params: {
  resolvedPath?: string;
  resolvedId?: number;
  rootPath?: string;
  rootId?: number;
}): boolean {
  if (params.resolvedId !== undefined && params.rootId !== undefined) {
    if (params.resolvedId === params.rootId) return true;
  }
  if (params.resolvedPath !== undefined && params.rootPath !== undefined) {
    if (params.resolvedPath === params.rootPath) return true;
  }
  // A bare "/" is always root regardless of what the live root lookup returned.
  if (params.resolvedPath === '/') return true;
  return false;
}

/**
 * Gate 2 enforcement point. Call this immediately before any write known to target Base
 * scope or the root OU. Independent of SCOUT_MODE — even SCOUT_MODE=write does not imply
 * Base/root writes are allowed; this arming flag must be separately set to true.
 */
export function checkBaseWriteAllowed(scope: WriteScope): void {
  if (!scope.isBaseOrRoot) return;

  if (process.env.SCOUT_ALLOW_BASE_WRITES !== 'true') {
    throw new GuardrailError(
      `Blocked: write targets ${scope.label}, which inherits to the entire fleet. ` +
        'Set SCOUT_ALLOW_BASE_WRITES=true to arm Base/root writes explicitly. ' +
        'This is independent of SCOUT_MODE and must be set deliberately.',
      'base-write',
    );
  }
}

// ── Gate 3: Blast-radius cap ─────────────────────────────────────────────────────

export const DEFAULT_BLAST_RADIUS = 25;

/**
 * Hard ceiling on the configurable blast-radius cap. SCOUT_MAX_BLAST_RADIUS cannot raise
 * the effective cap above this value — it can only be used to lower it, or raise it up to
 * this ceiling. Raising the ceiling itself requires a code change (and review), which is
 * the point: no single env var should be able to authorize an unbounded fleet-wide write.
 */
export const HARD_BLAST_RADIUS_CEILING = 500;

/**
 * Resolve the effective blast-radius cap from SCOUT_MAX_BLAST_RADIUS, clamped to
 * [1, HARD_BLAST_RADIUS_CEILING]. Falls back to DEFAULT_BLAST_RADIUS if unset or invalid.
 */
export function getBlastRadiusCap(): number {
  const raw = process.env.SCOUT_MAX_BLAST_RADIUS;
  if (!raw) return DEFAULT_BLAST_RADIUS;

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BLAST_RADIUS;

  return Math.min(parsed, HARD_BLAST_RADIUS_CEILING);
}

export interface BlastRadiusCheckParams {
  /** Number of devices the write operation would affect, after resolving OU scope/search. */
  affectedCount: number;
  /** Caller-supplied override flag (tool input field) to bypass the cap for this one call. */
  overrideBlastRadius?: boolean;
}

/**
 * Gate 3 enforcement point. Call this after resolving the device count for an OU-scope or
 * search-based write (e.g. after device/search but before issuing the bulk move/command),
 * and before issuing any mutating call.
 *
 * TODO(WS-D confirmation-token phase): `overrideBlastRadius: true` is a blunt bypass for
 * now — it has no expiry, no binding to the specific resolved device set, and no replay
 * protection. The later phase should replace this with a confirmation token minted from
 * a hash of (operation, resolved target IDs, timestamp) that the caller must echo back,
 * with staleness detection if the underlying device set changes between plan and execute.
 * Do not consider overrideBlastRadius production-safe for unattended/automated callers.
 */
export function checkBlastRadius(params: BlastRadiusCheckParams): void {
  const cap = getBlastRadiusCap();

  if (params.affectedCount <= cap) return;

  if (params.overrideBlastRadius === true) {
    if (params.affectedCount > HARD_BLAST_RADIUS_CEILING) {
      throw new GuardrailError(
        `Blocked: operation would affect ${params.affectedCount} devices, which exceeds the ` +
          `hard ceiling of ${HARD_BLAST_RADIUS_CEILING}. overrideBlastRadius cannot bypass the hard ceiling. ` +
          'Narrow the scope (e.g. a more specific search term or sub-OU) and retry.',
        'blast-radius',
      );
    }
    return;
  }

  throw new GuardrailError(
    `Blocked: operation would affect ${params.affectedCount} devices, exceeding the cap of ${cap} ` +
      `(set via SCOUT_MAX_BLAST_RADIUS, hard ceiling ${HARD_BLAST_RADIUS_CEILING}). ` +
      'Pass overrideBlastRadius=true to proceed anyway, or narrow the scope.',
    'blast-radius',
  );
}
