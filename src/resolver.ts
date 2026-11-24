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
import { parseOuTree, ouChain, ouSubtree, type OuTree, type OuTreeNode } from './ou_tree.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OuMatch {
  ouid: number;
  name: string;
  path: string;
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
  return { ouid: n.ouid, name: n.name, path: n.path };
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
  const num = typeof ref === 'number' ? ref : (String(ref).trim() !== '' ? Number(ref) : NaN);
  if (!isNaN(num) && String(ref).trim() !== '') {
    const all = await loadCache();
    const hit = all.find((o) => o.ouid === num);
    if (hit) return hit;
    throw new Error(`No OU found with ID ${num}. Use ou_get mode=structure to list all OUs.`);
  }

  const s = String(ref).trim();
  const all = await loadCache();

  // 2. Exact path
  if (s.startsWith('/')) {
    const want = s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
    const byPath = all.filter((o) => o.path.toLowerCase() === want.toLowerCase());
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

function throwAmbiguous(ref: string, candidates: OuMatch[]): never {
  const list = candidates.map((c) => `  • "${c.name}"  ID: ${c.ouid}  path: ${c.path}`).join('\n');
  throw new Error(
    `"${ref}" matches ${candidates.length} OUs — please clarify:\n${list}\n` +
      'Tip: use the full path (e.g. "/Enterprise/Germany/Berlin") or the numeric ID for an exact match.',
  );
}
