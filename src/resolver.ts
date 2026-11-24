/**
 * OU name resolver — translates a free-form OU reference (name, partial name, full path,
 * or numeric ID) into a concrete { ouid, name, path } match.
 *
 * The cache is loaded once per process (lazy) and stays valid for CACHE_TTL_MS.
 * Call invalidateOuCache() after any ou_manage mutation so the next lookup re-fetches.
 */

import { getClient } from './client.js';
import { parseSearchDevices } from './devices.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OuMatch {
  ouid: number;
  name: string;
  path: string;
}

interface OuNode {
  OUID: number;
  OUName: string;
  OUPath: string;
  SubOUs?: OuNode[];
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: OuMatch[] | null = null;
let cacheLoadedAt = 0;

export function invalidateOuCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

async function loadCache(): Promise<OuMatch[]> {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;

  const client = getClient();
  const root = await client.request<OuNode>('GET', '/api/v1/ou/structure');

  const flat: OuMatch[] = [];
  function flatten(node: OuNode): void {
    if (node.OUID !== undefined) {
      flat.push({ ouid: node.OUID, name: node.OUName, path: node.OUPath });
    }
    if (Array.isArray(node.SubOUs)) node.SubOUs.forEach(flatten);
  }
  flatten(root);

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
 * Throws a descriptive error with a candidate list on ambiguity, and a
 * "not found" suggestion on zero matches.
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
    const byPath = all.filter((o) => o.path.toLowerCase() === s.toLowerCase());
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
 * Returns the chain of OUs from root to the given OU (inclusive), in root→leaf order, by
 * walking the cached OU tree and recording parentage as it flattens. Used by the RSoP
 * engine (§2) to fetch each ancestor OU's config layer in precedence order.
 *
 * Falls back to a single-element chain [ou] if the tree has no parent info (e.g. ou is
 * itself the root) — never throws on a missing parent, since the root OU has none.
 */
export async function getOuChain(ouRef: string | number): Promise<OuMatch[]> {
  const target = await resolveOuRef(ouRef);
  const client = getClient();
  const root = await client.request<OuNode>('GET', '/api/v1/ou/structure');

  const chain: OuMatch[] = [];
  function findPathTo(node: OuNode, trail: OuMatch[]): boolean {
    const here: OuMatch = { ouid: node.OUID, name: node.OUName, path: node.OUPath };
    const nextTrail = [...trail, here];
    if (node.OUID === target.ouid) {
      chain.push(...nextTrail);
      return true;
    }
    if (Array.isArray(node.SubOUs)) {
      for (const child of node.SubOUs) {
        if (findPathTo(child, nextTrail)) return true;
      }
    }
    return false;
  }
  findPathTo(root, []);

  // If the walk failed to find the target (shouldn't happen since resolveOuRef already
  // matched it against the same flattened cache), fall back to a single-element chain.
  return chain.length > 0 ? chain : [target];
}

/** Recursively collects every OU in the subtree rooted at `ouid` (inclusive), by walking
 *  the cached OU tree structure directly rather than relying on includeSubOus — per known
 *  project behavior, the device/search `includeSubOus` flag does not reliably recurse, so
 *  fan-out is done manually here, one /device/search call per leaf/branch OU. */
async function collectOuSubtree(ouid: number): Promise<OuMatch[]> {
  const client = getClient();
  const root = await client.request<OuNode>('GET', '/api/v1/ou/structure');

  const collected: OuMatch[] = [];
  function walk(node: OuNode, capture: boolean): void {
    const isTarget = node.OUID === ouid;
    const shouldCapture = capture || isTarget;
    if (shouldCapture && node.OUID !== undefined) {
      collected.push({ ouid: node.OUID, name: node.OUName, path: node.OUPath });
    }
    if (Array.isArray(node.SubOUs)) {
      for (const child of node.SubOUs) walk(child, shouldCapture);
    }
  }
  walk(root, false);
  return collected;
}

/**
 * Counts the number of devices under an OU, including all sub-OUs, by walking the OU
 * subtree and issuing one `/api/v1/device/search` call per OU in it (in parallel), using
 * the `%` wildcard searchTerm convention (Scout's device search wildcard is `%`, not `*`)
 * to match every device in each OU. Used by config_update's Gate 3 (blast-radius) check
 * for target=ou writes, where a single OU-scope write inherits to every device under it.
 *
 * FAILS CLOSED: if any sub-OU's device-search call errors, or returns a response that
 * doesn't parse as a valid device-search envelope (see parseSearchDevices in devices.ts),
 * the whole count throws rather than silently substituting 0 for that OU. A blast-radius
 * cap that undercounts on a transient failure is worse than one that refuses outright — it
 * would let a write through that should have been capped. checkBlastRadius's caller is
 * expected to treat a thrown error here as "refuse the operation", not "proceed assuming a
 * lower count than reality."
 *
 * (Previously this was a best-effort count that treated per-OU errors as 0 devices,
 * documented as an intentionally-flagged fail-open tradeoff — that tradeoff is removed by
 * this change; see security-review.md for the round that closed it.)
 */
export async function countDevicesUnderOu(ouRef: string | number): Promise<number> {
  const target = await resolveOuRef(ouRef);
  const subtree = await collectOuSubtree(target.ouid);
  const client = getClient();

  const counts = await Promise.all(
    subtree.map(async (ou) => {
      const qs = `?ouId=${encodeURIComponent(String(ou.ouid))}&searchTerm=${encodeURIComponent('%')}&limit=10000`;
      let data: unknown;
      try {
        data = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
      } catch (err) {
        throw new Error(
          `countDevicesUnderOu: device search failed for OU "${ou.path}" (id ${ou.ouid}): ` +
            `${err instanceof Error ? err.message : String(err)}. Refusing to undercount — ` +
            'the blast-radius check cannot proceed without a reliable count.',
        );
      }
      const parsed = parseSearchDevices(data);
      if (!parsed.ok) {
        throw new Error(
          `countDevicesUnderOu: could not parse device search response for OU "${ou.path}" ` +
            `(id ${ou.ouid}): ${parsed.reason}. Refusing to undercount — the blast-radius check ` +
            'cannot proceed without a reliable count.',
        );
      }
      return parsed.devices.length;
    }),
  );

  return counts.reduce((sum, c) => sum + c, 0);
}

function throwAmbiguous(ref: string, candidates: OuMatch[]): never {
  const list = candidates.map((c) => `  • "${c.name}"  ID: ${c.ouid}  path: ${c.path}`).join('\n');
  throw new Error(
    `"${ref}" matches ${candidates.length} OUs — please clarify:\n${list}\n` +
      'Tip: use the full path (e.g. "/Enterprise/Germany/Berlin") or the numeric ID for an exact match.',
  );
}
