/**
 * Device -> OU mapping via GroupID. Live evidence (Scout 26.11.0): GET /api/v1/device/search returns
 * `msg` as a LIST of rows {ClientIdentifier, DeviceID, GroupID, IP_Address, Mac_Address, Name} and
 * GroupID equals the device's direct OU id. This file covers the unified parser, the strict id
 * reader, and every wired consumer (device_manage move, move_devices_by_filter, bulk_command,
 * device_command / notification_manage target=device, config_resolve device branch, enricher).
 * Fixture: tests/fixtures/device-search-live.json (sanitised, synthetic names/addresses).
 * Run: npx tsx tests/device-ou-groupid.test.ts
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
import { parseSearchDevices, readDeviceOuId, readDeviceOuIds, deviceOuId } from '../src/devices.js';
import { deviceManageTool } from '../src/tools/device.js';
import { deviceCommandTool } from '../src/tools/command.js';
import { notificationManageTool } from '../src/tools/notification.js';
import { bulkCommandTool, moveDevicesByFilterTool } from '../src/tools/workflow.js';
import { resolveTargetRef } from '../src/tools/config_resolve.js';
import { enrich, invalidateEnrichmentCache } from '../src/enricher.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
const AUDIT = join(mkdtempSync(join(tmpdir(), 'scout-grp-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = AUDIT;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-grp-no-kill-switch');
process.env.SCOUT_SNAPSHOT_DIR = join(tmpdir(), 'scout-grp-snapshots');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE_TREE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));
const LIVE_SEARCH = JSON.parse(readFileSync(join(here, 'fixtures', 'device-search-live.json'), 'utf8'));
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
let singleDevice: Record<string, unknown> = { Name: 'synth-ad-01', GroupID: 10 };
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
c.request = async (method: string, path: string) => {
  if (method !== 'GET') { writes.push(`${method} ${path}`); return { ok: true }; }
  if (path.startsWith('/api/v1/ou/structure')) return LIVE_TREE;
  if (path.startsWith('/api/v1/device/search')) return searchBody;
  if (path.startsWith('/api/v1/device?')) return singleDevice;
  return {};
};
const reset = (): void => {
  writes.length = 0; searchBody = listEnvelope(liveRows()); singleDevice = { Name: 'synth-ad-01', GroupID: 10 };
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
console.log('\nunified device-search parser');
await test('live list shape parses (6 rows, GroupID kept)', () => {
  const p = parseSearchDevices(LIVE_SEARCH);
  assert(p.ok && p.devices.length === 6 && p.devices[0]!['GroupID'] === 10, 'list parsed');
});
await test('legacy {visibleDevices,hiddenDevices} envelope still parses', () => {
  const p = parseSearchDevices(legacyEnvelope([{ Name: 'a', OUID: 10 }]));
  assert(p.ok && p.devices.length === 1 && p.hiddenDevices === 0, 'legacy parsed');
});
await test('empty list is a valid zero-match result; unknown shapes are NOT an empty list', () => {
  const e = parseSearchDevices(listEnvelope([]));
  assert(e.ok && e.devices.length === 0, 'empty list ok');
  for (const bad of [listEnvelope('boom'), listEnvelope(null), listEnvelope({}), listEnvelope({ Devices: [] }), listEnvelope([1, 'x']), listEnvelope([null]), null, {}, { response: {} }]) {
    assert(!parseSearchDevices(bad).ok, `refused: ${JSON.stringify(bad)}`);
  }
});

// ── strict id reader ──────────────────────────────────────────────────────────
console.log('\nstrict OU id reader');
await test('GroupID-only, OUID-only and agreeing OUID+GroupID are accepted', () => {
  assert(deviceOuId({ GroupID: 10 }) === 10 && deviceOuId({ OUID: 10 }) === 10 && deviceOuId({ OUID: 10, GroupID: 10 }) === 10, 'accepted');
});
await test('string / float / negative / NaN / null / bool / disagreeing values are refused', () => {
  for (const rec of [{ GroupID: '10' }, { GroupID: 10.5 }, { GroupID: -1 }, { GroupID: NaN }, { GroupID: null }, { GroupID: true }, { OUID: '10', GroupID: 10 },
    { OUID: 10, GroupID: 11 }, { OUID: 10, ouId: 11 }, {}]) {
    assert(!readDeviceOuId(rec).ok, `refused: ${JSON.stringify(rec)}`);
  }
});
await test('rows of one search that disagree on shape are refused (and a bad row refuses the batch)', () => {
  assert(readDeviceOuIds(liveRows()).ok, 'uniform live rows ok');
  assert(!readDeviceOuIds([{ GroupID: 10 }, { OUID: 10 }]).ok, 'GroupID vs OUID rows');
  assert(!readDeviceOuIds([{ GroupID: 10 }, {}]).ok, 'row without id');
  assert(!readDeviceOuIds([{ GroupID: 10 }, { GroupID: '5' }]).ok, 'one non-integer row');
});

// ── device_manage move (single-device record) ─────────────────────────────────
console.log('\ndevice_manage move source OU via GroupID');
const mv = { action: 'move', name: 'synth-ad-01', destoupath: '/NorthCreek/Imprivata' };
await test('device in a PROTECTED OU (GroupID 10 = AD) -> refused, no move', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  await refused('protected source', () => deviceManageTool.execute(mv));
});
await test('device in an UNPROTECTED OU (GroupID 8 = Customers) -> move reaches the server', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; singleDevice = { Name: 'x', GroupID: 8 };
  const r = await deviceManageTool.execute(mv);
  assert(!r.isError && writes.length === 1 && /PUT \/api\/v1\/device\/move/.test(writes[0]!), `moved: ${writes.join('|')} ${text(r)}`);
});
await test('GroupID not in the tree / disagreeing OUID+GroupID / string GroupID -> refused', async () => {
  for (const rec of [{ GroupID: 999 }, { OUID: 10, GroupID: 8 }, { GroupID: '10' }, { GroupID: -3 }]) {
    reset(); singleDevice = { Name: 'x', ...rec };
    await refused(JSON.stringify(rec), () => deviceManageTool.execute(mv), /source OU/);
  }
});

// ── move_devices_by_filter ────────────────────────────────────────────────────
console.log('\nmove_devices_by_filter (bulk) via GroupID');
const bulk = { sourceOuPath: '/NorthCreek', searchTerm: 'synth', includeSubOus: true, destOuPath: '/NorthCreek/SmartCard', confirm: true };
await test('allowed sources (nothing protected): all 6 live rows are moved end-to-end', async () => {
  reset();
  const r = await moveDevicesByFilterTool.execute(bulk);
  assert(!r.isError && writes.length === 6 && writes.every((w) => /^PUT \/api\/v1\/device\/move\?name=synth-.*&destouid=6$/.test(w)), `moved: ${writes.join('|')} ${text(r)}`);
});
await test('protected source (a row sits in /NorthCreek/AD via GroupID 10) -> refused, no PUT', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  await refused('bulk protected source', () => moveDevicesByFilterTool.execute(bulk), /protected|blocked/i);
});
await test('protected parent of rows (/NorthCreek/Customers, rows in CLALIT 9 + DNIe 17) -> refused', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  await refused('bulk protected ancestor', () => moveDevicesByFilterTool.execute(bulk));
});
await test('a protected OU that holds none of the matched rows does not block the move', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/SmartCard/fmnt';
  // fmnt (14) holds no matched device.
  const r = await moveDevicesByFilterTool.execute({ ...bulk, destOuPath: '/NorthCreek/Imprivata' });
  assert(!r.isError && writes.length === 6, `moved: ${writes.join('|')} ${text(r)}`);
});
await test('a GroupID not in the OU tree -> refused (no moves)', async () => {
  reset(); const rows = liveRows(); rows[3]!['GroupID'] = 4242; searchBody = listEnvelope(rows);
  await refused('unknown GroupID', () => moveDevicesByFilterTool.execute(bulk), /source OU/);
});
await test('rows with disagreeing OUID/GroupID, or mixed shapes within one search -> refused', async () => {
  reset(); let rows = liveRows(); rows[0]!['OUID'] = 11; searchBody = listEnvelope(rows);
  await refused('OUID vs GroupID', () => moveDevicesByFilterTool.execute(bulk), /source OU/);
  reset(); rows = liveRows(); delete rows[2]!['GroupID']; rows[2]!['OUID'] = 16; searchBody = listEnvelope(rows);
  await refused('mixed shape', () => moveDevicesByFilterTool.execute(bulk), /shape/);
});
await test('legacy envelope with OUID rows still works end-to-end; unknown msg shape refuses', async () => {
  reset(); searchBody = legacyEnvelope([{ Name: 'legacy-1', OUID: 10 }, { Name: 'legacy-2', OUID: 11 }]);
  const r = await moveDevicesByFilterTool.execute(bulk);
  assert(!r.isError && writes.length === 2, `moved: ${writes.join('|')} ${text(r)}`);
  reset(); searchBody = listEnvelope({ Devices: liveRows() });
  await refused('unknown shape', () => moveDevicesByFilterTool.execute(bulk), /parse/);
});

// ── bulk_command / device_command / notification_manage ───────────────────────
console.log('\nbulk_command + target=device gating via GroupID');
const bc = { sourceOuPath: '/NorthCreek', searchTerm: 'synth', command: 'restart', confirm: true };
await test('bulk_command: matched device in a protected OU (root itself not protected) -> refused', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  await refused('bulk_command per-device', () => bulkCommandTool.execute(bc), /source OU|protected/i);
});
await test('bulk_command: no lists configured -> unchanged behaviour (commands sent)', async () => {
  reset();
  const r = await bulkCommandTool.execute(bc);
  assert(!r.isError && writes.length === 6, `sent: ${writes.join('|')} ${text(r)}`);
});
await test('device_command target=device: protected OU refused; other OU sent; unresolvable refused', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  await refused('device_command protected', () => deviceCommandTool.execute({ target: 'device', command: 'restart', name: 'synth-ad-01' }));
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; singleDevice = { Name: 'x', GroupID: 5 };
  const r = await deviceCommandTool.execute({ target: 'device', command: 'restart', name: 'x' });
  assert(!r.isError && writes.length === 1, `sent: ${writes.join('|')} ${text(r)}`);
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; singleDevice = { Name: 'x' };
  await refused('device_command no id', () => deviceCommandTool.execute({ target: 'device', command: 'restart', name: 'x' }), /source OU/);
});
await test('notification_manage target=device: protected OU refused; other OU sent', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD';
  await refused('notification protected', () => notificationManageTool.execute({ action: 'set', target: 'device', type: 'configurationupdate', name: 'synth-ad-01' }));
  reset(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/AD'; singleDevice = { Name: 'x', GroupID: 5 };
  const r = await notificationManageTool.execute({ action: 'set', target: 'device', type: 'configurationupdate', name: 'x' });
  assert(!r.isError && writes.length === 1, `sent: ${writes.join('|')} ${text(r)}`);
});

// ── config_resolve device branch + enricher ───────────────────────────────────
console.log('\nconfig_resolve device branch + enricher');
await test('device (GroupID only) -> OU chain root: ouId/ouPath resolved from the tree', async () => {
  reset(); singleDevice = { Name: 'synth-cep-01', GroupID: 16 };
  const t = await resolveTargetRef('device', 'synth-cep-01');
  assert(t.ouId === 16 && t.ouPath === '/NorthCreek/Browser/Google-CEP', `got ${JSON.stringify(t)}`);
});
await test('device with a GroupID not in the tree / string GroupID -> throws (no guess)', async () => {
  for (const rec of [{ GroupID: 999 }, { GroupID: '16' }, {}]) {
    reset(); singleDevice = { Name: 'x', ...rec };
    let threw = false;
    try { await resolveTargetRef('device', 'x'); } catch { threw = true; }
    assert(threw, `threw for ${JSON.stringify(rec)}`);
  }
});
await test('enrich(): device-search rows get _GroupIDName/_GroupIDPath; non-device GroupID is left alone', async () => {
  reset();
  const out = (await enrich(listEnvelope(liveRows()))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const row = out.response.status.msg[2];
  assert(row._GroupIDName === 'Google-CEP' && row._GroupIDPath === '/NorthCreek/Browser/Google-CEP', `annotated: ${JSON.stringify(row)}`);
  const other = (await enrich({ Label: 'x', GroupID: 10 })) as Record<string, unknown>;
  assert(!('_GroupIDName' in other), 'non-device object untouched');
});

console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
