/**
 * Canonical form of an OU path, used for every protected/allowed-OU comparison and for
 * resolver path matching, so that case, surrounding whitespace, repeated or trailing
 * slashes cannot be used to slip past a SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS entry.
 *
 * Rules: trim the whole string; split on "/"; drop empty segments (collapses "//" and
 * trailing "/"); case-fold (toLowerCase) every segment; always lead with "/"; "." and ".."
 * segments and control characters are REJECTED (throw) rather than interpreted.
 * Examples: " /NorthCreek//Customers/ " -> "/northcreek/customers"; "" or "/" -> "/".
 */
export class OuPathError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'OuPathError';
  }
}

export function canonicalizeOuPath(path: string): string {
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new OuPathError('contains control characters');
  const segments = path.trim().split('/').filter((s) => s !== '');
  for (const s of segments) {
    if (s === '.' || s === '..') throw new OuPathError(`contains a "${s}" segment`);
  }
  return '/' + segments.map((s) => s.toLowerCase()).join('/');
}
