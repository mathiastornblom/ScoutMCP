/**
 * QA: e2e wiring of the ourights preflight into config_update(target=ou) and ou_manage.
 * Client methods are instance-patched (no network). Run: npx tsx tests/preflight-wiring.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSessionConfig } from '../src/session.js';
import { getClient, ScoutError } from '../src/client.js';
import { invalidateOuCache } from '../src/resolver.js';
import { resetPreflightCache } from '../src/safety/preflight.js';
import { __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { configUpdateTool } from '../src/tools/config.js';
import { ouManageTool } from '../src/tools/ou.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
process.env.SCOUT_AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'scout-pfw-')), 'audit.log');
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-pfw-no-kill-switch');

const STRUCT = {
  OUID: 1, OUName: 'Enterprise', OUPath: '/Enterprise',
  SubOUs: [{ OUID: 7, OUName: 'Lab', OUPath: '/Enterprise/Lab', SubOUs: [] }],
};

let failed = 0;
let passed = 0;
function assert(c: boolean, m: string): asserts c { if (!c) throw new Error(`Assertion failed: ${m}`); }
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  resetPreflightCache(); invalidateOuCache(); __resetCircuitBreakerStateForTests();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

interface Spy { writes: string[]; rights: string[] }
function patch(rights: () => Promise<unknown>): Spy {
  const s: Spy = { writes: [], rights: [] };
  const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  c.request = async (method: string, path: string) => {
    if (method !== 'GET') { s.writes.push(`${method} ${path}`); return { ok: true }; }
    if (path.startsWith('/api/v1/ou/structure')) return STRUCT;
    if (path.startsWith('/api/v1/ou/root')) return { OUID: 1, OUPath: '/Enterprise' };
    if (path.startsWith('/api/v1/device/search')) return { response: { status: { msg: { visibleDevices: [], hiddenDevices: 0 } } } };
    return {};
  };
  c.rawRequest = async (_m: string, path: string) => { s.rights.push(path); return rights(); };
  return s;
}
const env = (mode = 'write') => { process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS = 'true'; process.env.SCOUT_MODE = mode; };
const cfg = { target: 'ou', section: 'Network', body: {}, ouPath: '/Enterprise/Lab', confirm: true, skipValidation: true };
const ouDel = { action: 'delete', path: '/Enterprise/Lab', confirm: true };
const ouRen = { action: 'rename', path: '/Enterprise/Lab', newname: 'Lab2' };

await test('ou_manage rename: rename=false -> blocked, no write', async () => {
  env(); const s = patch(async () => ({ rename: false }));
  const r = await ouManageTool.execute(ouRen);
  assert(r.isError === true && /preflight/i.test(r.content[0]!.text), 'preflight refusal');
  assert(s.writes.length === 0, 'no write'); assert(s.rights[0] === '/api/v1/ourights?ouId=7', 'queried ouId 7');
});
await test('ou_manage rename: right=true -> write sent', async () => {
  env(); const s = patch(async () => ({ rename: true }));
  const r = await ouManageTool.execute(ouRen);
  assert(!r.isError && s.writes.length === 1, 'write sent');
});
await test('ou_manage rename: ourights 404 -> write sent', async () => {
  env(); const s = patch(async () => { throw new ScoutError('nf', 404); });
  const r = await ouManageTool.execute(ouRen);
  assert(!r.isError && s.writes.length === 1, 'write sent');
});
await test('ou_manage delete: delete=false -> blocked', async () => {
  env(); const s = patch(async () => ({ delete: false }));
  const r = await ouManageTool.execute(ouDel);
  assert(r.isError === true && s.writes.length === 0, 'blocked');
});
await test('ou_manage: true never relaxes protected-OU gate (preflight not reached)', async () => {
  env(); process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Lab';
  const s = patch(async () => ({ delete: true }));
  const r = await ouManageTool.execute(ouDel);
  assert(r.isError === true && s.writes.length === 0 && s.rights.length === 0, 'protected gate first');
});
await test('ou_manage: dry-run does not call ourights or write', async () => {
  env('dry-run'); const s = patch(async () => ({ rename: false }));
  const r = await ouManageTool.execute(ouRen);
  assert(!r.isError && s.writes.length === 0 && s.rights.length === 0, 'dry-run unchanged');
});
await test('ou_manage: private endpoints disabled -> no ourights call, write sent', async () => {
  env(); delete process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS;
  const s = patch(async () => ({ rename: false }));
  const r = await ouManageTool.execute(ouRen);
  assert(!r.isError && s.rights.length === 0 && s.writes.length === 1, 'skipped');
});
await test('config_update(ou): setup=false -> blocked before confirm/write', async () => {
  env(); const s = patch(async () => ({ setup: false }));
  const r = await configUpdateTool.execute({ ...cfg, confirm: undefined });
  assert(r.isError === true && /preflight/i.test(r.content[0]!.text), `preflight message, got ${r.content[0]!.text}`);
  assert(s.writes.length === 0, 'no write'); assert(s.rights[0] === '/api/v1/ourights?ouId=7', 'ouId 7');
});
await test('config_update(ou): setup=true -> write sent', async () => {
  env(); const s = patch(async () => ({ setup: true }));
  const r = await configUpdateTool.execute(cfg);
  assert(!r.isError && s.writes.length === 1, `write sent: ${r.content[0]!.text}`);
});
await test('config_update(ou): setup=true does not bypass confirm gate', async () => {
  env(); const s = patch(async () => ({ setup: true }));
  const r = await configUpdateTool.execute({ ...cfg, confirm: undefined });
  assert(r.isError === true && s.writes.length === 0, 'confirm still required');
});
await test('config_update(ou): ourights 500 / garbage -> proceeds', async () => {
  env(); let s = patch(async () => { throw new ScoutError('x', 500); });
  let r = await configUpdateTool.execute(cfg); assert(!r.isError && s.writes.length === 1, '500 proceeds');
  resetPreflightCache();
  s = patch(async () => 'garbage'); r = await configUpdateTool.execute(cfg);
  assert(!r.isError && s.writes.length === 1, 'garbage proceeds');
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
