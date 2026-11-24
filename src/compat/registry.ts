/**
 * Scout-version capability registry.
 *
 * Single source of truth for which MCP features depend on the Scout Board release.
 * RULE: any new Scout-version-dependent feature must add/update its entry here AND its row in
 * docs/compatibility.md in the same PR (tests/compat.test.ts enforces that the two agree).
 *
 * Facts only: minScoutVersion is null when no source (README, HAR, docs) establishes it.
 * Versions are year-month numbers written as strings, e.g. '2611' = Scout 2611.
 */

/** How well the feature is known to work against a real server. */
export type CapabilityStatus = 'verified-live' | 'har-only' | 'untested';

/** Whether the probe hits the public API (/rest prefix, client.request) or a private one (rawRequest). */
export type ProbeKind = 'public' | 'private';

export interface CapabilityProbe {
  /** Probes are read-only by construction: the type admits GET only (asserted in tests). */
  method: 'GET';
  /** Path as passed to client.request / client.rawRequest. */
  path: string;
  kind: ProbeKind;
  /**
   * HTTP 400 on this probe means "route exists, parameters missing" -> available.
   * Only set where the probe deliberately omits a required parameter.
   */
  badRequestMeansAvailable?: boolean;
  /**
   * HTTP 404 whose body message contains this text (case-insensitive) means "route exists, the
   * entity was not found" -> available. A plain route-404 (any other message) stays unavailable.
   */
  notFoundMessageMeansAvailable?: string;
}

export interface Capability {
  id: string;
  description: string;
  /** Scout release (YYMM as string) the feature first appears in, or null if not established. */
  minScoutVersion: string | null;
  /** null = not probeable (config-driven or syntax-level feature). */
  probe: CapabilityProbe | null;
  /** MCP tool names that depend on this capability. */
  dependentTools: string[];
  status: CapabilityStatus;
}

const ELIAS_TOOLS = [
  'elias_health',
  'elias_container_list',
  'elias_container_files',
  'elias_rights',
  'elias_package_list',
  'elias_image_list',
  'elias_certificate_list',
  'elias_certificate_get',
  'elias_upload_status',
  'elias_container_get',
  'elias_container_capabilities',
  'elias_container_rules',
  'elias_package_versions',
  'elias_package_dependencies',
  'elias_image_get',
  'elias_my_roles',
];

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'elias',
    description:
      'Built-in ELIAS (containers, packages, images, certificates), served under /api/v1 (private, read-only tools)',
    minScoutVersion: '2611',
    probe: { method: 'GET', path: '/api/v1/systemcheck/elias', kind: 'private' },
    dependentTools: ELIAS_TOOLS,
    status: 'verified-live',
  },
  {
    id: 'ourights-preflight',
    description: 'Per-OU rights check (GET /api/v1/ourights?ouId=) used as a UX-only write preflight',
    minScoutVersion: null,
    probe: { method: 'GET', path: '/api/v1/ourights', kind: 'private', badRequestMeansAvailable: true, notFoundMessageMeansAvailable: 'OuId not found' },
    dependentTools: ['ou_manage', 'device_command', 'config_update'],
    status: 'har-only',
  },
  {
    id: 'advanced-file-entries',
    description: 'Public /config/advanced/{base,ou,device}/fileEntries endpoints (advanced file entries)',
    minScoutVersion: null,
    probe: { method: 'GET', path: '/api/v1/config/advanced/base/fileEntries', kind: 'public' },
    dependentTools: ['config_resolve'],
    status: 'untested',
  },
  {
    id: 'ou-filter-and-or',
    description: 'OU user-defined filter custom_filter with AND/OR, bracket grouping and built-in prefix matching',
    minScoutVersion: '2605',
    probe: null,
    dependentTools: ['ou_filter_manage'],
    status: 'verified-live',
  },
  {
    id: 'ccauth-login',
    description: 'Citrix Cloud service-principal login (OAuth2 client_credentials, then /auth/v1/ccauth/login)',
    minScoutVersion: null,
    probe: null,
    dependentTools: ['scout_configure'],
    status: 'untested',
  },
  {
    id: 'elias-write-containers',
    description:
      'ELIAS container write ops (POST /api/v1/containers/import; foundation only: off by default, registered only with verified-live body evidence)',
    minScoutVersion: '2611',
    probe: null,
    dependentTools: ['elias_container_create'],
    status: 'untested',
  },
  {
    id: 'healthcheck',
    description: 'Public GET /api/v1/healthcheck (authenticated system status)',
    minScoutVersion: null,
    probe: { method: 'GET', path: '/api/v1/healthcheck', kind: 'public' },
    dependentTools: ['health_check'],
    status: 'verified-live',
  },
];

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

// ── Per-tool write body evidence (ELIAS write phase, design D0 / Security C12) ────────────────────

/**
 * Evidence that a write body was captured from a live server and scrubbed (allow-list extraction,
 * see src/elias/fixture-scrub.ts). A status string alone is self-attested and is NOT enough.
 */
export interface BodyEvidence {
  /** ISO date `YYYY-MM-DD` of the capture. */
  date: string;
  /** Opaque capture id (never a host name). */
  captureId: string;
  /** sha256 (hex) of the scrubbed contract fixture file. */
  fixtureSha256: string;
}

export interface WriteBodyContract {
  toolName: string;
  /** Key into the closed op table (src/elias/optable.ts). */
  opKey: string;
  /** `verified-live` needs `evidence` and `fixture`. */
  bodyStatus: CapabilityStatus;
  evidence?: BodyEvidence;
  /** Path of the scrubbed contract fixture, relative to tests/fixtures/elias/contracts/. */
  fixture?: string;
}

/**
 * Write tools whose request body is registered. Rule D0: a write tool is registered with the MCP only
 * when its entry here is `verified-live` WITH a valid evidence record (or, in SCOUT_ENV=test only,
 * the explicit unverified escape hatch restricted to strict MCPTEST names).
 * `POST /containers/import {name}` is known from the vendor source/e2e only; no live capture exists yet.
 */
export const WRITE_BODY_CONTRACTS: readonly WriteBodyContract[] = [
  { toolName: 'elias_container_create', opKey: 'containers.import', bodyStatus: 'untested' },
];

export function getBodyContract(toolName: string, contracts: readonly WriteBodyContract[] = WRITE_BODY_CONTRACTS): WriteBodyContract | undefined {
  return contracts.find((c) => c.toolName === toolName);
}

/** Structural validity of an evidence record (the fixture hash is verified in tests/compat). */
export function hasValidEvidence(c: WriteBodyContract): boolean {
  const e = c.evidence;
  return (
    !!e &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
    /^[A-Za-z0-9._-]{4,64}$/.test(e.captureId) &&
    /^[0-9a-f]{64}$/.test(e.fixtureSha256) &&
    typeof c.fixture === 'string' &&
    c.fixture.length > 0
  );
}

/** D0: `verified-live` AND a valid evidence record. */
export function isBodyVerifiedLive(toolName: string, contracts: readonly WriteBodyContract[] = WRITE_BODY_CONTRACTS): boolean {
  const c = getBodyContract(toolName, contracts);
  return !!c && c.bodyStatus === 'verified-live' && hasValidEvidence(c);
}
