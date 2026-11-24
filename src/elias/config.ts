/**
 * Strict, safe-by-default configuration for the ELIAS write phase (design section 9; Security C4, C16, C25).
 *
 * Rules:
 *  - Everything is OFF by default. Booleans accept ONLY the literal string `true`.
 *  - Anything unparseable falls to the SAFE side (off / smaller / empty) and is reported in `errors`.
 *  - Numeric ceilings are code constants; an env value above the ceiling is rejected (default used).
 *  - Scope entries (allowed / protected / deletable): a GUID, an exact name, or `prefix*`. Bare `*`,
 *    prefixes shorter than 4 characters, braces and odd characters are rejected; an ALLOWED entry that
 *    overlaps a PROTECTED entry is rejected. Any scope error makes the whole scope invalid (writes refuse).
 *  - `SCOUT_ELIAS_ALLOW_FORCE` is deliberately NOT read (C16: no `force` in the first delete PR).
 *  - Read fresh on every call (no caching), like getScoutMode().
 */

export type EliasWriteTier = 'off' | 'a' | 'b';

export const MIN_PREFIX_LENGTH = 4;
export const CEILING_DELETE_DEPENDENTS = 5;
export const CEILING_EDIT_DEPENDENTS = 5;
export const CEILING_DELETES_PER_HOUR = 20;
export const DEFAULT_DELETES_PER_HOUR = 5;
export const DEFAULT_TEST_PREFIX = 'MCPTEST-';
/** Strict test-container name (C12/C17/C23): `MCPTEST-<yyyymmdd>-<8 hex>`. */
export const MCPTEST_STRICT_RE = /^MCPTEST-\d{8}-[0-9a-f]{8}$/;

export type ScopeEntry =
  | { kind: 'guid'; value: string } // upper-cased canonical
  | { kind: 'exact'; value: string } // lower-cased
  | { kind: 'prefix'; value: string }; // lower-cased, without the trailing *

const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const NAME_CHARS_RE = /^[A-Za-z0-9._-]+$/;

export interface ParsedScope {
  entries: ScopeEntry[];
  errors: string[];
}

/** Parses a comma list or a JSON array of strings. Invalid entries are reported, never silently kept. */
export function parseScopeList(raw: string | undefined, label: string): ParsedScope {
  const entries: ScopeEntry[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw.trim() === '') return { entries, errors };
  let items: unknown[];
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const j: unknown = JSON.parse(t);
      if (!Array.isArray(j)) throw new Error('not an array');
      items = j;
    } catch {
      return { entries, errors: [`${label}: not a valid JSON array`] };
    }
  } else {
    items = t.split(',');
  }
  for (const item of items) {
    if (typeof item !== 'string') {
      errors.push(`${label}: non-string entry rejected`);
      continue;
    }
    const e = item.trim();
    if (e === '') continue;
    if (e === '*') {
      errors.push(`${label}: bare "*" is rejected`);
      continue;
    }
    if (GUID_RE.test(e)) {
      entries.push({ kind: 'guid', value: e.toUpperCase() });
      continue;
    }
    if (e.includes('{') || e.includes('}')) {
      errors.push(`${label}: entries with braces are rejected (use the GUID as listed, without braces)`);
      continue;
    }
    if (e.endsWith('*')) {
      const prefix = e.slice(0, -1);
      if (prefix.includes('*') || !NAME_CHARS_RE.test(prefix)) {
        errors.push(`${label}: invalid prefix entry rejected`);
      } else if (prefix.length < MIN_PREFIX_LENGTH) {
        errors.push(`${label}: prefix entries need at least ${MIN_PREFIX_LENGTH} characters before "*"`);
      } else {
        entries.push({ kind: 'prefix', value: prefix.toLowerCase() });
      }
      continue;
    }
    if (e.includes('*') || !NAME_CHARS_RE.test(e) || e.includes('..') || !/^[A-Za-z0-9]/.test(e)) {
      errors.push(`${label}: invalid entry rejected (allowed: GUID, exact name [A-Za-z0-9._-] starting alphanumeric, or prefix*)`);
      continue;
    }
    entries.push({ kind: 'exact', value: e.toLowerCase() });
  }
  return { entries, errors };
}

