/**
 * Closed op table for ELIAS writes (design D1, Security C1/C14, Tier C exclusion).
 *
 * EVERY ELIAS non-GET endpoint known to this project is classified here. Anything not in the
 * table is unknown and refused by client.ts; Tier C (signing / trust / certificates) is never in
 * the table and is refused even when asked for. No tool, no caller-supplied path/method/header:
 * request builders live in this file and take validated fields only.
 *
 * `enabled` marks the ops this BUILD may send at all. Everything else is classified (so it is
 * refused with a precise reason and so tests can prove it is unreachable) but never sendable.
 *
 * This module must not import client.ts (client.ts imports it).
 */

export type OpTier = 'A0' | 'A' | 'B' | 'internal' | 'legacy';
export type OpKind = 'write' | 'read-post' | 'internal';

export interface OpDef {
  key: string;
  method: 'POST' | 'PUT' | 'DELETE';
  /** Human-readable template, e.g. `/api/v1/images/{c}/{id}`. Token bindings use this string. */
  template: string;
  pattern: RegExp;
  tier: OpTier;
  kind: OpKind;
  /** MCP tool that is (or will be) the only caller; null = internal helper. */
  tool: string | null;
  /** True only for ops this build can send. Deferred ops are classified but refused. */
  enabled: boolean;
  /** Body keys the builder may emit (documentation + test oracle). */
  bodyKeys?: readonly string[];
  /** True when the endpoint takes a query string (never the case for an enabled op today). */
  allowQuery?: boolean;
}

const S = '[^/?#]+';
const re = (tail: string): RegExp => new RegExp(`^/api/v1${tail}$`, 'i');

