/**
 * Response enricher — annotates Scout Board API responses that contain numeric
 * OUID values with their human-readable OUName and OUPath.
 *
 * BEFORE: device_get returned {"Name":"Thin01","OUID":42,"Status":"active"}
 *         → AI had to call ou_get(id=42) to learn the OU name
 *
 * AFTER:  same call returns
 *         {"Name":"Thin01","OUID":42,"_ouName":"03 - LU Berlin",
 *          "_ouPath":"/Enterprise/Germany/Berlin","Status":"active"}
 *         → AI has full context, no follow-up call needed
 *
 * Enrichment is best-effort: if the OU tree cannot be fetched (e.g. during
 * the first unauthenticated request) the original data is returned unchanged.
 *
 * Cache: the OU→{name,path} map is loaded once and reused for 5 minutes.
 * Call invalidateEnrichmentCache() after any ou_manage mutation.
 */

import { getClient } from './client.js';

// ── OU map cache ──────────────────────────────────────────────────────────────

interface OuEntry { name: string; path: string }
interface OuNode  { OUID?: number; OUName?: string; OUPath?: string; SubOUs?: OuNode[] }

const CACHE_TTL_MS = 5 * 60 * 1000;

let ouMap: Map<number, OuEntry> | null = null;
let ouMapLoadedAt = 0;

/** Discard the cached map; the next enrichment call will re-fetch. */
export function invalidateEnrichmentCache(): void {
  ouMap = null;
  ouMapLoadedAt = 0;
}

async function loadOuMap(): Promise<Map<number, OuEntry>> {
  if (ouMap && Date.now() - ouMapLoadedAt < CACHE_TTL_MS) return ouMap;

  const client = getClient();
  const tree = await client.request<OuNode>('GET', '/api/v1/ou/structure');

  const map = new Map<number, OuEntry>();
  function flatten(node: OuNode): void {
    if (typeof node.OUID === 'number' && node.OUName && node.OUPath) {
      map.set(node.OUID, { name: node.OUName, path: node.OUPath });
    }
    if (Array.isArray(node.SubOUs)) node.SubOUs.forEach(flatten);
  }
  flatten(tree);

  ouMap = map;
  ouMapLoadedAt = Date.now();
  return map;
}

// ── Annotation ────────────────────────────────────────────────────────────────

/** Keys that contain nested OU tree nodes — do not recurse into them to avoid re-annotating. */
const SKIP_RECURSE = new Set(['SubOUs', 'subOUs', 'Children', 'children']);

/** OUID-like field names to look for in any object. */
const OUID_KEYS = ['OUID', 'ouId', 'OuId', 'DestOUID'];

function annotate(data: unknown, map: Map<number, OuEntry>): unknown {
  if (Array.isArray(data)) return data.map((item) => annotate(item, map));

  if (data !== null && typeof data === 'object') {
    const src = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(src)) {
      // Copy the value first, then possibly recurse
      const val = src[key];

      if (SKIP_RECURSE.has(key)) {
        out[key] = val; // don't annotate OU tree nodes
        continue;
      }

      // Recurse into nested objects/arrays
      out[key] = annotate(val, map);

      // After copying, inject _ouName / _ouPath sibling if this is an OUID field
      if (OUID_KEYS.includes(key) && typeof val === 'number') {
        const entry = map.get(val);
        if (entry) {
          out[`_${key}Name`] = entry.name;
          out[`_${key}Path`] = entry.path;
        }
      }
    }
    return out;
  }

  return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enriches a Scout Board API response by adding _ouName / _ouPath annotations
 * next to any OUID fields found anywhere in the response tree.
 *
 * Always returns a value — silently falls back to the original data on error.
 */
export async function enrich(data: unknown): Promise<unknown> {
  try {
    const map = await loadOuMap();
    if (map.size === 0) return data; // no OUs to annotate with
    return annotate(data, map);
  } catch {
    return data; // enrichment failure must never surface as a tool error
  }
}
