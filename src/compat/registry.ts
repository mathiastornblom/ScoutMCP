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
];

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'elias',
    description:
      'Built-in ELIAS (containers, packages, images, certificates), served under /api/v1 (private, read-only tools)',
    minScoutVersion: '2611',
    probe: { method: 'GET', path: '/api/v1/systemcheck/elias', kind: 'private' },
    dependentTools: ELIAS_TOOLS,
    status: 'har-only',
  },
  {
    id: 'ourights-preflight',
    description: 'Per-OU rights check (GET /api/v1/ourights?ouId=) used as a UX-only write preflight',
    minScoutVersion: null,
    probe: { method: 'GET', path: '/api/v1/ourights', kind: 'private', badRequestMeansAvailable: true },
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
    id: 'healthcheck',
    description: 'Public GET /api/v1/healthcheck (authenticated system status)',
    minScoutVersion: null,
    probe: { method: 'GET', path: '/api/v1/healthcheck', kind: 'public' },
    dependentTools: ['health_check'],
    status: 'untested',
  },
];

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}
