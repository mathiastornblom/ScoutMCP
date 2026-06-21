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
 *
 * This round (WS-D round 2) adds five more gates, all funneled through the same module:
 *
 *   4. Kill switch          — sentinel file forces read-only regardless of SCOUT_MODE.
 *   5. Circuit breaker      — N destructive ops within T seconds trips a hard stop.
 *   6. Protected/allowed OU — deny-list (and optional allow-list) of OU paths for writes.
 *   7. Private-writes-in-production — extra flag required to allow high-risk private
 *      endpoints to mutate when SCOUT_MODE=write.
 *   8. Audit log + snapshot — side-effecting helpers (not gates per se) that record every
 *      mutation attempt and capture effective config before fleet-scope writes.
 *
 * checkMutationAllowed() remains the single chokepoint tools call before any mutating
 * request: it now also enforces the kill switch and circuit breaker (gates that apply to
 * *every* mutating call, regardless of scope), in addition to the original mode-tier gate.
 * Gates 2, 3, 6, and 7 stay as separate dedicated helpers because — same as gates 2/3
 * originally — only the tool layer knows the semantic scope (OU path, private-endpoint
 * identity, resolved device count) needed to evaluate them.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
    public readonly gate:
      | 'mode'
      | 'base-write'
      | 'blast-radius'
      | 'protected-ou'
      | 'circuit-breaker'
      | 'kill-switch'
      | 'private-write-production'
      | 'unresolvable-source-ou',
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
  // Gate 4 (kill switch) and Gate 5 (circuit breaker) apply to every mutating call,
  // regardless of mode/scope, and are checked first — they are blunt, total stops.
  checkKillSwitch(opName);
  checkCircuitBreaker(opName);

  const mode = getScoutMode();

  if (mode === 'read-only') {
    auditLog({ opName, target: 'unknown', result: 'refused', gate: 'mode' });
    throw new GuardrailError(
      `Blocked by SCOUT_MODE=read-only: "${opName}" would mutate Scout Board state. ` +
        'Set SCOUT_MODE=dry-run to preview, or SCOUT_MODE=write to allow mutations.',
      'mode',
    );
  }

  if (mode === 'dry-run') {
    auditLog({ opName, target: 'unknown', result: 'refused', gate: 'mode', detail: 'dry-run skip' });
    return {
      proceed: false,
      dryRunNotice: `SCOUT_MODE=dry-run: "${opName}" was planned but not executed. Set SCOUT_MODE=write to perform it.`,
    };
  }

  // Mode gate passed — record the attempt as allowed and count it toward the circuit
  // breaker's sliding window. Tools that go on to fail a later gate (base-write,
  // blast-radius, protected-OU) log their own refusal at that gate; this entry just
  // marks that Gate 1/4/5 did not block the call.
  recordDestructiveOp();
  auditLog({ opName, target: 'unknown', result: 'allowed', gate: null });

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

// ── Gate 4: Kill switch ──────────────────────────────────────────────────────────

/**
 * Resolves the kill-switch sentinel file path from SCOUT_KILL_SWITCH_FILE, defaulting to
 * ./KILL_SWITCH (relative to the process cwd). Read fresh from env on every call, same
 * rationale as getScoutMode() — no caching, so an operator's `touch`/`rm` takes effect on
 * the very next mutating call without a restart.
 */
export function getKillSwitchPath(): string {
  return process.env.SCOUT_KILL_SWITCH_FILE || './KILL_SWITCH';
}

/**
 * Returns true if the kill switch is currently engaged (the sentinel file exists).
 * Operator workflow: `touch ./KILL_SWITCH` (or the path in SCOUT_KILL_SWITCH_FILE) to force
 * every mutating call into read-only immediately, irrespective of SCOUT_MODE; `rm` the file
 * to clear it. No process restart is required in either direction — the check is a fresh
 * `existsSync` on every call.
 */
export function isKillSwitchEngaged(): boolean {
  try {
    return existsSync(getKillSwitchPath());
  } catch {
    // Filesystem errors (permissions, exotic paths) fail closed: treat as engaged so a
    // broken check can never silently grant write access.
    return true;
  }
}

/** Gate 4 enforcement point. Throws if the kill switch is engaged. Checked first, before
 *  any other gate, inside checkMutationAllowed(). */
export function checkKillSwitch(opName: string): void {
  if (!isKillSwitchEngaged()) return;
  auditLog({ opName, target: 'unknown', result: 'refused', gate: 'kill-switch' });
  throw new GuardrailError(
    `Blocked: kill switch is engaged (sentinel file "${getKillSwitchPath()}" exists). ` +
      'All mutating calls are forced read-only until the file is removed. ' +
      `Clear it with: rm ${getKillSwitchPath()}`,
    'kill-switch',
  );
}

