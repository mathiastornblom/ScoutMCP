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

import { resolveWriteTarget, collectOuSubtree, type OuMatch } from '../resolver.js';
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
