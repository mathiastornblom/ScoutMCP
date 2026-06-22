/**
 * Pure transport-selection logic, extracted from index.ts so it can be unit tested without
 * the side effects of importing index.ts (startup auth check, version check, server
 * construction, etc).
 */

export type TransportMode = 'stdio' | 'http';

export class InvalidTransportError extends Error {
  constructor(public readonly raw: string | undefined) {
    super(`Invalid SCOUT_TRANSPORT="${raw}" — expected "stdio" or "http".`);
    this.name = 'InvalidTransportError';
  }
}

/**
 * Resolves the transport mode from SCOUT_TRANSPORT. Defaults to "stdio" when unset, so
 * existing deployments that never set this env var keep their current behavior unchanged.
 * Case-insensitive. Throws InvalidTransportError for any other value.
 */
export function resolveTransportMode(rawEnvValue: string | undefined): TransportMode {
  const normalized = (rawEnvValue ?? 'stdio').toLowerCase();
  if (normalized === 'stdio' || normalized === 'http') {
    return normalized;
  }
  throw new InvalidTransportError(rawEnvValue);
}

/**
 * Resolves and validates the HTTP port from SCOUT_HTTP_PORT. Defaults to 3000.
 */
export function resolveHttpPort(rawEnvValue: string | undefined): number {
  const port = Number(rawEnvValue ?? '3000');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SCOUT_HTTP_PORT: ${rawEnvValue}`);
  }
  return port;
}
