/**
 * Read-only guarantee checks for §2 (config_resolve, config_compare inheritance-aware
 * modes) — acceptance criterion: "config_resolve and the new config_compare modes are
 * read-only; no writes."
 *
 * Two complementary checks:
 *  1. Static: grep the source files for `mutating: true` — it must never appear outside
 *     config_update's write paths in src/tools/config.ts.
 *  2. Structural: foldConfigLayers/renderResolvedTable (the pure merge core) take no
 *     client/network dependency at all — already covered by tests/rsop.test.ts's
 *     "pure function" test; this file focuses on the static source-level guarantee for
 *     the tool-layer files, since those are the ones that hold a getClient() reference.
 *
 * Run with: npx tsx tests/rsop-readonly.test.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

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

/** Strips // and /* *\/ comments, then asserts the actual code contains no `mutating: true`
 *  call-site (avoids false positives from doc comments that mention the literal string). */
function assertNoLiveMutatingCall(source: string, label: string): void {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert(
    !/mutating:\s*true/.test(stripped),
    `found a live mutating:true call site in ${label}`,
  );
}

console.log('\nRead-only guarantees — config_resolve and config_compare inheritance-aware modes');

test('src/tools/config_resolve.ts never passes mutating: true to client.request()', () => {
  const text = readFileSync(join(SRC, 'tools', 'config_resolve.ts'), 'utf8');
  assertNoLiveMutatingCall(text, 'config_resolve.ts');
  // Also confirm it only ever issues GET requests.
  const requestCalls = [...text.matchAll(/client\.request<[^>]*>\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
  for (const verb of requestCalls) {
    assert(verb === 'GET', `expected only GET calls in config_resolve.ts, found ${verb}`);
  }
});

test('the inheritance-aware config_compare modes in src/tools/config.ts never use mutating: true', () => {
  const text = readFileSync(join(SRC, 'tools', 'config.ts'), 'utf8');
  // Isolate the inheritance-aware section: everything from "Inheritance-aware modes" marker
  // through the end of configCompareInheritanceAware / resolveBaseOnlyRows / diffResolvedSides.
  const startMarker = '// ── Inheritance-aware modes';
  const endMarker = 'export const configCompareTool';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  assert(start !== -1 && end !== -1 && end > start, 'could not locate inheritance-aware modes section markers');
  const section = text.slice(start, end);
  assertNoLiveMutatingCall(section, 'config.ts inheritance-aware compare section');
  const requestCalls = [...section.matchAll(/client\.request<[^>]*>\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
  for (const verb of requestCalls) {
    assert(verb === 'GET', `expected only GET calls in inheritance-aware compare modes, found ${verb}`);
  }
});

test('config_update (the one write path in config.ts) is the only place mutating: true appears', () => {
  const text = readFileSync(join(SRC, 'tools', 'config.ts'), 'utf8');
  const occurrences = [...text.matchAll(/mutating:\s*true/g)];
  assert(occurrences.length >= 1, 'expected at least one mutating:true (config_update write paths)');
  // Sanity: every occurrence's surrounding context mentions config_update, confirming the
  // pattern hasn't crept into a read-only function.
  for (const occ of occurrences) {
    const idx = occ.index ?? 0;
    const window = text.slice(idx, idx + 200);
    assert(window.includes("opName: 'config_update'") || window.includes('opName:"config_update"'), `mutating:true at offset ${idx} is not tagged opName: 'config_update'`);
  }
});

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
