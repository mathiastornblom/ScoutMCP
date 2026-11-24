/**
 * Unit tests for src/safety/guardrails.ts — the three early safety gates:
 *   1. Mode tiers (SCOUT_MODE)
 *   2. Base/root write-protection (SCOUT_ALLOW_BASE_WRITES)
 *   3. Blast-radius cap (SCOUT_MAX_BLAST_RADIUS, hard ceiling)
 *
 * Pure unit tests — no live Scout Board connection required. Run with:
 *   npx tsx tests/guardrails.test.ts
 */

import {
  getScoutMode,
  checkMutationAllowed,
  GuardrailError,
  isBaseConfigTarget,
  isRootOuTarget,
  checkBaseWriteAllowed,
  getBlastRadiusCap,
  checkBlastRadius,
  DEFAULT_BLAST_RADIUS,
  HARD_BLAST_RADIUS_CEILING,
} from '../src/safety/guardrails.js';
import { setSessionConfig, clearSessionConfig } from '../src/session.js';
import { dbCleanupTool } from '../src/tools/db_cleanup.js';
import { adminManageTool } from '../src/tools/admins.js';
import { systemSettingsTool } from '../src/tools/system_settings.js';
import { deviceCommandTool } from '../src/tools/command.js';

// Fake but well-formed config so getClient() succeeds without ever issuing a real
// network call (Gate 1 short-circuits before client.request()/rawRequest() in
// read-only and dry-run modes, so login() is never reached).
setSessionConfig({
  baseUrl: 'https://fake-scout-board.invalid:22160',
  username: 'fake-user',
  password: 'fake-password',
});

// ─── Minimal test harness (mirrors tests/integration.ts style) ────────────────

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  // Snapshot and restore the relevant env vars around every test so tests don't leak
  // state into each other (these guardrail functions read process.env directly, by
  // design, so behavior changes take effect immediately without a restart).
  const snapshot = {
    SCOUT_MODE: process.env.SCOUT_MODE,
    SCOUT_ALLOW_BASE_WRITES: process.env.SCOUT_ALLOW_BASE_WRITES,
    SCOUT_MAX_BLAST_RADIUS: process.env.SCOUT_MAX_BLAST_RADIUS,
  };
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

/** Async variant of test() for tool-level Gate 1 wiring checks (execute() is async). */
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  const snapshot = {
    SCOUT_MODE: process.env.SCOUT_MODE,
    SCOUT_ALLOW_BASE_WRITES: process.env.SCOUT_ALLOW_BASE_WRITES,
    SCOUT_MAX_BLAST_RADIUS: process.env.SCOUT_MAX_BLAST_RADIUS,
  };
  try {
    await fn();
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
  }
}