/** Does `entry` match the container (server id and/or server name)? Case-insensitive. */
export function entryMatches(entry: ScopeEntry, c: { id?: string; name?: string }): boolean {
  if (entry.kind === 'guid') return c.id !== undefined && c.id.toUpperCase() === entry.value;
  const name = c.name?.toLowerCase();
  if (name === undefined) return false;
  return entry.kind === 'exact' ? name === entry.value : name.startsWith(entry.value);
}

/** True when some string could satisfy both entries (used to reject ALLOWED entries overlapping PROTECTED). */
export function entriesOverlap(a: ScopeEntry, b: ScopeEntry): boolean {
  if (a.kind === 'guid' || b.kind === 'guid') return a.kind === b.kind && a.value === b.value;
  if (a.kind === 'exact' && b.kind === 'exact') return a.value === b.value;
  if (a.kind === 'prefix' && b.kind === 'prefix') return a.value.startsWith(b.value) || b.value.startsWith(a.value);
  const exact = a.kind === 'exact' ? a : (b as { kind: 'exact'; value: string });
  const prefix = a.kind === 'prefix' ? a : (b as { kind: 'prefix'; value: string });
  return exact.value.startsWith(prefix.value);
}

/** True when an entry is name-based (exact / prefix), i.e. subject to name ambiguity (C3). */
export const isNameEntry = (e: ScopeEntry): boolean => e.kind !== 'guid';

export interface EliasWriteConfig {
  tier: EliasWriteTier;
  privateEndpoints: boolean;
  allowed: ScopeEntry[];
  protected: ScopeEntry[];
  /** Container delete allow-list (inert in this slice). */
  deletable: ScopeEntry[];
  /** False when any scope list had an error: every write is then refused (fail closed). */
  scopeValid: boolean;
  testEnv: boolean;
  testPrefix: string;
  allowUnverifiedWrites: boolean;
  allowDelete: boolean;
  allowUpload: boolean;
  allowSolver: boolean;
  allowAccept: boolean;
  maxDeleteDependents: number;
  maxEditDependents: number;
  maxDeletesPerHour: number;
  /** Human-readable problems (also surfaced by elias_write_status). Never contains secrets. */
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function parseBool(env: Env, name: string): boolean {
  return env[name] === 'true'; // C25: only the literal `true`
}

function parseCappedInt(env: Env, name: string, def: number, min: number, ceiling: number, errors: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d{1,6}$/.test(raw.trim())) {
    errors.push(`${name}: not a non-negative integer; using ${def}`);
    return def;
  }
  const n = parseInt(raw.trim(), 10);
  if (n < min || n > ceiling) {
    errors.push(`${name}: ${n} is outside ${min}..${ceiling}; using ${def}`);
    return def;
  }
  return n;
}