export const OPS: readonly OpDef[] = [
  // ── Tier A: additive / metadata ────────────────────────────────────────────
  { key: 'containers.import', method: 'POST', template: '/api/v1/containers/import', pattern: re('/containers/import'), tier: 'A', kind: 'write', tool: 'elias_container_create', enabled: true, bodyKeys: ['name'] },
  { key: 'containers.rename', method: 'PUT', template: '/api/v1/containers/{id}', pattern: re(`/containers/${S}`), tier: 'A', kind: 'write', tool: 'elias_container_rename', enabled: false },
  { key: 'epms.preselection', method: 'PUT', template: '/api/v1/epms/{c}/{id}/preselection', pattern: re(`/epms/${S}/${S}/preselection`), tier: 'A', kind: 'write', tool: 'elias_package_set_preselection', enabled: false },
  { key: 'images.create', method: 'POST', template: '/api/v1/images/container/{c}', pattern: re(`/images/container/${S}`), tier: 'A', kind: 'write', tool: 'elias_image_create', enabled: false },
  { key: 'images.update', method: 'PUT', template: '/api/v1/images/{c}/{id}', pattern: re(`/images/${S}/${S}`), tier: 'A', kind: 'write', tool: 'elias_image_update', enabled: false },
  { key: 'images.addEpm', method: 'PUT', template: '/api/v1/images/addEpm', pattern: re('/images/addEpm'), tier: 'A', kind: 'write', tool: 'elias_image_add_package', enabled: false },
  { key: 'images.deleteEpm', method: 'PUT', template: '/api/v1/images/deleteEpm', pattern: re('/images/deleteEpm'), tier: 'A', kind: 'write', tool: 'elias_image_remove_package', enabled: false },

  // ── Tier B: destructive / ingest / long-running (all deferred) ────────────
  { key: 'images.delete', method: 'DELETE', template: '/api/v1/images/{c}/{id}', pattern: re(`/images/${S}/${S}`), tier: 'B', kind: 'write', tool: 'elias_image_delete', enabled: false },
  { key: 'epms.delete', method: 'DELETE', template: '/api/v1/epms/{c}/{id}', pattern: re(`/epms/${S}/${S}`), tier: 'B', kind: 'write', tool: 'elias_package_delete', enabled: false },
  { key: 'containers.files.delete', method: 'DELETE', template: '/api/v1/containers/{id}/files/{filename}', pattern: re(`/containers/${S}/files/${S}`), tier: 'B', kind: 'write', tool: 'elias_container_file_delete', enabled: false },
  { key: 'containers.delete', method: 'DELETE', template: '/api/v1/containers/{id}', pattern: re(`/containers/${S}`), tier: 'B', kind: 'write', tool: 'elias_container_delete', enabled: false },
  { key: 'containers.files.images', method: 'POST', template: '/api/v1/containers/{id}/files/images', pattern: re(`/containers/${S}/files/images`), tier: 'B', kind: 'write', tool: 'elias_container_upload_images', enabled: false },
  { key: 'containers.packageChanges.accept', method: 'POST', template: '/api/v1/containers/{id}/package-changes/accept', pattern: re(`/containers/${S}/package-changes/accept`), tier: 'B', kind: 'write', tool: 'elias_package_changes_accept', enabled: false },
  { key: 'images.generate', method: 'POST', template: '/api/v1/images/generate', pattern: re('/images/generate'), tier: 'B', kind: 'write', tool: 'elias_image_generate', enabled: false, allowQuery: true },
  { key: 'files.import', method: 'POST', template: '/api/v1/files/import/{c}', pattern: re(`/files/import/${S}`), tier: 'B', kind: 'write', tool: 'elias_container_import_archive', enabled: false },
  { key: 'files.upload.init', method: 'POST', template: '/api/v1/files/upload/init', pattern: re('/files/upload/init'), tier: 'B', kind: 'write', tool: 'elias_upload_file', enabled: false },
  { key: 'files.upload.chunk', method: 'PUT', template: '/api/v1/files/upload/{id}/chunk', pattern: re(`/files/upload/${S}/chunk`), tier: 'B', kind: 'write', tool: 'elias_upload_file', enabled: false },
  { key: 'files.upload.complete', method: 'POST', template: '/api/v1/files/upload/{id}/complete', pattern: re(`/files/upload/${S}/complete`), tier: 'B', kind: 'write', tool: 'elias_upload_file', enabled: false },
  { key: 'files.upload.target', method: 'POST', template: '/api/v1/files/upload/{id}/target', pattern: re(`/files/upload/${S}/target`), tier: 'B', kind: 'write', tool: null, enabled: false },
  { key: 'solver.generateRules', method: 'POST', template: '/api/v1/solver/{c}/generateRules', pattern: re(`/solver/${S}/generateRules`), tier: 'B', kind: 'write', tool: 'elias_solver_generate_rules', enabled: false },
  { key: 'solver.solve', method: 'POST', template: '/api/v1/solver/{c}/solve', pattern: re(`/solver/${S}/solve`), tier: 'B', kind: 'write', tool: 'elias_solver_solve', enabled: false },

  // ── Tier A0: read-class POSTs. Sendable without a token only when `enabled` (live non-mutation
  //    evidence recorded, C28). None of the A0 ops below is enabled yet. ─────────────────────────
  { key: 'images.idf', method: 'POST', template: '/api/v1/images/{c}/{id}/idf', pattern: re(`/images/${S}/${S}/idf`), tier: 'A0', kind: 'read-post', tool: 'elias_image_export_idf', enabled: false },
  { key: 'images.parseIdf', method: 'POST', template: '/api/v1/images/{c}/parseIdf', pattern: re(`/images/${S}/parseIdf`), tier: 'A0', kind: 'read-post', tool: 'elias_idf_parse', enabled: false },
  { key: 'images.verify', method: 'POST', template: '/api/v1/images/{c}/{id}/verify', pattern: re(`/images/${S}/${S}/verify`), tier: 'A0', kind: 'read-post', tool: 'elias_image_verify', enabled: false },
  { key: 'solver.hasConflicts', method: 'POST', template: '/api/v1/solver/{c}/hasConflicts', pattern: re(`/solver/${S}/hasConflicts`), tier: 'A0', kind: 'read-post', tool: 'elias_solver_check', enabled: false },
  { key: 'solver.findConflicts', method: 'POST', template: '/api/v1/solver/{c}/findConflicts', pattern: re(`/solver/${S}/findConflicts`), tier: 'A0', kind: 'read-post', tool: 'elias_solver_check', enabled: false },
  { key: 'solver.isSelfContained', method: 'POST', template: '/api/v1/solver/{c}/isSelfContained', pattern: re(`/solver/${S}/isSelfContained`), tier: 'A0', kind: 'read-post', tool: 'elias_solver_check', enabled: false },

  // ── Read-class POSTs that already exist today (closed list, C1) ───────────────────────────────
  { key: 'elias.myContainerRoles', method: 'POST', template: '/api/v1/elias/my-container-roles', pattern: re('/elias/my-container-roles'), tier: 'A0', kind: 'read-post', tool: 'elias_my_roles', enabled: true },
  { key: 'legacy.treefilter', method: 'POST', template: '/api/v1/treefilter', pattern: re('/treefilter'), tier: 'legacy', kind: 'read-post', tool: 'system_info', enabled: true },

  // ── Session / lock plumbing: internal to the future lock.ts only. Refused by the client until
  //    that module exists (no caller can claim `internal` today). ───────────────────────────────
  { key: 'lock.set', method: 'POST', template: '/api/v1/lock/set', pattern: re('/lock/set'), tier: 'internal', kind: 'internal', tool: null, enabled: false },
  { key: 'lock.release', method: 'POST', template: '/api/v1/lock/release', pattern: re('/lock/release'), tier: 'internal', kind: 'internal', tool: null, enabled: false },
  { key: 'heartbeat', method: 'POST', template: '/api/v1/heartbeat', pattern: re('/heartbeat'), tier: 'internal', kind: 'internal', tool: null, enabled: false },
  { key: 'ui.unregister', method: 'POST', template: '/api/v1/ui/unregister', pattern: re('/ui/unregister'), tier: 'internal', kind: 'internal', tool: null, enabled: false },
];

