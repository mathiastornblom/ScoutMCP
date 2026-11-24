/**
 * OU name resolver — translates a free-form OU reference (name, partial name, full path,
 * or numeric ID) into a concrete { ouid, name, path } match.
 *
 * The OU tree is parsed by the shared, fail-closed parser in src/ou_tree.ts (real
 * `treeStructure` envelope; paths are derived as "/Top/Child/Leaf" - see its header for the
 * exact format and the cumulative-DeviceCount note).
 *
 * The cache is loaded once per process (lazy) and stays valid for CACHE_TTL_MS.
 * Call invalidateOuCache() after any ou_manage mutation so the next lookup re-fetches.
 */

import { getClient } from './client.js';
import { canonicalizeOuPath, OuPathError } from './ou_path.js';
import { auditLog, GuardrailError } from './safety/guardrails.js';
import { parseOuTree, ouChain, ouSubtree, type OuTree, type OuTreeNode } from './ou_tree.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OuMatch {
  ouid: number;
  name: string;
  path: string;
  /** True when the OU has no parent in the parsed tree (a forest root, ParentID -1). Derived from
   *  the same tree read as the match, so no separate /ou/root call is needed. */
  topLevel: boolean;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: OuMatch[] | null = null;
let cacheLoadedAt = 0;

export function invalidateOuCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

/** Fetches and parses the live OU tree (uncached). Throws OuTreeParseError on any unexpected
 *  shape — callers rely on this to fail closed (see src/ou_tree.ts). */
async function fetchOuTree(): Promise<OuTree> {
  const raw = await getClient().request<unknown>('GET', '/api/v1/ou/structure');
  return parseOuTree(raw);
}

function toMatch(n: OuTreeNode): OuMatch {
  return { ouid: n.ouid, name: n.name, path: n.path, topLevel: n.parentId === undefined };
}

