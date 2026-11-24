/**
 * Unit tests for src/validation.ts — pre-write config validation (§3 of the upgrade spec).
 *
 * Uses the real bundled schema/elux-config.json (via src/schema/eluxConfig.ts) since
 * validation must prove it works against the actual schema, not a synthetic one — but
 * still fully offline: no Scout Board connection, no getClient() calls.
 *
 * Run with: npx tsx tests/validation.test.ts
 */

import {
  validateConfigWrite,
  apiSectionToSchemaSection,
  isVersionNewer,
  formatViolations,
  formatWarnings,
} from '../src/validation.js';
import { findEluxConfigEntry, loadEluxConfigSchema } from '../src/schema/eluxConfig.js';

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// apiSectionToSchemaSection — sanity that the mapping resolves the keys we test with
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\napiSectionToSchemaSection mapping');

test('"security" API section maps to schema section "Security"', () => {
  assert(apiSectionToSchemaSection('security') === 'Security', 'expected "Security"');
});

test('an unmapped API section (e.g. "diagnostics") returns null', () => {
  assert(apiSectionToSchemaSection('diagnostics') === null, 'expected null for unmapped section');
});

// Sanity: confirm the schema actually has AuthType under Security with the range we assume below.
test('fixture assumption: Security.AuthType exists in the bundled schema with range including 13', () => {
  const entry = findEluxConfigEntry('Security', 'AuthType');
  assert(entry !== undefined, 'expected Security.AuthType to exist in schema/elux-config.json');
  assert(Array.isArray(entry!.range) && entry!.range.includes(13), 'expected range to include 13');
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateConfigWrite — in-range / out-of-range / unknown-key / since-version
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nvalidateConfigWrite');

test('in-range value passes with no violations', () => {
  const result = validateConfigWrite('security', { AuthType: 13 });
  assert(result.valid === true, 'expected valid=true');
  assert(result.violations.length === 0, 'expected no violations');
});

test('out-of-range value fails with reason=out-of-range and the allowed range', () => {
  const result = validateConfigWrite('security', { AuthType: 999 });
  assert(result.valid === false, 'expected valid=false');
  assert(result.violations.length === 1, 'expected exactly one violation');
  assert(result.violations[0]!.reason === 'out-of-range', 'expected reason=out-of-range');
  assert(Array.isArray(result.violations[0]!.allowedRange), 'expected allowedRange to be present');
});

test('unknown key fails with reason=unknown-key and a "did you mean" suggestion', () => {
  // "AuthTyp" is a near-miss of the real key "AuthType" — should be suggested.
  const result = validateConfigWrite('security', { AuthTyp: 13 });
  assert(result.valid === false, 'expected valid=false');
  assert(result.violations[0]!.reason === 'unknown-key', 'expected reason=unknown-key');
  assert(
    (result.violations[0]!.didYouMean ?? []).includes('AuthType'),
    `expected "AuthType" in didYouMean, got ${JSON.stringify(result.violations[0]!.didYouMean)}`,
  );
});

test('a section with no schema coverage (e.g. "diagnostics") is a no-op pass', () => {
  const result = validateConfigWrite('diagnostics', { AnythingGoes: 'yep' });
  assert(result.valid === true, 'expected valid=true (no schema coverage = no validation)');
  assert(result.violations.length === 0, 'expected no violations');
});

test('since-version warning is surfaced but does not fail validation', () => {
  // Find a key with a non-null sinceVersion to use as fixture data.
  const sinceVersionedEntry = findKeyWithSinceVersion();
  assert(sinceVersionedEntry !== undefined, 'expected at least one schema entry with sinceVersion set');

  const { section, key, sinceVersion, sampleValue } = sinceVersionedEntry!;
  const apiSection = section.toLowerCase();
  const result = validateConfigWrite(apiSection, { [key]: sampleValue }, '0.0.0'); // running version older than sinceVersion
  assert(result.valid === true, 'expected valid=true — since-version is a warning, not a violation');
  assert(result.warnings.length === 1, `expected exactly one warning, got ${result.warnings.length}`);
  assert(result.warnings[0]!.reason === 'since-version', 'expected reason=since-version');
  assert(result.warnings[0]!.sinceVersion === sinceVersion, 'expected matching sinceVersion in warning');
});

test('since-version warning is skipped when runningVersion is unknown (undefined)', () => {
  const sinceVersionedEntry = findKeyWithSinceVersion();
  assert(sinceVersionedEntry !== undefined, 'expected fixture entry');
  const { section, key, sampleValue } = sinceVersionedEntry!;
  const result = validateConfigWrite(section.toLowerCase(), { [key]: sampleValue }); // no runningVersion
  assert(result.warnings.length === 0, 'expected no warnings when runningVersion is unknown');
});

function findKeyWithSinceVersion(): { section: string; key: string; sinceVersion: string; sampleValue: unknown } | undefined {
  const all = loadEluxConfigSchema();
  const entry = all.find((e) => e.sinceVersion !== null && /[A-Za-z][A-Za-z0-9]*$/.test(`${e.section}.${e.key}`));
  if (!entry) return undefined;
  const sampleValue = Array.isArray(entry.range)
    ? entry.range[0]
    : entry.default !== 'unset'
    ? entry.default
    : 0;
  return { section: entry.section, key: entry.key, sinceVersion: entry.sinceVersion!, sampleValue };
}

// ═══════════════════════════════════════════════════════════════════════════════
// isVersionNewer
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nisVersionNewer');

test('7.2503.0 is newer than 7.2105.0', () => {
  assert(isVersionNewer('7.2503.0', '7.2105.0') === true, 'expected true');
});

test('7.2105.0 is not newer than 7.2503.0', () => {
  assert(isVersionNewer('7.2105.0', '7.2503.0') === false, 'expected false');
});

test('equal versions are not "newer"', () => {
  assert(isVersionNewer('7.2105.0', '7.2105.0') === false, 'expected false for equal versions');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting helpers — smoke tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nFormatting helpers');

test('formatViolations renders did-you-mean suggestions inline', () => {
  const result = validateConfigWrite('security', { AuthTyp: 13 });
  const text = formatViolations(result.violations);
  assert(text.includes('AuthTyp'), 'expected the bad key name in the message');
  assert(text.toLowerCase().includes('did you mean'), 'expected a "did you mean" hint');
});

test('formatWarnings renders one line per warning', () => {
  const entry = findKeyWithSinceVersion();
  assert(entry !== undefined, 'expected fixture entry');
  const result = validateConfigWrite(entry!.section.toLowerCase(), { [entry!.key]: entry!.sampleValue }, '0.0.0');
  const lines = formatWarnings(result.warnings);
  assert(lines.length === result.warnings.length, 'expected one formatted line per warning');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

const passedCount = results.filter((r) => r.status === 'PASS').length;
const failedCount = results.filter((r) => r.status === 'FAIL').length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passedCount} passed, ${failedCount} failed (${results.length} total)`);

if (failedCount > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => r.status === 'FAIL')) {
    console.log(`  ✗ ${r.name}`);
    if (r.error) console.log(`    ${r.error}`);
  }
}

process.exit(failedCount > 0 ? 1 : 0);
