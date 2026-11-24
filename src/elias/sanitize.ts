/**
 * Output hygiene for the ELIAS write phase (Security C6).
 *
 * Server-derived strings (container names, ids, filenames) that reach an elicitation prompt, a plan,
 * an error or an audit row are reduced to a conservative charset and capped. Free-text fields
 * (descriptions, server messages) are never put into a prompt at all.
 */

import { createHash } from 'node:crypto';

/** Shown instead of characters outside the safe set. */
const REPLACEMENT = '?';
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;

/**
 * Escapes a server-derived string for prompts, errors and audit: ANSI sequences removed, every
 * character outside `[A-Za-z0-9._+~ -]` replaced with `?` (so no newline, markdown, backtick, angle
 * bracket or control character survives), whitespace runs collapsed, capped at `max` characters.
 */
export function safeDisplay(value: unknown, max = 80): string {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const noAnsi = s.replace(ANSI_RE, '');
  const cleaned = noAnsi.replace(/[^A-Za-z0-9._+~ -]/g, REPLACEMENT).replace(/ {2,}/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/** Deterministic JSON (object keys sorted recursively). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Plan digest (C5): sha256 over the canonical plan (target, server names, dependents, body sha, snapshot plan). */
export function planDigest(plan: unknown): string {
  return sha256Hex(canonicalJson(plan));
}
