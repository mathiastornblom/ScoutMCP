/**
 * OU-gating follow-up: schedule_manage update/delete (refused while OU gates are active), command and
 * notification devicelist (every clientId looked up, all source OUs gated), ddg (refused while gated),
 * and the _GroupIDPath cross-check against the fresh OU tree. Client methods are instance-patched (no
 * network); credentials are random runtime fakes. Run: npx tsx tests/ou-gating-followup.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient, ScoutError } from '../src/client.js';
import { invalidateOuCache } from '../src/resolver.js';
import { __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { resolveDeviceSourceOus, gateDeviceListSources, normalizeClientId } from '../src/safety/ou_gate.js';
import { readDeviceOuId, readDeviceOuIds } from '../src/devices.js';
import { clearWorkingOu } from '../src/context.js';
import { deviceCommandTool } from '../src/tools/command.js';
import { notificationManageTool } from '../src/tools/notification.js';
import { scheduleManageTool } from '../src/tools/schedule.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: `u-${randomUUID()}`, password: randomUUID() });
const AUDIT = join(mkdtempSync(join(tmpdir(), 'scout-fup-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = AUDIT;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-fup-no-kill-switch');
process.env.SCOUT_SNAPSHOT_DIR = join(tmpdir(), 'scout-fup-snapshots');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));
const renamed = (from: string, to: string) => JSON.parse(JSON.stringify(LIVE).replace(`"Name":"${from}"`, `"Name":"${to}"`));

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string): asserts c { if (!c) throw new Error(`Assertion failed: ${m}`); }
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const saved = { ...process.env };
  invalidateOuCache(); __resetCircuitBreakerStateForTests(); clearWorkingOu();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
  finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// ── fake server ───────────────────────────────────────────────────────────────
interface Write { method: string; path: string; body: unknown }
const writes: Write[] = [];
let structureFetches = 0;
let tree: (n: number) => unknown = () => LIVE;
let lookups = 0;
let extraGets = 0; // GETs other than OU structure / device lookups (schedule lists etc.)
const G = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; // fixture ids 1..3 -> OU 10 / 11 / 16
const B = (n: number): string => `{${G(n)}}`;
const lookupIds: string[] = [];
const row = (n: number, ou: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ClientIdentifier: G(n), DeviceID: 1000 + n, GroupID: ou, Name: `synth-${n}`, ...extra });
let fleet: Map<string, Record<string, unknown>> = new Map();
let lookupHook: ((cid: string) => unknown) | undefined;
const envelope = (rows: unknown[], counts: Record<string, number> = {}): unknown =>
  ({ response: { status: { msg: { visibleDevices: rows, hiddenDevices: 0, pendingDevices: 0, deniedDevices: 0, ...counts } } } });
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
c.request = async (method: string, path: string, body?: unknown) => {
  if (method !== 'GET') { writes.push({ method, path, body }); return { ok: true }; }
  if (path.startsWith('/api/v1/ou/structure')) return tree(++structureFetches);
  if (path.startsWith('/api/v1/device?')) {
    lookups++;
    lookupIds.push(new URL(`http://x${path}`).searchParams.get('clientid') ?? '');
    const cid = decodeURIComponent(new URL(`http://x${path}`).searchParams.get('clientid') ?? '');
    if (lookupHook) return lookupHook(cid);
    const hit = fleet.get(normalizeClientId(cid) ?? '');
    if (!hit) throw new ScoutError('not found', 404);
    return envelope([hit]);
  }
  extraGets++;
  return {};
};
const reset = (): void => {
  tree = () => LIVE; structureFetches = 0; writes.length = 0; lookups = 0; extraGets = 0; lookupHook = undefined; lookupIds.length = 0;
  fleet = new Map([
    [G(1), row(1, 10)], [G(2), row(2, 11, { ClientIdentifier: `{${G(2)}}` })], [G(3), row(3, 16)],
  ]);
};
const writeMode = (): void => { process.env.SCOUT_MODE = 'write'; };
const auditText = (): string => { try { return readFileSync(AUDIT, 'utf8'); } catch { return ''; } };
const text = (r: { content: Array<{ text: string }> }): string => r.content[0]?.text ?? '';
const AD = '/NorthCreek/AD'; // OU 10
const sent = (): string => writes.map((w) => `${w.method} ${w.path}`).join(' | ');

async function refused(label: string, run: () => Promise<{ isError?: boolean; content: Array<{ text: string }> }>, re?: RegExp, expectAudit = true): Promise<void> {
  writes.length = 0;
  __resetCircuitBreakerStateForTests();
  const before = auditText().length;
  const r = await run();
  assert(r.isError === true && writes.length === 0, `${label}: refused with no mutating call (writes=${JSON.stringify(writes)}): ${text(r)}`);
  if (re) assert(re.test(text(r)), `${label}: message ${re}: ${text(r)}`);
  if (expectAudit) assert(auditText().length > before, `${label}: refusal audit-logged`);
}
const cmd = (body: unknown, extra: Record<string, unknown> = {}) => deviceCommandTool.execute({ target: 'devicelist', command: 'restart', body, ...extra });
const note = (body: unknown, extra: Record<string, unknown> = {}) =>
  notificationManageTool.execute({ action: 'set', target: 'devicelist', type: 'configurationupdate', body, ...extra });

// ── 1. schedule_manage ────────────────────────────────────────────────────────
console.log('\nschedule_manage update/delete');
const sched = (action: string, extra: Record<string, unknown> = {}) => scheduleManageTool.execute({ action, scheduleId: 57, body: { schedule: { type: 'once' } }, ...extra });
await test('no gate active: update/delete behave as before (no extra GETs)', async () => {
  reset(); writeMode();
  let r = await sched('update');
  assert(!r.isError && sent() === 'POST /api/v1/schedule/update?scheduleId=57', sent() + text(r));
  r = await sched('delete');
  assert(!r.isError && sent().endsWith('DELETE /api/v1/schedule/delete?scheduleId=57'), sent());
  assert(extraGets === 0 && structureFetches === 0 && lookups === 0, 'no lookups at all');
});
await test('gates active (protected / allowed / SCOUT_ENV=test): update and delete refused, audited, no POST, no GETs', async () => {
  const gates: Array<Record<string, string>> = [
    { SCOUT_PROTECTED_OUS: AD }, { SCOUT_ALLOWED_OUS: '/MCP-Test' }, { SCOUT_ENV: 'test', SCOUT_TEST_OU_PATH: '/MCP-Test' },
  ];
  for (const g of gates) {
    reset(); writeMode(); Object.assign(process.env, g);
    await refused(`update ${JSON.stringify(g)}`, () => sched('update'), /cannot map a schedule id/);
    await refused(`delete ${JSON.stringify(g)}`, () => sched('delete'), /cannot map a schedule id/);
    await refused(`update with ouRef-ish body ${JSON.stringify(g)}`, () => sched('update', { body: { ouId: 2 } }));
    assert(extraGets === 0 && structureFetches === 0, 'no lookups while refusing');
  }
});
await test('gates active: scheduleId missing / read-only still refused first; get_ou/get_device reads stay allowed', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = AD; process.env.SCOUT_MODE = 'read-only';
  const before = auditText().length;
  const r = await sched('update');
  assert(r.isError === true && writes.length === 0 && /read-only|mode/i.test(text(r)), text(r));
  assert(auditText().length > before, 'mode refusal audited');
  const g = await scheduleManageTool.execute({ action: 'get_ou', ouId: 2 });
  assert(!g.isError && extraGets === 1, 'get_ou unaffected');
  const g2 = await scheduleManageTool.execute({ action: 'get_device', name: 'x' });
  assert(!g2.isError && extraGets === 2, 'get_device unaffected');
});
await test('dry-run mode without gates returns dry_run; no mutating call', async () => {
  reset(); process.env.SCOUT_MODE = 'dry-run';
  const r = await sched('delete');
  assert(!r.isError && /dry_run/.test(text(r)) && writes.length === 0, text(r));
});

// ── 2. devicelist ─────────────────────────────────────────────────────────────
console.log('\ndevicelist (device_command + notification_manage)');
await test('gates inactive: devicelist/ddg unchanged, body untouched, no lookups', async () => {
  reset(); writeMode();
  const body = { clientIds: [G(1), 'not-even-a-guid'], ouId: 9, ddgid: 4 };
  let r = await cmd(body);
  assert(!r.isError && writes.length === 1 && JSON.stringify(writes[0].body) === JSON.stringify(body) && lookups === 0 && structureFetches === 0, `${sent()} ${text(r)}`);
  r = await deviceCommandTool.execute({ target: 'ddg', command: 'restart', body: { id: 3 } });
  assert(!r.isError && writes.length === 2 && lookups === 0, text(r));
  r = await note(body);
  assert(!r.isError && writes.length === 3 && lookups === 0, text(r));
});
await test('PROTECTED=AD: [OU 11] allowed; adding the protected member (OU 10) refuses the whole command; no partial send', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  let r = await cmd({ clientIds: [G(2)] });
  assert(!r.isError && writes.length === 1, text(r));
  assert(JSON.stringify((writes[0].body as any).clientIds) === JSON.stringify([`{${G(2)}}`]), 'forwarded as {GUID}'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await refused('one protected member', () => cmd({ clientIds: [G(2), G(1)] }), /protected/i);
  await refused('protected first', () => cmd({ clientIds: [G(1), G(2)] }), /protected/i);
  for (const command of ['update', 'updateuefi', 'custom', 'factoryreset', 'halt', 'message']) {
    await refused(`command ${command}`, () => deviceCommandTool.execute({ target: 'devicelist', command, confirm: true, body: { clientIds: [G(1)] } }), /protected/i);
  }
  await refused('schedule key does not escape the gate', () => cmd({ clientIds: [G(1)], schedule: { type: 'once' } }), /protected/i);
});
await test('allowed device with a schedule key: schedule kept, clientIds replaced by the server identifiers', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const r = await cmd({ clientIds: [G(3)], schedule: { type: 'once' }, informUser: { title: 't' } });
  assert(!r.isError && writes.length === 1, text(r));
  assert(JSON.stringify(writes[0].body) === JSON.stringify({ schedule: { type: 'once' }, informUser: { title: 't' }, clientIds: [B(3)] }), JSON.stringify(writes[0].body));
});
await test('SCOUT_ENV=test, TEST_OU=AD: [OU 10] ok; adding OU 16 refused test-scope', async () => {
  reset(); writeMode(); process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = AD;
  let r = await cmd({ clientIds: [G(1)] });
  assert(!r.isError && writes.length === 1, text(r));
  await refused('outside test scope', () => cmd({ clientIds: [G(1), G(3)] }), /outside SCOUT_TEST_OU_PATH/);
  assert(/test-scope/.test(auditText()), 'audit has test-scope gate');
});
await test('GUID variants (brace / UPPER / whitespace) normalise to the same device and are gated identically', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  for (const v of [G(1), `{${G(1)}}`, G(1).toUpperCase(), `{${G(1).toUpperCase()}}`, ` ${G(1)} `, `\t{${G(1)}}\n`]) {
    await refused(`variant ${JSON.stringify(v)}`, () => cmd({ clientIds: [v] }), /protected/i);
  }
  for (const v of [G(2), `{${G(2)}}`, G(2).toUpperCase()]) {
    writes.length = 0;
    const r = await cmd({ clientIds: [v] });
    assert(!r.isError && (writes[0].body as any).clientIds[0] === `{${G(2)}}`, `${v}: ${JSON.stringify(writes[0]?.body)} ${text(r)}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  assert(normalizeClientId(`{${G(1)}`) === undefined && normalizeClientId(`{{${G(1)}}}`) === undefined, 'unbalanced / double braces rejected');
});
await test('lookup failures refuse the whole command (audited, no POST)', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  await refused('unknown id (404)', () => cmd({ clientIds: [G(2), G(9)] }), /unresolvable|Refusing/i);
  const bad: Array<[string, unknown]> = [
    ['zero rows', envelope([])],
    ['two rows', envelope([row(2, 11), row(3, 16)])],
    ['hidden > 0', envelope([row(2, 11)], { hiddenDevices: 1 })],
    ['pending > 0', envelope([row(2, 11)], { pendingDevices: 1 })],
    ['denied > 0', envelope([row(2, 11)], { deniedDevices: 1 })],
    ['ClientIdentifier differs', envelope([row(3, 11)])],
    ['ClientIdentifier missing', envelope([{ GroupID: 11, DeviceID: 5 }])],
    ['no GroupID/OUID', envelope([{ ClientIdentifier: G(2), DeviceID: 5 }])],
    ['GroupID string', envelope([row(2, '11' as unknown as number)])],
    ['GroupID 10.5', envelope([row(2, 10.5)])],
    ['GroupID -1', envelope([row(2, -1)])],
    ['GroupID not in tree', envelope([row(2, 999)])],
    ['non-object response', 'oops'],
    ['bad envelope', { response: { status: { msg: 7 } } }],
  ];
  for (const [label, reply] of bad) {
    lookupHook = () => reply;
    await refused(label, () => cmd({ clientIds: [G(2)] }));
  }
  lookupHook = () => { throw new ScoutError('boom', 500); };
  await refused('lookup throws', () => cmd({ clientIds: [G(2)] }), /lookup of device 1 failed/);
  lookupHook = (cid) => (normalizeClientId(cid) === G(3) ? envelope([row(3, 16)]) : envelope([row(2, 11)]));
  lookupHook = (cid) => (normalizeClientId(cid) === G(3) ? envelope([row(3, 16)]) : envelope([{ ClientIdentifier: G(2), DeviceID: 2, OUID: 11 }]));
  await refused('mixed row shapes', () => cmd({ clientIds: [G(3), G(2)] }), /disagree on shape/);
});
await test('invalid clientIds inputs refused with no lookups', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const many = (n: number): string[] => Array.from({ length: n }, (_, i) => G(i + 1));
  const cases: Array<[string, unknown]> = [
    ['missing body', undefined], ['empty object', {}], ['empty array', { clientIds: [] }], ['non-array', { clientIds: G(1) }],
    ['numbers', { clientIds: [1, 2] }], ['objects', { clientIds: [{ id: G(1) }] }], ['empty string', { clientIds: [''] }],
    ['non-GUID', { clientIds: ['abc'] }], ['embedded space', { clientIds: [`${G(1).slice(0, 8)} ${G(1).slice(9)}`] }],
    ['NUL', { clientIds: [`${G(1)}\u0000`] }], ['non-ASCII digit', { clientIds: [G(1).replace('1', '１')] }],
    ['101 ids', { clientIds: many(101) }], ['two clientIds variants', { clientIds: [G(2)], ClientIDs: [G(1)] }],
  ];
  for (const [label, body] of cases) {
    lookups = 0;
    await refused(label, () => cmd(body));
    assert(lookups === 0, `${label}: no lookups (${lookups})`);
  }
});
await test('lookup uses the bare UPPERCASE GUID; forwarded ids are {UPPERCASE} rebuilt from the server rows; forms dedupe to one id', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const hex = 'abcdef01-2345-4678-89ab-cdef01234567';
  fleet.set(hex, { ClientIdentifier: hex, DeviceID: 77, GroupID: 11, Name: 'hex' }); // server returns lowercase bare
  const forms = [`{${hex}}`, hex, ` ${hex.toUpperCase()}\n`, `{${hex.toUpperCase()}}`];
  for (const f of forms) {
    lookupIds.length = 0; writes.length = 0;
    const r = await cmd({ clientIds: [f] });
    assert(!r.isError && lookupIds.length === 1 && lookupIds[0] === hex.toUpperCase(), `${JSON.stringify(f)} -> lookup ${lookupIds}`);
    assert(JSON.stringify((writes[0].body as any).clientIds) === JSON.stringify([`{${hex.toUpperCase()}}`]), JSON.stringify(writes[0].body)); // eslint-disable-line @typescript-eslint/no-explicit-any
    writes.length = 0;
    const n = await note({ clientIds: [f] });
    assert(!n.isError && JSON.stringify((writes[0].body as any).clientIds) === JSON.stringify([`{${hex.toUpperCase()}}`]), 'notification forwards {UPPER}'); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  lookupIds.length = 0; writes.length = 0;
  const r = await cmd({ clientIds: forms });
  assert(!r.isError && lookupIds.length === 1 && (writes[0].body as any).clientIds.length === 1, 'braced + unbraced + case forms collapse to one'); // eslint-disable-line @typescript-eslint/no-explicit-any
});
await test('duplicates de-duplicated: one lookup per distinct id, one POST', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const r = await cmd({ clientIds: [G(2), `{${G(2)}}`, G(2).toUpperCase(), G(3)] });
  assert(!r.isError && lookups === 2 && writes.length === 1, `${lookups} ${sent()} ${text(r)}`);
  assert((writes[0].body as any).clientIds.length === 2, JSON.stringify(writes[0].body)); // eslint-disable-line @typescript-eslint/no-explicit-any
});
await test('body smuggling: OU keys refused; includeSubOus dropped; ddgid refused; ClientIDs variant rebuilt as clientIds', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const smug: Array<Record<string, unknown>> = [
    { ouId: 9 }, { OU_Path: AD }, { x: { ouid: 11 } }, { groupId: 11 }, { 'ou.id': 10 }, { id: 3 }, { path: AD }, { destinationOU: 11 },
  ];
  for (const s of smug) await refused(`smuggle ${JSON.stringify(s)}`, () => cmd({ clientIds: [G(2)], ...s }), /OU keys/);
  await refused('ddgid not in schema', () => cmd({ clientIds: [G(3)], ddgid: 3 }), /not in the documented request schema/);
  const r = await cmd({ ClientIDs: [G(3)], includeSubOus: true });
  assert(!r.isError, text(r));
  assert(JSON.stringify(writes[0].body) === JSON.stringify({ clientIds: [B(3)] }), JSON.stringify(writes[0].body));
});
await test('100 ids allowed (100 lookups, ONE fresh tree read in dry-run); 101 refused; 1 protected among 100 refuses', async () => {
  reset(); process.env.SCOUT_MODE = 'dry-run'; process.env.SCOUT_PROTECTED_OUS = AD;
  const ids: string[] = [];
  for (let i = 1; i <= 100; i++) { const id = G(100 + i); ids.push(id); fleet.set(id, row(100 + i, 11)); }
  let r = await cmd({ clientIds: ids });
  assert(!r.isError && /dry_run/.test(text(r)) && writes.length === 0, text(r));
  assert(lookups === 100 && structureFetches === 1, `lookups=${lookups} structureFetches=${structureFetches}`);
  assert(/100 device\(s\) in 1 source OU/.test(auditText()), 'audit has device + OU counts');
  fleet.set(ids[57], row(158, 10));
  await refused('protected among 100', () => cmd({ clientIds: ids }), /protected/i);
  fleet.set(G(999), row(999, 11));
  await refused('101 ids', () => cmd({ clientIds: [...ids, G(999)] }), /max 100/);
});
await test('read-only blocked before any lookup; dry-run does the lookups, returns dry_run, no POST', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = AD; process.env.SCOUT_MODE = 'read-only';
  let r = await cmd({ clientIds: [G(2)] });
  assert(r.isError === true && lookups === 0 && writes.length === 0, text(r));
  process.env.SCOUT_MODE = 'dry-run';
  r = await cmd({ clientIds: [G(2)] });
  assert(!r.isError && /dry_run/.test(text(r)) && lookups === 1 && writes.length === 0, text(r));
  await refused('dry-run still refuses a protected member', () => cmd({ clientIds: [G(1)] }), /protected/i);
});
await test('factoryreset: source OU renamed between the gate and the write (after confirm) -> refused, no POST', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  tree = (n) => (n >= 2 ? renamed('Boot2VDI', 'Boot2VDI-moved') : LIVE);
  await refused('recheck', () => cmd({ clientIds: [G(2)] }, { command: 'factoryreset', confirm: true }), /changed during the operation/);
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  const r = await cmd({ clientIds: [G(2)] }, { command: 'factoryreset', confirm: true });
  assert(!r.isError && writes.length === 1, text(r));
});
await test('QA#1: notification_manage devicelist re-reads the tree right before the POST (renamed source OU -> refused)', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  tree = (n) => (n >= 2 ? renamed('Boot2VDI', 'Boot2VDI-moved') : LIVE);
  await refused('recheck', () => note({ clientIds: [G(2)] }), /changed during the operation/);
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = '/NorthCreek/Customers';
  const r = await note({ clientIds: [G(2)] });
  assert(!r.isError && writes.length === 1, text(r));
});
await test('SEC#3: devicelist body is an allowlist per endpoint (unknown keys refused while gated; unchanged when inactive)', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  await refused('unknown key', () => cmd({ clientIds: [G(2)], evil: 1 }), /not in the documented request schema \(evil\)/);
  await refused('key of another command', () => cmd({ clientIds: [G(2)], command: 'rm -rf /' }), /not in the documented request schema/); // restart has no `command`
  await refused('case-variant key', () => cmd({ clientIds: [G(2)], Schedule: {} }), /not in the documented/);
  await refused('notification unknown key', () => note({ clientIds: [G(2)], informUser: {} }), /not in the documented/); // configurationupdate has none
  await refused('notification delete takes clientIds only', () => notificationManageTool.execute({ action: 'delete', target: 'devicelist', type: 'delivery', body: { clientIds: [G(2)], informUser: {} } }), /not in the documented/);
  let r = await deviceCommandTool.execute({ target: 'devicelist', command: 'custom', body: { clientIds: [G(2)], command: 'ls', runAsRoot: false, schedule: { type: 'once' } } });
  assert(!r.isError && writes.length === 1, text(r));
  r = await notificationManageTool.execute({ action: 'set', target: 'devicelist', type: 'delivery', body: { clientIds: [G(2)], informUser: { title: 't' }, deliverCompleteImage: true } });
  assert(!r.isError && writes.length === 2, text(r));
  reset(); writeMode(); delete process.env.SCOUT_PROTECTED_OUS;
  r = await cmd({ clientIds: ['x'], evil: 1 });
  assert(!r.isError && writes.length === 1 && lookups === 0, 'inactive: unchanged');
});
await test('SEC#1/#2: devicerelocation target=device and target=ou gate destinationOU (required, single, scalar, resolved id only)', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  for (const target of ['device', 'ou'] as const) {
    const base: Record<string, unknown> = target === 'device' ? { clientid: G(3) } : { ouId: 11 };
    const reloc = (body?: Record<string, unknown>, action = 'set') => notificationManageTool.execute({ action, target, type: 'devicerelocation', body, ...base });
    await refused(`${target}: protected destination id`, () => reloc({ destinationOU: 10 }), /protected/i);
    await refused(`${target}: protected destination path`, () => reloc({ DestinationOU: '/northcreek/AD/' }), /protected/i);
    await refused(`${target}: omitted destination`, () => reloc({ destinationScoutServer: 'x.invalid' }), /requires destinationOU/);
    await refused(`${target}: no body`, () => reloc(undefined), /requires destinationOU/);
    await refused(`${target}: two variants`, () => reloc({ destinationOU: 11, destination_ou: 11 }));
    await refused(`${target}: non-scalar`, () => reloc({ destinationOU: [11] }));
    await refused(`${target}: unknown OU`, () => reloc({ destinationOU: 9999 }));
    writes.length = 0;
    const r = await reloc({ destinationOU: '/NorthCreek/Boot2VDI', destinationScoutServer: 'x.invalid' });
    assert(!r.isError && writes.length === 1, `${target}: ${text(r)}`);
    assert((writes[0].body as any).destinationOU === 11 && (writes[0].body as any).destinationScoutServer === 'x.invalid', JSON.stringify(writes[0].body)); // eslint-disable-line @typescript-eslint/no-explicit-any
    writes.length = 0;
    const d = await reloc(undefined, 'delete');
    assert(!d.isError && writes.length === 1, `${target}: delete does not require a destination: ${text(d)}`);
  }
  reset(); writeMode(); process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Browser';
  await refused('device: destination outside test scope', () => notificationManageTool.execute({ action: 'set', target: 'device', type: 'devicerelocation', clientid: G(3), body: { destinationOU: 11 } }), /outside SCOUT_TEST_OU_PATH/);
  reset(); writeMode(); delete process.env.SCOUT_ENV; delete process.env.SCOUT_TEST_OU_PATH; delete process.env.SCOUT_PROTECTED_OUS; // no gate: unchanged, no destination required, no lookups
  const r = await notificationManageTool.execute({ action: 'set', target: 'device', type: 'devicerelocation', clientid: G(3) });
  assert(!r.isError && writes.length === 1 && structureFetches === 0, text(r));
});
await test('QA#3: refusal messages say what to do / what is accepted', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  await refused('ddg', () => deviceCommandTool.execute({ target: 'ddg', command: 'restart' }), /target=devicelist with explicit clientIds, or target=ou/);
  await refused('bad id', () => cmd({ clientIds: ['abc'] }), /accepted: a GUID/);
});
await test('notification_manage devicelist: set AND delete gated for every type; allowed passes with rebuilt body', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  for (const type of ['configurationupdate', 'delivery', 'updateuefi', 'updatefirmware', 'devicerelocation']) {
    for (const action of ['set', 'delete']) {
      await refused(`${action} ${type}`, () => notificationManageTool.execute({ action, target: 'devicelist', type, body: { clientIds: [G(1)], ...(type === 'devicerelocation' && action === 'set' ? { destinationOU: 11 } : {}) } }), /protected/i);
    }
  }
  await refused('generic id key in a devicelist body', () => notificationManageTool.execute({ action: 'delete', target: 'devicelist', type: 'delivery', body: { clientIds: [G(3)], id: 4 } }), /OU keys/);
  assert(/unresolvable-source-ou/.test(auditText()), 'audited with gate name');
  writes.length = 0;
  const ok2 = await notificationManageTool.execute({ action: 'delete', target: 'devicelist', type: 'delivery', body: { clientIds: [G(3)] } });
  assert(!ok2.isError && sent() === 'DELETE /api/v1/notification/devicelist/delivery' && JSON.stringify(writes[0].body) === JSON.stringify({ clientIds: [B(3)] }), sent());
  await refused('missing clientIds', () => note({}));
  await refused('read-only', async () => { process.env.SCOUT_MODE = 'read-only'; return note({ clientIds: [G(3)] }); }, undefined, false);
});
await test('devicerelocation via devicelist: destinationOU gated as a write target and replaced by the resolved id', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  const reloc = (body: Record<string, unknown>) => notificationManageTool.execute({ action: 'set', target: 'devicelist', type: 'devicerelocation', body });
  await refused('protected destination (id)', () => reloc({ clientIds: [G(3)], destinationOU: 10 }), /protected/i);
  await refused('protected destination (path)', () => reloc({ clientIds: [G(3)], DestinationOU: '/northcreek/ad/' }), /protected/i);
  await refused('unknown destination', () => reloc({ clientIds: [G(3)], destinationOU: 9999 }));
  await refused('two destination variants', () => reloc({ clientIds: [G(3)], destinationOU: 11, destination_ou: 11 }));
  await refused('non-scalar destination', () => reloc({ clientIds: [G(3)], destinationOU: { id: 11 } }));
  await refused('other OU key still refused', () => reloc({ clientIds: [G(3)], destinationOU: 11, ouId: 11 }), /OU keys/);
  let r = await reloc({ clientIds: [G(3)], destinationOU: '/NorthCreek/Boot2VDI', destinationScoutServer: 'x.invalid' });
  assert(!r.isError && writes.length === 1, text(r));
  assert(JSON.stringify(writes[0].body) === JSON.stringify({ destinationScoutServer: 'x.invalid', clientIds: [B(3)], destinationOU: 11 }), JSON.stringify(writes[0].body));
  reset(); writeMode(); process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Browser';
  await refused('destination outside test scope', () => reloc({ clientIds: [G(3)], destinationOU: 11 }), /outside SCOUT_TEST_OU_PATH/);
  await refused('omitted destination (server default OU)', () => reloc({ clientIds: [G(3)] }), /requires destinationOU/);
});

// ── 3. ddg ────────────────────────────────────────────────────────────────────
console.log('\nddg');
await test('ddg refused while any source-OU check is active (command + notification, set/delete, id/ddgid in body); no POST, audited', async () => {
  const gates: Array<Record<string, string>> = [
    { SCOUT_PROTECTED_OUS: AD }, { SCOUT_ALLOWED_OUS: '/MCP-Test' }, { SCOUT_ENV: 'test', SCOUT_TEST_OU_PATH: '/MCP-Test' },
  ];
  for (const g of gates) {
    reset(); writeMode(); Object.assign(process.env, g);
    await refused(`command ddg ${JSON.stringify(g)}`, () => deviceCommandTool.execute({ target: 'ddg', command: 'restart', body: { id: 3, ddgid: 3 } }), /dynamic device group/);
    await refused('command ddg factoryreset', () => deviceCommandTool.execute({ target: 'ddg', command: 'factoryreset', confirm: true }));
    for (const action of ['set', 'delete']) {
      await refused(`notification ddg ${action}`, () => notificationManageTool.execute({ action, target: 'ddg', type: 'delivery', body: { ddgid: 3, id: 3 } }), /dynamic device group/);
    }
    await refused('notification ddg devicerelocation', () => notificationManageTool.execute({ action: 'set', target: 'ddg', type: 'devicerelocation', body: { destinationOU: 11 } }));
    assert(/unresolvable-source-ou/.test(auditText()), 'gate name audited');
  }
});
await test('ddg dry-run with gates still refused; read-only blocked by mode first; no gate -> unchanged', async () => {
  reset(); process.env.SCOUT_MODE = 'dry-run'; process.env.SCOUT_PROTECTED_OUS = AD;
  await refused('dry-run', () => deviceCommandTool.execute({ target: 'ddg', command: 'restart' }));
  reset(); process.env.SCOUT_MODE = 'read-only'; process.env.SCOUT_PROTECTED_OUS = AD;
  const r = await deviceCommandTool.execute({ target: 'ddg', command: 'restart' });
  assert(r.isError === true && writes.length === 0, text(r));
  reset(); writeMode(); delete process.env.SCOUT_PROTECTED_OUS;
  const r2 = await notificationManageTool.execute({ action: 'set', target: 'ddg', type: 'delivery', body: { x: 1 } });
  assert(!r2.isError && writes.length === 1 && lookups === 0 && structureFetches === 0, text(r2));
});

// ── 4. _GroupIDPath cross-check ───────────────────────────────────────────────
console.log('\n_GroupIDPath / _OUIDPath cross-check');
const dev = (extra: Record<string, unknown>): Record<string, unknown> => ({ ClientIdentifier: G(1), DeviceID: 1, GroupID: 10, ...extra });
const gateRows = (rows: Array<Record<string, unknown>>) => resolveDeviceSourceOus('t', 'x', rows as never);
await test('matching claimed path passes (case/space/slash variants); absent keys behave as before; undefined = absent', async () => {
  reset();
  for (const p of ['/NorthCreek/AD', '/northcreek/ad/', ' /NORTHCREEK//AD ']) {
    const [m] = await gateRows([dev({ _GroupIDPath: p, _GroupIDName: 'AD' })]);
    assert(m.ouid === 10, p);
  }
  assert((await gateRows([dev({})])).length === 1, 'absent');
  assert((await gateRows([dev({ _GroupIDPath: undefined, _GroupIDName: undefined })])).length === 1, 'undefined = absent');
  const r = readDeviceOuId(dev({ _GroupIDPath: '/NorthCreek/AD' }));
  assert(r.ok && r.claimedPath === '/northcreek/ad', JSON.stringify(r));
});
await test('enriched row with matching _GroupIDPath passes the real gate (device target) and an enriched single record with _OUIDPath', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  lookupHook = () => envelope([dev({ GroupID: 11, _GroupIDName: 'Boot2VDI', _GroupIDPath: '/NorthCreek/Boot2VDI' })]);
  let r = await deviceCommandTool.execute({ target: 'device', command: 'restart', clientid: G(1) });
  assert(!r.isError && writes.length === 1, text(r));
  lookupHook = () => ({ OUID: 11, Name: 'x', _OUIDName: 'Boot2VDI', _OUIDPath: '/NorthCreek/Boot2VDI' });
  r = await deviceCommandTool.execute({ target: 'device', command: 'restart', clientid: G(1) });
  assert(!r.isError && writes.length === 2, text(r));
  lookupHook = () => ({ OUID: 11, Name: 'x', _OUIDPath: AD });
  await refused('single record mismatching _OUIDPath', () => deviceCommandTool.execute({ target: 'device', command: 'restart', clientid: G(1) }), /disagrees|unknown source OU|Refusing/);
});
await test('mismatch with the fresh tree refused in BOTH directions (audited); protected path with harmless id and vice versa', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = AD;
  for (const rowv of [dev({ _GroupIDPath: '/NorthCreek/Browser' }), dev({ GroupID: 13, _GroupIDPath: AD }), dev({ GroupID: 11, _GroupIDPath: AD }), dev({ GroupID: 10, _GroupIDPath: '/NorthCreek/Boot2VDI' })]) {
    const before = auditText().length;
    let threw = false;
    try { await gateRows([rowv]); } catch (e) { threw = /unresolvable|determine the source OU/.test(String(e instanceof Error ? e.message : e)); }
    assert(threw && auditText().length > before, `refused ${JSON.stringify(rowv)}`);
  }
});
await test('path key without id key, non-string / empty / array / null path, "..", ".", control chars -> refused', () => {
  const cases: Array<Record<string, unknown>> = [
    { ClientIdentifier: G(1), OUID: 10, _GroupIDPath: AD },
    { ClientIdentifier: G(1), GroupID: 10, _OUIDPath: AD },
    dev({ _GroupIDPath: 5 }), dev({ _GroupIDPath: ['/a'] }), dev({ _GroupIDPath: null }), dev({ _GroupIDPath: '' }), dev({ _GroupIDPath: '   ' }),
    dev({ _GroupIDPath: '/NorthCreek/../AD' }), dev({ _GroupIDPath: '/NorthCreek/./AD' }), dev({ _GroupIDPath: '/North\u0000Creek/AD' }),
    dev({ _GroupIDName: 'AD' }), // name without path
  ];
  for (const rowv of cases) assert(!readDeviceOuId(rowv).ok, `refused ${JSON.stringify(rowv)}`);
});
await test('_GroupIDName must equal the last path segment; claimed paths must agree among themselves', () => {
  assert(!readDeviceOuId(dev({ _GroupIDPath: AD, _GroupIDName: 'Browser' })).ok, 'wrong name');
  assert(!readDeviceOuId(dev({ _GroupIDPath: AD, _GroupIDName: 7 })).ok, 'non-string name');
  assert(readDeviceOuId(dev({ _GroupIDPath: AD, _GroupIDName: 'ad' })).ok, 'matching name (case-insensitive)');
  assert(!readDeviceOuId(dev({ OUID: 10, _GroupIDPath: AD, _OUIDPath: '/NorthCreek/Browser' })).ok, 'two claimed paths disagree');
  assert(readDeviceOuId(dev({ OUID: 10, _GroupIDPath: AD, _OUIDPath: '/northcreek/ad/' })).ok, 'two claimed paths agree');
});
await test('own properties only: inherited path keys are ignored', () => {
  const proto = { _GroupIDPath: '/NorthCreek/Browser' };
  const r = Object.create(proto) as Record<string, unknown>;
  Object.assign(r, { ClientIdentifier: G(1), GroupID: 10 });
  const res = readDeviceOuId(r);
  assert(res.ok && res.claimedPath === undefined, JSON.stringify(res));
});
await test('mixed result (some rows with path, some without): no shape refusal; one wrong path refuses the whole result', async () => {
  reset();
  const rows = [dev({ _GroupIDPath: AD }), dev({ GroupID: 11 }), dev({ GroupID: 16, _GroupIDPath: '/NorthCreek/Browser/Google-CEP' })];
  const r = readDeviceOuIds(rows as never);
  assert(r.ok && r.claimedPaths.length === 3 && r.claimedPaths[1] === undefined, JSON.stringify(r));
  assert((await gateRows(rows)).length === 3, 'passes');
  let threw = false;
  try { await gateRows([rows[0], dev({ GroupID: 11, _GroupIDPath: AD }), rows[2]]); } catch { threw = true; }
  assert(threw, 'whole result refused');
});
await test('devicelist gate: an enriched row with matching path passes; a mismatching path refuses the command', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = AD;
  lookupHook = () => envelope([row(2, 11, { ClientIdentifier: G(2), _GroupIDName: 'Boot2VDI', _GroupIDPath: '/NorthCreek/Boot2VDI' })]);
  let r = await cmd({ clientIds: [G(2)] });
  assert(!r.isError && writes.length === 1, text(r));
  lookupHook = () => envelope([row(2, 11, { ClientIdentifier: G(2), _GroupIDName: 'AD', _GroupIDPath: AD })]);
  await refused('claimed protected path with unprotected id', () => cmd({ clientIds: [G(2)] }));
});
await test('gateDeviceListSources direct: rejects non-object body and missing key; accepts a minimal valid list', async () => {
  reset(); process.env.SCOUT_PROTECTED_OUS = AD;
  for (const b of [undefined, [] as unknown as Record<string, unknown>]) {
    let threw = false; try { await gateDeviceListSources(c, 't', b); } catch { threw = true; }
    assert(threw, 'refused');
  }
  const g = await gateDeviceListSources(c, 't', { clientIds: [G(3)] });
  assert(g.deviceCount === 1 && g.ouCount === 1, JSON.stringify(g));
  await g.recheck();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
