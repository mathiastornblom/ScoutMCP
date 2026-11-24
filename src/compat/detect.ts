/**
 * Scout version + capability detection. Best effort, read-only (GET only), never throws,
 * never blocks a tool: probes are the source of truth, the version table is advisory.
 *
 * VERSION SOURCES (honest status; no live server was available when this was written):
 *  1. GET /api/v1/ui/instances (private): rows with InstanceType 1/6/8 and `Version` (documented
 *     in the SBD-UI source review, confidence 'medium'); otherwise a generic `version` scan ('low').
 *  2. GET /api/v1/healthcheck?scoutServer=true: response.scoutServer.scoutServer[].Version, e.g.
 *     '15.2611' ('medium'); then ?scoutDatabase=true: response.scoutDatabase.version ('medium').
 *     The public healthcheck returns HTTP 200 even on errors (errors are in the body).
 *  3. Capability inference: a working ELIAS probe proves Scout >= 2611 (lower bound only).
 *  NOT used as server version:
 *   - openapi.json info.version ("25.11.0" = spec snapshot, shipped with the repo, not the
 *     live server). Reported separately as `specVersion` for information only.
 *   - Device `OSVersion` ("7.2609.0" ...) in the HAR is the eLux CLIENT OS, not Scout Board.
 * Confidence is therefore 'low' for any parsed value and 'none' when nothing is found.
 */

import { readFileSync } from 'node:fs';
import { ScoutError } from '../client.js';
import { CAPABILITIES, getCapability, type Capability, type CapabilityStatus } from './registry.js';

// ── Version parsing ───────────────────────────────────────────────────────────

/** Parses '7.2611.0-13', '2611', '25.11.0' ... into a comparable YYMM number (2611), or null. */
export function parseScoutVersion(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const validYymm = (n: number): boolean => {
    const yy = Math.floor(n / 100);
    const mm = n % 100;
    return yy >= 20 && yy <= 99 && mm >= 1 && mm <= 12;
  };
  // 4-digit YYMM token between separators: '2611', '7.2611.x', '7.2611.0-13'
  for (const tok of s.split(/[.\-_\s]/)) {
    if (/^\d{4}$/.test(tok) && validYymm(Number(tok))) return Number(tok);
  }
  // 'YY.MM[.x]' (OpenAPI-style '25.11.0')
  const m = /^(\d{2})\.(\d{1,2})(?:\.|$)/.exec(s);
  if (m) {
    const n = Number(m[1]) * 100 + Number(m[2]);
    if (validYymm(n)) return n;
  }
  return null;
}

