/**
 * Single-device read envelope (live: legacy envelope with INTEGER hidden/pending/denied counts). Live evidence (Scout 26.11.0): GET /api/v1/device/search returns
 * `msg` as a LIST of rows {ClientIdentifier, DeviceID, GroupID, IP_Address, Mac_Address, Name} and
 * GroupID equals the device's direct OU id. This file covers the unified parser, the strict id
 * reader, and every wired consumer (device_manage move, move_devices_by_filter, bulk_command,
 * device_command / notification_manage target=device, config_resolve device branch, enricher).
 * Fixture: tests/fixtures/device-search-live.json (sanitised, synthetic names/addresses).
 * Run: npx tsx tests/single-device-envelope.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient } from '../src/client.js';
import { invalidateOuCache } from '../src/resolver.js';
import { __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { clearWorkingOu } from '../src/context.js';
import { parseSearchDevices, parseSingleDevice } from '../src/devices.js';
import { deviceManageTool } from '../src/tools/device.js';
import { bulkCommandTool, moveDevicesByFilterTool } from '../src/tools/workflow.js';
import { enrich, invalidateEnrichmentCache } from '../src/enricher.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
const AUDIT = join(mkdtempSync(join(tmpdir(), 'scout-grp-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = AUDIT;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-grp-no-kill-switch');
process.env.SCOUT_SNAPSHOT_DIR = join(tmpdir(), 'scout-grp-snapshots');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE_TREE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));
const LIVE_SEARCH = JSON.parse(readFileSync(join(here, 'fixtures', 'device-search-live.json'), 'utf8'));
const LIVE_GET = JSON.parse(readFileSync(join(here, 'fixtures', 'device-get-live.json'), 'utf8'));
const getEnv = (patch: Record<string, unknown> = {}, rowPatch: Record<string, unknown> = {}): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const e = JSON.parse(JSON.stringify(LIVE_GET));
  Object.assign(e.response.status.msg.visibleDevices[0], rowPatch);
  Object.assign(e.response.status.msg, patch);
  return e;
};
const liveRows = (): Array<Record<string, unknown>> => JSON.parse(JSON.stringify(LIVE_SEARCH.response.status.msg));
const listEnvelope = (rows: unknown): unknown => ({ code: 200, message: 'OK', response: { status: { result: 0, msg: rows } } });
const legacyEnvelope = (rows: unknown): unknown => ({ response: { status: { msg: { visibleDevices: rows, hiddenDevices: 0 } } } });

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string): asserts c { if (!c) throw new Error(`Assertion failed: ${m}`); }
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const saved = { ...process.env };
  invalidateOuCache(); invalidateEnrichmentCache(); __resetCircuitBreakerStateForTests(); clearWorkingOu();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// ── fake server ───────────────────────────────────────────────────────────────
const writes: string[] = [];
let searchBody: unknown = listEnvelope(liveRows());
let singleDevice: unknown = getEnv();
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const searches: string[] = [];
let searchFn: ((path: string) => unknown) | undefined;
c.request = async (method: string, path: string) => {
  if (path.startsWith('/api/v1/device/search')) { searches.push(path); if (searchFn) return searchFn(path); }
  if (method !== 'GET') { writes.push(`${method} ${path}`); return { ok: true }; }
  if (path.startsWith('/api/v1/ou/structure')) return LIVE_TREE;
  if (path.startsWith('/api/v1/device/search')) return searchBody;
  if (path.startsWith('/api/v1/device?')) return singleDevice;
  return {};
};
const reset = (): void => {
  searches.length = 0; searchFn = undefined;
  writes.length = 0; searchBody = listEnvelope(liveRows()); singleDevice = getEnv();
  process.env.SCOUT_MODE = 'write';
};
const text = (r: { content: Array<{ text: string }> }): string => r.content[0]?.text ?? '';
const auditText = (): string => { try { return readFileSync(AUDIT, 'utf8'); } catch { return ''; } };
async function refused(label: string, run: () => Promise<{ isError?: boolean; content: Array<{ text: string }> }>, re?: RegExp): Promise<void> {
  writes.length = 0;
  __resetCircuitBreakerStateForTests();
  const before = auditText().length;
  const r = await run();
  assert(r.isError === true && writes.length === 0, `${label}: refused, no write (writes=${writes.join('|')}): ${text(r)}`);
  if (re) assert(re.test(text(r)), `${label}: message ${re}: ${text(r)}`);
  assert(auditText().length > before, `${label}: audit-logged`);
}

// ── parser ────────────────────────────────────────────────────────────────────
console.log('\nenvelope parsing');
await test('live single-device envelope parses to exactly one row (integer counts 0)', () => {
  const p = parseSingleDevice(LIVE_GET);
  assert(p.ok && p.row['GroupID'] === 10, 'one row');
});
await test('envelope with LISTS still parses (search path), unlisted counted', () => {
  const p = parseSearchDevices(legacyEnvelope([{ Name: 'a', OUID: 10 }]));
  assert(p.ok && p.devices.length === 1 && p.unlisted === 0, 'lists ok');
  const q = parseSearchDevices({ response: { status: { msg: { visibleDevices: [{ Name: 'a' }], hiddenDevices: [{ Name: 'h' }], pendingDevices: 2, deniedDevices: 0 } } } });
  assert(q.ok && q.unlisted === 3 && q.otherRows.length === 1, 'lists + counts summed');
});
await test('single: zero rows, two rows, non-zero counts, bad counts, unknown shape -> refused', () => {
  const two = getEnv(); two.response.status.msg.visibleDevices.push({ ...two.response.status.msg.visibleDevices[0], DeviceID: 2002 });
  const bad: unknown[] = [
    getEnv({ visibleDevices: [] }), two, getEnv({ hiddenDevices: 1 }), getEnv({ pendingDevices: 1 }), getEnv({ deniedDevices: 2 }),
    getEnv({ hiddenDevices: -1 }), getEnv({ pendingDevices: 1.5 }), getEnv({ deniedDevices: '0' }), getEnv({ hiddenDevices: [{ Name: 'h', GroupID: 10 }] }),
    getEnv({ visibleDevices: 'x' }), { response: { status: { msg: 'nope' } } }, { response: {} }, null, [],
  ];
  for (const b of bad) assert(!parseSingleDevice(b).ok, `refused: ${JSON.stringify(b)}`);
});

// ── device_manage rename / delete / move ──────────────────────────────────────
console.log('\ndevice_manage rename/delete/move on the live single-device envelope');
const ops: Array<[string, Record<string, unknown>]> = [
  ['rename', { action: 'rename', name: 'synth-single-01', newname: 'zzz' }],
  ['delete', { action: 'delete', name: 'synth-single-01' }],
  ['move', { action: 'move', name: 'synth-single-01', destoupath: '/NorthCreek/Imprivata' }],
];
await test('device in protected /NorthCreek/AD (GroupID 10) -> rename/delete/move refused (audited, no write)', async () => {
  for (const [label, input] of ops) {
    reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; process.env.SCOUT_ENV = 'production';
    await refused(label, () => deviceManageTool.execute(input), /protected/i);
  }
});
await test('device in an UNPROTECTED OU (GroupID 5) -> gate passes; real write sent', async () => {
  for (const [label, input] of ops) {
    reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; process.env.SCOUT_ENV = 'production'; singleDevice = getEnv({}, { GroupID: 5 });
    const r = await deviceManageTool.execute(input);
    assert(!r.isError && writes.length === 1, `${label}: ${writes.join('|')} ${text(r)}`);
  }
});
await test('dry-run plan passes the gate for an unprotected device, and is refused for a protected one', async () => {
  reset(); process.env.SCOUT_MODE = 'dry-run'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; process.env.SCOUT_ENV = 'production'; singleDevice = getEnv({}, { GroupID: 5 });
  const r = await deviceManageTool.execute(ops[0]![1]);
  assert(!r.isError && /dry_run/.test(text(r)) && writes.length === 0, text(r));
  reset(); process.env.SCOUT_MODE = 'dry-run'; process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; process.env.SCOUT_ENV = 'production';
  await refused('dry-run protected', () => deviceManageTool.execute(ops[0]![1]), /protected/i);
});
await test('counts > 0, two rows, zero rows, unknown shape -> refused for rename/delete/move', async () => {
  const two = getEnv(); two.response.status.msg.visibleDevices.push({ ...two.response.status.msg.visibleDevices[0], DeviceID: 2002, GroupID: 5 });
  const cases: unknown[] = [getEnv({ hiddenDevices: 1 }, { GroupID: 5 }), getEnv({ pendingDevices: 1 }, { GroupID: 5 }), getEnv({ deniedDevices: 1 }, { GroupID: 5 }),
    two, getEnv({ visibleDevices: [] }), { response: { status: { msg: { devices: [] } } } }];
  for (const rec of cases) {
    for (const [label, input] of ops) {
      reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; process.env.SCOUT_ENV = 'production'; singleDevice = rec;
      await refused(`${label} ${JSON.stringify(rec).slice(0, 60)}`, () => deviceManageTool.execute(input), /source OU/);
    }
  }
});
await test('envelope row with GroupID not in tree / string GroupID -> refused', async () => {
  for (const g of [999, '5']) {
    reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; singleDevice = getEnv({}, { GroupID: g });
    await refused(`GroupID ${g}`, () => deviceManageTool.execute(ops[0]![1]), /source OU/);
  }
});

// ── bulk paths: non-zero integer counts must not read as "fully listed" ───────
console.log('\nbulk gate paths refuse when devices exist but are not listed');
const bulk = { sourceOuPath: '/NorthCreek', searchTerm: 'synth', includeSubOus: true, destOuPath: '/NorthCreek/SmartCard', confirm: true };
await test('move_devices_by_filter / bulk_command: envelope with integer counts > 0 -> refused; counts 0 -> works', async () => {
  const env = (extra: Record<string, unknown>) => ({ response: { status: { msg: { visibleDevices: [{ Name: 'a', GroupID: 10 }], hiddenDevices: 0, pendingDevices: 0, deniedDevices: 0, ...extra } } } });
  for (const extra of [{ hiddenDevices: 1 }, { pendingDevices: 2 }, { deniedDevices: 1 }]) {
    reset(); searchBody = env(extra);
    await refused(`move ${JSON.stringify(extra)}`, () => moveDevicesByFilterTool.execute(bulk), /hidden|unlisted|not listed/i);
    reset(); searchBody = env(extra);
    await refused(`bulk ${JSON.stringify(extra)}`, () => bulkCommandTool.execute({ sourceOuPath: '/NorthCreek', searchTerm: 'a', command: 'restart', confirm: true }), /hidden|unlisted|not listed/i);
  }
  reset(); searchBody = env({});
  const r = await moveDevicesByFilterTool.execute(bulk);
  assert(!r.isError && writes.length === 1, `${writes.join('|')} ${text(r)}`);
});

// ── search request shape + per-OU fan-out ─────────────────────────────────────
console.log('\nbulk search request: searchFields, % wildcard, per-OU fan-out, cap, de-dup');
const bc = { sourceOuPath: '/NorthCreek/SmartCard', searchTerm: 'Thin*', command: 'restart', confirm: true };
const q = (path: string): URLSearchParams => new URLSearchParams(path.split('?')[1] ?? '');
await test('search carries searchFields=Name (default) and "*" -> "%"; includeSubOus is not sent', async () => {
  reset(); searchBody = legacyEnvelope([{ Name: 'a', GroupID: 6 }]);
  await bulkCommandTool.execute(bc);
  assert(searches.length === 1, `one search: ${searches.join('|')}`);
  const p = q(searches[0]!);
  assert(p.get('searchFields') === 'Name' && p.get('searchTerm') === 'Thin%' && p.get('ouPath') === '/NorthCreek/SmartCard' && !p.has('includeSubOus'), searches[0]!);
  reset(); searchBody = legacyEnvelope([{ Name: 'a', GroupID: 6 }]);
  await moveDevicesByFilterTool.execute({ sourceOuPath: '/NorthCreek/SmartCard', searchTerm: '*', searchFields: 'Mac_Address', destOuPath: '/NorthCreek/Imprivata', dryRun: true });
  const p2 = q(searches[0]!);
  assert(p2.get('searchTerm') === '%' && p2.get('searchFields') === 'Mac_Address', searches[0]!);
});
await test('invalid searchFields is rejected by the schema', async () => {
  reset();
  let threw = false;
  try { await bulkCommandTool.execute({ ...bc, searchFields: 'Name; DROP' }); } catch { threw = true; }
  assert(threw && searches.length === 0, 'rejected before any search');
});
await test('includeSubOus: one search per OU of the fresh subtree (SmartCard, fmnt, Mpollux), de-duplicated by DeviceID', async () => {
  reset(); searchFn = () => legacyEnvelope([{ Name: 'a', DeviceID: 1, GroupID: 6 }]);
  const r = await bulkCommandTool.execute({ ...bc, includeSubOus: true });
  const ous = searches.map((x) => q(x).get('ouPath')).sort();
  assert(JSON.stringify(ous) === JSON.stringify(['/NorthCreek/SmartCard', '/NorthCreek/SmartCard/Mpollux', '/NorthCreek/SmartCard/fmnt']), ous.join(','));
  assert(!r.isError && writes.length === 1, `one device commanded once: ${writes.join('|')} ${text(r)}`);
});
await test('includeSubOus with a protected DESCENDANT -> refused before any search (bulk_command)', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/SmartCard/fmnt';
  await refused('protected descendant', () => bulkCommandTool.execute({ ...bc, includeSubOus: true }));
  assert(searches.length === 0, `no search issued: ${searches.join('|')}`);
});
await test('more than 500 devices across the fan-out -> refused, not truncated (both tools)', async () => {
  let n = 0;
  const big = (): unknown => legacyEnvelope(Array.from({ length: 200 }, () => ({ Name: `d${n}`, DeviceID: n++, GroupID: 6 })));
  reset(); searchFn = big;
  await refused('bulk cap', () => bulkCommandTool.execute({ ...bc, includeSubOus: true }), /500/);
  n = 0; reset(); searchFn = big;
  await refused('move cap', () => moveDevicesByFilterTool.execute({ sourceOuPath: '/NorthCreek/SmartCard', searchTerm: '*', includeSubOus: true, destOuPath: '/NorthCreek/Imprivata', confirm: true }), /500/);
});
await test('a per-OU response that is unparseable or has unlisted counts -> whole call refused', async () => {
  reset(); searchFn = (p) => (q(p).get('ouPath') === '/NorthCreek/SmartCard/fmnt' ? { nope: 1 } : legacyEnvelope([{ Name: 'a', DeviceID: 1, GroupID: 6 }]));
  await refused('unparseable in one OU', () => bulkCommandTool.execute({ ...bc, includeSubOus: true }), /parse/);
  reset(); searchFn = (p) => (q(p).get('ouPath') === '/NorthCreek/SmartCard/Mpollux'
    ? { response: { status: { msg: { visibleDevices: [], hiddenDevices: 3, pendingDevices: 0, deniedDevices: 0 } } } }
    : legacyEnvelope([{ Name: 'a', DeviceID: 1, GroupID: 6 }]));
  await refused('hidden in one OU', () => moveDevicesByFilterTool.execute({ sourceOuPath: '/NorthCreek/SmartCard', searchTerm: '*', includeSubOus: true, destOuPath: '/NorthCreek/Imprivata', confirm: true }), /hidden|not listed/i);
});
await test('move_devices_by_filter fan-out: row in a protected descendant -> refused by the per-device gate', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/SmartCard/fmnt';
  searchFn = (p) => legacyEnvelope(q(p).get('ouPath') === '/NorthCreek/SmartCard/fmnt' ? [{ Name: 'p', DeviceID: 9, GroupID: 14 }] : [{ Name: 'a', DeviceID: 1, GroupID: 6 }]);
  await refused('protected row', () => moveDevicesByFilterTool.execute({ sourceOuPath: '/NorthCreek/SmartCard', searchTerm: '*', includeSubOus: true, destOuPath: '/NorthCreek/Imprivata', confirm: true }), /protected/i);
});

console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
