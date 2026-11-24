/**
 * Unit tests for src/rsop.ts — the RSoP merge engine (§2 of the upgrade spec).
 *
 * Fully offline/synthetic: a hand-built OU tree (Base → /Enterprise →
 * /Enterprise/Boot-to-VDI → device) with known overrides (AuthType=13 at the VDI OU,
 * KioskMode=2 at the device) is folded via foldConfigLayers() directly — no live Scout
 * Board connection, no getClient() calls. This exercises exactly the merge algorithm
 * the MCP tool layer (src/tools/config_resolve.ts) calls into.
 *
 * Run with: npx tsx tests/rsop.test.ts
 */

import { foldConfigLayers, renderResolvedTable, type ConfigLayerRef } from '../src/rsop.js';
import type { EluxConfigEntry } from '../src/schema/eluxConfig.js';

// ─── Minimal test harness (mirrors tests/guardrails.test.ts style) ────────────

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
// Golden-file fixture: Base → /Enterprise → /Enterprise/Boot-to-VDI → device
// ═══════════════════════════════════════════════════════════════════════════════

// Synthetic schema covering the two keys under test (Security.AuthType, Layout.KioskMode)
// plus an untouched key (Security.AuthTimeout) to prove factory-default fall-through.
const schema: EluxConfigEntry[] = [
  {
    section: 'Security',
    key: 'AuthType',
    default: 0,
    range: [0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15],
    sinceVersion: null,
    publish: true,
    notes: '13 = Citrix',
  },
  {
    section: 'Security',
    key: 'AuthTimeout',
    default: 30,
    range: { min: 0, max: 600 },
    sinceVersion: null,
    publish: true,
    notes: 'Auth timeout in seconds — never overridden in this fixture.',
  },
  {
    section: 'Layout',
    key: 'KioskMode',
    default: 0,
    range: [0, 1, 2],
    sinceVersion: null,
    publish: true,
    notes: '',
  },
];

const securityEntries = schema.filter((e) => e.section === 'Security');
const layoutEntries = schema.filter((e) => e.section === 'Layout');

/** Builds the precedence-ordered layer chain for the golden-file OU tree:
 *  base → /Enterprise → /Enterprise/Boot-to-VDI → device. */
