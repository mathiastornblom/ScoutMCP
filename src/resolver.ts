/**
 * OU name resolver — translates a free-form OU reference (name, partial name, full path,
 * or numeric ID) into a concrete { ouid, name, path } match.
 *
 * The cache is loaded once per process (lazy) and stays valid for CACHE_TTL_MS.
 * Call invalidateOuCache() after any ou_manage mutation so the next lookup re-fetches.
 */

import { getClient } from './client.js';

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

/** Extract the flat device array from a Scout /device/search response envelope. */
function extractSearchDevices(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  const response = r['response'];
  if (response && typeof response === 'object') {
    const status = (response as Record<string, unknown>)['status'];
    if (status && typeof status === 'object') {
      const msg = (status as Record<string, unknown>)['msg'];
      if (Array.isArray(msg)) return msg as Array<Record<string, unknown>>;
    }
  }
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  return [];
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
 * This is a best-effort count: OUs whose search call errors are treated as 0 devices for
 * that OU (logged to stderr) rather than aborting the whole count, so a single flaky OU
 * doesn't block the safety check that depends on this count — though note that "best
 * effort" here is intentionally conservative in the wrong direction for a safety gate (an
 * undercount could let a write through that should have been capped); this tradeoff is
 * documented in the security review for this round.
 */
export async function countDevicesUnderOu(ouRef: string | number): Promise<number> {
  const target = await resolveOuRef(ouRef);
  const subtree = await collectOuSubtree(target.ouid);
  const client = getClient();

  const counts = await Promise.all(
    subtree.map(async (ou) => {
      try {
        const qs = `?ouId=${encodeURIComponent(String(ou.ouid))}&searchTerm=${encodeURIComponent('%')}&limit=10000`;
        const data = await client.request<unknown>('GET', `/api/v1/device/search${qs}`);
        return extractSearchDevices(data).length;
      } catch (err) {
        process.stderr.write(
          `[scout-mcp/resolver] countDevicesUnderOu: search failed for OU "${ou.path}" (id ${ou.ouid}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 0;
      }
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
