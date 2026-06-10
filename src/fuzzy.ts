/**
 * Fuzzy matching and "did you mean?" suggestions for Scout Board lookups.
 *
 * When an ou_get or ou_manage call returns HTTP 404, the failed query is
 * scored against every known OU (name and path) and the top matches are
 * appended to the error so the AI can self-correct without a separate lookup.
 *
 * The OU list is cached for 5 minutes (same TTL as the enricher).
 * All operations are best-effort: any fetch error returns an empty list.
 */

import { getClient } from './client.js';

// ── Levenshtein distance (two-row O(n) space) ─────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Returns a 0–1 similarity score between two strings (1 = identical). */
export function similarity(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return 1.0;
  if (c.startsWith(q) || q.startsWith(c)) return 0.85;
  if (c.includes(q) || q.includes(c)) return 0.7;
  const maxLen = Math.max(q.length, c.length);
  if (maxLen === 0) return 1.0;
  return Math.max(0, 1 - levenshtein(q, c) / maxLen);
}

// ── OU suggestion cache ───────────────────────────────────────────────────────

export interface OuSuggestion { name: string; path: string }

interface OuNode { OUName?: string; OUPath?: string; SubOUs?: OuNode[] }

const CACHE_TTL_MS = 5 * 60 * 1000;
let ouList: OuSuggestion[] | null = null;
let ouListLoadedAt = 0;

async function loadOuList(): Promise<OuSuggestion[]> {
  if (ouList && Date.now() - ouListLoadedAt < CACHE_TTL_MS) return ouList;
  const client = getClient();
  const tree = await client.request<OuNode>('GET', '/api/v1/ou/structure');
  const entries: OuSuggestion[] = [];
  function walk(node: OuNode): void {
    if (node.OUName && node.OUPath) entries.push({ name: node.OUName, path: node.OUPath });
    if (Array.isArray(node.SubOUs)) node.SubOUs.forEach(walk);
  }
  walk(tree);
  ouList = entries;
  ouListLoadedAt = Date.now();
  return entries;
}

// ── Public API ────────────────────────────────────────────────────────────────

const MIN_SCORE = 0.35;

/**
 * Returns up to `limit` OUs most similar to the given query string.
 * Scores against the full path, the last path segment, and the display name.
 * Returns [] if the OU tree cannot be fetched (best-effort).
 */
export async function suggestOus(query: string, limit = 5): Promise<OuSuggestion[]> {
  try {
    const all = await loadOuList();
    const lastSeg = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
    const scored = all.map((ou) => ({
      ou,
      sc: Math.max(
        similarity(query, ou.name),
        similarity(query, ou.path),
        similarity(query, lastSeg(ou.path)),
      ),
    }));
    return scored
      .filter((x) => x.sc >= MIN_SCORE)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, limit)
      .map((x) => x.ou);
  } catch {
    return [];
  }
}

/**
 * Formats a "Did you mean?" block suitable for appending to an error message.
 * Returns an empty string when there are no suggestions.
 */
export function formatOuSuggestions(suggestions: OuSuggestion[]): string {
  if (suggestions.length === 0) return '';
  const lines = suggestions.map((s) => `  • "${s.name}"  →  ${s.path}`).join('\n');
  return `\n\nDid you mean one of these OUs?\n${lines}`;
}

/** Returns true when the error represents an HTTP 404 from the Scout API. */
export function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as Error & { statusCode?: number }).statusCode;
    return code === 404;
  }
  return false;
}