function buildGoldenLayers(opts: {
  base?: Record<string, unknown>;
  enterprise?: Record<string, unknown>;
  vdiOu?: Record<string, unknown>;
  device?: Record<string, unknown>;
}): ConfigLayerRef[] {
  return [
    { level: 'base', values: opts.base ?? {} },
    { level: '/Enterprise', values: opts.enterprise ?? {} },
    { level: '/Enterprise/Boot-to-VDI', values: opts.vdiOu ?? {} },
    ...(opts.device ? [{ level: 'device', values: opts.device }] : []),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Golden-file test: AuthType=13 at VDI OU, KioskMode=2 at device
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nRSoP golden-file test — Base → /Enterprise → /Enterprise/Boot-to-VDI → device');

test('AuthType resolves from the VDI OU level (13), KioskMode resolves from device (2)', () => {
  const securityLayers = buildGoldenLayers({ vdiOu: { AuthType: 13 } });
  const layoutLayers = buildGoldenLayers({ device: { KioskMode: 2 } });

  const securityResolved = foldConfigLayers(securityEntries, securityLayers);
  const layoutResolved = foldConfigLayers(layoutEntries, layoutLayers);

  const authType = securityResolved.find((r) => r.key === 'AuthType')!;
  assert(authType.effectiveValue === 13, `expected AuthType=13, got ${authType.effectiveValue}`);
  assert(authType.setAt === '/Enterprise/Boot-to-VDI', `expected setAt=/Enterprise/Boot-to-VDI, got ${authType.setAt}`);
  assert(authType.isOverride === true, 'expected AuthType isOverride=true');
  assert(authType.overridesValue === 0, `expected overridesValue=0 (factory default), got ${authType.overridesValue}`);
  assert(authType.isExplicitDefault === false, 'expected AuthType isExplicitDefault=false (13 != default 0)');

  const kioskMode = layoutResolved.find((r) => r.key === 'KioskMode')!;
  assert(kioskMode.effectiveValue === 2, `expected KioskMode=2, got ${kioskMode.effectiveValue}`);
  assert(kioskMode.setAt === 'device', `expected setAt=device, got ${kioskMode.setAt}`);
  assert(kioskMode.isOverride === true, 'expected KioskMode isOverride=true');
  assert(kioskMode.overridesValue === 0, `expected overridesValue=0, got ${kioskMode.overridesValue}`);
});

test('AuthTimeout (untouched at every level) falls through to factory-default', () => {
  const layers = buildGoldenLayers({ vdiOu: { AuthType: 13 }, device: { KioskMode: 2 } });
  const resolved = foldConfigLayers(securityEntries, layers);
  const authTimeout = resolved.find((r) => r.key === 'AuthTimeout')!;
  assert(authTimeout.effectiveValue === 30, `expected factory default 30, got ${authTimeout.effectiveValue}`);
  assert(authTimeout.setAt === 'factory-default', `expected setAt=factory-default, got ${authTimeout.setAt}`);
  assert(authTimeout.isOverride === false, 'expected isOverride=false for untouched key');
  assert(authTimeout.isExplicitDefault === true, 'expected isExplicitDefault=true (value equals schema default)');
});

test('intermediate OU override is shadowed by a more specific OU in the chain', () => {
  // /Enterprise sets AuthType=2, but /Enterprise/Boot-to-VDI overrides to 13 — the leaf wins,
  // and overridesValue should reflect the immediately-shadowed value (2), not the factory default (0).
  const layers = buildGoldenLayers({ enterprise: { AuthType: 2 }, vdiOu: { AuthType: 13 } });
  const resolved = foldConfigLayers(securityEntries, layers);
  const authType = resolved.find((r) => r.key === 'AuthType')!;
  assert(authType.effectiveValue === 13, `expected 13, got ${authType.effectiveValue}`);
  assert(authType.setAt === '/Enterprise/Boot-to-VDI', `expected setAt=/Enterprise/Boot-to-VDI, got ${authType.setAt}`);
  assert(authType.overridesValue === 2, `expected overridesValue=2 (shadowed /Enterprise value), got ${authType.overridesValue}`);
});

test('a value matching factory default, set explicitly at a non-default level, is still isExplicitDefault=true', () => {
  // §2 acceptance criterion: isExplicitDefault is schema-driven, not "only true when
  // setAt=factory-default". Explicitly setting AuthType=0 at the VDI OU (same as the
  // factory default) must still be flagged isExplicitDefault=true.
  const layers = buildGoldenLayers({ vdiOu: { AuthType: 0 } });
  const resolved = foldConfigLayers(securityEntries, layers);
  const authType = resolved.find((r) => r.key === 'AuthType')!;
  assert(authType.setAt === '/Enterprise/Boot-to-VDI', 'expected explicit set at VDI OU, not factory-default');
  assert(authType.isOverride === true, 'expected isOverride=true (it was set at a non-default level)');
  assert(authType.isExplicitDefault === true, 'expected isExplicitDefault=true (0 equals schema default 0)');
});

test('renderResolvedTable produces a parseable ASCII table with all expected columns', () => {
  const layers = buildGoldenLayers({ vdiOu: { AuthType: 13 } });
  const resolved = foldConfigLayers(securityEntries, layers);
  const table = renderResolvedTable(resolved);
  assert(table.includes('Section'), 'expected header row with "Section"');
  assert(table.includes('Set At'), 'expected header row with "Set At"');
  assert(table.includes('AuthType'), 'expected AuthType row');
  assert(table.includes('/Enterprise/Boot-to-VDI'), 'expected the VDI OU level in the rendered table');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Read-only guarantee: foldConfigLayers/renderResolvedTable never touch the network
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nRead-only guarantees');

test('foldConfigLayers is a pure function — same input always yields the same output, no I/O', () => {
  const layers = buildGoldenLayers({ vdiOu: { AuthType: 13 }, device: { KioskMode: 2 } });
  const a = foldConfigLayers(securityEntries, layers);
  const b = foldConfigLayers(securityEntries, layers);
  assert(JSON.stringify(a) === JSON.stringify(b), 'expected deterministic output for identical input');
});

test('foldConfigLayers throws (not silently mis-resolves) on ambiguous cross-section bare keys', () => {
  const ambiguous: EluxConfigEntry[] = [
    { section: 'Security', key: 'Mode', default: 0, range: null, sinceVersion: null, publish: true, notes: '' },
    { section: 'Layout', key: 'Mode', default: 0, range: null, sinceVersion: null, publish: true, notes: '' },
  ];
  let threw = false;
  try {
    foldConfigLayers(ambiguous, [{ level: 'base', values: { Mode: 1 } }]);
  } catch {
    threw = true;
  }
  assert(threw, 'expected foldConfigLayers to throw on ambiguous bare-key schema input');
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
