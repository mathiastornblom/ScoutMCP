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

function throwAmbiguous(ref: string, candidates: OuMatch[]): never {
  const list = candidates.map((c) => `  • "${c.name}"  ID: ${c.ouid}  path: ${c.path}`).join('\n');
  throw new Error(
    `"${ref}" matches ${candidates.length} OUs — please clarify:\n${list}\n` +
      'Tip: use the full path (e.g. "/Enterprise/Germany/Berlin") or the numeric ID for an exact match.',
  );
}