/** True if detected >= required, both YYMM strings/numbers; null when either is unparseable. */
export function versionAtLeast(detected: number | null, required: string | null): boolean | null {
  if (detected === null || required === null) return null;
  const req = parseScoutVersion(required);
  return req === null ? null : detected >= req;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal client surface needed for probing (ScoutClient satisfies it; tests inject fakes). */
export interface ProbeClient {
  request<T>(method: string, path: string): Promise<T>;
  rawRequest<T>(method: string, path: string): Promise<T>;
}

export type AvailabilityState = 'available' | 'unavailable' | 'unknown';

export interface CapabilityResult {
  state: AvailabilityState;
  status: CapabilityStatus;
  minScoutVersion: string | null;
  reason?: string;
}

export type VersionSource =
  | 'server_instances'
  | 'healthcheck'
  | 'healthcheck_database'
  | 'capability-inference'
  | 'none';

export interface VersionInfo {
  /** Raw version string as reported (or '>=2611' for inference), null if unknown. */
  version: string | null;
  yymm: number | null;
  source: VersionSource;
  confidence: 'low' | 'medium' | 'none';
  /** openapi.json info.version of the shipped spec - informational, NOT the server version. */
  specVersion: string | null;
}

export interface CompatReport {
  scoutVersion: string | null;
  versionSource: VersionSource;
  versionConfidence: 'low' | 'medium' | 'none';
  specVersion: string | null;
  capabilities: Record<string, CapabilityResult>;
  /** Cases where the version table and a probe disagree (the probe wins). */
  disagreements: string[];
}

export interface DetectOptions {
  /** Cache TTL in ms (default 5 min). */
  ttlMs?: number;
  /** Per-probe timeout in ms (default 5 s). */
  timeoutMs?: number;
  /** Override for SCOUT_ENABLE_PRIVATE_ENDPOINTS (tests). */
  privateEnabled?: boolean;
  /** Clock injection (tests). */
  now?: () => number;
  /** Bypass the cache. */
  force?: boolean;
}

export const COMPAT_CACHE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 5_000;

// ── Probe execution / interpretation ──────────────────────────────────────────

/** Maps a probe outcome (success, or the thrown error) to an availability state. Pure. */
export function interpretProbe(
  cap: Capability,
  outcome: { ok: true } | { ok: false; error: unknown },
): { state: AvailabilityState; reason: string } {
  if (outcome.ok) return { state: 'available', reason: 'probe returned 2xx' };
  const err = outcome.error;
  // res.json() on a 200 with a non-JSON body throws SyntaxError: the route exists.
  if (err instanceof SyntaxError) return { state: 'available', reason: 'HTTP 200 with non-JSON body' };
  if (err instanceof ScoutError && err.statusCode !== undefined) {
    const sc = err.statusCode;
    if (sc === 404) {
      const marker = cap.probe?.notFoundMessageMeansAvailable;
      if (marker && err.message.toLowerCase().includes(marker.toLowerCase())) {
        return { state: 'available', reason: `HTTP 404 "${marker}" (route exists, entity not found)` };
      }
      return { state: 'unavailable', reason: 'HTTP 404' };
    }
    if (sc === 401 || sc === 403) return { state: 'unknown', reason: `forbidden/unknown (HTTP ${sc})` };
    if (sc === 400 && cap.probe?.badRequestMeansAvailable) {
      return { state: 'available', reason: 'HTTP 400 (route exists, probe omits required parameter)' };
    }
    return { state: 'unknown', reason: `HTTP ${sc}` };
  }
  return { state: 'unknown', reason: err instanceof Error ? `network/error: ${err.message}` : 'network/error' };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`probe timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function runProbe(
  client: ProbeClient,
  cap: Capability,
  privateEnabled: boolean,
  timeoutMs: number,
): Promise<CapabilityResult> {
  const base = { status: cap.status, minScoutVersion: cap.minScoutVersion };
  const probe = cap.probe;
  if (!probe) return { ...base, state: 'unknown', reason: 'not probeable (config-driven or syntax-level)' };
  if (probe.kind === 'private' && !privateEnabled) {
    return { ...base, state: 'unknown', reason: 'private endpoints disabled (SCOUT_ENABLE_PRIVATE_ENDPOINTS!=true)' };
  }
  try {
    const call =
      probe.kind === 'private'
        ? client.rawRequest<unknown>(probe.method, probe.path)
        : client.request<unknown>(probe.method, probe.path);
    await withTimeout(call, timeoutMs);
    return { ...base, ...interpretProbe(cap, { ok: true }) };
  } catch (error) {
    return { ...base, ...interpretProbe(cap, { ok: false, error }) };
  }
}

// ── Version detection ─────────────────────────────────────────────────────────

/** Accepts only short, plain version strings (server-controlled text must not reach tool output). */
export function sanitizeVersion(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  return s.length >= 1 && s.length <= 32 && /^[0-9A-Za-z._+-]+$/.test(s) ? s : null;
}

/** Case-insensitive own-property lookup on a plain object. */
function getKey(o: unknown, name: string): unknown {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const k = Object.keys(o).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : (o as Record<string, unknown>)[k];
}

/**
 * Known locations of the Scout instance/server version (documented in docs/compatibility.md):
 * `version`|`scoutVersion` on the root, under `response`, under `scoutServer`, or under
 * `response.scoutServer`; for an array body (instances list) the same paths on each of the
 * first 50 items. No deep search: a nested database/OS `version` elsewhere is never used.
 */
const VERSION_PATHS: string[][] = [
  ['version'],
  ['scoutVersion'],
  ['scoutServer', 'version'],
  ['scoutServer', 'scoutVersion'],
  ['response', 'version'],
  ['response', 'scoutVersion'],
  ['response', 'scoutServer', 'version'],
  ['response', 'scoutServer', 'scoutVersion'],
];

function versionAtPaths(v: unknown): string | null {
  for (const path of VERSION_PATHS) {
    let cur: unknown = v;
    for (const seg of path) cur = getKey(cur, seg);
    const s = sanitizeVersion(cur);
    if (s !== null && parseScoutVersion(s) !== null) return s;
  }
  return null;
}

export function findVersionField(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 50)) {
      const r = versionAtPaths(item);
      if (r) return r;
    }
    return null;
  }
  const direct = versionAtPaths(v);
  if (direct) return direct;
  const resp = getKey(v, 'response');
  if (Array.isArray(resp)) return findVersionField(resp);
  return null;
}

function readSpecVersion(): string | null {
  try {
    const raw = readFileSync(new URL('../../openapi.json', import.meta.url), 'utf-8');
    const info = (JSON.parse(raw) as { info?: { version?: unknown } }).info;
    return typeof info?.version === 'string' ? info.version : null;
  } catch {
    return null; // not shipped in the Docker image; informational only
  }
}

/** Documented: GET /rest/api/v1/healthcheck?scoutServer -> response.scoutServer.scoutServer[].Version ('15.2611'). */
export function findDocumentedServerVersion(v: unknown): string | null {
  const arr = getKey(getKey(getKey(v, 'response'), 'scoutServer'), 'scoutServer');
  if (!Array.isArray(arr)) return null;
  for (const row of arr.slice(0, 50)) {
    const s = sanitizeVersion(getKey(row, 'Version'));
    if (s !== null && parseScoutVersion(s) !== null) return s;
  }
  return null;
}

/** Documented: GET /rest/api/v1/healthcheck?scoutDatabase -> response.scoutDatabase.version. */
export function findDocumentedDatabaseVersion(v: unknown): string | null {
  const s = sanitizeVersion(getKey(getKey(getKey(v, 'response'), 'scoutDatabase'), 'version'));
  return s !== null && parseScoutVersion(s) !== null ? s : null;
}

/** Documented: GET /api/v1/ui/instances rows, InstanceType 1 (Server), 6 (DBLayer), 8 (Scout Board), field Version. */
export function findDocumentedInstanceVersion(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  for (const row of v.slice(0, 200)) {
    const t = Number(getKey(row, 'InstanceType'));
    if (t !== 1 && t !== 6 && t !== 8) continue;
    const s = sanitizeVersion(getKey(row, 'Version'));
    if (s !== null && parseScoutVersion(s) !== null) return s;
  }
  return null;
}

/** Best-effort server version. Never throws. */
export async function detectScoutVersion(
  client: ProbeClient,
  opts: DetectOptions = {},
): Promise<VersionInfo> {
  const privateEnabled = opts.privateEnabled ?? process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const specVersion = readSpecVersion();
  const found = (version: string, source: VersionSource, confidence: 'low' | 'medium' = 'low'): VersionInfo => ({
    version,
    yymm: parseScoutVersion(version),
    source,
    confidence,
    specVersion,
  });

  if (privateEnabled) {
    try {
      const data = await withTimeout(client.rawRequest<unknown>('GET', '/api/v1/ui/instances'), timeoutMs);
      const doc = findDocumentedInstanceVersion(data);
      if (doc) return found(doc, 'server_instances', 'medium');
      const v = findVersionField(data);
      if (v) return found(v, 'server_instances');
    } catch {
      /* fall through to next source */
    }
  }
  try {
    const data = await withTimeout(
      client.request<unknown>('GET', '/api/v1/healthcheck?scoutServer=true'),
      timeoutMs,
    );
    const doc = findDocumentedServerVersion(data);
    if (doc) return found(doc, 'healthcheck', 'medium');
    const v = findVersionField(data);
    if (v) return found(v, 'healthcheck');
  } catch {
    /* fall through */
  }
  try {
    // NB: the public healthcheck answers HTTP 200 even on errors (errors are in the body).
    const data = await withTimeout(
      client.request<unknown>('GET', '/api/v1/healthcheck?scoutDatabase=true'),
      timeoutMs,
    );
    const doc = findDocumentedDatabaseVersion(data);
    if (doc) return found(doc, 'healthcheck_database', 'medium');
  } catch {
    /* fall through */
  }
  return { version: null, yymm: null, source: 'none', confidence: 'none', specVersion };
}

// ── Capability detection (cached) ─────────────────────────────────────────────

interface CacheEntry {
  at: number;
  report: CompatReport;
}
const cache = new WeakMap<object, CacheEntry>();
const inflight = new WeakMap<object, Promise<CompatReport>>();

/** Clears the per-client cache for a client (tests / reconfigure). */
export function resetCompatCache(client: object): void {
  cache.delete(client);
}

/** Runs all probes + version detection. Never throws. Cached per client with a TTL. */
export async function detectCapabilities(
  client: ProbeClient,
  opts: DetectOptions = {},
): Promise<CompatReport> {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? COMPAT_CACHE_TTL_MS;
  const hit = cache.get(client);
  if (!opts.force && hit && now() - hit.at <= ttl) return hit.report;
  if (!opts.force) {
    const pending = inflight.get(client);
    if (pending) return pending;
  }
  const run = computeReport(client, opts, now);
  inflight.set(client, run);
  try {
    return await run;
  } finally {
    if (inflight.get(client) === run) inflight.delete(client);
  }
}

async function computeReport(client: ProbeClient, opts: DetectOptions, now: () => number): Promise<CompatReport> {
  const privateEnabled = opts.privateEnabled ?? process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let report: CompatReport;
  try {
    const [version, results] = await Promise.all([
      detectScoutVersion(client, opts),
      Promise.all(CAPABILITIES.map(async (c) => [c.id, await runProbe(client, c, privateEnabled, timeoutMs)] as const)),
    ]);
    const capabilities: Record<string, CapabilityResult> = Object.fromEntries(results);

    let { version: vStr, yymm, source, confidence } = version;
    // Lower-bound inference from a working ELIAS probe when no version field was found.
    if (yymm === null && capabilities['elias']?.state === 'available') {
      const min = getCapability('elias')?.minScoutVersion ?? null;
      if (min) {
        vStr = `>=${min}`;
        yymm = parseScoutVersion(min);
        source = 'capability-inference';
        confidence = 'low';
      }
    }

    const disagreements: string[] = [];
    if (source !== 'capability-inference') {
      for (const c of CAPABILITIES) {
        const r = capabilities[c.id];
        const expected = versionAtLeast(yymm, c.minScoutVersion);
        if (!r || expected === null || r.state === 'unknown') continue;
        if (expected !== (r.state === 'available')) {
          disagreements.push(
            `${c.id}: version table says ${expected ? 'available' : 'unavailable'} (detected ${vStr}, requires >=${c.minScoutVersion}) but probe says ${r.state}; probe wins`,
          );
        }
      }
    }
    report = {
      scoutVersion: vStr,
      versionSource: source,
      versionConfidence: confidence,
      specVersion: version.specVersion,
      capabilities,
      disagreements,
    };
  } catch (err) {
    // Defensive: detection must never throw into a tool handler.
    report = {
      scoutVersion: null,
      versionSource: 'none',
      versionConfidence: 'none',
      specVersion: null,
      capabilities: {},
      disagreements: [`detection failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  cache.set(client, { at: now(), report });
  return report;
}

// ── requireCapability ─────────────────────────────────────────────────────────

/**
 * Message for a tool handler, or null when the tool should proceed. Only a probe result of
 * 'unavailable' blocks; 'unknown' (forbidden, network, 5xx, not probeable) proceeds, so
 * detection problems can never block a working feature.
 */
export async function requireCapability(
  id: string,
  client: ProbeClient,
  opts: DetectOptions = {},
): Promise<string | null> {
  const cap = getCapability(id);
  if (!cap) return null;
  const report = await detectCapabilities(client, opts);
  if (report.capabilities[id]?.state !== 'unavailable') return null;
  const detected = report.scoutVersion ?? 'unknown';
  return cap.minScoutVersion
    ? `${id} requires Scout >=${cap.minScoutVersion} (detected ${detected}); the server returned HTTP 404 for ${cap.probe?.path ?? 'its endpoint'}`
    : `${id} is not available on this Scout server (detected ${detected}); the minimum Scout version for it is not established`;
}
