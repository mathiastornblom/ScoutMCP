/**
 * Write-ahead audit for ELIAS writes (design section 7; Security C7, C26).
 *
 * - The INTENT row is appended with O_APPEND, written and fsynced BEFORE the mutating call. If it
 *   cannot be written, the mutation is blocked (fail closed): `appendIntentRow` throws.
 * - Result / refusal rows are best-effort (a failed write is reported on stderr, never swallowed
 *   silently, but it must not turn a completed mutation into a lie).
 * - The file is created 0600 (directory 0700). Same path as the legacy audit log (getAuditLogPath()).
 * - An intent without a result row is an unknown operation; `recoverUnknownIntents` appends
 *   `recovered-unknown` rows at startup so it is surfaced exactly once.
 * - Row content: ids, validated names, hashes, statuses. Never tokens, bodies, IDF text or absolute paths
 *   in anything that is returned to the model (only `auditFileName()` basename is exposed).
 */

import * as nodeFs from 'node:fs';
import { basename, dirname } from 'node:path';
import { getAuditLogPath } from '../safety/guardrails.js';

export type AuditPhase = 'intent' | 'result' | 'plan' | 'refusal' | 'recovered-unknown';
export type AuditOutcome = 'committed' | 'failed' | 'unknown' | 'not-applied';

export interface EliasAuditRow {
  opName: string;
  opId: string;
  phase: AuditPhase;
  tier: 'A0' | 'A' | 'B';
  /** Container id or `new:<validated name>`; server names pass through safeDisplay first. */
  target: string;
  result?: 'allowed' | 'refused' | 'error' | 'unknown';
  gate?: string | null;
  outcome?: AuditOutcome;
  httpStatus?: number;
  msgId?: string;
  bodySha256?: string;
  bodyBytes?: number;
  planDigest?: string;
  createdId?: string;
  elapsedMs?: number;
  restorable?: boolean;
  rights?: 'allowed' | 'denied' | 'unknown';
  dryRun?: boolean;
  /** Set when the op ran through the D0 escape hatch (body not verified-live). */
  unverified?: boolean;
  detail?: string;
}

export class EliasAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EliasAuditError';
  }
}

/** Swappable fs surface so tests can record the fsync order and inject failures. */
export interface AuditFs {
  mkdirSync: typeof nodeFs.mkdirSync;
  openSync: typeof nodeFs.openSync;
  writeSync: typeof nodeFs.writeSync;
  fsyncSync: typeof nodeFs.fsyncSync;
  fchmodSync: typeof nodeFs.fchmodSync;
  closeSync: typeof nodeFs.closeSync;
  existsSync: typeof nodeFs.existsSync;
  readFileSync: typeof nodeFs.readFileSync;
  statSync: typeof nodeFs.statSync;
}

const realFs: AuditFs = {
  mkdirSync: nodeFs.mkdirSync,
  openSync: nodeFs.openSync,
  writeSync: nodeFs.writeSync,
  fsyncSync: nodeFs.fsyncSync,
  fchmodSync: nodeFs.fchmodSync,
  closeSync: nodeFs.closeSync,
  existsSync: nodeFs.existsSync,
  readFileSync: nodeFs.readFileSync,
  statSync: nodeFs.statSync,
};
let fsImpl: AuditFs = realFs;

/** Test hook: replace (or restore with no argument) the fs implementation. */
export function __setAuditFsForTests(impl?: Partial<AuditFs>): void {
  fsImpl = impl ? { ...realFs, ...impl } : realFs;
}

function actor(): string {
  return process.env.SCOUT_AUDIT_ACTOR || 'unknown';
}

/** Basename only: tool output must never carry absolute local paths (C7). */
export function auditFileName(): string {
  return basename(getAuditLogPath());
}

function appendRow(row: EliasAuditRow | Record<string, unknown>): void {
  const path = getAuditLogPath();
  const dir = dirname(path);
  if (dir && dir !== '.' && !fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), actor: actor(), ...row }) + '\n';
  const fd = fsImpl.openSync(path, 'a', 0o600);
  try {
    try {
      fsImpl.fchmodSync(fd, 0o600);
    } catch {
      /* best effort: some filesystems refuse chmod */
    }
    fsImpl.writeSync(fd, line);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

/** Blocking write-ahead row. Throws EliasAuditError when the row could not be durably written. */
export function appendIntentRow(row: EliasAuditRow): void {
  try {
    appendRow(row);
  } catch (err) {
    throw new EliasAuditError(`audit intent row could not be written (${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : 'error'}); the mutation is blocked`);
  }
}

/** Best-effort row (refusals, plans, results). Returns false when the write failed. */
export function appendAuditRow(row: EliasAuditRow): boolean {
  try {
    appendRow(row);
    return true;
  } catch (err) {
    process.stderr.write(`[scout-mcp/elias-audit] failed to write audit row: ${err instanceof Error ? err.message.split('\n')[0] : 'error'}\n`);
    return false;
  }
}

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** Parses the tail of the audit file (last MAX_SCAN_BYTES). Malformed lines are skipped. */
export function readAuditRows(path = getAuditLogPath()): Array<Record<string, unknown>> {
  try {
    if (!fsImpl.existsSync(path)) return [];
    const size = fsImpl.statSync(path).size;
    let text = fsImpl.readFileSync(path, 'utf-8');
    if (size > MAX_SCAN_BYTES) text = text.slice(text.length - MAX_SCAN_BYTES);
    const rows: Array<Record<string, unknown>> = [];
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* skip a truncated first line or garbage */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** opIds with an intent row but no result / recovered row. */
export function findUnresolvedIntents(rows: Array<Record<string, unknown>>): Array<{ opId: string; opName: string; timestamp: string }> {
  const intents = new Map<string, { opId: string; opName: string; timestamp: string }>();
  const resolved = new Set<string>();
  for (const r of rows) {
    const opId = typeof r.opId === 'string' ? r.opId : undefined;
    if (!opId) continue;
    if (r.phase === 'intent') {
      intents.set(opId, { opId, opName: String(r.opName ?? ''), timestamp: String(r.timestamp ?? '') });
    } else if (r.phase === 'result' || r.phase === 'recovered-unknown') {
      resolved.add(opId);
    }
  }
  return [...intents.values()].filter((i) => !resolved.has(i.opId));
}

/** Startup recovery: one `recovered-unknown` row per unresolved intent. Returns the opIds recovered. */
export function recoverUnknownIntents(): string[] {
  const unresolved = findUnresolvedIntents(readAuditRows());
  const done: string[] = [];
  for (const u of unresolved) {
    const ok = appendAuditRow({
      opName: u.opName,
      opId: u.opId,
      phase: 'recovered-unknown',
      tier: 'A',
      target: 'unknown',
      result: 'unknown',
      outcome: 'unknown',
      detail: 'intent row without a result row (process ended or crashed mid-operation)',
    });
    if (ok) done.push(u.opId);
  }
  return done;
}
