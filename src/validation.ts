/**
 * Pre-write config validation — §3 of the upgrade spec.
 *
 * Validates a config_update (or any future terminal.ini/kioskmode.ini write) payload
 * against the eLux config schema (src/schema/eluxConfig.ts) before the write is issued:
 *   - unknown section/key → fail, with a fuzzy "did you mean" suggestion
 *   - value outside the documented range/type → fail, with the allowed range
 *   - sinceVersion newer than the target's running eLux build → warn, non-fatal
 *
 * This module is pure (no network calls except the optional running-version lookup,
 * which is injected by the caller) so it can be unit-tested offline.
 */

import {
  findEluxConfigEntry,
  isValueInRange,
  getEluxConfigSection,
  listEluxConfigSections,
  type EluxConfigEntry,
} from './schema/eluxConfig.js';
import { similarity } from './fuzzy.js';

export interface ValidationViolation {
  section: string;
  key: string;
  reason: 'unknown-key' | 'out-of-range';
  /** Present for out-of-range violations. */
  allowedRange?: EluxConfigEntry['range'];
  /** Present for unknown-key violations — nearest known keys in the same section. */
  didYouMean?: string[];
}

export interface ValidationWarning {
  section: string;
  key: string;
  reason: 'since-version';
  sinceVersion: string;
  runningVersion: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: ValidationViolation[];
  warnings: ValidationWarning[];
}

/**
 * Maps a Scout config_get/config_update API section path (e.g. "security", "network/lan")
 * back to a schema section name (e.g. "Security"). Best-effort case-insensitive match on
 * the last path segment; sections with no schema equivalent (most of the live API's
 * sections, e.g. "diagnostics", "mirror") simply yield no schema entries, so validation
 * is a no-op for them — this is intentional: §3 only validates terminal.ini/kioskmode.ini
 * keys, which is the subset the schema actually covers.
 */
export function apiSectionToSchemaSection(apiSection: string): string | null {
  const last = apiSection.split('/').pop() ?? apiSection;
  const sections = listEluxConfigSections();
  const hit = sections.find((c) => c.toLowerCase() === last.toLowerCase());
  return hit ?? null;
}

/** Returns up to 3 nearest key names within the given schema section for "did you mean" suggestions. */
function suggestKeysInSection(schemaSection: string, badKey: string): string[] {
  const entries = getEluxConfigSection(schemaSection);
  return entries
    .map((e) => ({ key: e.key, score: similarity(badKey, e.key) }))
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.key);
}

/**
 * Validates a config_update body against the schema for the given API section.
 *
 * `runningVersion` is the target device's currently-running eLux build (e.g. "7.2105.0"),
 * if known — pass undefined when it cannot be determined (e.g. target=base/ou, or the
 * device's version isn't exposed); sinceVersion warnings are skipped in that case rather
 * than guessed.
 */
export function validateConfigWrite(
  apiSection: string,
  body: Record<string, unknown>,
  runningVersion?: string,
): ValidationResult {
  const schemaSection = apiSectionToSchemaSection(apiSection);
  const violations: ValidationViolation[] = [];
  const warnings: ValidationWarning[] = [];

  // No schema coverage for this section — nothing to validate (see apiSectionToSchemaSection note).
  if (!schemaSection) {
    return { valid: true, violations, warnings };
  }

  for (const [key, value] of Object.entries(body)) {
    const entry = findEluxConfigEntry(schemaSection, key);
    if (!entry) {
      violations.push({
        section: schemaSection,
        key,
        reason: 'unknown-key',
        didYouMean: suggestKeysInSection(schemaSection, key),
      });
      continue;
    }

    if (!isValueInRange(entry, value)) {
      violations.push({
        section: schemaSection,
        key,
        reason: 'out-of-range',
        allowedRange: entry.range,
      });
      continue;
    }

    if (entry.sinceVersion && runningVersion && isVersionNewer(entry.sinceVersion, runningVersion)) {
      warnings.push({
        section: schemaSection,
        key,
        reason: 'since-version',
        sinceVersion: entry.sinceVersion,
        runningVersion,
      });
    }
  }

  return { valid: violations.length === 0, violations, warnings };
}

/** Returns true if `a` (e.g. entry.sinceVersion) is a newer semver-ish version than `b` (running version). */
export function isVersionNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

/** Formats a ValidationResult into a human-readable failure message for fail(). */
export function formatViolations(violations: ValidationViolation[]): string {
  return violations
    .map((v) => {
      if (v.reason === 'unknown-key') {
        const dym = v.didYouMean && v.didYouMean.length > 0
          ? ` Did you mean: ${v.didYouMean.join(', ')}?`
          : '';
        return `  • [${v.section}] "${v.key}" is not a known config key.${dym}`;
      }
      return `  • [${v.section}] "${v.key}" value is out of range. Allowed: ${JSON.stringify(v.allowedRange)}`;
    })
    .join('\n');
}

/** Formats warnings (non-fatal) for inclusion in a successful response. */
export function formatWarnings(warnings: ValidationWarning[]): string[] {
  return warnings.map(
    (w) =>
      `[${w.section}] "${w.key}" requires eLux >= ${w.sinceVersion}, target is running ${w.runningVersion}.`,
  );
}
