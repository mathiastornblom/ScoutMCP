/**
 * Shared OU write gate used by EVERY tool that mutates with an OU path/id.
 *
 * One pattern, in one place, so no tool can drift from it:
 *   1. resolve ALL supplied references against a FRESH OU tree (resolveWriteTarget) and refuse when
 *      they name different OUs;
 *   2. (optional) a top-level OU requires SCOUT_ALLOW_BASE_WRITES (derived from the same parsed
 *      tree, no /ou/root call);
 *   3. SCOUT_ENV=test scope guard on the RESOLVED canonical path (segment-prefix compare);
 *   4. SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS on the RESOLVED canonical path;
 *   5. every refusal (including unresolvable refs and an unreadable tree) is audit-logged.
 *
 * Callers MUST send only the returned `ouid` to the server and call assertOuPathUnchanged(ouid,
 * path) right before the mutating call (and after any confirm prompt), so the gated OU and the
 * written OU are the same by construction.
 */

import { resolveWriteTarget, collectOuSubtree, resolveOuIdsFresh, type OuMatch } from '../resolver.js';
import { readDeviceOuId, readDeviceOuIds, type DeviceRecord } from '../devices.js';
import { buildQuery } from '../types.js';
import { canonicalizeOuPath, OuPathError } from '../ou_path.js';
import {
  auditLog,
  checkBaseWriteAllowed,
  checkOuWriteAllowed,
  getAllowedOus,
  getProtectedOus,
  GuardrailError,
} from './guardrails.js';

export type OuRef = string | number | undefined;

/** True when SCOUT_PROTECTED_OUS or SCOUT_ALLOWED_OUS is set (a lookup only needed for those gates). */
export function ouListsConfigured(): boolean {
  return getProtectedOus().length > 0 || getAllowedOus().length > 0;
}

/**
 * SCOUT_ENV=test scope guard on a RESOLVED path. Canonical, segment-prefix comparison: with
 * SCOUT_TEST_OU_PATH=/MCP-Test, "/MCP-Test/x" and "/mcp-test" pass; "/MCP-Test2" does not.
 * Returns an error message or null.
 */
export function testScopeViolation(resolvedPath: string, label: string): string | null {
  if (process.env.SCOUT_ENV !== 'test') return null;
  const root = process.env.SCOUT_TEST_OU_PATH;
  if (!root) return 'SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test';
  let c: string;
  let r: string;
  try {
    c = canonicalizeOuPath(resolvedPath);
    r = canonicalizeOuPath(root);
  } catch (err) {
    const why = err instanceof OuPathError ? err.message : String(err);
    return `${label} "${resolvedPath}" or SCOUT_TEST_OU_PATH "${root}" is not a valid OU path (${why}). Blocked in test mode.`;
  }
  const inside = r === '/' || c === r || c.startsWith(r + '/');
  return inside ? null : `${label} "${resolvedPath}" is outside SCOUT_TEST_OU_PATH "${root}". Blocked in test mode.`;
}

/** Audits and throws a refusal on the protected-OU gate. */
export function refuseOuWrite(opName: string, target: string, detail: string, gate: GuardrailError['gate'] = 'protected-ou'): never {
  auditLog({ opName, target, result: 'refused', gate, detail });
  throw new GuardrailError(detail, gate);
}

export interface GateOptions {
  /** A top-level OU (no parent in the tree) requires SCOUT_ALLOW_BASE_WRITES. */
  topLevelNeedsBase?: boolean;
  /** Resolve + test-scope only; skip SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS (read side of a copy). */
  skipProtectedCheck?: boolean;
  /** Refuse (audited) when no reference at all was supplied. Text is the missing-input message. */
  requiredMessage?: string;
}

/**
 * Resolves `refs` (all must name the same OU) and applies the gates above. Returns the resolved
 * OU, or undefined when no reference was supplied and `requiredMessage` is not set.
 */