/** Extract the JSON-serialized payload from an ok()/fail() McpToolResult for assertions. */
function resultText(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 1: Mode tiers
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 1 — Mode tiers (SCOUT_MODE)');

test('defaults to read-only when SCOUT_MODE is unset', () => {
  delete process.env.SCOUT_MODE;
  assert(getScoutMode() === 'read-only', 'expected default mode read-only');
});

test('defaults to read-only when SCOUT_MODE is an invalid value', () => {
  process.env.SCOUT_MODE = 'yolo';
  assert(getScoutMode() === 'read-only', 'expected fallback to read-only for invalid value');
});

test('recognizes all three valid modes', () => {
  for (const mode of ['read-only', 'dry-run', 'write']) {
    process.env.SCOUT_MODE = mode;
    assert(getScoutMode() === mode, `expected getScoutMode() to return "${mode}"`);
  }
});

test('read-only blocks mutation with GuardrailError(gate=mode)', () => {
  process.env.SCOUT_MODE = 'read-only';
  assertThrowsGuardrail(() => checkMutationAllowed('test_op'), 'mode', 'read-only mutation');
});

test('unset SCOUT_MODE (defaults read-only) blocks mutation', () => {
  delete process.env.SCOUT_MODE;
  assertThrowsGuardrail(() => checkMutationAllowed('test_op'), 'mode', 'default-mode mutation');
});

test('dry-run returns proceed=false with a notice, does not throw', () => {
  process.env.SCOUT_MODE = 'dry-run';
  const result = checkMutationAllowed('test_op');
  assert(result.proceed === false, 'expected proceed=false in dry-run');
  assert(typeof result.dryRunNotice === 'string' && result.dryRunNotice.length > 0, 'expected a dry-run notice');
});

test('write returns proceed=true', () => {
  process.env.SCOUT_MODE = 'write';
  const result = checkMutationAllowed('test_op');
  assert(result.proceed === true, 'expected proceed=true in write mode');
  assert(result.dryRunNotice === undefined, 'expected no dry-run notice in write mode');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 2: Base/root write-protection
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 2 — Base/root write-protection (SCOUT_ALLOW_BASE_WRITES)');

test('isBaseConfigTarget is true only for target=base', () => {
  assert(isBaseConfigTarget('base') === true, 'base should be true');
  assert(isBaseConfigTarget('ou') === false, 'ou should be false');
  assert(isBaseConfigTarget('device') === false, 'device should be false');
});

test('isRootOuTarget matches by id', () => {
  assert(isRootOuTarget({ resolvedId: 1, rootId: 1 }) === true, 'matching ids should be root');
  assert(isRootOuTarget({ resolvedId: 2, rootId: 1 }) === false, 'non-matching ids should not be root');
});

test('isRootOuTarget matches by path', () => {
  assert(
    isRootOuTarget({ resolvedPath: '/Enterprise', rootPath: '/Enterprise' }) === true,
    'matching paths should be root',
  );
  assert(
    isRootOuTarget({ resolvedPath: '/Enterprise/Berlin', rootPath: '/Enterprise' }) === false,
    'non-matching paths should not be root',
  );
});

test('isRootOuTarget treats bare "/" as root regardless of live root lookup', () => {
  assert(isRootOuTarget({ resolvedPath: '/' }) === true, 'bare slash should always be root');
});

test('isRootOuTarget is false when nothing matches and no resolved target given', () => {
  assert(isRootOuTarget({}) === false, 'empty params should not be root');
});

test('Base/root write blocked by default (SCOUT_ALLOW_BASE_WRITES unset)', () => {
  delete process.env.SCOUT_ALLOW_BASE_WRITES;
  assertThrowsGuardrail(
    () => checkBaseWriteAllowed({ isBaseOrRoot: true, label: 'Base config' }),
    'base-write',
    'base write without arming flag',
  );
});

test('Base/root write blocked when SCOUT_ALLOW_BASE_WRITES=false', () => {
  process.env.SCOUT_ALLOW_BASE_WRITES = 'false';
  assertThrowsGuardrail(
    () => checkBaseWriteAllowed({ isBaseOrRoot: true, label: 'Base config' }),
    'base-write',
    'base write with arming flag explicitly false',
  );
});

test('Base/root write allowed when SCOUT_ALLOW_BASE_WRITES=true', () => {
  process.env.SCOUT_ALLOW_BASE_WRITES = 'true';
  // Should not throw.
  checkBaseWriteAllowed({ isBaseOrRoot: true, label: 'Base config' });
});

test('Non-base/root writes are never blocked by this gate, regardless of arming flag', () => {
  delete process.env.SCOUT_ALLOW_BASE_WRITES;
  // Should not throw — isBaseOrRoot=false short-circuits.
  checkBaseWriteAllowed({ isBaseOrRoot: false, label: 'some OU' });
});

test('Gate 2 is independent of SCOUT_MODE — write mode alone does not arm base writes', () => {
  process.env.SCOUT_MODE = 'write';
  delete process.env.SCOUT_ALLOW_BASE_WRITES;
  assertThrowsGuardrail(
    () => checkBaseWriteAllowed({ isBaseOrRoot: true, label: 'Base config' }),
    'base-write',
    'SCOUT_MODE=write should not imply SCOUT_ALLOW_BASE_WRITES=true',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 3: Blast-radius cap
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nGate 3 — Blast-radius cap (SCOUT_MAX_BLAST_RADIUS)');

test('defaults to DEFAULT_BLAST_RADIUS when unset', () => {
  delete process.env.SCOUT_MAX_BLAST_RADIUS;
  assert(getBlastRadiusCap() === DEFAULT_BLAST_RADIUS, `expected default cap ${DEFAULT_BLAST_RADIUS}`);
});

test('honors a valid SCOUT_MAX_BLAST_RADIUS below the ceiling', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = '100';
  assert(getBlastRadiusCap() === 100, 'expected cap=100');
});

test('clamps SCOUT_MAX_BLAST_RADIUS above the hard ceiling down to the ceiling', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = String(HARD_BLAST_RADIUS_CEILING + 1000);
  assert(
    getBlastRadiusCap() === HARD_BLAST_RADIUS_CEILING,
    `expected cap clamped to ceiling ${HARD_BLAST_RADIUS_CEILING}`,
  );
});

test('falls back to default for invalid (non-numeric) SCOUT_MAX_BLAST_RADIUS', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = 'not-a-number';
  assert(getBlastRadiusCap() === DEFAULT_BLAST_RADIUS, 'expected fallback to default on invalid value');
});

test('falls back to default for zero/negative SCOUT_MAX_BLAST_RADIUS', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = '0';
  assert(getBlastRadiusCap() === DEFAULT_BLAST_RADIUS, 'expected fallback to default for 0');
  process.env.SCOUT_MAX_BLAST_RADIUS = '-5';
  assert(getBlastRadiusCap() === DEFAULT_BLAST_RADIUS, 'expected fallback to default for negative value');
});

test('allows operations at or under the cap', () => {
  delete process.env.SCOUT_MAX_BLAST_RADIUS;
  checkBlastRadius({ affectedCount: DEFAULT_BLAST_RADIUS }); // should not throw
  checkBlastRadius({ affectedCount: 1 }); // should not throw
});

test('blocks operations over the cap without override', () => {
  delete process.env.SCOUT_MAX_BLAST_RADIUS;
  assertThrowsGuardrail(
    () => checkBlastRadius({ affectedCount: DEFAULT_BLAST_RADIUS + 1 }),
    'blast-radius',
    'over-cap without override',
  );
});

test('override allows exceeding the configured cap, up to the hard ceiling', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = '10';
  // 50 > cap(10) but <= ceiling — override should let it through.
  checkBlastRadius({ affectedCount: 50, overrideBlastRadius: true });
});

test('override cannot exceed the hard ceiling', () => {
  process.env.SCOUT_MAX_BLAST_RADIUS = '10';
  assertThrowsGuardrail(
    () => checkBlastRadius({ affectedCount: HARD_BLAST_RADIUS_CEILING + 1, overrideBlastRadius: true }),
    'blast-radius',
    'override beyond hard ceiling',
  );
});

test('override=false behaves the same as no override', () => {
  delete process.env.SCOUT_MAX_BLAST_RADIUS;
  assertThrowsGuardrail(
    () => checkBlastRadius({ affectedCount: DEFAULT_BLAST_RADIUS + 1, overrideBlastRadius: false }),
    'blast-radius',
    'explicit override=false should still block',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate 1 wiring — tool-level checks (db_cleanup, admin_manage, system_settings,
// device_command). These exercise the real execute() functions end-to-end: a fake
// (non-connecting) session config is set above so getClient() succeeds, and Gate 1
// short-circuits before any real HTTP call would be made in read-only/dry-run modes.
// ═══════════════════════════════════════════════════════════════════════════════

async function runToolGateTests(): Promise<void> {
  console.log('\nGate 1 wiring — db_cleanup');

  await testAsync('db_cleanup: read-only blocks action=delete', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await dbCleanupTool.execute({
      action: 'delete',
      filter: '[{"id":0,"from":"2020-01-01","to":"2021-01-01"}]',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('db_cleanup blocked:'), 'expected "db_cleanup blocked:" prefix');
  });

  await testAsync('db_cleanup: dry-run short-circuits action=delete without calling the real client', async () => {
    process.env.SCOUT_MODE = 'dry-run';
    const result = await dbCleanupTool.execute({
      action: 'delete',
      filter: '[{"id":0,"from":"2020-01-01","to":"2021-01-01"}]',
      confirm: true,
    });
    assert(result.isError !== true, 'expected a non-error result in dry-run');
    const text = resultText(result);
    assert(text.includes('"status": "dry_run"'), 'expected status=dry_run in payload');
  });

  console.log('\nGate 1 wiring — admin_manage');

  await testAsync('admin_manage: read-only blocks action=delete_admin', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await adminManageTool.execute({
      action: 'delete_admin',
      admin_name: 'old-admin',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('admin_manage blocked:'), 'expected "admin_manage blocked:" prefix');
  });

  await testAsync('admin_manage: dry-run short-circuits action=delete_admin', async () => {
    process.env.SCOUT_MODE = 'dry-run';
    const result = await adminManageTool.execute({
      action: 'delete_admin',
      admin_name: 'old-admin',
      confirm: true,
    });
    assert(result.isError !== true, 'expected a non-error result in dry-run');
    assert(resultText(result).includes('"status": "dry_run"'), 'expected status=dry_run in payload');
  });

  await testAsync('admin_manage: read-only blocks action=add_admin', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await adminManageTool.execute({
      action: 'add_admin',
      name: 'DOMAIN\\newadmin',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('admin_manage blocked:'), 'expected "admin_manage blocked:" prefix');
  });

  console.log('\nGate 1 wiring — system_settings');

  await testAsync('system_settings: read-only blocks action=set_device_password', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await systemSettingsTool.execute({
      action: 'set_device_password',
      old_password: 'old',
      new_password: 'new',
      scout_board_id: 'abc-123',
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('system_settings blocked:'), 'expected "system_settings blocked:" prefix');
  });

  await testAsync('system_settings: dry-run short-circuits action=set_device_password', async () => {
    process.env.SCOUT_MODE = 'dry-run';
    const result = await systemSettingsTool.execute({
      action: 'set_device_password',
      old_password: 'old',
      new_password: 'new',
      scout_board_id: 'abc-123',
    });
    assert(result.isError !== true, 'expected a non-error result in dry-run');
    assert(resultText(result).includes('"status": "dry_run"'), 'expected status=dry_run in payload');
  });

  await testAsync('system_settings: read-only blocks action=set_logging', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await systemSettingsTool.execute({ action: 'set_logging', log_enabled: true });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('system_settings blocked:'), 'expected "system_settings blocked:" prefix');
  });

  console.log('\nGate 1 wiring — device_command (single-device path)');

  await testAsync('device_command: read-only blocks target=device command=restart', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await deviceCommandTool.execute({
      target: 'device',
      command: 'restart',
      name: 'TestDevice01',
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('device_command blocked:'), 'expected "device_command blocked:" prefix');
  });

  await testAsync('device_command: dry-run short-circuits target=device command=restart', async () => {
    process.env.SCOUT_MODE = 'dry-run';
    const result = await deviceCommandTool.execute({
      target: 'device',
      command: 'restart',
      name: 'TestDevice01',
    });
    assert(result.isError !== true, 'expected a non-error result in dry-run');
    assert(resultText(result).includes('"status": "dry_run"'), 'expected status=dry_run in payload');
  });

  await testAsync('device_command: read-only blocks factoryreset even with confirm=true', async () => {
    process.env.SCOUT_MODE = 'read-only';
    const result = await deviceCommandTool.execute({
      target: 'device',
      command: 'factoryreset',
      name: 'TestDevice01',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    assert(resultText(result).includes('device_command blocked:'), 'expected "device_command blocked:" prefix');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

await runToolGateTests();
clearSessionConfig();

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
