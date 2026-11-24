/**
 * Fixture scrubber for captured ELIAS traffic (Security C13).
 *
 * Allow-list EXTRACTION, not redaction of a copy: from a capture we keep only the HTTP method, a
 * path TEMPLATE (ids replaced by placeholders, host and query values dropped), request/response BODY
 * SHAPES (key names and value types) and the status code. Header values, cookies, tokens, host names,
 * e-mail addresses and every body VALUE are never copied. Keys that look credential-like are omitted
 * from the shape altogether. Authentication exchanges and Tier C paths are skipped.
 *
 * Never run this on a HAR you are not allowed to read; never commit a raw HAR (.gitignore has *.har).
 * `scanForSecrets` is the safety net for the output and the repo-wide scan test.
 */

import { canonicalJson, sha256Hex } from './sanitize.js';
import { OPS, isTierCPath } from './optable.js';

export interface CapturedExchange {
  method: string;
  url: string;
  requestBody?: unknown;
  status: number;
  responseBody?: unknown;
}

export interface ScrubbedContract {
  method: string;
  pathTemplate: string;
  queryKeys: string[];
  requestShape?: unknown;
  status: number;
  responseShape?: unknown;
}

export interface ScrubResult {
  contracts: ScrubbedContract[];
  skipped: { auth: number; tierC: number; unparseable: number };
  omittedKeys: number;
  fixtureSha256: string;
  json: string;
}

// ── Secret scanning ───────────────────────────────────────────────────────────

const PLACEHOLDER_VALUES = '(?:string|number|boolean|null|array|object|redacted|omitted|changeme|example|placeholder|dummy|x+|your[-_a-z]*|\\*+|<[^"\'>]*>)';

const SECRET_PATTERNS: Array<{ kind: string; re: RegExp; strictOnly?: boolean }> = [
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\b/ },
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]+-----[\sA-Za-z0-9+/=]{20,}-----END [A-Z0-9 ]+-----/ },
  { kind: 'cookie-value', re: /\bCookie\s*[:=]\s*['"]?[A-Za-z0-9_.-]+=[A-Za-z0-9._%+/=-]{16,}/i },
  { kind: 'session-cookie-value', re: /\bScoutBoardAuthJWT=[A-Za-z0-9._-]{16,}/ },
  { kind: 'authorization-value', re: /\bAuthorization\s*[:=]\s*['"]?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { kind: 'password-value', re: new RegExp(`["']?(?:password|passwd|pwd)["']?\\s*[:=]\\s*["'](?!${PLACEHOLDER_VALUES}["'])[^"'\\s]{4,}["']`, 'i') },
  { kind: 'login-data', re: /loginData64["']?\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}["']/ },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, strictOnly: true },
  { kind: 'hostname', re: /\b(?:[a-z0-9-]+\.)+(?:net|com|org|se|local|lan|io|dev|eu)\b/i, strictOnly: true },
  { kind: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, strictOnly: true },
];

/** Returns the kinds of secret material found in `text` ([] = clean). `strict` adds e-mail / host / IP checks. */
export function scanForSecrets(text: string, opts: { strict?: boolean } = {}): string[] {
  const found: string[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.strictOnly && !opts.strict) continue;
    if (p.re.test(text)) found.push(p.kind);
  }
  return found;
}

// ── Shape extraction ──────────────────────────────────────────────────────────

/** Key names that look like credential material are omitted from shapes (never even listed). */
const OMIT_KEY = /passw|passphrase|secret|token|cookie|credential|apikey|privatekey|keystore|authoriz|bearer|cert|pem|pfx|p12|signature|signing|session|jwt/i;
/** camelCase / separator word match for short credential words (`key`, `sign`, `auth`) so `author` or `design` survive. */
function omitKey(k: string): boolean {
  if (OMIT_KEY.test(k)) return true;
  const w = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x.toLowerCase());
  return w.some((x) => ['key', 'keys', 'sign', 'signed', 'auth', 'pwd', 'pw'].includes(x));
}

const KEY_GUID = /^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;
/** Plain field-name shape: identifier, at most one digit run of <=2 digits (`x509`-style names are omitted elsewhere). */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** Objects with this many keys are dictionaries (id/name -> value), never fixed records. */
const DICTIONARY_KEYS = 20;

/**
 * N7: response/request OBJECT KEYS that carry data (GUIDs, numbers, container/image names, anything
 * not a plain field name, or every key of a large dictionary) become placeholders so a real id or name
 * never lands in a fixture through a map-style response.
 */
export function keyPlaceholder(k: string, dictionary: boolean): string | null {
  if (KEY_GUID.test(k)) return '{guid}';
  if (/^\d+$/.test(k)) return '{int}';
  if (dictionary) return '{key}';
  if (!FIELD_NAME.test(k) || (k.match(/\d+/g) ?? []).some((d) => d.length > 2) || (k.match(/\d+/g) ?? []).length > 1) return '{key}';
  return null;
}

function shapeOf(v: unknown, counter: { omitted: number }, depth = 0): unknown {
  if (depth > 8) return 'object';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0], counter, depth + 1)];
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(v) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>).sort();
      const dictionary = keys.length >= DICTIONARY_KEYS;
      for (const k of keys) {
        if (omitKey(k) || k.length > 64) {
          counter.omitted += 1;
          continue;
        }
        const ph = keyPlaceholder(k, dictionary);
        const outKey = ph ?? k;
        if (Object.prototype.hasOwnProperty.call(out, outKey)) continue; // placeholder collision: first shape wins
        out[outKey] = shapeOf((v as Record<string, unknown>)[k], counter, depth + 1);
      }
      return out;
    }
    default:
      return 'unknown';
  }
}