// ── Gate 5: Circuit breaker ──────────────────────────────────────────────────────

export const DEFAULT_CIRCUIT_BREAKER_MAX_OPS = 10;
export const DEFAULT_CIRCUIT_BREAKER_WINDOW_SECONDS = 60;

function getCircuitBreakerMaxOps(): number {
  const raw = process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS;
  if (!raw) return DEFAULT_CIRCUIT_BREAKER_MAX_OPS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CIRCUIT_BREAKER_MAX_OPS;
}

function getCircuitBreakerWindowMs(): number {
  const raw = process.env.SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CIRCUIT_BREAKER_WINDOW_SECONDS;
  return seconds * 1000;
}

/**
 * In-memory sliding window of destructive-op timestamps, plus a "tripped" flag. Single
 * process, no distributed state needed (per task spec) — this server runs as one MCP
 * stdio process per session.
 *
 * Re-arm design: once tripped, the breaker requires an EXPLICIT call to
 * resetCircuitBreaker() (exposed as a tool/operator action) — it does NOT auto-clear when
 * the window passes. Rationale: a time-based-only cooldown means a runaway agent that
 * tripped the breaker can simply keep retrying and resume the moment the window rolls
 * over, with no human in the loop. Requiring an explicit re-arm forces a human (or a
 * deliberate, separate tool call) to acknowledge the trip before mutations resume. The
 * tradeoff is operational friction: if nobody calls resetCircuitBreaker(), the server
 * stays read-only-for-writes until a process restart (which also clears the in-memory
 * window). This is intentional — documented in README and the security review as the
 * chosen tradeoff for this round.
 */
let opTimestamps: number[] = [];
let tripped = false;

/** Records one allowed destructive-op attempt and trips the breaker if the configured
 *  threshold is exceeded within the configured window. Called from checkMutationAllowed()
 *  after the mode gate passes (read-only-blocked attempts never reach the client and are
 *  not destructive, so they do not count toward the window). */
function recordDestructiveOp(): void {
  if (tripped) return; // already tripped — no need to keep growing the window
  const now = Date.now();
  const windowMs = getCircuitBreakerWindowMs();
  opTimestamps = opTimestamps.filter((t) => now - t < windowMs);
  opTimestamps.push(now);
  if (opTimestamps.length > getCircuitBreakerMaxOps()) {
    tripped = true;
  }
}

/** Gate 5 enforcement point. Throws if the breaker is currently tripped. Checked on every
 *  mutating call attempt, before recordDestructiveOp() runs, inside checkMutationAllowed(). */
export function checkCircuitBreaker(opName: string): void {
  if (!tripped) return;
  auditLog({ opName, target: 'unknown', result: 'refused', gate: 'circuit-breaker' });
  throw new GuardrailError(
    `Blocked: circuit breaker is tripped (more than ${getCircuitBreakerMaxOps()} destructive ` +
      `ops within ${getCircuitBreakerWindowMs() / 1000}s). All mutating calls are refused until ` +
      'an explicit re-arm via resetCircuitBreaker() (or a process restart).',
    'circuit-breaker',
  );
}

/** Returns true if the breaker is currently tripped. Exposed for tests and for a future
 *  status/diagnostics tool to surface breaker state without tripping it further. */
export function isCircuitBreakerTripped(): boolean {
  return tripped;
}

/** Explicit re-arm: clears the tripped flag and the sliding window. This is the only way
 *  to resume mutations after a trip (besides a process restart, which has the same effect
 *  on this in-memory state). Intended to be wired to an operator-facing tool/flag in a
 *  later round; exposed here so it is unit-testable now. */
export function resetCircuitBreaker(): void {
  tripped = false;
  opTimestamps = [];
}

/** Test-only escape hatch to reset breaker state between unrelated test cases without
 *  going through the public resetCircuitBreaker() semantics (which is identical here, but
 *  kept separate in case re-arm semantics grow more ceremony later, e.g. a cooldown). */
export function __resetCircuitBreakerStateForTests(): void {
  tripped = false;
  opTimestamps = [];
}

// ── Gate 6: Protected/allowed OU lists ───────────────────────────────────────────