export async function gateOuWrite(
  opName: string,
  refs: OuRef[],
  label: string,
  opts: GateOptions = {},
): Promise<OuMatch | undefined> {
  let match: OuMatch | undefined;
  try {
    match = await resolveWriteTarget(refs, label);
  } catch (err) {
    // resolveWriteTarget audits its own GuardrailErrors (disagreement, invalid path). Anything else
    // (not found, ambiguous, unreadable tree) is also a refusal and must leave a trace.
    if (!(err instanceof GuardrailError)) {
      auditLog({
        opName,
        target: refs.filter((r) => r !== undefined).map(String).join(','),
        result: 'refused',
        gate: 'protected-ou',
        detail: `${label} could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    throw err;
  }
  if (!match) {
    if (opts.requiredMessage) refuseOuWrite(opName, label, opts.requiredMessage);
    return undefined;
  }
  if (opts.topLevelNeedsBase && match.topLevel) {
    try {
      checkBaseWriteAllowed({
        isBaseOrRoot: true,
        label: `the top-level OU "${match.path}" (ancestor of its whole subtree)`,
      });
    } catch (err) {
      auditLog({
        opName,
        target: match.path,
        result: 'refused',
        gate: 'base-write',
        detail: 'top-level OU write without SCOUT_ALLOW_BASE_WRITES',
      });
      throw err;
    }
  }
  const scopeErr = testScopeViolation(match.path, label === 'OU' ? 'Target OU' : capitalize(label));
  if (scopeErr) refuseOuWrite(opName, match.path, scopeErr, 'test-scope');
  if (!opts.skipProtectedCheck) checkOuWriteAllowed({ targetPath: match.path });
  return match;
}

/** Gates every OU under (and including) `root` - for writes that fan out with includeSubOus. */
export async function gateOuSubtree(opName: string, root: OuMatch): Promise<void> {
  let subtree: OuMatch[];
  try {
    subtree = await collectOuSubtree(root.ouid);
  } catch (err) {
    return refuseOuWrite(
      opName,
      root.path,
      `Could not enumerate the sub-OUs of "${root.path}": ${err instanceof Error ? err.message : String(err)}. Refusing.`,
    );
  }
  for (const ou of subtree) {
    const scopeErr = testScopeViolation(ou.path, 'Sub-OU');
    if (scopeErr) refuseOuWrite(opName, ou.path, scopeErr, 'test-scope');
    checkOuWriteAllowed({ targetPath: ou.path });
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Strict includeSubOus normalisation for gating: ONLY an absent value or an explicit boolean false
 * means "no sub-OUs"; every other value (true, 1, "1", "true", "yes", arrays, objects, ...) is
 * treated as true. Callers must send the returned boolean, never the raw value.
 */
export function subOusRequested(v: unknown): boolean {
  return !(v === undefined || v === false);
}

// ── Caller-body sanitising ────────────────────────────────────────────────────

/** Key normal form: NFKC, lower-case, everything except letters/digits removed (zero-width, NBSP, separators,
 *  dots/brackets: "ou.id", "ou[id]", "OU_Id", fullwidth forms all collapse to "ouid"). */
export function normKey(k: string): string {
  return k.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SPECIFIC_OU_KEY =
  /^(ous?|ouids?|oupaths?|ounames?|organi[sz]ationalunit(id|ids|path|name)?s?|groupids?|group|parent(ou|id|ouid)?|source(ou|ouid)?|target(ou|ouid)?|dest(ou|ouid|oupath)?|destination(ou|ouid)?|includesubous)$/;
const CONTAINS_OU = /ou(id|path|ids|name)|(id|path|ids|name)ou/;
const GENERIC_OU_KEY = /^(path|id)$/;

export interface BodyOptions {
  /** Also treat the generic names `id` / `path` as OU-ish (command/notification bodies). Off for
   *  application definitions, where such names may be legitimate application fields. */
  generic?: boolean;
}

function isOuKey(norm: string, opts: BodyOptions): boolean {
  return SPECIFIC_OU_KEY.test(norm) || CONTAINS_OU.test(norm) || (opts.generic !== false && GENERIC_OU_KEY.test(norm));
}

/** Walks a caller body (objects and arrays, recursively). */
function walk(
  v: unknown,
  opts: BodyOptions,
  onOuKey: (norm: string, value: unknown) => void,
): unknown {
  if (Array.isArray(v)) return v.map((x) => walk(x, opts, onOuKey));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (PROTO_KEYS.has(k.toLowerCase())) continue;
      const n = normKey(k);
      if (isOuKey(n, opts)) {
        onOuKey(n, val);
        continue;
      }
      out[k] = walk(val, opts, onOuKey);
    }
    return out;
  }
  return v;
}

export interface SanitizedBody {
  /** The body with every OU-ish key (any depth) removed. */
  body: Record<string, unknown>;
  /** Values of OU-ish keys that could name an OU (numbers / non-empty strings): must all resolve to the gated OU. */
  ouRefs: Array<string | number>;
  /** True when any case/separator/Unicode variant of includeSubOus is present with a non-false value. */
  subOusRequested: boolean;
  /** True when an includeSubOus key (any variant) is present at all. */
  hasSubOusKey: boolean;
}

/**
 * Sanitises a caller-supplied body that is forwarded next to a gated OU. Callers must (1) pass
 * `ouRefs` to the gate together with the gated references, so a key naming a DIFFERENT OU is
 * refused as disagreeing, (2) gate the subtree when `subOusRequested`, and (3) add back only the
 * canonical resolved id and a normalised boolean includeSubOus.
 */
export function sanitizeOuBody(raw: Record<string, unknown> | undefined, opts: BodyOptions = {}): SanitizedBody {
  const ouRefs: Array<string | number> = [];
  let subOus = false;
  let hasKey = false;
  const body = walk(raw ?? {}, opts, (norm, value) => {
    if (norm === 'includesubous') {
      hasKey = true;
      if (subOusRequested(value)) subOus = true;
      return;
    }
    const collect = (x: unknown): void => {
      if (typeof x === 'number' && Number.isFinite(x)) ouRefs.push(x);
      else if (typeof x === 'string' && x.trim() !== '') ouRefs.push(x);
      else if (Array.isArray(x)) x.forEach(collect);
      else if (x !== null && typeof x === 'object') Object.values(x as Record<string, unknown>).forEach(collect);
    };
    collect(value);
  }) as Record<string, unknown>;
  return { body, ouRefs, subOusRequested: subOus, hasSubOusKey: hasKey };
}

/**
 * Maps device rows to their CURRENT (source) OUs: reads each row's OU id strictly (OUID and/or
 * GroupID, integers, agreeing; rows of one result must share a shape) and confirms every id exists
 * in a FRESH parsed OU tree. Any failure is audit-logged and throws GuardrailError
 * 'unresolvable-source-ou' - an unknown source OU is never treated as unprotected. Returns one
 * OuMatch per input row, in order.
 */
export async function resolveDeviceSourceOus(opName: string, target: string, devices: DeviceRecord[]): Promise<OuMatch[]> {
  const refuse = (detail: string): never => {
    auditLog({ opName, target, result: 'refused', gate: 'unresolvable-source-ou', detail });
    throw new GuardrailError(
      `Could not determine the source OU of ${devices.length === 1 ? 'the device' : 'the matched device(s)'} (${detail}). ` +
        'Refusing: the protected-OU check cannot run against an unknown source OU.',
      'unresolvable-source-ou',
    );
  };
  const read = devices.length === 1 ? readDeviceOuId(devices[0]) : readDeviceOuIds(devices);
  if (!read.ok) return refuse(read.reason);
  const ids = 'ids' in read ? read.ids : [read.id];
  try {
    return await resolveOuIdsFresh(ids);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}

/** Applies the protected/allowed lists and SCOUT_ENV=test scope to each distinct source OU. */
export function gateSourceOus(opName: string, sources: OuMatch[]): void {
  const seen = new Set<number>();
  for (const ou of sources) {
    if (seen.has(ou.ouid)) continue;
    seen.add(ou.ouid);
    const scopeErr = testScopeViolation(ou.path, 'Source OU');
    if (scopeErr) refuseOuWrite(opName, ou.path, scopeErr, 'test-scope');
    checkOuWriteAllowed({ targetPath: ou.path });
  }
}

/** True when any source-OU check can matter (lists configured or SCOUT_ENV=test). */
export function sourceOuChecksActive(): boolean {
  return ouListsConfigured() || process.env.SCOUT_ENV === 'test';
}

/**
 * Looks up ONE device (GET /api/v1/device) and gates its current OU. Used by single-device writes
 * (device_manage move, device_command / notification_manage target=device). Fails closed.
 */
export async function gateSingleDeviceSource(
  client: { request<T>(method: string, path: string, ...rest: unknown[]): Promise<T> },
  opName: string,
  identifiers: { name?: string; mac?: string; id?: string; clientid?: string },
): Promise<OuMatch> {
  const target = identifiers.name ?? identifiers.mac ?? identifiers.id ?? identifiers.clientid ?? 'unknown';
  let data: unknown;
  try {
    const qs = buildQuery({ name: identifiers.name, mac: identifiers.mac, id: identifiers.id, clientid: identifiers.clientid });
    data = await client.request<unknown>('GET', `/api/v1/device${qs}`);
  } catch (err) {
    auditLog({ opName, target, result: 'refused', gate: 'unresolvable-source-ou', detail: `device lookup failed: ${err instanceof Error ? err.message : String(err)}` });
    throw new GuardrailError(
      `Could not determine the source OU of the device (device lookup failed: ${err instanceof Error ? err.message : String(err)}). ` +
        'Refusing: the protected-OU check cannot run against an unknown source OU.',
      'unresolvable-source-ou',
    );
  }
  const rec = data && typeof data === 'object' && !Array.isArray(data) ? (data as DeviceRecord) : {};
  const [ou] = await resolveDeviceSourceOus(opName, target, [rec]);
  gateSourceOus(opName, [ou]);
  return ou;
}
