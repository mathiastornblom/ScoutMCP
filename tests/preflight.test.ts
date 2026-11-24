/**
 * Tests for src/safety/preflight.ts (ourights UX preflight) and the systemcheck/elias
 * health_check field. Offline: the HTTP layer is replaced via the fetchRights seam or by
 * patching the singleton client instance's request/rawRequest — no network.
 *
 * Contract under test (Security review B2): only an explicit `false` refuses; 404/5xx/
 * network/malformed/absent proceed; `true` never relaxes any other gate.
 *
 * Run with: npx tsx tests/preflight.test.ts
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSessionConfig } from '../src/session.js';
import { getClient, ScoutError } from '../src/client.js';
import { GuardrailError } from '../src/safety/guardrails.js';
import { checkOuRightPreflight, resetPreflightCache } from '../src/safety/preflight.js';
import { deviceCommandTool } from '../src/tools/command.js';
import { fetchEliasSystemcheck } from '../src/tools/health.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
const auditPath = join(mkdtempSync(join(tmpdir(), 'scout-preflight-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = auditPath;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-preflight-no-kill-switch');

const results: { name: string; ok: boolean; error?: string }[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  resetPreflightCache();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
async function rejectsPreflight(p: Promise<unknown>): Promise<GuardrailError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GuardrailError && e.gate === 'preflight') return e;
    throw e;
  }
  throw new Error('expected GuardrailError(preflight)');
}
function auditLines(): string[] {
  return existsSync(auditPath) ? readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean) : [];
}

const base = { opName: 'test_op', target: 'ou:/T', ouId: 5, requiredRight: 'restart' } as const;
const enable = () => {
  process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS = 'true';
};

await test('disabled flag -> skipped, no fetch', async () => {
  delete process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS;
  let called = false;
  const o = await checkOuRightPreflight({ ...base, fetchRights: async () => ((called = true), {}) });
  assert(o.status === 'skipped-disabled' && !called, 'skipped without calling');
});

await test('unknown ouId -> skipped', async () => {
  enable();
  const o = await checkOuRightPreflight({ ...base, ouId: undefined, fetchRights: async () => ({ restart: false }) });
  assert(o.status === 'skipped-no-ou', 'skipped-no-ou');
});

await test('right true -> granted', async () => {
  enable();
  const o = await checkOuRightPreflight({ ...base, fetchRights: async () => ({ restart: true }) });
  assert(o.status === 'granted', 'granted');
});

await test('right explicitly false -> refused + audit-logged', async () => {
  enable();
  const before = auditLines().length;
  const e = await rejectsPreflight(checkOuRightPreflight({ ...base, fetchRights: async () => ({ restart: false }) }));
  assert(/UX|early-refusal/.test(e.message), 'message mentions it is an early-refusal aid');
  const added = auditLines().slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert(added.some((a) => a.result === 'refused' && a.gate === 'preflight' && a.opName === 'test_op'), 'audit refused entry');
});

await test('404 (unsupported) -> proceeds', async () => {
  enable();
  const o = await checkOuRightPreflight({
    ...base,
    fetchRights: async () => {
      throw new ScoutError('nf', 404);
    },
  });
  assert(o.status === 'soft-fail-open', 'soft-fail-open');
});

await test('500 -> proceeds (not fail-closed, per Security B2)', async () => {
  enable();
  const o = await checkOuRightPreflight({
    ...base,
    fetchRights: async () => {
      throw new ScoutError('boom', 500);
    },
  });
  assert(o.status === 'soft-fail-open', 'soft-fail-open');
});

await test('network error -> proceeds', async () => {
  enable();
  const o = await checkOuRightPreflight({
    ...base,
    fetchRights: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert(o.status === 'soft-fail-open', 'soft-fail-open');
});

await test('unparseable body / absent right / non-boolean right -> proceeds', async () => {
  enable();
  for (const body of ['<html>', null, [], {}, { restart: 'no' }, { restart: 0 }]) {
    resetPreflightCache();
    const o = await checkOuRightPreflight({ ...base, fetchRights: async () => body });
    assert(o.status === 'soft-fail-open', `proceeds for ${JSON.stringify(body)}`);
  }
});

await test('failures are not cached as denied; success cached <=30s', async () => {
  enable();
  let n = 0;
  await checkOuRightPreflight({
    ...base,
    fetchRights: async () => {
      n++;
      throw new ScoutError('x', 500);
    },
  });
  await checkOuRightPreflight({ ...base, fetchRights: async () => (n++, { restart: true }) });
  await checkOuRightPreflight({ ...base, fetchRights: async () => (n++, { restart: false }) });
  assert(n === 2, 'failure not cached, success cached (third call served from cache and still granted)');
});

await test('non-integer ouId is never interpolated -> skipped', async () => {
  enable();
  const o = await checkOuRightPreflight({ ...base, ouId: 1.5, fetchRights: async () => ({ restart: false }) });
  assert(o.status === 'skipped-no-ou', 'skipped');
});

// ── Wiring: device_command (target=ou with body.ouId) ─────────────────────────────

interface Patched {
  posts: number;
  rawPaths: string[];
}
function patchClient(rawImpl: () => Promise<unknown>): Patched {
  const c = getClient();
  const p: Patched = { posts: 0, rawPaths: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only instance patching
  (c as any).request = async (method: string) => {
    if (method === 'POST') p.posts++;
    return { ok: true };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only instance patching
  (c as any).rawRequest = async (_m: string, path: string) => {
    p.rawPaths.push(path);
    return rawImpl();
  };
  return p;
}
const cmd = { target: 'ou', command: 'restart', body: { ouId: 5 } };

await test('device_command: ourights false -> blocked before POST', async () => {
  enable();
  process.env.SCOUT_MODE = 'write';
  const p = patchClient(async () => ({ restart: false }));
  const r = await deviceCommandTool.execute(cmd);
  assert(r.isError === true && /preflight/i.test(r.content[0]!.text), 'blocked with preflight message');
  assert(p.posts === 0, 'no POST sent');
  assert(p.rawPaths[0] === '/api/v1/ourights?ouId=5', 'ourights queried with integer ouId');
});

await test('device_command: ourights true -> POST sent', async () => {
  enable();
  process.env.SCOUT_MODE = 'write';
  const p = patchClient(async () => ({ restart: true }));
  const r = await deviceCommandTool.execute(cmd);
  assert(!r.isError && p.posts === 1, 'POST sent');
});

await test('device_command: ourights 404 -> POST sent (behaves as before)', async () => {
  enable();
  process.env.SCOUT_MODE = 'write';
  const p = patchClient(async () => {
    throw new ScoutError('nf', 404);
  });
  const r = await deviceCommandTool.execute(cmd);
  assert(!r.isError && p.posts === 1, 'POST sent');
});

await test('device_command: ourights true never relaxes mode gate (read-only still blocks)', async () => {
  enable();
  process.env.SCOUT_MODE = 'read-only';
  const p = patchClient(async () => ({ restart: true }));
  const r = await deviceCommandTool.execute(cmd);
  assert(r.isError === true && p.posts === 0, 'read-only still refuses');
  assert(p.rawPaths.length === 0, 'preflight not even reached after a failed earlier gate');
});

await test('device_command: dry-run does not call preflight or POST', async () => {
  enable();
  process.env.SCOUT_MODE = 'dry-run';
  const p = patchClient(async () => ({ restart: false }));
  const r = await deviceCommandTool.execute(cmd);
  assert(!r.isError && p.posts === 0 && p.rawPaths.length === 0, 'dry-run unchanged');
});

// ── health_check extra field ──────────────────────────────────────────────────────

await test('systemcheck/elias: reachable', async () => {
  patchClient(async () => ({ state: 'reachable' }));
  const r = await fetchEliasSystemcheck();
  assert(r.state === 'reachable' && r.error === undefined, 'reachable');
});

await test('systemcheck/elias: error -> unknown + error text, never throws', async () => {
  patchClient(async () => {
    throw new ScoutError('Request failed (HTTP 404)', 404);
  });
  const r = await fetchEliasSystemcheck();
  assert(r.state === 'unknown' && /404/.test(r.error ?? ''), 'unknown with error');
});

await test('systemcheck/elias: malformed -> unknown', async () => {
  patchClient(async () => 'nope');
  const r = await fetchEliasSystemcheck();
  assert(r.state === 'unknown' && r.error !== undefined, 'unknown');
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\nResults: ${results.length - failed} passed, ${failed} failed (${results.length} total)`);
process.exit(failed > 0 ? 1 : 0);
