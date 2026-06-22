/**
 * Unit tests for src/transport.ts — pure transport-selection and port-resolution logic.
 *
 * No live Scout Board connection, no real HTTP listener, no network. Run with:
 *   npx tsx tests/transport.test.ts
 */

import { resolveTransportMode, resolveHttpPort, InvalidTransportError } from '../src/transport.js';

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

// ─── resolveTransportMode ──────────────────────────────────────────────────────

console.log('\nresolveTransportMode — default behavior must be unchanged for existing users');

test('undefined env var defaults to stdio', () => {
  assert(resolveTransportMode(undefined) === 'stdio', 'expected default stdio');
});

test('empty string is treated as an explicit invalid value, not a default', () => {
  // Note: "" ?? "stdio" does NOT fall through (only null/undefined trigger ??), so this
  // documents actual behavior — an explicitly empty SCOUT_TRANSPORT is invalid, not a
  // silent default. Existing users simply never set the var, so this never affects them.
  let threw = false;
  try {
    resolveTransportMode('');
  } catch (e) {
    threw = e instanceof InvalidTransportError;
  }
  assert(threw, 'expected InvalidTransportError for empty string');
});

test('"stdio" resolves to stdio', () => {
  assert(resolveTransportMode('stdio') === 'stdio', 'expected stdio');
});

test('"http" resolves to http', () => {
  assert(resolveTransportMode('http') === 'http', 'expected http');
});

test('case-insensitive: "HTTP" resolves to http', () => {
  assert(resolveTransportMode('HTTP') === 'http', 'expected http');
});

test('case-insensitive: "StdIO" resolves to stdio', () => {
  assert(resolveTransportMode('StdIO') === 'stdio', 'expected stdio');
});

test('invalid value throws InvalidTransportError', () => {
  let threw = false;
  try {
    resolveTransportMode('websocket');
  } catch (e) {
    threw = e instanceof InvalidTransportError;
  }
  assert(threw, 'expected InvalidTransportError for unrecognized value');
});

test('InvalidTransportError message includes the raw value', () => {
  try {
    resolveTransportMode('bogus');
    assert(false, 'expected throw');
  } catch (e) {
    assert(e instanceof InvalidTransportError, 'expected InvalidTransportError');
    assert((e as Error).message.includes('bogus'), 'expected raw value in message');
  }
});

// ─── resolveHttpPort ────────────────────────────────────────────────────────────

console.log('\nresolveHttpPort');

test('undefined defaults to 3000', () => {
  assert(resolveHttpPort(undefined) === 3000, 'expected default port 3000');
});

test('valid numeric string resolves correctly', () => {
  assert(resolveHttpPort('8080') === 8080, 'expected 8080');
});

test('rejects non-numeric string', () => {
  let threw = false;
  try {
    resolveHttpPort('not-a-port');
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw for non-numeric port');
});

test('rejects zero', () => {
  let threw = false;
  try {
    resolveHttpPort('0');
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw for port 0');
});

test('rejects negative port', () => {
  let threw = false;
  try {
    resolveHttpPort('-1');
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw for negative port');
});

test('rejects port above 65535', () => {
  let threw = false;
  try {
    resolveHttpPort('70000');
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw for out-of-range port');
});

test('rejects non-integer (float) port', () => {
  let threw = false;
  try {
    resolveHttpPort('8080.5');
  } catch {
    threw = true;
  }
  assert(threw, 'expected throw for non-integer port');
});

test('accepts boundary port 65535', () => {
  assert(resolveHttpPort('65535') === 65535, 'expected 65535 to be valid');
});

test('accepts boundary port 1', () => {
  assert(resolveHttpPort('1') === 1, 'expected 1 to be valid');
});

// ─── Summary ────────────────────────────────────────────────────────────────────

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
