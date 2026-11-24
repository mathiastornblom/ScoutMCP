/**
 * Container scope policy for ELIAS writes (design 3.1; Security C3, C4).
 *
 * Pure functions: the caller supplies a FRESH `GET /containers` list (never the cache). Matching is
 * evaluated against the SERVER's id and name, never against caller text. PROTECTED always wins;
 * ALLOWED must be non-empty and match; SCOUT_ENV=test additionally requires the test prefix.
 * Two containers with the same name make any name-based decision refuse (C3).
 */

import { type EliasWriteConfig, entryMatches, isNameEntry } from './config.js';
import { safeDisplay } from './sanitize.js';

export interface ContainerRef {
  id: string;
  name: string;
}

export type ScopeDecision = { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): ScopeDecision => ({ allowed: false, reason });

/** Names that appear more than once (case-insensitive) in the fresh list. */
export function findAmbiguousNames(list: readonly ContainerRef[]): Set<string> {
  const seen = new Map<string, number>();
  for (const c of list) {
    const k = c.name.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/**
 * Decides whether a write may target an EXISTING container (`container`) and/or introduce a NEW name
 * (`newName`, for create/rename). At least one subject is required.
 */
export function evaluateScope(
  cfg: EliasWriteConfig,
  subject: { container?: ContainerRef; newName?: string },
  freshList: readonly ContainerRef[],
): ScopeDecision {
  if (!cfg.scopeValid) {
    return deny('the ELIAS container scope configuration is invalid (see elias_write_status); all ELIAS writes are refused');
  }
  if (cfg.allowed.length === 0) {
    return deny('no ELIAS containers are allowed: set SCOUT_ELIAS_ALLOWED_CONTAINERS');
  }
  const refs: Array<{ id?: string; name: string }> = [];
  if (subject.container) refs.push(subject.container);
  if (subject.newName !== undefined) refs.push({ name: subject.newName });
  if (refs.length === 0) return deny('no write subject');

  const ambiguous = findAmbiguousNames(freshList);
  for (const ref of refs) {
    const shown = safeDisplay(ref.name);
    // Name ambiguity (C3): a duplicated name cannot be told apart by a name-based entry.
    if (ref.id !== undefined && ambiguous.has(ref.name.toLowerCase())) {
      const nameEntryMatches = [...cfg.allowed, ...cfg.protected].some((e) => isNameEntry(e) && entryMatches(e, { name: ref.name }));
      if (nameEntryMatches) {
        return deny(`container name "${shown}" is not unique on the server; name-based scope entries cannot be applied (use ids)`);
      }
    }
    if (cfg.protected.some((e) => entryMatches(e, ref))) {
      return deny(`"${shown}" is protected (SCOUT_ELIAS_PROTECTED_CONTAINERS)`);
    }
    if (!cfg.allowed.some((e) => entryMatches(e, ref))) {
      return deny(`"${shown}" is not in SCOUT_ELIAS_ALLOWED_CONTAINERS`);
    }
    if (cfg.testEnv && !ref.name.startsWith(cfg.testPrefix)) {
      return deny(`SCOUT_ENV=test: "${shown}" does not start with the test prefix "${safeDisplay(cfg.testPrefix)}"`);
    }
  }
  return { allowed: true };
}
