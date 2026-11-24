/**
 * Golden-file tests for the RSoP advanced-file-entries layer (src/rsop.ts:
 * parseAdvancedFileEntries + foldAdvancedLayers). Fixtures live in
 * tests/fixtures/rsop-advanced/*.json: each holds the raw per-layer API responses
 * (shape per openapi.json /config/advanced/{base|ou|device}/fileEntries and the 2611 HAR
 * sample) and the expected folded result. Fully offline.
 *
 * Run with: npx tsx tests/rsop-advanced.test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  parseAdvancedFileEntries,
  foldAdvancedLayers,
  type AdvancedLayerRef,
  type ResolvedAdvancedResult,
} from '../src/rsop.js';

const results: { name: string; ok: boolean; error?: string }[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

interface Fixture {
  description: string;
  layers: { level: string; response: unknown }[];
  expected: ResolvedAdvancedResult;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rsop-advanced');
function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Fixture;
}

function run(fx: Fixture): ResolvedAdvancedResult {
  const layers: AdvancedLayerRef[] = [];
  const warnings: string[] = [];
  for (const l of fx.layers) {
    const parsed = parseAdvancedFileEntries(l.level, l.response);
    layers.push(parsed.layer);
    warnings.push(...parsed.warnings);
  }
  return foldAdvancedLayers(layers, warnings);
}

for (const name of ['no-entries', 'ou-entries', 'ou-override', 'malformed']) {
  test(`golden: ${name}`, () => {
    const fx = load(`${name}.json`);
    const actual = run(fx);
    assert(
      isDeepStrictEqual(actual, fx.expected),
      `actual != expected\nactual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(fx.expected)}`,
    );
  });
}

test('override keeps provenance chain (setAt = most specific, overridesValue = previous layer)', () => {
  const r = run(load('ou-override.json'));
  const e = r.entries.find((x) => x.key === 'SuppressPrompts');
  assert(e !== undefined && e.isOverride && e.overridesValue === 'true' && e.setAt === '/Enterprise/Boot-to-VDI', 'provenance');
});

test('malformed result is never silently complete', () => {
  const r = run(load('malformed.json'));
  assert(!r.complete && r.warnings.length === 4, 'complete=false with 4 warnings');
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\nResults: ${results.length - failed} passed, ${failed} failed (${results.length} total)`);
process.exit(failed > 0 ? 1 : 0);