async function loadCache(): Promise<OuMatch[]> {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  const flat = (await fetchOuTree()).nodes.map(toMatch);
  cache = flat;
  cacheLoadedAt = Date.now();
  return flat;
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolves a free-form OU reference to an OuMatch.
 *
 * Resolution order:
 *   1. Numeric value (string or number) → looked up by OUID
 *   2. String starting with "/" → exact path match (case-insensitive)
 *   3. Exact name match (case-insensitive)
 *   4. Partial name contains match
 *
 * Throws a descriptive error with a candidate list on ambiguity (two OUs with the same name
 * at different depths are reported, never silently picked), and a "not found" suggestion on
 * zero matches. An unreadable OU tree also throws (never "no match").
 */
export async function resolveOuRef(ref: string | number): Promise<OuMatch> {
  // 1. Numeric ID
  // Digits only: Number() would also accept "0x10", "1e1", "010" and resolve them to other OUIDs.
  const isNumeric = typeof ref === 'number' ? Number.isInteger(ref) : /^\d+$/.test(String(ref).trim());
  const num = isNumeric ? Number(ref) : NaN;
  if (isNumeric) {
    const all = await loadCache();
    const hit = all.find((o) => o.ouid === num);
    if (hit) return hit;
    throw new Error(`No OU found with ID ${num}. Use ou_get mode=structure to list all OUs.`);
  }

  const s = String(ref).trim();
  const all = await loadCache();

  // 2. Exact path
  if (s.startsWith('/')) {
    // Canonical compare (case, repeated/trailing slashes); '.'/'..' segments throw.
    let want: string;
    try {
      want = canonicalizeOuPath(s);
    } catch (err) {
      if (!(err instanceof OuPathError)) throw err;
      const message = `Refusing OU reference ${JSON.stringify(s)}: ${err.message}.`;
      auditLog({ opName: 'ou-ref-resolve', target: s, result: 'refused', gate: 'protected-ou', detail: message });
      throw new GuardrailError(message, 'protected-ou');
    }
    const byPath = all.filter((o) => canonicalizeOuPath(o.path) === want);
    if (byPath.length === 1) return byPath[0];
    if (byPath.length > 1) return throwAmbiguous(s, byPath);
  }

  // 3. Exact name
  const byName = all.filter((o) => o.name.toLowerCase() === s.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return throwAmbiguous(s, byName);

  // 4. Partial name contains
  const partial = all.filter((o) => o.name.toLowerCase().includes(s.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return throwAmbiguous(s, partial);

  throw new Error(
    `No OU matching "${s}". Use ou_get mode=search with a searchTerm, or mode=structure to browse the full tree.`,
  );
}

/**
 * Returns the chain of OUs from the top-level OU to the given OU (inclusive), in root→leaf
 * order, from a fresh read of the OU tree. Used by the RSoP engine (§2) to fetch each
 * ancestor OU's config layer in precedence order.
 *
 * Throws if the tree cannot be parsed or no longer contains the resolved OU — it never
 * substitutes a guessed single-element chain, because a truncated chain would silently drop
 * ancestor config layers from the effective-config computation.
 */
export async function getOuChain(ouRef: string | number): Promise<OuMatch[]> {
  const target = await resolveOuRef(ouRef);
  const chain = ouChain(await fetchOuTree(), target.ouid);
  if (!chain) {
    throw new Error(`OU ${target.ouid} ("${target.path}") is no longer present in the OU tree.`);
  }
  return chain.map(toMatch);
}

/** Every OU in the subtree rooted at `ouid` (inclusive), depth-first, from a fresh tree read.
 *  Throws if the tree cannot be parsed or `ouid` is not in it. */
export async function collectOuSubtree(ouid: number): Promise<OuMatch[]> {
  const sub = ouSubtree(await fetchOuTree(), ouid);
  if (!sub) throw new Error(`OU ${ouid} is not present in the OU tree.`);
  return sub.map(toMatch);
}

/**
 * Counts the devices under an OU (including all sub-OUs) for config_update's Gate 3
 * (blast-radius) check on target=ou writes, where one OU-scope write inherits to every
 * device under it.
 *
 * Source: the `DeviceCount` of the target node in a FRESH /ou/structure read. On the real
 * server that field is CUMULATIVE (already includes every descendant OU — see ou_tree.ts),
 * so the target's own value is the answer; summing over the subtree would double count.
 * (The former per-OU device-search fan-out is gone: it relied on the `ouId` search filter,
 * which the server rejects with HTTP 400.)
 *
 * FAILS CLOSED: an unparseable tree, a target missing from the fresh tree, or a target node
 * without a usable DeviceCount all throw rather than substituting 0. checkBlastRadius's caller
 * treats a thrown error here as "refuse the operation", not "proceed assuming a lower count".
 */
export async function countDevicesUnderOu(ouRef: string | number): Promise<number> {
  const target = await resolveOuRef(ouRef);
  const node = (await fetchOuTree()).byId.get(target.ouid);
  if (!node) {
    throw new Error(
      `countDevicesUnderOu: OU ${target.ouid} ("${target.path}") is not present in the OU tree. ` +
        'Refusing to guess a device count.',
    );
  }
  if (node.deviceCount === undefined) {
    throw new Error(
      `countDevicesUnderOu: OU "${node.path}" (id ${node.ouid}) has no usable DeviceCount in the OU ` +
        'tree. Refusing to undercount — the blast-radius check cannot proceed without a reliable count.',
    );
  }
  return node.deviceCount;
}

/**
 * Write-gate helper: resolves `ref` against a FRESH tree read (the cache is dropped first, so
 * an out-of-band rename/move cannot let the gate judge a stale path) and returns the
 * canonical server-derived path to gate on. Throws if the OU cannot be resolved.
 */
export async function resolveOuForWriteGate(ref: string | number): Promise<OuMatch> {
  invalidateOuCache();
  return resolveOuRef(ref);
}

/**
 * Resolves OU ids (taken from device records) against ONE fresh tree read. Every id must exist in
 * the tree; otherwise this throws (no partial results). Returns matches in input order.
 */
export async function resolveOuIdsFresh(ids: number[]): Promise<OuMatch[]> {
  invalidateOuCache();
  const all = await loadCache();
  return ids.map((id) => {
    const hit = all.find((o) => o.ouid === id);
    if (!hit) throw new Error(`OU id ${id} is not present in the OU tree.`);
    return hit;
  });
}

/**
 * Resolves every supplied reference (fresh tree) and requires they all name the SAME OU.
 * Returns that OU, or undefined if no reference was supplied. Callers gate on the returned
 * canonical path AND must send only `{id: match.ouid}` to the server, so the OU that was gated
 * and the OU that is written are the same by construction (a caller giving an allowed id plus
 * a protected path is refused here rather than judged on the id alone).
 */
export async function resolveWriteTarget(
  refs: Array<string | number | undefined>,
  label = 'OU',
): Promise<OuMatch | undefined> {
  const given = refs.filter((r): r is string | number => r !== undefined);
  if (given.length === 0) return undefined;
  invalidateOuCache();
  const matches: OuMatch[] = [];
  for (const r of given) matches.push(await resolveOuRef(r));
  const first = matches[0];
  const other = matches.find((m) => m.ouid !== first.ouid);
  if (other) {
    const message =
      `Refusing: the ${label} references resolve to different OUs ("${first.path}" id ${first.ouid} vs ` +
      `"${other.path}" id ${other.ouid}). Give a single OU reference.`;
    auditLog({ opName: 'ou-ref-resolve', target: label, result: 'refused', gate: 'protected-ou', detail: message });
    throw new GuardrailError(message, 'protected-ou');
  }
  return first;
}

/** Throws unless OU `ouid` currently has exactly the path that was gated (fresh tree read). */
export async function assertOuPathUnchanged(ouid: number, gatedPath: string): Promise<void> {
  const node = (await fetchOuTree()).byId.get(ouid);
  if (!node || canonicalizeOuPath(node.path) !== canonicalizeOuPath(gatedPath)) {
    throw new Error(
      `OU ${ouid} no longer has the path "${gatedPath}" that was checked (now ${node ? `"${node.path}"` : 'absent'}). ` +
        'The OU tree changed during the operation; refusing - retry.',
    );
  }
}

function throwAmbiguous(ref: string, candidates: OuMatch[]): never {
  const list = candidates.map((c) => `  • "${c.name}"  ID: ${c.ouid}  path: ${c.path}`).join('\n');
  throw new Error(
    `"${ref}" matches ${candidates.length} OUs — please clarify:\n${list}\n` +
      'Tip: use the full path (e.g. "/Enterprise/Germany/Berlin") or the numeric ID for an exact match.',
  );
}
