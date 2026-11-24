/**
 * OU tree parser + resolver against the REAL /api/v1/ou/structure capture from a Scout 26.11.0
 * server (tests/fixtures/ou-structure-live.json). Client methods are instance-patched (no network).
 * Run: npx tsx tests/ou-tree.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient } from '../src/client.js';
import { parseOuTree, OuTreeParseError } from '../src/ou_tree.js';
import {
  resolveOuRef, invalidateOuCache, getOuChain, collectOuSubtree, countDevicesUnderOu,
} from '../src/resolver.js';
import { checkOuWriteAllowed, __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { ouManageTool } from '../src/tools/ou.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
process.env.SCOUT_AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'scout-outree-')), 'audit.log');
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-outree-no-kill-switch');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));

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
async function rejects(p: Promise<unknown>, re: RegExp, m: string): Promise<void> {
  try { await p; } catch (e) { assert(re.test(e instanceof Error ? e.message : String(e)), `${m}: wrong error: ${e}`); return; }
  throw new Error(`Assertion failed: ${m}: expected a throw`);
}

let served: unknown = LIVE;
const writes: string[] = [];
function patch(): void {
  const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  c.request = async (method: string, path: string) => {
    if (method !== 'GET') { writes.push(`${method} ${path}`); return { ok: true }; }
    if (path.startsWith('/api/v1/ou/structure')) return served;
    if (path.startsWith('/api/v1/ou/root')) return { OUID: 2, OUPath: '/NorthCreek' };
    return {};
  };
}
patch();
const reset = (): void => { served = LIVE; writes.length = 0; };
const wrap = (treeStructure: unknown) => ({ response: { status: { msg: { treeStructure } } } });

console.log('\nparseOuTree (real fixture)');
await test('parses forest, derives paths, parents and children', () => {
  const t = parseOuTree(LIVE);
  assert(t.nodes.length === 15, `15 OUs, got ${t.nodes.length}`);
  assert(t.roots.join() === '2,4', 'two top-level OUs (NorthCreek, SKY)');
  assert(t.byId.get(16)!.path === '/NorthCreek/Browser/Google-CEP', 'nested path');
  assert(t.byId.get(16)!.parentId === 13, 'parent');
  assert(t.byId.get(2)!.parentId === undefined && t.byId.get(2)!.path === '/NorthCreek', 'root path');
  assert(t.byId.get(4)!.path === '/SKY', 'second root');
  assert(t.byId.get(8)!.children.join() === '9,17,12,15', 'children order');
});
await test('DeviceCount is cumulative in the fixture (parent >= sum of children)', () => {
  const t = parseOuTree(LIVE);
  for (const n of t.nodes) {
    const sum = n.children.reduce((a, c) => a + t.byId.get(c)!.deviceCount!, 0);
    assert(n.deviceCount! >= sum, `${n.path}: ${n.deviceCount} < children ${sum}`);
  }
  assert(t.byId.get(2)!.deviceCount === 10, 'NorthCreek 10');
});

console.log('\nparseOuTree fail-closed');
const bad: Array<[string, unknown]> = [
  ['null', null],
  ['legacy flat node (no envelope)', { OUID: 1, OUName: 'Enterprise', OUPath: '/Enterprise', SubOUs: [] }],
  ['missing treeStructure', { response: { status: { result: 0, msg: {} } } }],
  ['treeStructure not an array', wrap({})],
  ['empty treeStructure', wrap([])],
  ['node without Name', wrap([{ OUID: 1, children: [] }])],
  ['node without OUID', wrap([{ Name: 'x' }])],
  ['duplicate OUID', wrap([{ OUID: 1, Name: 'a' }, { OUID: 1, Name: 'b' }])],
  ['name containing slash', wrap([{ OUID: 1, Name: 'a/b' }])],
  ['children not an array', wrap([{ OUID: 1, Name: 'a', children: 5 }])],
];
for (const [label, v] of bad) {
  await test(`throws OuTreeParseError: ${label}`, () => {
    let threw = false;
    try { parseOuTree(v); } catch (e) { threw = e instanceof OuTreeParseError; }
    assert(threw, 'expected OuTreeParseError');
  });
}

console.log('\nresolveOuRef (real fixture)');
await test('by numeric id (number and string)', async () => {
  reset();
  assert((await resolveOuRef(16)).path === '/NorthCreek/Browser/Google-CEP', 'number');
  assert((await resolveOuRef('16')).name === 'Google-CEP', 'string');
});
await test('by exact name (case-insensitive) - the live "No OU matching AD" bug', async () => {
  reset();
  const m = await resolveOuRef('AD');
  assert(m.ouid === 10 && m.path === '/NorthCreek/AD', `got ${JSON.stringify(m)}`);
  assert((await resolveOuRef('ad')).ouid === 10, 'case-insensitive');
});
await test('by exact path (and trailing slash)', async () => {
  reset();
  assert((await resolveOuRef('/NorthCreek/Customers/Epiroc')).ouid === 12, 'path');
  assert((await resolveOuRef('/northcreek/customers/')).ouid === 8, 'case + trailing slash');
});
await test('by unique partial name', async () => {
  reset();
  assert((await resolveOuRef('Mpol')).ouid === 7, 'partial');
});
await test('ambiguous partial throws with candidates', async () => {
  reset();
  await rejects(resolveOuRef('C'), /matches \d+ OUs/, 'ambiguous');
});
await test('same name at different depth reports ambiguity, never picks one', async () => {
  served = wrap([{ OUID: 1, Name: 'Lab', children: [{ OUID: 2, Name: 'Lab', children: [] }] }]);
  await rejects(resolveOuRef('Lab'), /matches 2 OUs[\s\S]*\/Lab[\s\S]*\/Lab\/Lab/, 'dup names');
  assert((await resolveOuRef('/Lab/Lab')).ouid === 2, 'path disambiguates');
  assert((await resolveOuRef(1)).ouid === 1, 'id disambiguates');
  reset();
});
await test('unknown OU throws (name, path, id)', async () => {
  reset();
  await rejects(resolveOuRef('Nope'), /No OU matching/, 'name');
  await rejects(resolveOuRef('/NorthCreek/Nope'), /No OU matching/, 'path');
  await rejects(resolveOuRef(999), /No OU found with ID 999/, 'id');
});
await test('malformed envelope throws (never "no match", never empty tree)', async () => {
  served = { response: { status: { msg: {} } } };
  await rejects(resolveOuRef('AD'), /Could not parse \/api\/v1\/ou\/structure/, 'malformed');
  reset();
});

console.log('\nchain / subtree / count (real fixture)');
await test('chain Google-CEP -> Browser -> NorthCreek (root first)', async () => {
  reset();
  const chain = await getOuChain('Google-CEP');
  assert(chain.map((c) => c.name).join('>') === 'NorthCreek>Browser>Google-CEP', chain.map((c) => c.name).join('>'));
  assert(chain.map((c) => c.ouid).join() === '2,13,16', 'ids');
});
await test('chain of a top-level OU is just itself', async () => {
  reset();
  assert((await getOuChain('SKY')).length === 1, 'single');
});
await test('subtree of Customers = Customers + 4 children', async () => {
  reset();
  const sub = await collectOuSubtree(8);
  assert(sub.map((s) => s.ouid).join() === '8,9,17,12,15', sub.map((s) => s.ouid).join());
});
await test('count: NorthCreek (cumulative, not double counted) vs Customers vs leaf', async () => {
  reset();
  assert((await countDevicesUnderOu('Customers')) === 2, 'Customers 2');
  assert((await countDevicesUnderOu('Google-CEP')) === 1, 'Google-CEP 1');
  assert((await countDevicesUnderOu('NorthCreek')) === 10, 'NorthCreek 10 (summing the subtree would double count)');
  assert((await countDevicesUnderOu('SKY')) === 0, 'SKY 0');
});
await test('count fails closed when DeviceCount is missing or tree unreadable', async () => {
  served = wrap([{ OUID: 1, Name: 'A', children: [] }]);
  await rejects(countDevicesUnderOu('A'), /no usable DeviceCount/, 'missing DeviceCount');
  served = { nope: true };
  invalidateOuCache();
  await rejects(countDevicesUnderOu(1), /Could not parse/, 'unreadable');
  reset();
});

console.log('\nguardrail end-to-end (SCOUT_PROTECTED_OUS against derived paths)');
const del = { action: 'delete', path: '/NorthCreek/Browser/Google-CEP', confirm: true };
await test('protected OU path from env matches a descendant via derived path', async () => {
  reset(); process.env.SCOUT_MODE = 'write'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Browser';
  const m = await resolveOuRef('Google-CEP');
  let blocked = false;
  try { checkOuWriteAllowed({ targetPath: m.path }); } catch { blocked = true; }
  assert(blocked, 'descendant of protected OU must be blocked');
  checkOuWriteAllowed({ targetPath: (await resolveOuRef('Customers')).path });
});
await test('ou_manage delete under protected OU: refused, no write', async () => {
  reset(); process.env.SCOUT_MODE = 'write'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Browser';
  const r = await ouManageTool.execute(del);
  assert(r.isError === true && writes.length === 0, `refused, writes=${writes.length}: ${r.content[0]?.text}`);
  assert(/protected|SCOUT_PROTECTED_OUS/i.test(r.content[0]!.text), 'refused by the protected-OU gate');
});
await test('ou_manage delete, tree unreadable: refused (fails closed), no write', async () => {
  reset(); process.env.SCOUT_MODE = 'write'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Browser';
  served = { response: { status: { msg: {} } } };
  const r = await ouManageTool.execute(del);
  assert(r.isError === true && writes.length === 0, `refused, writes=${writes.length}: ${r.content[0]?.text}`);
  reset();
});
await test('positive control: unprotected sibling OU delete reaches the server', async () => {
  reset(); process.env.SCOUT_MODE = 'write'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Browser';
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Imprivata', confirm: true });
  assert(!r.isError && writes.length === 1, `write sent: ${r.content[0]?.text}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
