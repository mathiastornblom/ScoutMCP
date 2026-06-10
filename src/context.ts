/**
 * Session-level OU context — an in-memory "working OU" that tools use as
 * a default when no explicit ouPath/destoupath is provided.
 *
 * Stored in memory only; cleared on process restart. Set via the
 * scout_context tool (action=set_ou).
 */

export interface WorkingOu {
  /** Canonical OU path, e.g. "/Enterprise/Germany/Berlin" */
  path: string;
  /** Display name, e.g. "Berlin Office" */
  name: string;
}

let current: WorkingOu | null = null;

/** Returns the active working OU, or null if none is set. */
export function getWorkingOu(): WorkingOu | null {
  return current;
}

/** Sets the active working OU. */
export function setWorkingOu(path: string, name: string): void {
  current = { path, name };
}

/** Clears the active working OU. */
export function clearWorkingOu(): void {
  current = null;
}