export function loadEliasWriteConfig(env: Env = process.env): EliasWriteConfig {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawTier = env.SCOUT_ELIAS_WRITES;
  let tier: EliasWriteTier = 'off';
  if (rawTier === 'a' || rawTier === 'b') tier = rawTier;
  else if (rawTier !== undefined && rawTier !== '' && rawTier !== 'off') {
    errors.push('SCOUT_ELIAS_WRITES: expected exactly "off", "a" or "b"; treated as off');
  }

  const allowed = parseScopeList(env.SCOUT_ELIAS_ALLOWED_CONTAINERS, 'SCOUT_ELIAS_ALLOWED_CONTAINERS');
  const prot = parseScopeList(env.SCOUT_ELIAS_PROTECTED_CONTAINERS, 'SCOUT_ELIAS_PROTECTED_CONTAINERS');
  const deletable = parseScopeList(env.SCOUT_ELIAS_DELETABLE_CONTAINERS, 'SCOUT_ELIAS_DELETABLE_CONTAINERS');
  const scopeErrors = [...allowed.errors, ...prot.errors, ...deletable.errors];

  for (const a of allowed.entries) {
    if (prot.entries.some((p) => entriesOverlap(a, p))) {
      scopeErrors.push('SCOUT_ELIAS_ALLOWED_CONTAINERS: an entry overlaps SCOUT_ELIAS_PROTECTED_CONTAINERS (rejected)');
      break;
    }
  }
  for (const d of deletable.entries) {
    if (prot.entries.some((p) => entriesOverlap(d, p))) {
      scopeErrors.push('SCOUT_ELIAS_DELETABLE_CONTAINERS: an entry overlaps SCOUT_ELIAS_PROTECTED_CONTAINERS (rejected)');
      break;
    }
  }
  errors.push(...scopeErrors);
  if (prot.entries.length > 0 && !prot.entries.some((e) => e.kind === 'guid')) {
    warnings.push('SCOUT_ELIAS_PROTECTED_CONTAINERS lists no container id; names can be renamed, list ids as well');
  }

  const testEnv = env.SCOUT_ENV === 'test';
  let testPrefix = DEFAULT_TEST_PREFIX;
  const rawPrefix = env.SCOUT_TEST_CONTAINER_PREFIX;
  if (rawPrefix !== undefined && rawPrefix !== '') {
    if (NAME_CHARS_RE.test(rawPrefix) && rawPrefix.length >= MIN_PREFIX_LENGTH && rawPrefix.length <= 32) testPrefix = rawPrefix;
    else errors.push(`SCOUT_TEST_CONTAINER_PREFIX: invalid; using ${DEFAULT_TEST_PREFIX}`);
  }

  if (env.SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES === 'true' && !testEnv) {
    warnings.push('SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES=true is ignored unless SCOUT_ENV=test');
  }

  return {
    tier,
    privateEndpoints: env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true',
    allowed: scopeErrors.length > 0 ? [] : allowed.entries,
    protected: prot.entries,
    deletable: scopeErrors.length > 0 ? [] : deletable.entries,
    scopeValid: scopeErrors.length === 0,
    testEnv,
    testPrefix,
    allowUnverifiedWrites: parseBool(env, 'SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES') && testEnv,
    allowDelete: parseBool(env, 'SCOUT_ELIAS_ALLOW_DELETE'),
    allowUpload: parseBool(env, 'SCOUT_ELIAS_ALLOW_UPLOAD'),
    allowSolver: parseBool(env, 'SCOUT_ELIAS_ALLOW_SOLVER'),
    allowAccept: parseBool(env, 'SCOUT_ELIAS_ALLOW_ACCEPT'),
    maxDeleteDependents: parseCappedInt(env, 'SCOUT_ELIAS_MAX_DELETE_DEPENDENTS', 0, 0, CEILING_DELETE_DEPENDENTS, errors),
    maxEditDependents: parseCappedInt(env, 'SCOUT_ELIAS_MAX_EDIT_DEPENDENTS', 0, 0, CEILING_EDIT_DEPENDENTS, errors),
    maxDeletesPerHour: parseCappedInt(env, 'SCOUT_ELIAS_MAX_DELETES_PER_HOUR', DEFAULT_DELETES_PER_HOUR, 1, CEILING_DELETES_PER_HOUR, errors),
    errors,
    warnings,
  };
}

/** Does tier `cfg.tier` cover an op of tier `opTier`? ('a' covers A0+A, 'b' also B, 'off' nothing.) */
export function tierCovers(cfg: EliasWriteConfig, opTier: 'A0' | 'A' | 'B'): boolean {
  if (cfg.tier === 'off') return false;
  if (opTier === 'B') return cfg.tier === 'b';
  return true;
}
