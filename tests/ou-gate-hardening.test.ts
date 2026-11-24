/**
 * Security round on fix/ou-tree-parser (F1-F3, F5-F7): canonical OU-path comparison in the
 * protected/allowed gates, raw-path call sites resolved + gated on canonical paths, fail-closed
 * device move source lookup, fresh-tree write gates, parser hardening, numeric-ref strictness.
 * Client methods are instance-patched (no network). Run: npx tsx tests/ou-gate-hardening.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient } from '../src/client.js';
import { parseOuTree } from '../src/ou_tree.js';
import { resolveOuRef, invalidateOuCache, assertOuPathUnchanged } from '../src/resolver.js';
import { checkOuWriteAllowed, GuardrailError, __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { ouManageTool } from '../src/tools/ou.js';
import { deviceManageTool } from '../src/tools/device.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
process.env.SCOUT_AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'scout-gate-')), 'audit.log');
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-gate-no-kill-switch');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));
const wrap = (treeStructure: unknown, result: unknown = 0) => ({ response: { status: { result, msg: { treeStructure } } } });

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string): asserts c { if (!c) throw new Error(`Assertion failed: ${m}`); }
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const saved = { ...process.env };
  invalidateOuCache(); __resetCircuitBreakerStateForTests();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
function blocked(path: string): boolean {
  try { checkOuWriteAllowed({ targetPath: path }); return false; } catch (e) { return e instanceof GuardrailError; }
}

let served: unknown = LIVE;
let deviceRecord: unknown = { OUID: 10, Name: 'thin01' };
let deviceThrows = false;
const writes: string[] = [];
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
c.request = async (method: string, path: string) => {
  if (method !== 'GET') { writes.push(`${method} ${path}`); return { ok: true }; }
  if (path.startsWith('/api/v1/ou/structure')) return served;
  if (path.startsWith('/api/v1/ou/root')) return { OUID: 2, OUPath: '/NorthCreek' };
  if (path.startsWith('/api/v1/device?') || path === '/api/v1/device') {
    if (deviceThrows) throw new Error('boom');
    return deviceRecord;
  }
  return {};
};
const reset = (): void => { served = LIVE; writes.length = 0; deviceRecord = { OUID: 10, Name: 'thin01' }; deviceThrows = false; };
const writeMode = (): void => { process.env.SCOUT_MODE = 'write'; };

console.log('\nF1 canonical comparison in guardrails');
const variants = ['/NorthCreek/Customers', '/northcreek/customers', '/NorthCreek/Customers ', ' /NorthCreek/Customers',
  '/NorthCreek//Customers', '/NorthCreek/Customers/', 'NorthCreek/Customers', '/NORTHCREEK/CUSTOMERS/CLALIT'];
await test('protected list: every variant (and a descendant) is blocked; sibling and prefix-lookalike are not', () => {
  process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  for (const v of variants) assert(blocked(v), `should be blocked: ${JSON.stringify(v)}`);
  assert(!blocked('/NorthCreek/Imprivata'), 'sibling not blocked');
  assert(!blocked('/NorthCreek/Customers2'), 'prefix lookalike not blocked');
});
await test('case typo / whitespace / double slash in the ENV var still protects the real OU', () => {
  for (const env of ['/northcreek/CUSTOMERS', ' /NorthCreek//Customers/ ', '["/NORTHCREEK/customers"]']) {
    process.env.SCOUT_PROTECTED_OUS = env;
    assert(blocked('/NorthCreek/Customers'), `env ${JSON.stringify(env)} must protect real OU`);
  }
});
await test('allowed list: variants of an allowed OU are allowed, everything else blocked', () => {
  process.env.SCOUT_ALLOWED_OUS = '/northcreek/IMPRIVATA ';
  for (const v of ['/NorthCreek/Imprivata', '/northcreek/imprivata', '/NorthCreek//Imprivata/', '/NorthCreek/Imprivata ']) {
    assert(!blocked(v), `should be allowed: ${JSON.stringify(v)}`);
  }
  assert(blocked('/NorthCreek/Customers'), 'other OU blocked');
});
await test("'.' and '..' segments are rejected (fail closed) on candidate and on env entry", () => {
  process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  assert(blocked('/NorthCreek/Imprivata/../Customers'), "'..' candidate refused");
  assert(blocked('/NorthCreek/./Imprivata'), "'.' candidate refused");
  process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/../Customers';
  assert(blocked('/NorthCreek/Imprivata'), "'..' in env entry refuses everything");
});

console.log('\nF1 raw-path call sites (ou_manage / device_manage)');
for (const raw of ['/northcreek/customers', '/NorthCreek/Customers ', '/NorthCreek//Customers']) {
  await test(`ou_manage delete ${JSON.stringify(raw)} on protected OU: refused, no write`, async () => {
    reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
    const r = await ouManageTool.execute({ action: 'delete', path: raw, confirm: true });
    assert(r.isError === true && writes.length === 0, `refused, writes=${writes.length}: ${r.content[0]?.text}`);
  });
}
await test('ou_manage move with raw protected destoupath variant: refused, no write', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  const r = await ouManageTool.execute({ action: 'move', path: '/NorthCreek/Imprivata', destoupath: '/northcreek//CUSTOMERS/', confirm: true });
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
});
await test('ou_manage delete with env case-typo still protects the real OU', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/northcreek/CUSTOMERS';
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Customers', confirm: true });
  assert(r.isError === true && writes.length === 0, 'refused');
});
await test('ou_manage allow-list: variant of allowed OU passes, disallowed OU refused', async () => {
  reset(); writeMode(); process.env.SCOUT_ALLOWED_OUS = '/NorthCreek/Imprivata';
  const ok = await ouManageTool.execute({ action: 'delete', path: '/northcreek/imprivata', confirm: true });
  assert(!ok.isError && writes.length === 1, `allowed variant: ${ok.content[0]?.text}`);
  writes.length = 0;
  const no = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Customers', confirm: true });
  assert(no.isError === true && writes.length === 0, 'disallowed refused');
});
await test('ou_manage with an unresolvable path is refused (never gated on the raw string)', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Imprivata/../Customers', confirm: true });
  assert(r.isError === true && writes.length === 0, 'refused');
});
await test('device_manage move to raw protected destoupath variant: refused, no move call', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  const r = await deviceManageTool.execute({ action: 'move', name: 'thin01', destoupath: '/northcreek/customers ' });
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
});

console.log('\nF2 device move source OU fails closed');
const moveInput = { action: 'move', name: 'thin01', destoupath: '/NorthCreek/Imprivata' };
await test('control: resolvable source OU, nothing protected -> move reaches the server', async () => {
  reset(); writeMode();
  const r = await deviceManageTool.execute(moveInput);
  assert(!r.isError && writes.length === 1, `moved: ${r.content[0]?.text}`);
});
await test('source in protected OU (OUID 10 = AD) -> refused, no move', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  const r = await deviceManageTool.execute(moveInput);
  assert(r.isError === true && writes.length === 0, 'refused');
});
const refusals: Array<[string, () => void]> = [
  // Was 'record without OUID (only GroupID)'; GroupID is now accepted as the device's OU id (live-verified), so
  // the refusal cases are: GroupID not in tree / non-integer GroupID / no id field at all.
  ['record with only a GroupID that is not in the tree', () => { deviceRecord = { Name: 'thin01', GroupID: 999 }; }],
  ['record with a non-integer GroupID', () => { deviceRecord = { Name: 'thin01', GroupID: '10' }; }],
  ['record without any OU id field', () => { deviceRecord = { Name: 'thin01' }; }],
  ['raw envelope instead of record', () => { deviceRecord = { code: 200, response: { status: { msg: {} } } }; }],
  ['OUID not a number', () => { deviceRecord = { OUID: '10' }; }],
  ['OUID not in tree', () => { deviceRecord = { OUID: 999 }; }],
  ['device lookup throws', () => { deviceThrows = true; }],
  ['OU tree unparseable', () => { served = { response: { status: { msg: {} } } }; }],
];
for (const [label, arrange] of refusals) {
  await test(`unresolvable source (${label}) -> refused, no move call`, async () => {
    reset(); writeMode(); arrange();
    const r = await deviceManageTool.execute(moveInput);
    assert(r.isError === true && writes.length === 0, `refused, writes=${writes.length}: ${r.content[0]?.text}`);
    assert(/source OU|OU tree|Could not parse/i.test(r.content[0]!.text), `unexpected reason: ${r.content[0]?.text}`);
  });
}

console.log('\nF3 write gates use a fresh tree');
await test('stale cache: OU renamed out-of-band is gated under its CURRENT path', async () => {
  reset(); writeMode();
  await resolveOuRef('Customers'); // populate cache with the old tree
  served = JSON.parse(JSON.stringify(LIVE).replace('"Name":"Customers"', '"Name":"Clients"'));
  process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Clients';
  const r = await ouManageTool.execute({ action: 'delete', ouRef: '8', confirm: true });
  assert(r.isError === true && writes.length === 0, `refused under new path: ${r.content[0]?.text}`);
});
await test('cache is invalidated after a failed write (finally)', async () => {
  reset(); writeMode();
  await resolveOuRef('Customers');
  const orig = c.request;
  c.request = async (m: string, p: string, ...a: unknown[]) => { if (m !== 'GET') throw new Error('server down'); return orig(m, p, ...a); };
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Imprivata', confirm: true });
  assert(r.isError === true, 'write failed');
  served = JSON.parse(JSON.stringify(LIVE).replace('"Name":"Imprivata"', '"Name":"Renamed"'));
  c.request = orig;
  assert((await resolveOuRef('Renamed')).ouid === 5, 'next lookup re-read the tree');
});
await test('assertOuPathUnchanged: same path ok; renamed/absent OU throws', async () => {
  reset();
  c.request = async (_m: string, p: string) => (p.startsWith('/api/v1/ou/structure') ? served : {});
  await assertOuPathUnchanged(8, '/northcreek/CUSTOMERS');
  served = JSON.parse(JSON.stringify(LIVE).replace('"Name":"Customers"', '"Name":"Clients"'));
  let threw = false; try { await assertOuPathUnchanged(8, '/NorthCreek/Customers'); } catch { threw = true; }
  assert(threw, 'renamed throws');
  threw = false; try { await assertOuPathUnchanged(999, '/x'); } catch { threw = true; }
  assert(threw, 'absent throws');
});

console.log('\nF5 / F6 / F7');
for (const [label, name] of [['newline', 'a\nb'], ['ANSI escape', 'a\u001b[31mb'], ['trailing space', 'Customers '], ['leading space', ' Customers']] as const) {
  await test(`parseOuTree rejects name with ${label}`, () => {
    let threw = false; try { parseOuTree(wrap([{ OUID: 1, Name: name }])); } catch { threw = true; }
    assert(threw, 'must throw');
  });
}
await test('parseOuTree rejects non-zero status.result, accepts 0 and absent', () => {
  let threw = false; try { parseOuTree(wrap([{ OUID: 1, Name: 'a' }], 1)); } catch { threw = true; }
  assert(threw, 'result 1 throws');
  parseOuTree(wrap([{ OUID: 1, Name: 'a' }], 0));
  parseOuTree({ response: { status: { msg: { treeStructure: [{ OUID: 1, Name: 'a' }] } } } });
});
await test('numeric refs: only digit strings are ids ("0x10", "1e1" are not)', async () => {
  reset();
  assert((await resolveOuRef('16')).ouid === 16, 'digits ok');
  for (const bad of ['0x10', '1e1', ' ', '16.0', '-5']) {
    let m: unknown; try { m = await resolveOuRef(bad); } catch { m = undefined; }
    assert(m === undefined, `${bad} must not resolve (got ${JSON.stringify(m)})`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
