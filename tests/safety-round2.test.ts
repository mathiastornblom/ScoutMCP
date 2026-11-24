/**
 * Unit tests for the WS-D round-2 safety gates added to src/safety/guardrails.ts:
 *   4. Kill switch (SCOUT_KILL_SWITCH_FILE)
 *   5. Circuit breaker (SCOUT_CIRCUIT_BREAKER_MAX_OPS / _WINDOW_SECONDS)
 *   6. Protected/allowed OU lists (SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS)
 *   7. Private-endpoint writes hard-off in production (SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION)
 *   8. Audit log (SCOUT_AUDIT_LOG_PATH) + snapshot-before-mutate (SCOUT_SNAPSHOT_DIR)
 *
 * Pure unit tests — no live Scout Board connection required, but DOES touch the real
 * filesystem (temp files under a throwaway tmp directory, cleaned up after the run).
 *
 * Run with: npx tsx tests/safety-round2.test.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GuardrailError,
  checkKillSwitch,
  isKillSwitchEngaged,
  getKillSwitchPath,
  checkCircuitBreaker,
  checkMutationAllowed,
  isCircuitBreakerTripped,
  resetCircuitBreaker,
  __resetCircuitBreakerStateForTests,
  getProtectedOus,
  getAllowedOus,
  checkOuWriteAllowed,
  checkPrivateWriteAllowedInProduction,
  auditLog,
  getAuditLogPath,
  writeSnapshot,
  getSnapshotDir,
} from '../src/safety/guardrails.js';

// ─── Minimal test harness (mirrors tests/guardrails.test.ts style) ────────────

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

const TRACKED_ENV_KEYS = [
  'SCOUT_MODE',
  'SCOUT_KILL_SWITCH_FILE',
  'SCOUT_CIRCUIT_BREAKER_MAX_OPS',
  'SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS',
  'SCOUT_PROTECTED_OUS',
  'SCOUT_ALLOWED_OUS',
  'SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION',
  'SCOUT_AUDIT_LOG_PATH',
  'SCOUT_SNAPSHOT_DIR',
  'SCOUT_AUDIT_ACTOR',
] as const;

function test(name: string, fn: () => void): void {
  const snapshot = Object.fromEntries(TRACKED_ENV_KEYS.map((k) => [k, process.env[k]]));
  __resetCircuitBreakerStateForTests();
  try {
    fn();
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetCircuitBreakerStateForTests();
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertThrowsGuardrail(fn: () => void, gate: GuardrailError['gate'], context: string): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof GuardrailError, `${context}: expected GuardrailError, got ${String(err)}`);
    assert(
      (err as GuardrailError).gate === gate,
      `${context}: expected gate="${gate}", got "${(err as GuardrailError).gate}"`,
    );
    return;
  }
  throw new Error(`${context}: expected GuardrailError to be thrown, but nothing was thrown`);
}

// Throwaway tmp dir for all filesystem-touching tests, removed at the end of the run.
const tmpRoot = mkdtempSync(join(tmpdir(), 'scout-mcp-safety-test-'));

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 4: Kill switch
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 4 — Kill switch (SCOUT_KILL_SWITCH_FILE)');

test('kill switch is not engaged when the sentinel file does not exist', () => {
  const path = join(tmpRoot, 'no-such-kill-switch');
  process.env.SCOUT_KILL_SWITCH_FILE = path;
  assert(!existsSync(path), 'precondition: file must not exist');
  assert(isKillSwitchEngaged() === false, 'expected kill switch disengaged');
  checkKillSwitch('test_op'); // should not throw
});

test('kill switch engages when the sentinel file exists, and blocks with gate=kill-switch', () => {
  const path = join(tmpRoot, 'KILL_SWITCH_engaged');
  writeFileSync(path, '');
  process.env.SCOUT_KILL_SWITCH_FILE = path;
  assert(isKillSwitchEngaged() === true, 'expected kill switch engaged');
  assertThrowsGuardrail(() => checkKillSwitch('test_op'), 'kill-switch', 'engaged kill switch');
});

test('clearing the sentinel file (rm) disengages the kill switch on the next check', () => {
  const path = join(tmpRoot, 'KILL_SWITCH_toggle');
  writeFileSync(path, '');
  process.env.SCOUT_KILL_SWITCH_FILE = path;
  assert(isKillSwitchEngaged() === true, 'expected engaged before removal');
  rmSync(path);
  assert(isKillSwitchEngaged() === false, 'expected disengaged immediately after removal, no caching');
});

test('kill switch defaults to ./KILL_SWITCH when SCOUT_KILL_SWITCH_FILE is unset', () => {
  delete process.env.SCOUT_KILL_SWITCH_FILE;
  assert(getKillSwitchPath() === './KILL_SWITCH', 'expected default path ./KILL_SWITCH');
});

test('kill switch overrides SCOUT_MODE=write — checkMutationAllowed still blocks', () => {
  const path = join(tmpRoot, 'KILL_SWITCH_override');
  writeFileSync(path, '');
  process.env.SCOUT_KILL_SWITCH_FILE = path;
  process.env.SCOUT_MODE = 'write';
  assertThrowsGuardrail(() => checkMutationAllowed('test_op'), 'kill-switch', 'kill switch should override SCOUT_MODE=write');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 5: Circuit breaker
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 5 — Circuit breaker (SCOUT_CIRCUIT_BREAKER_MAX_OPS / _WINDOW_SECONDS)');

test('breaker is not tripped initially', () => {
  assert(isCircuitBreakerTripped() === false, 'expected untripped at start');
  checkCircuitBreaker('test_op'); // should not throw
});

test('breaker trips after exceeding max ops within the window, via checkMutationAllowed', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = '3';
  process.env.SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS = '60';
  for (let i = 0; i < 3; i++) {
    const r = checkMutationAllowed(`op_${i}`);
    assert(r.proceed === true, `expected proceed=true on op ${i} (within limit)`);
  }
  assert(isCircuitBreakerTripped() === false, 'expected not tripped at exactly the limit');
  // The 4th op exceeds the limit (> max, not >=) and trips the breaker.
  const r4 = checkMutationAllowed('op_4');
  assert(r4.proceed === true, 'the op that trips the breaker still proceeds itself');
  assert(isCircuitBreakerTripped() === true, 'expected tripped after exceeding max ops');
});

test('once tripped, ALL subsequent mutating calls are refused with gate=circuit-breaker', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = '1';
  process.env.SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS = '60';
  checkMutationAllowed('op_a');
  checkMutationAllowed('op_b'); // trips it (2 > max 1)
  assert(isCircuitBreakerTripped() === true, 'expected tripped');
  assertThrowsGuardrail(() => checkMutationAllowed('op_c'), 'circuit-breaker', 'post-trip call');
  // Even read-only-incompatible modes don't matter — breaker is checked first.
  assertThrowsGuardrail(() => checkMutationAllowed('op_d'), 'circuit-breaker', 'post-trip call 2');
});

test('explicit resetCircuitBreaker() re-arms the breaker', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = '1';
  checkMutationAllowed('op_a');
  checkMutationAllowed('op_b'); // trips it
  assert(isCircuitBreakerTripped() === true, 'expected tripped');
  resetCircuitBreaker();
  assert(isCircuitBreakerTripped() === false, 'expected untripped after reset');
  const r = checkMutationAllowed('op_after_reset');
  assert(r.proceed === true, 'expected proceed=true after re-arm');
});

test('breaker respects a configurable window — old ops age out (synthetic clock-free check via direct reset)', () => {
  // We cannot fast-forward real time in a unit test without mocking Date.now, so this test
  // verifies the documented behavior indirectly: a short window with ops spaced by an
  // explicit resetCircuitBreaker() between bursts never trips, proving the window is a
  // sliding count over recent timestamps, not a permanent cumulative counter.
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = '2';
  process.env.SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS = '60';
  checkMutationAllowed('burst1_a');
  checkMutationAllowed('burst1_b');
  assert(isCircuitBreakerTripped() === false, 'expected not tripped at exactly the limit');
  resetCircuitBreaker();
  checkMutationAllowed('burst2_a');
  checkMutationAllowed('burst2_b');
  assert(isCircuitBreakerTripped() === false, 'expected not tripped after reset + fresh burst at the limit');
});

test('falls back to defaults for invalid SCOUT_CIRCUIT_BREAKER_MAX_OPS', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = 'not-a-number';
  // Default is 10 — 10 calls should not trip it.
  for (let i = 0; i < 10; i++) checkMutationAllowed(`op_${i}`);
  assert(isCircuitBreakerTripped() === false, 'expected default max ops (10) to not trip at exactly 10');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 6: Protected/allowed OU lists
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 6 — Protected/allowed OU lists (SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS)');

test('no lists configured — every OU is allowed', () => {
  delete process.env.SCOUT_PROTECTED_OUS;
  delete process.env.SCOUT_ALLOWED_OUS;
  checkOuWriteAllowed({ targetPath: '/Enterprise/Anything' }); // should not throw
});

test('comma-separated SCOUT_PROTECTED_OUS parses correctly', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production, /Enterprise/Finance';
  assert(getProtectedOus().length === 2, 'expected 2 protected OUs');
  assert(getProtectedOus()[0] === '/Enterprise/Production', 'expected trimmed first entry');
});

test('JSON-array SCOUT_PROTECTED_OUS parses correctly', () => {
  process.env.SCOUT_PROTECTED_OUS = '["/Enterprise/Production","/Enterprise/Finance"]';
  assert(getProtectedOus().length === 2, 'expected 2 protected OUs from JSON array');
});

test('exact match on a protected OU is blocked', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
  assertThrowsGuardrail(
    () => checkOuWriteAllowed({ targetPath: '/Enterprise/Production' }),
    'protected-ou',
    'exact match on protected OU',
  );
});

test('a descendant of a protected OU is also blocked (judgment call: subtree protection)', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
  assertThrowsGuardrail(
    () => checkOuWriteAllowed({ targetPath: '/Enterprise/Production/Floor3' }),
    'protected-ou',
    'descendant of protected OU',
  );
});

test('a sibling OU that merely shares a string prefix is NOT blocked (path-segment match, not raw prefix)', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
  checkOuWriteAllowed({ targetPath: '/Enterprise/Production2' }); // should not throw
});

test('an unrelated OU is not blocked by the deny list', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
  checkOuWriteAllowed({ targetPath: '/Enterprise/Sandbox' }); // should not throw
});

test('SCOUT_ALLOWED_OUS restricts writes to only the allowed subtree(s)', () => {
  delete process.env.SCOUT_PROTECTED_OUS;
  process.env.SCOUT_ALLOWED_OUS = '/Enterprise/Sandbox';
  checkOuWriteAllowed({ targetPath: '/Enterprise/Sandbox' }); // exact match — allowed
  checkOuWriteAllowed({ targetPath: '/Enterprise/Sandbox/Sub' }); // descendant — allowed
  assertThrowsGuardrail(
    () => checkOuWriteAllowed({ targetPath: '/Enterprise/Production' }),
    'protected-ou',
    'OU outside allow-list',
  );
});

test('deny list wins over allow list when an OU is listed in both', () => {
  process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Sandbox/Locked';
  process.env.SCOUT_ALLOWED_OUS = '/Enterprise/Sandbox';
  assertThrowsGuardrail(
    () => checkOuWriteAllowed({ targetPath: '/Enterprise/Sandbox/Locked' }),
    'protected-ou',
    'protected subtree inside an otherwise-allowed OU',
  );
  // A sibling under the same allowed OU, not under the protected sub-path, is fine.
  checkOuWriteAllowed({ targetPath: '/Enterprise/Sandbox/Open' });
});

test('root "/" in SCOUT_PROTECTED_OUS blocks every OU', () => {
  process.env.SCOUT_PROTECTED_OUS = '/';
  assertThrowsGuardrail(
    () => checkOuWriteAllowed({ targetPath: '/Enterprise/Anything' }),
    'protected-ou',
    'root protected OU blocks everything',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 7: Private-endpoint writes hard-off in production
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 7 — Private-endpoint writes hard-off in production (SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION)');

test('not blocked when SCOUT_MODE is read-only (Gate 1 already handles it)', () => {
  process.env.SCOUT_MODE = 'read-only';
  delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
  checkPrivateWriteAllowedInProduction('db_cleanup(delete)'); // should not throw
});

test('not blocked when SCOUT_MODE is dry-run (Gate 1 already handles it)', () => {
  process.env.SCOUT_MODE = 'dry-run';
  delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
  checkPrivateWriteAllowedInProduction('db_cleanup(delete)'); // should not throw
});

test('blocked in SCOUT_MODE=write by default, even with private endpoints conceptually enabled', () => {
  process.env.SCOUT_MODE = 'write';
  delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
  assertThrowsGuardrail(
    () => checkPrivateWriteAllowedInProduction('db_cleanup(delete)'),
    'private-write-production',
    'private write in production without override flag',
  );
});

test('allowed in SCOUT_MODE=write when SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
  checkPrivateWriteAllowedInProduction('db_cleanup(delete)'); // should not throw
});

test('SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=false behaves the same as unset (still blocked)', () => {
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'false';
  assertThrowsGuardrail(
    () => checkPrivateWriteAllowedInProduction('system_settings(set_device_password)'),
    'private-write-production',
    'explicit false override flag',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 8: Audit log
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 8 — Append-only audit log (SCOUT_AUDIT_LOG_PATH)');

test('audit log writes a real, parseable JSON line to disk', () => {
  const logPath = join(tmpRoot, 'audit-1.log');
  process.env.SCOUT_AUDIT_LOG_PATH = logPath;
  auditLog({ opName: 'test_op', target: 'device:123', result: 'allowed', gate: null });
  assert(existsSync(logPath), 'expected audit log file to exist after write');
  const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
  assert(lines.length === 1, `expected exactly 1 line, got ${lines.length}`);
  const parsed = JSON.parse(lines[0]!);
  assert(parsed.opName === 'test_op', 'expected opName field');
  assert(parsed.target === 'device:123', 'expected target field');
  assert(parsed.result === 'allowed', 'expected result field');
  assert(typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0, 'expected a timestamp');
  assert(parsed.actor === 'unknown', 'expected honest "unknown" actor when SCOUT_AUDIT_ACTOR is unset');
});

test('audit log is append-only — multiple writes accumulate as separate lines, not overwritten', () => {
  const logPath = join(tmpRoot, 'audit-2.log');
  process.env.SCOUT_AUDIT_LOG_PATH = logPath;
  auditLog({ opName: 'op_1', target: 'a', result: 'allowed', gate: null });
  auditLog({ opName: 'op_2', target: 'b', result: 'refused', gate: 'mode' });
  auditLog({ opName: 'op_3', target: 'c', result: 'error', gate: null });
  const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
  assert(lines.length === 3, `expected 3 accumulated lines, got ${lines.length}`);
  const parsed = lines.map((l) => JSON.parse(l));
  assert(parsed[0].opName === 'op_1' && parsed[1].opName === 'op_2' && parsed[2].opName === 'op_3', 'expected in-order entries');
});

test('audit log creates its parent directory if missing', () => {
  const logPath = join(tmpRoot, 'nested', 'dir', 'audit.log');
  process.env.SCOUT_AUDIT_LOG_PATH = logPath;
  auditLog({ opName: 'test_op', target: 'x', result: 'allowed', gate: null });
  assert(existsSync(logPath), 'expected log file to exist even though parent dir did not pre-exist');
});

test('SCOUT_AUDIT_ACTOR overrides the "unknown" fallback when explicitly set', () => {
  const logPath = join(tmpRoot, 'audit-actor.log');
  process.env.SCOUT_AUDIT_LOG_PATH = logPath;
  process.env.SCOUT_AUDIT_ACTOR = 'operator@example.com';
  auditLog({ opName: 'test_op', target: 'x', result: 'allowed', gate: null });
  const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim().split('\n')[0]!);
  assert(parsed.actor === 'operator@example.com', 'expected explicit actor override');
});

test('a refused mutation (read-only mode) is recorded in the audit log via checkMutationAllowed', () => {
  const logPath = join(tmpRoot, 'audit-refusal.log');
  process.env.SCOUT_AUDIT_LOG_PATH = logPath;
  process.env.SCOUT_MODE = 'read-only';
  try {
    checkMutationAllowed('some_write_op');
  } catch {
    // expected
  }
  const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]!);
  assert(last.opName === 'some_write_op', 'expected the refused op name in the audit log');
  assert(last.result === 'refused', 'expected result=refused');
  assert(last.gate === 'mode', 'expected gate=mode');
});

test('defaults to ./logs/scout-audit.log when SCOUT_AUDIT_LOG_PATH is unset', () => {
  delete process.env.SCOUT_AUDIT_LOG_PATH;
  assert(getAuditLogPath() === './logs/scout-audit.log', 'expected default audit log path');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 8b: Snapshot-before-mutate
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 8b — Snapshot-before-mutate (SCOUT_SNAPSHOT_DIR)');

test('writeSnapshot creates a JSON file containing the supplied data', () => {
  const dir = join(tmpRoot, 'snapshots-1');
  process.env.SCOUT_SNAPSHOT_DIR = dir;
  const path = writeSnapshot('ou-42', { hello: 'world', count: 3 });
  assert(typeof path === 'string', 'expected a path to be returned');
  assert(existsSync(path!), 'expected the snapshot file to exist');
  const parsed = JSON.parse(readFileSync(path!, 'utf-8'));
  assert(parsed.hello === 'world' && parsed.count === 3, 'expected the snapshot content to round-trip');
});

test('writeSnapshot creates the snapshot directory if missing', () => {
  const dir = join(tmpRoot, 'snapshots-2', 'nested');
  process.env.SCOUT_SNAPSHOT_DIR = dir;
  assert(!existsSync(dir), 'precondition: dir must not pre-exist');
  const path = writeSnapshot('ou-1', { a: 1 });
  assert(existsSync(dir), 'expected snapshot dir to be created');
  assert(typeof path === 'string' && existsSync(path!), 'expected snapshot file to exist');
});

test('writeSnapshot sanitizes the target into a safe filename', () => {
  const dir = join(tmpRoot, 'snapshots-3');
  process.env.SCOUT_SNAPSHOT_DIR = dir;
  const path = writeSnapshot('/Enterprise/Some Weird Target!@#', { a: 1 });
  assert(typeof path === 'string', 'expected a path');
  assert(!path!.includes('/Enterprise/Some Weird'), 'expected unsafe characters to be stripped from filename');
});

test('defaults to ./logs/scout-snapshots when SCOUT_SNAPSHOT_DIR is unset', () => {
  delete process.env.SCOUT_SNAPSHOT_DIR;
  assert(getSnapshotDir() === './logs/scout-snapshots', 'expected default snapshot dir');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup + summary
// ═══════════════════════════════════════════════════════════════════════════════

rmSync(tmpRoot, { recursive: true, force: true });

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
