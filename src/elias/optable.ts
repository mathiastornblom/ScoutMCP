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
}

const S = '[^/?#]+';
const re = (tail: string): RegExp => new RegExp(`^/api/v1${tail}$`);

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
  { key: 'images.generate', method: 'POST', template: '/api/v1/images/generate', pattern: /^\/api\/v1\/images\/generate(\?containerName=[^/#]*)?$/, tier: 'B', kind: 'write', tool: 'elias_image_generate', enabled: false },
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

// ── Tier C: permanently excluded ─────────────────────────────────────────────────

/**
 * Tier C = signing, signing material, sign, trust-certificate import/restore, certificate delete.
 * Fleet-wide trust and attestation; never reachable from this MCP (design section 1, Security R4).
 * Detection is STRUCTURAL and conservative: any non-GET request whose path has a `certificates`
 * segment, or a segment that is exactly one of the signing/trust words, is Tier C. (Exact segments,
 * not substrings: legacy paths such as `.../assignDevices` must not be caught.)
 */
const TIER_C_EXACT_SEGMENTS = new Set(['certificates', 'certificate', 'sign', 'signing', 'signing-upload-key', 'trust', 'defaults']);

function pathSegments(path: string): string[] | null {
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  const out: string[] = [];
  for (const raw of bare.split('/')) {
    if (raw === '') continue;
    let dec: string;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      return null; // undecodable: caller treats as Tier C (fail closed)
    }
    out.push(dec.toLowerCase());
  }
  return out;
}

export function isTierCPath(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return false;
  const segs = pathSegments(path);
  if (segs === null) return true;
  return segs.some((s) => TIER_C_EXACT_SEGMENTS.has(s));
}

export class NotInOpTable extends Error {
  constructor(
    public readonly method: string,
    path: string,
    public readonly reason: 'tier-c' | 'unknown',
  ) {
    super(
      reason === 'tier-c'
        ? `${method} ${path.split(/[?#]/, 1)[0]} is Tier C (signing/trust/certificates) and is permanently excluded from this MCP`
        : `${method} ${path.split(/[?#]/, 1)[0]} is not in the closed ELIAS op table`,
    );
    this.name = 'NotInOpTable';
  }
}

export type Classification =
  | { kind: 'read' }
  | { kind: 'tier-c' }
  | { kind: 'op'; op: OpDef }
  | { kind: 'unknown' };

/** Classifies a concrete request. Tier C wins over everything. */
export function classifyRequest(method: string, path: string): Classification {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return { kind: 'read' };
  if (isTierCPath(m, path)) return { kind: 'tier-c' };
  // Path traversal / encoded separators never match a template.
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(path.split(/[?#]/, 1)[0] ?? '')) return { kind: 'unknown' };
  for (const op of OPS) {
    if (op.method === m && op.pattern.test(path)) return { kind: 'op', op };
  }
  return { kind: 'unknown' };
}

/** Op-table lookup for a write request. Throws NotInOpTable for Tier C and for unknown requests. */
export function lookupOp(method: string, path: string): OpDef {
  const c = classifyRequest(method, path);
  if (c.kind === 'op') return c.op;
  throw new NotInOpTable(method.toUpperCase(), path, c.kind === 'tier-c' ? 'tier-c' : 'unknown');
}

export function getOp(key: string): OpDef {
  const op = OPS.find((o) => o.key === key);
  if (!op) throw new Error(`unknown op key ${key}`);
  return op;
}

// ── Body deny-list (C14) ─────────────────────────────────────────────────────────

/** Keys that must never appear in any body this MCP builds. */
export const BODY_KEY_DENY = /sign|cert|pem|trust|signature|password|secret/i;

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