function parseOuList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Accept either a JSON array string or a comma-separated list.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeOuPath(path: string): string {
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/** True if `candidate` is exactly `ancestorOrSelf`, or a descendant of it (path-prefix
 *  match on path segments, not raw string prefix — so "/Enterprise2" is not treated as a
 *  descendant of "/Enterprise"). */
function isSameOrDescendant(candidate: string, ancestorOrSelf: string): boolean {
  const c = normalizeOuPath(candidate);
  const a = normalizeOuPath(ancestorOrSelf);
  if (c === a) return true;
  if (a === '/') return true; // everything is a descendant of root
  return c.startsWith(a + '/');
}

export function getProtectedOus(): string[] {
  return parseOuList(process.env.SCOUT_PROTECTED_OUS);
}

export function getAllowedOus(): string[] {
  return parseOuList(process.env.SCOUT_ALLOWED_OUS);
}

export interface OuWriteCheckParams {
  /** Resolved target OU path being written to (or that a device/bulk write resolves under). */
  targetPath: string;
}

/**
 * Gate 6 enforcement point. Call before any write whose scope resolves to (or under) a
 * specific OU path — target=ou config writes, OU-scoped bulk operations, device moves,
 * etc. Two independent checks:
 *
 *   - Deny list (SCOUT_PROTECTED_OUS): if the target path is the protected OU itself OR any
 *     descendant of it, the write is blocked. Judgment call: a write to a *descendant* of a
 *     protected OU is blocked too, not just exact-path matches. Rationale — protecting an OU
 *     but not its children would be nearly useless for the common case (protecting e.g.
 *     "/Enterprise/Production" should also protect "/Enterprise/Production/Floor3"); the
 *     point of marking an OU protected is almost always "this whole subtree is off-limits."
 *     Edge case this creates: there is no way to protect a parent OU's *own* config (e.g.
 *     its description) while leaving children writable — protecting a node always protects
 *     its entire subtree. If finer-grained control is needed later, this would need a
 *     separate "exact-match only" list, which this round does not implement.
 *   - Allow list (SCOUT_ALLOWED_OUS): if set (non-empty), it is treated as an exhaustive
 *     allow-list for ALL writes — the target path must be the allowed OU itself or a
 *     descendant of one of the allowed entries, or the write is blocked. If unset, every OU
 *     not on the deny list is allowed (allow-list is opt-in, not on by default).
 *
 * Deny-list wins over allow-list if both somehow overlap (deny is checked first; an OU that
 * is both allowed and protected is still blocked) — protected always means protected.
 */
export function checkOuWriteAllowed(params: OuWriteCheckParams): void {
  const protectedOus = getProtectedOus();
  for (const denied of protectedOus) {
    if (isSameOrDescendant(params.targetPath, denied)) {
      auditLog({
        opName: 'ou-write-check',
        target: params.targetPath,
        result: 'refused',
        gate: 'protected-ou',
        detail: `matches protected OU "${denied}"`,
      });
      throw new GuardrailError(
        `Blocked: "${params.targetPath}" is protected (matches or is a descendant of "${denied}" in ` +
          'SCOUT_PROTECTED_OUS). Writes to this subtree are never allowed regardless of SCOUT_MODE.',
        'protected-ou',
      );
    }
  }

  const allowedOus = getAllowedOus();
  if (allowedOus.length === 0) return; // no allow-list configured — everything not denied is fine

  const isAllowed = allowedOus.some((allowed) => isSameOrDescendant(params.targetPath, allowed));
  if (!isAllowed) {
    auditLog({
      opName: 'ou-write-check',
      target: params.targetPath,
      result: 'refused',
      gate: 'protected-ou',
      detail: 'not under any SCOUT_ALLOWED_OUS entry',
    });
    throw new GuardrailError(
      `Blocked: "${params.targetPath}" is not under any OU listed in SCOUT_ALLOWED_OUS. ` +
        'When SCOUT_ALLOWED_OUS is set, writes are restricted to only those OUs (and their descendants).',
      'protected-ou',
    );
  }
}

// ── Gate 7: Private endpoints hard-off in production (SCOUT_MODE=write) ─────────────

/**
 * Gate 7 enforcement point. Call from the high-risk private-endpoint tools (db_cleanup
 * delete, system_settings set_device_password, admin_manage destructive actions) before
 * their own checkMutationAllowed() call. Belt-and-suspenders on top of
 * SCOUT_ENABLE_PRIVATE_ENDPOINTS: when SCOUT_MODE=write (full production), these specific
 * endpoints are hard-disabled by default even if private endpoints are otherwise enabled,
 * requiring SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true to re-enable. Only applies when
 * mode is exactly 'write' — read-only/dry-run already block or no-op the mutation via Gate
 * 1, so this gate would be redundant (and confusingly worded) there.
 */
export function checkPrivateWriteAllowedInProduction(opName: string): void {
  if (getScoutMode() !== 'write') return;
  if (process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION === 'true') return;

  auditLog({ opName, target: 'unknown', result: 'refused', gate: 'private-write-production' });
  throw new GuardrailError(
    `Blocked: "${opName}" is a high-risk private endpoint and SCOUT_MODE=write (production). ` +
      'Private-endpoint writes are hard-disabled in production by default, even with ' +
      'SCOUT_ENABLE_PRIVATE_ENDPOINTS=true. Set SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true ' +
      'to explicitly re-enable this specific high-risk endpoint in production.',
    'private-write-production',
  );
}

// ── Gate 8 (non-blocking): Append-only audit log ─────────────────────────────────

export interface AuditLogEntry {
  timestamp: string;
  opName: string;
  target: string;
  operation?: string;
  blastRadius?: number;
  actor: string;
  result: 'allowed' | 'refused' | 'error';
  gate: GuardrailError['gate'] | null;
  detail?: string;
}

export function getAuditLogPath(): string {
  return process.env.SCOUT_AUDIT_LOG_PATH || './logs/scout-audit.log';
}

/**
 * Appends one newline-delimited JSON record to the audit log. Append-only at the OS
 * level as much as practical: opened with the 'a' flag (POSIX O_APPEND semantics via
 * Node's fs), never truncated, never rewritten. Directory is created on first write if
 * missing. Failures to write the audit log are swallowed (logged to stderr) rather than
 * thrown — an audit-log failure must never block or crash a security gate's own
 * decision, since that would make the audit subsystem itself a new way to deny service.
 *
 * Durability/rotation honestly noted as NOT handled this round: no log rotation, no size
 * cap, no fsync-per-write guarantee beyond what the OS append flag gives you, and no
 * tamper-evidence (e.g. hash chaining) — this is a plain append-only file, suitable as an
 * immediate "what happened" trail, not a forensic-grade audit system.
 */
export function auditLog(entry: Omit<AuditLogEntry, 'timestamp' | 'actor'> & { actor?: string }): void {
  try {
    const path = getAuditLogPath();
    const dir = dirname(path);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const full: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      actor: entry.actor ?? getBestEffortActor(),
      ...entry,
    };
    appendFileSync(path, JSON.stringify(full) + '\n', { encoding: 'utf-8', flag: 'a' });
  } catch (err) {
    process.stderr.write(
      `[scout-mcp/audit] failed to write audit log entry: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Best-effort actor identity. This codebase's session/auth layer (src/session.ts) stores
 * Scout Board credentials for the MCP server's own connection to Scout, not an
 * upstream-caller identity — there is no per-call MCP client/user identity threaded through
 * today (stdio transport, single session). Rather than fabricate a username, this honestly
 * reports "unknown" unless SCOUT_AUDIT_ACTOR is explicitly set (e.g. by a deployment that
 * wraps this server and knows which human/automation triggered the session).
 */
function getBestEffortActor(): string {
  return process.env.SCOUT_AUDIT_ACTOR || 'unknown';
}

// ── Gate 8b (non-blocking): Snapshot-before-mutate ───────────────────────────────

export function getSnapshotDir(): string {
  return process.env.SCOUT_SNAPSHOT_DIR || './logs/scout-snapshots';
}

/**
 * Writes a JSON snapshot file capturing the caller-supplied effective-config payload
 * (typically the result of config_resolve / RSoP) before a fleet-scope write (OU-scope or
 * bulk multi-device) executes. This is a rollback reference point, not an automatic
 * rollback mechanism — restoring from a snapshot is a manual operator action (re-apply the
 * captured values via config_update) in this round.
 *
 * Deliberately does NOT push to git — file-based only. A future option (not implemented
 * here) would be to git-add/commit the logs/scout-snapshots directory as a separate repo
 * or worktree so snapshots get version history "for free"; skipped this round per the
 * task's explicit scope note.
 *
 * Filename: `<ISO-timestamp-with-no-colons>-<target>.json` under SCOUT_SNAPSHOT_DIR.
 * Returns the path written, or undefined if the write failed (failures are logged to
 * stderr and swallowed — same rationale as auditLog: a snapshot failure must never block
 * the write it is meant to back up, only the explicit gates above get to block writes).
 */
export function writeSnapshot(target: string, data: unknown): string | undefined {
  try {
    const dir = getSnapshotDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const safeTarget = target.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${dir}/${timestamp}-${safeTarget}.json`;
    writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf-8', flag: 'wx' });
    return path;
  } catch (err) {
    process.stderr.write(
      `[scout-mcp/snapshot] failed to write snapshot: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}