// ── Path normalisation (Security F1) ─────────────────────────────────────────────

export type NormalizedPath = { ok: true; path: string; query: string } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Normalises a request path BEFORE any classification: query split off, percent-decoding applied
 * exactly once (double encoding rejected), '//' collapsed, '.'/'..' segments, ';', '#', backslash,
 * encoded '/' ('%2F') and '\' ('%5C'), NUL and control characters rejected, lower-cased.
 */
export function normalizeWritePath(path: string): NormalizedPath {
  if (typeof path !== 'string' || path === '') return { ok: false, reason: 'empty path' };
  const qi = path.indexOf('?');
  const rawPath = qi === -1 ? path : path.slice(0, qi);
  const query = qi === -1 ? '' : path.slice(qi + 1);
  if (CONTROL_RE.test(path) || /[\\#\s]/.test(rawPath)) return { ok: false, reason: 'control character, backslash, fragment or whitespace in path' };
  if (rawPath.includes(';')) return { ok: false, reason: 'path parameter separator ";" in path' };
  if (/%2f|%5c|%00/i.test(rawPath)) return { ok: false, reason: 'encoded separator or NUL in path' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, reason: 'undecodable percent-encoding' };
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) return { ok: false, reason: 'double percent-encoding' };
  if (CONTROL_RE.test(decoded) || /[\\;#\s]/.test(decoded) || decoded.includes('\u0000')) return { ok: false, reason: 'unsafe character after decoding' };
  const segs = decoded.split('/').filter((x) => x !== '');
  if (segs.some((x) => x === '.' || x === '..')) return { ok: false, reason: '"." or ".." segment in path' };
  return { ok: true, path: `/${segs.join('/').toLowerCase()}`, query };
}

/**
 * N1: the string that was validated must be the string that is sent. For a non-GET the bare path
 * (query stripped) must start with '/', contain no empty segment ('//') and no trailing slash, and
 * the fixed segments of the matched template (or legacy path) must match EXACTLY (case included), so
 * `api/v1/...` (host rewrite), `/API/V1/...`, `/api/v1//x` and `/api/v1/x/` never reach fetch().
 * `fixed` is a template such as `/api/v1/images/{c}/{id}`; `{...}` segments are free (ids may be
 * mixed-case). When omitted only the structural checks apply.
 */
export function isCanonicalSentPath(path: string, fixed?: string): boolean {
  if (typeof path !== 'string') return false;
  const qi = path.indexOf('?');
  const bare = qi === -1 ? path : path.slice(0, qi);
  if (!bare.startsWith('/') || bare.startsWith('//')) return false;
  const segs = bare.slice(1).split('/');
  if (segs.some((x) => x === '')) return false; // '//' or a trailing slash
  if (fixed === undefined) return true;
  const want = fixed.slice(1).split('/');
  if (want.length !== segs.length) return false;
  return want.every((w, i) => (w.startsWith('{') ? segs[i] !== '' : w === segs[i]));
}

// ── Tier C: permanently excluded ─────────────────────────────────────────────────

/**
 * Tier C = signing, signing material, sign, trust-certificate import/restore, certificate delete.
 * Fleet-wide trust and attestation; never reachable from this MCP (design section 1, Security R4).
 * Detection is broad and applies to EVERY non-GET, on the raw path (decoded repeatedly, so double
 * encoding cannot hide it) and on the normalised path: the long words (signing, signature,
 * certificate, trust, pfx, pkcs) match as substrings; the short word `sign` matches as a word or as a
 * segment prefix (so `sign;x`, `signing-keys`, `trustCertificates` are caught while `assignDevices` is not).
 */
const TIER_C_SUBSTRINGS = /signing|signature|certificate|trust|pfx|pkcs/i;

function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function tierCText(text: string): boolean {
  if (TIER_C_SUBSTRINGS.test(text)) return true;
  for (const seg of text.split('/')) {
    if (seg.toLowerCase().startsWith('sign')) return true;
    const w = words(seg);
    if (w.includes('sign') || w.includes('cert') || w.includes('defaults')) return true;
  }
  return false;
}

export function isTierCPath(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  const bare = path.split('?', 1)[0] ?? '';
  // Raw text, decoded up to three times (failures ignored): hides nothing behind encoding.
  let cur = bare;
  for (let i = 0; i < 4; i++) {
    if (tierCText(cur)) return true;
    try {
      const next = decodeURIComponent(cur);
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  const n = normalizeWritePath(path);
  return n.ok && tierCText(n.path);
}

export class NotInOpTable extends Error {
  constructor(
    public readonly method: string,
    path: string,
    public readonly reason: 'tier-c' | 'unknown' | 'rejected',
  ) {
    super(
      reason === 'tier-c'
        ? `${method} ${path.split(/[?#]/, 1)[0]} is Tier C (signing/trust/certificates) and is permanently excluded from this MCP`
        : reason === 'rejected'
          ? `${method} ${path.split(/[?#]/, 1)[0]} was rejected by path normalisation`
          : `${method} ${path.split(/[?#]/, 1)[0]} is not in the closed ELIAS op table`,
    );
    this.name = 'NotInOpTable';
  }
}

export type Classification =
  | { kind: 'read' }
  | { kind: 'tier-c' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'op'; op: OpDef; path: string }
  | { kind: 'unknown'; path: string; query: string };

/** Classifies a concrete request: normalise first, Tier C wins over everything. */
export function classifyRequest(method: string, path: string): Classification {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { kind: 'read' };
  if (isTierCPath(m, path)) return { kind: 'tier-c' };
  const n = normalizeWritePath(path);
  if (!n.ok) return { kind: 'rejected', reason: n.reason };
  // N1: structural ambiguity is rejected here, not collapsed: a missing leading '/' or an empty
  // segment ('//') can change what the URL means once it is concatenated onto the base URL.
  const bare = path.split('?', 1)[0] ?? '';
  if (!bare.startsWith('/') || bare.includes('//')) return { kind: 'rejected', reason: 'missing leading "/" or empty path segment' };
  for (const op of OPS) {
    if (op.method === m && op.pattern.test(n.path) && (n.query === '' || op.allowQuery)) return { kind: 'op', op, path: n.path };
  }
  return { kind: 'unknown', path: n.path, query: n.query };
}

/**
 * Legacy private-write endpoints (non-ELIAS) that pass `mutating:true`. EXACT normalised paths only;
 * built from the existing rawRequest write callers. Anything else that is a non-GET and not in the op
 * table is refused even with `mutating:true`.
 */
export type LegacyMethod = 'POST' | 'PUT' | 'DELETE';
/** N3: method is pinned per entry; only the listed verb(s) may be sent to a listed path. */
export const LEGACY_MUTATING: ReadonlyArray<{ path: string; methods: readonly LegacyMethod[]; allowQuery?: boolean }> = [
  { path: '/api/v1/license/reconfigure', methods: ['PUT'] },
  { path: '/api/v1/ui/instances', methods: ['PUT', 'DELETE'] },
  { path: '/api/v1/predefinedcommands/add', methods: ['POST'] },
  { path: '/api/v1/predefinedcommands/modify', methods: ['POST'] },
  { path: '/api/v1/predefinedcommands/delete', methods: ['POST'] },
  { path: '/api/v1/predefinedcommands/auth', methods: ['POST'] },
  { path: '/api/v1/predefinedcommands/modifytemplates', methods: ['POST'] },
  { path: '/api/v1/predefinedpaths/add', methods: ['POST'] },
  { path: '/api/v1/predefinedpaths/delete', methods: ['POST'] },
  { path: '/api/v1/loggingoptions/set', methods: ['POST'] },
  { path: '/api/v1/discoveroptions/set', methods: ['POST'] },
  { path: '/api/v1/retainlocalconfig/set', methods: ['POST'] },
  { path: '/api/v1/devicenameoptions/set', methods: ['POST'] },
  { path: '/api/v1/recoverysettings', methods: ['POST'] },
  { path: '/api/v1/devicepassword/set', methods: ['POST'] },
  { path: '/api/v1/admins/add', methods: ['POST'] },
  { path: '/api/v1/admins/modify', methods: ['POST'] },
  { path: '/api/v1/oufilter/setsettings', methods: ['POST'] },
  { path: '/api/v1/oufilter/add', methods: ['POST'] },
  { path: '/api/v1/oufilter/modify', methods: ['POST'] },
  { path: '/api/v1/oufilter/delete', methods: ['POST'] },
  { path: '/api/v1/newdeviceoptions/set', methods: ['POST'] },
  { path: '/api/v1/admins', methods: ['DELETE'], allowQuery: true }, // DELETE /admins?adminName=
  { path: '/api/v1/dbcleanup', methods: ['POST', 'DELETE'], allowQuery: true }, // POST with body; query form kept
];

/**
 * True when (normalised path, query, method) is on the legacy allow-list. `method` is pinned (N3);
 * omitting it answers "is this path listed at all" (path-only lookups in tests).
 */
export function isLegacyMutating(normPath: string, query: string, method?: string): boolean {
  const m = method?.toUpperCase();
  return LEGACY_MUTATING.some(
    (e) => e.path === normPath && (query === '' || e.allowQuery === true) && (m === undefined || (e.methods as readonly string[]).includes(m)),
  );
}

/** Throws NotInOpTable for Tier C, rejected and unknown requests; returns the op otherwise. */
export function lookupOp(method: string, path: string): OpDef {
  const c = classifyRequest(method, path);
  if (c.kind === 'op') return c.op;
  throw new NotInOpTable(method.toUpperCase(), path, c.kind === 'tier-c' ? 'tier-c' : c.kind === 'rejected' ? 'rejected' : 'unknown');
}

export function getOp(key: string): OpDef {
  const op = OPS.find((o) => o.key === key);
  if (!op) throw new Error(`unknown op key ${key}`);
  return op;
}

// ── Body deny-list (C14) ─────────────────────────────────────────────────────────

/**
 * Keys that must never appear in any body this MCP builds (N2). Matching is by SUBSTRING on the
 * normalised key (lower-cased, `-`/`_`/whitespace/dots removed), so `signKey`, `sign_key`, `pemfile`,
 * `certfile`, `myCert`, `caCert`, `x509`, `signer`, `keystore`, `privateKey`, `password`, `secret`,
 * `trust`, `pkcs`, `pfx`, `p12`, `pem`, `thumbprint` are all denied in any spelling. Legitimate words that
 * merely contain `sign` (design, assign, assignedTo, resign, consign, ...) are removed from the key
 * before the `sign`/`cert` check, so they are not caught. Exposed with a RegExp-like `test`.
 */
const BODY_ALLOWED_WORDS = /design|assign|resign|consign|cosign|insignia|signal|signif|signpost|assert|desert|concert|certain|certify|uncertain/g;
const BODY_ALWAYS = /signature|signing|certificate|password|passwd|secret|trust|pkcs|privatekey|privkey|keystore|pemfile|certfile|x509|pfx|p12|thumbprint/;
export const BODY_KEY_DENY = {
  test(key: string): boolean {
    const n = key.toLowerCase().replace(/[\s_.\-]+/g, '');
    if (BODY_ALWAYS.test(n)) return true;
    const cleaned = n.replace(BODY_ALLOWED_WORDS, '');
    if (/sign|cert/.test(cleaned)) return true;
    // `pem` is short: whole word (camelCase split), a suffix (certPem, keyPem) or a prefix of a known compound.
    const w = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((x) => x.toLowerCase());
    return w.includes('pem') || n.endsWith('pem') || /pem(file|data|key|cert|body|string|text|content|blob|bundle)/.test(n);
  },
};

export class BodyDenied extends Error {
  constructor(key: string) {
    super(`request body key "${key.slice(0, 40)}" is on the deny-list (signing/certificate/trust/credential material is never sent)`);
    this.name = 'BodyDenied';
  }
}

/** Throws BodyDenied when any (nested) key matches the deny-list. */
export function assertBodyAllowed(body: unknown, depth = 0): void {
  if (depth > 8) throw new BodyDenied('<too deep>');
  if (Array.isArray(body)) {
    for (const v of body) assertBodyAllowed(v, depth + 1);
    return;
  }
  if (body !== null && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (BODY_KEY_DENY.test(k)) throw new BodyDenied(k);
      assertBodyAllowed(v, depth + 1);
    }
  }
}

// ── Request builders (the only place a write path/body is assembled) ───────────────

export interface BuiltRequest {
  op: OpDef;
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
}

/** POST /api/v1/containers/import {name}. `name` must already be a validated ContainerName. */
export function buildContainerCreateRequest(name: string): BuiltRequest {
  const op = getOp('containers.import');
  const body = { name };
  assertBodyAllowed(body);
  return { op, method: 'POST', path: '/api/v1/containers/import', body };
}

/** Ops the client may ever send with a mutation token. */
export function isSendableWrite(op: OpDef): boolean {
  return op.kind === 'write' && op.enabled;
}
