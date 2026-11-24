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
  /** Writer process id (set automatically); lets recovery leave another live process's in-flight intents alone. */
  pid?: number;
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

/** Short error code (EACCES, ENOSPC, ...) or UNKNOWN; never the message (it contains local paths). */
function fsErrorCode(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{2,24}$/.test(c) ? c : 'UNKNOWN';
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
  const line = JSON.stringify({ timestamp: new Date().toISOString(), actor: actor(), pid: process.pid, ...row }) + '\n';
  const existed = fsImpl.existsSync(path);
  const fd = fsImpl.openSync(path, 'a', 0o600);
  try {
    try {
      fsImpl.fchmodSync(fd, 0o600);
    } catch {
      /* best effort: some filesystems refuse chmod */
    }
    // writeSync may write fewer bytes than asked: loop until the whole row is out (F7).
    const total = Buffer.byteLength(line);
    let written = fsImpl.writeSync(fd, line);
    if (typeof written !== 'number') written = total;
    if (written < total) {
      const rest = Buffer.from(line).subarray(written);
      let off = 0;
      while (off < rest.length) {
        const n = fsImpl.writeSync(fd, rest, off, rest.length - off);
        if (n <= 0) throw new Error('short write');
        off += n;
      }
    }
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  if (!existed && dir) syncDirectory(dir);
}

/** Best effort: make the new directory entry durable after the file was created (F7). */
function syncDirectory(dir: string): void {
  try {
    const dfd = fsImpl.openSync(dir, 'r');
    try {
      fsImpl.fsyncSync(dfd);
    } finally {
      fsImpl.closeSync(dfd);
    }
  } catch {
    /* some platforms refuse fsync on a directory */
  }
}

/** Blocking write-ahead row. Throws EliasAuditError when the row could not be durably written. */
export function appendIntentRow(row: EliasAuditRow): void {
  try {
    appendRow(row);
  } catch (err) {
    // Fixed text plus an error CODE only: fs messages carry absolute local paths (C7).
    throw new EliasAuditError(`audit intent row could not be written (error code ${fsErrorCode(err)}); the mutation is blocked`);
  }
}

/** Best-effort row (refusals, plans, results). Returns false when the write failed. */
export function appendAuditRow(row: EliasAuditRow): boolean {
  try {
    appendRow(row);
    return true;
  } catch (err) {
    process.stderr.write(`[scout-mcp/elias-audit] failed to write audit row (error code ${fsErrorCode(err)})\n`);
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
export function findUnresolvedIntents(rows: Array<Record<string, unknown>>): Array<{ opId: string; opName: string; timestamp: string; pid?: number }> {
  const intents = new Map<string, { opId: string; opName: string; timestamp: string; pid?: number }>();
  const resolved = new Set<string>();
  for (const r of rows) {
    const opId = typeof r.opId === 'string' ? r.opId : undefined;
    if (!opId) continue;
    if (r.phase === 'intent') {
      intents.set(opId, { opId, opName: String(r.opName ?? ''), timestamp: String(r.timestamp ?? ''), pid: typeof r.pid === 'number' ? r.pid : undefined });
    } else if (r.phase === 'result' || r.phase === 'recovered-unknown') {
      resolved.add(opId);
    }
  }
  return [...intents.values()].filter((i) => !resolved.has(i.opId));
}

/** An intent is left alone when it belongs to ANOTHER live process and is recent (that op may still finish). */
const RECENT_FOREIGN_MS = 15 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string } | null)?.code === 'EPERM';
  }
}

export interface RecoverOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
}

/** Startup recovery: one `recovered-unknown` row per unresolved intent. Returns the opIds recovered. */
export function recoverUnknownIntents(opts: RecoverOptions = {}): string[] {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? processAlive;
  const unresolved = findUnresolvedIntents(readAuditRows());
  const done: string[] = [];
  for (const u of unresolved) {
    const age = now - Date.parse(u.timestamp);
    if (u.pid !== undefined && u.pid !== process.pid && Number.isFinite(age) && age < RECENT_FOREIGN_MS && alive(u.pid)) continue;
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