const EXTRA_WORDS = ['api', 'v1', 'getAll', 'capabilities', 'rules', 'packages', 'versions', 'dependencies', 'rights', 'status', 'files', 'containers', 'images', 'epms'];
/** lower-case word -> canonical spelling, from the static segments of every op template. */
const PATH_VOCABULARY: Map<string, string> = new Map(
  [...OPS.flatMap((o) => o.template.split('/').filter((x) => x && !x.startsWith('{'))), ...EXTRA_WORDS].map((w) => [w.toLowerCase(), w] as [string, string]),
);

const GUID_SEG = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** URL -> path template: host and query values dropped, ids replaced. */
export function toPathTemplate(url: string): { pathTemplate: string; queryKeys: string[] } {
  let u: URL;
  try {
    u = new URL(url, 'https://placeholder.invalid');
  } catch {
    return { pathTemplate: '/{unparseable}', queryKeys: [] };
  }
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        return '{x}';
      }
      if (GUID_SEG.test(d)) return '{guid}';
      if (/^\d+$/.test(d)) return '{int}';
      // Only words from the op-table vocabulary survive: real container/image/file names never do.
      return PATH_VOCABULARY.get(d.toLowerCase()) ?? '{x}';
    });
  return { pathTemplate: `/${segs.join('/')}`, queryKeys: [...new Set([...u.searchParams.keys()])].filter((k) => !omitKey(k)).sort() };
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Extracts exchanges from a HAR object (`log.entries[]`) or from an already-plain array of CapturedExchange. */
export function exchangesFromCapture(input: unknown): CapturedExchange[] {
  const entries = (input as { log?: { entries?: unknown[] } } | null)?.log?.entries;
  if (Array.isArray(entries)) {
    const out: CapturedExchange[] = [];
    for (const e of entries as Array<Record<string, unknown>>) {
      const req = e?.request as { method?: unknown; url?: unknown; postData?: { text?: unknown } } | undefined;
      const res = e?.response as { status?: unknown; content?: { encoding?: unknown; text?: unknown } } | undefined;
      if (!req || !res || typeof req.method !== 'string' || typeof req.url !== 'string') continue;
      out.push({
        method: req.method,
        url: req.url,
        requestBody: parseMaybeJson(req.postData?.text),
        status: typeof res.status === 'number' ? res.status : 0,
        responseBody: res.content?.encoding === 'base64' ? undefined : parseMaybeJson(res.content?.text),
      });
    }
    return out;
  }
  if (Array.isArray(input)) return input as CapturedExchange[];
  return [];
}

const AUTH_PATH = /(^|\/)(auth|login|logout|ccauth|oidc|token)(\/|$)/i;

/** Scrubs a capture (HAR or exchange array) into a contract fixture. Throws if the output still contains secrets. */
export function scrubCapture(input: unknown): ScrubResult {
  const skipped = { auth: 0, tierC: 0, unparseable: 0 };
  const counter = { omitted: 0 };
  const contracts: ScrubbedContract[] = [];
  for (const ex of exchangesFromCapture(input)) {
    if (typeof ex?.method !== 'string' || typeof ex?.url !== 'string') {
      skipped.unparseable += 1;
      continue;
    }
    const { pathTemplate, queryKeys } = toPathTemplate(ex.url);
    let rawPath = ex.url;
    try {
      rawPath = new URL(ex.url, 'https://placeholder.invalid').pathname;
    } catch {
      /* keep url */
    }
    if (AUTH_PATH.test(rawPath)) {
      skipped.auth += 1;
      continue;
    }
    // Tier C is judged on the ORIGINAL path: never produce a fixture for signing/trust traffic.
    let origPath = ex.url;
    try {
      origPath = new URL(ex.url, 'https://placeholder.invalid').pathname;
    } catch {
      /* keep url */
    }
    if (isTierCPath(ex.method, origPath) || isTierCPath('POST', origPath)) {
      skipped.tierC += 1;
      continue;
    }
    const c: ScrubbedContract = {
      method: ex.method.toUpperCase(),
      pathTemplate,
      queryKeys,
      status: Number.isInteger(ex.status) ? ex.status : 0,
    };
    if (ex.requestBody !== undefined) c.requestShape = shapeOf(ex.requestBody, counter);
    if (ex.responseBody !== undefined) c.responseShape = shapeOf(ex.responseBody, counter);
    contracts.push(c);
  }
  const json = JSON.stringify(contracts, null, 2);
  const found = scanForSecrets(json, { strict: true });
  if (found.length > 0) {
    throw new Error(`scrubbed output still contains secret-like material (${found.join(', ')}); refusing to emit`);
  }
  return { contracts, skipped, omittedKeys: counter.omitted, fixtureSha256: sha256Hex(canonicalJson(contracts)), json };
}
