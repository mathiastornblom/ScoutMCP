import { ScoutError } from './client.js';
import type { ScoutConfig } from './session.js';

/** True when two configs are field-for-field identical (compared by value, nothing is logged). */
export function sameConfig(a: ScoutConfig | null, b: ScoutConfig | null): boolean {
  if (!a || !b) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ScoutConfig>;
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Decide whether a failed background startup login should wipe the session credentials.
 * Only an explicit server rejection (HTTP 400/401/403) counts, and only while the config
 * is still the one the startup login used: if the user ran scout_configure meanwhile (or
 * the config was already cleared), the late rejection concerns OLD credentials and must
 * not touch the current state. Timeouts, network errors and 5xx never clear.
 */
export function shouldClearCredentialsAfterAuthFailure(
  err: unknown,
  captured: ScoutConfig,
  current: ScoutConfig | null,
): boolean {
  const status = err instanceof ScoutError ? err.statusCode : undefined;
  if (status !== 400 && status !== 401 && status !== 403) return false;
  return current !== null && sameConfig(captured, current);
}
