/**
 * OU gate COVERAGE round: every tool that mutates with an OU path/id resolves ALL supplied OU
 * references from a fresh tree, refuses on disagreement, gates the canonical resolved path
 * (SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS / SCOUT_ENV=test scope / top-level base-write), sends
 * ONLY the resolved id, and audit-logs every refusal. Client methods are instance-patched (no
 * network). Run: npx tsx tests/ou-gate-coverage.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient, ScoutError } from '../src/client.js';
import { invalidateOuCache } from '../src/resolver.js';
import { __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { testScopeViolation } from '../src/safety/ou_gate.js';
import { clearWorkingOu, getWorkingOu } from '../src/context.js';
import { ouManageTool } from '../src/tools/ou.js';
import { deviceManageTool } from '../src/tools/device.js';
import { appManageTool } from '../src/tools/application.js';
import { deviceCommandTool } from '../src/tools/command.js';
import { notificationManageTool } from '../src/tools/notification.js';
import { ouFilterManageTool, newDeviceOptionsTool } from '../src/tools/ou_filtering.js';
import { adminManageTool } from '../src/tools/admins.js';
import { onboardBranchTool, bulkCommandTool, moveDevicesByFilterTool } from '../src/tools/workflow.js';
import { configUpdateTool } from '../src/tools/config.js';
import { contextTool } from '../src/tools/context.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
const AUDIT = join(mkdtempSync(join(tmpdir(), 'scout-cov-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = AUDIT;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-cov-no-kill-switch');
process.env.SCOUT_SNAPSHOT_DIR = join(tmpdir(), 'scout-cov-snapshots');

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
let rootCalls = 0;
let filterRows: unknown = [];
let devices: Array<Record<string, unknown>> = [{ Name: 'thin01', OUID: 10 }];
const record = (method: string, path: string, body?: unknown): { ok: true } => { writes.push({ method, path, body }); return { ok: true }; };
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
c.request = async (method: string, path: string, body?: unknown) => {
  if (method !== 'GET') return record(method, path, body);
  if (path.startsWith('/api/v1/ou/structure')) return tree(++structureFetches);
  if (path.startsWith('/api/v1/ou/root')) { rootCalls++; throw new ScoutError('not found', 404); } // dev instance behaviour
  if (path.startsWith('/api/v1/device/search')) {
    return { response: { status: { msg: { visibleDevices: devices, hiddenDevices: 0 } } } };
  }
  if (path.startsWith('/api/v1/device?')) return { OUID: 10, Name: 'thin01' };
  return {};
};
c.rawRequest = async (method: string, path: string, body?: unknown) => {
  if (method !== 'GET') return record(method, path, body);
  if (path === '/api/v1/oufilter') return filterRows;
  return {};
};
const reset = (): void => {
  tree = () => LIVE; structureFetches = 0; writes.length = 0; rootCalls = 0; filterRows = [];
  devices = [{ Name: 'thin01', OUID: 10 }];
};
const writeMode = (): void => { process.env.SCOUT_MODE = 'write'; };
const auditText = (): string => { try { return readFileSync(AUDIT, 'utf8'); } catch { return ''; } };

const PROT = '/NorthCreek/Customers'; // OU 8 (CLALIT 9, DNIe 17, Epiroc 12, mnjustitsia 15 below it); OU 5 = /NorthCreek/Imprivata, OU 6 = SmartCard
const setProt = (): void => { process.env.SCOUT_PROTECTED_OUS = PROT; };
const text = (r: { content: Array<{ text: string }> }): string => r.content[0]?.text ?? '';

/** A refusal: isError, nothing written, and an audit line added for it. */
async function refused(label: string, run: () => Promise<{ isError?: boolean; content: Array<{ text: string }> }>, re?: RegExp): Promise<void> {
  writes.length = 0;
  __resetCircuitBreakerStateForTests(); // many refused attempts in one scenario must not trip the breaker
  const before = auditText().length;
  const r = await run();
  assert(r.isError === true && writes.length === 0, `${label}: refused with no mutating call (writes=${JSON.stringify(writes)}): ${text(r)}`);
  if (re) assert(re.test(text(r)), `${label}: message ${re}: ${text(r)}`);
  assert(auditText().length > before, `${label}: refusal audit-logged`);
}
const sent = (): string => writes.map((w) => `${w.method} ${w.path}`).join(' | ');

// ── application.ts ────────────────────────────────────────────────────────────
console.log('\napp_manage (scope=ou / copy / move / set_inheritance)');
await test('create/delete/set_inheritance on a protected OU (path variants, id, disagreeing refs, no OU) -> refused, no call', async () => {
  reset(); writeMode(); setProt();
  const refs: Array<Record<string, unknown>> = [
    { ouPath: PROT }, { ouPath: '/northcreek/CUSTOMERS/' }, { ouPath: ' //NorthCreek//Customers ' },
    { ouId: 8 }, { ouId: 5, ouPath: PROT }, {},
  ];
  for (const r of refs) {
    await refused(`create ${JSON.stringify(r)}`, () => appManageTool.execute({ action: 'create', scope: 'ou', applicationType: 'citrix', body: { a: 1 }, ...r }));
    await refused(`delete ${JSON.stringify(r)}`, () => appManageTool.execute({ action: 'delete', scope: 'ou', appId: 3, ...r }));
    await refused(`set_inheritance ${JSON.stringify(r)}`, () => appManageTool.execute({ action: 'set_inheritance', body: { useParentApps: true }, ...r }));
  }
});
await test('unprotected OU: path/id/both-consistent send ONLY id=<resolved>', async () => {
  for (const r of [{ ouPath: '/northcreek/imprivata' }, { ouId: 5 }, { ouId: 5, ouPath: '/NorthCreek/Imprivata' }]) {
    reset(); writeMode(); setProt();
    let res = await appManageTool.execute({ action: 'create', scope: 'ou', applicationType: 'citrix', body: { a: 1 }, ...r });
    assert(!res.isError && sent() === 'POST /api/v1/applications/ou/citrix?id=5', `create: ${sent()} ${text(res)}`);
    reset(); writeMode(); setProt();
    res = await appManageTool.execute({ action: 'delete', scope: 'ou', appId: 3, ...r });
    assert(!res.isError && sent() === 'DELETE /api/v1/applications/ou?appId=3&id=5', `delete: ${sent()}`);
    reset(); writeMode(); setProt();
    res = await appManageTool.execute({ action: 'set_inheritance', body: { useParentApps: false, evil: 1 }, ...r });
    assert(!res.isError && sent() === 'POST /api/v1/applications/inheritance?id=5', `set_inheritance: ${sent()}`);
    assert(JSON.stringify(writes[0]!.body) === '{"useParentApps":false}', `body validated down: ${JSON.stringify(writes[0]!.body)}`);
  }
});
await test('scope=base is not OU-scoped: sends no OU and is not gated by the OU lists', async () => {
  reset(); writeMode(); setProt();
  const r = await appManageTool.execute({ action: 'create', scope: 'base', applicationType: 'citrix', body: { a: 1 }, ouId: 8 });
  assert(!r.isError && sent() === 'POST /api/v1/applications/base/citrix', sent());
});
await test('copy/move: protected target (body.targetOu) refused; move from a protected source refused; copy FROM protected source allowed', async () => {
  reset(); writeMode(); setProt();
  await refused('copy -> protected target', () => appManageTool.execute({ action: 'copy', appId: 1, ouId: 5, body: { targetOu: 8 } }));
  await refused('move -> protected target', () => appManageTool.execute({ action: 'move', appId: 1, ouId: 5, body: { targetOu: 8 } }));
  await refused('move from protected source', () => appManageTool.execute({ action: 'move', appId: 1, ouPath: PROT, body: { targetOu: 6 } }));
  await refused('source id vs path disagree', () => appManageTool.execute({ action: 'move', appId: 1, ouId: 5, ouPath: PROT, body: { targetOu: 6 } }));
  reset(); writeMode(); setProt();
  let r = await appManageTool.execute({ action: 'copy', appId: 1, ouPath: PROT, body: { targetOu: 6, extra: true } });
  assert(!r.isError && sent() === 'POST /api/v1/applications/copy?appId=1&ouId=8', `copy from protected source reads only: ${sent()} ${text(r)}`);
  assert(JSON.stringify(writes[0]!.body) === '{"targetOu":6}', `body only targetOu: ${JSON.stringify(writes[0]!.body)}`);
  reset(); writeMode(); setProt();
  r = await appManageTool.execute({ action: 'move', appId: 1, ouId: 5, body: { targetOu: 6 } });
  assert(!r.isError && sent() === 'POST /api/v1/applications/move?appId=1&ouId=5', sent());
});

// ── command.ts ────────────────────────────────────────────────────────────────
console.log('\ndevice_command target=ou');
await test('protected OU via ouRef / body.ouId / body.ouPath / disagreeing refs / includeSubOus -> refused', async () => {
  reset(); writeMode(); setProt();
  const cases: Array<Record<string, unknown>> = [
    { ouRef: PROT },
    { ouRef: '/northcreek/customers/' },
    { body: { ouId: 8 } },
    { body: { ouPath: PROT } },
    { ouRef: '5', body: { ouId: 8 } }, // allowed ouRef + protected body.ouId must not slip through
    { ouRef: '/NorthCreek/Imprivata', body: { ouPath: PROT } },
    { ouRef: '/NorthCreek', body: { includeSubOus: true } }, // sub-OU Customers is protected
    {},
  ];
  for (const x of cases) await refused(JSON.stringify(x), () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ...x }));
});
await test('unprotected OU: body carries ONLY id=<resolved> (body.ouPath dropped)', async () => {
  for (const x of [{ ouRef: '5' }, { body: { ouId: 5 } }, { body: { ouPath: '/northcreek/imprivata' } }, { ouRef: '/NorthCreek/Imprivata', body: { ouId: 5, ouPath: '/NorthCreek/Imprivata', informUser: { enabled: true } } }]) {
    reset(); writeMode(); setProt();
    const r = await deviceCommandTool.execute({ target: 'ou', command: 'restart', ...x });
    assert(!r.isError && writes.length === 1, `${JSON.stringify(x)}: ${text(r)}`);
    const b = writes[0]!.body as Record<string, unknown>;
    assert(b['ouId'] === 5 && !('ouPath' in b), `only resolved id: ${JSON.stringify(b)}`);
  }
});
await test('factoryreset on a protected OU is refused before any confirm prompt; target=device is not OU-scoped', async () => {
  reset(); writeMode(); setProt();
  await refused('factoryreset', () => deviceCommandTool.execute({ target: 'ou', command: 'factoryreset', ouRef: PROT, confirm: true }));
  const r = await deviceCommandTool.execute({ target: 'device', command: 'restart', name: 'thin01' });
  assert(!r.isError && writes.length === 1, 'device-scope command unaffected');
});

// ── notification.ts ───────────────────────────────────────────────────────────
console.log('\nnotification_manage target=ou');
await test('protected OU refused (path variants / id / disagree / none); unprotected sends only id=<resolved>', async () => {
  reset(); writeMode(); setProt();
  for (const x of [{ ouPath: PROT }, { ouPath: '/NORTHCREEK/customers' }, { ouId: 8 }, { ouId: 5, ouPath: PROT }, {}]) {
    await refused(JSON.stringify(x), () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ...x }));
    await refused(`delete ${JSON.stringify(x)}`, () => notificationManageTool.execute({ action: 'delete', target: 'ou', type: 'delivery', ...x }));
  }
  await refused('includeSubOus over a protected child', () =>
    notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 2, body: { includeSubOus: true } }));
  reset(); writeMode(); setProt();
  const r = await notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouPath: '/northcreek/imprivata', ouId: 5 });
  assert(!r.isError && sent() === 'POST /api/v1/notification/ou/delivery?id=5', `${sent()} ${text(r)}`);
});

// ── ou_filtering.ts ───────────────────────────────────────────────────────────
console.log('\nou_filter_manage / new_device_options');
await test('add: protected ou_id refused; missing ou_id refused; unprotected sends OUID=<resolved>', async () => {
  reset(); writeMode(); setProt();
  await refused('protected', () => ouFilterManageTool.execute({ action: 'add', entries: [{ subnet_address: '10.0.0.0/24', ou_id: 8, active: true }] }));
  await refused('one of two protected', () => ouFilterManageTool.execute({ action: 'add', entries: [
    { subnet_address: '10.0.0.0/24', ou_id: 5, active: true }, { subnet_address: '10.0.1.0/24', ou_id: 9, active: true }] }));
  await refused('no ou_id', () => ouFilterManageTool.execute({ action: 'add', entries: [{ subnet_address: '10.0.0.0/24', active: true }] }));
  reset(); writeMode(); setProt();
  const r = await ouFilterManageTool.execute({ action: 'add', entries: [{ subnet_address: '10.0.0.0/24', ou_id: 5, active: true }] });
  assert(!r.isError && sent() === 'POST /api/v1/oufilter/add', sent());
  assert(JSON.stringify(writes[0]!.body).includes('"OUID":5'), JSON.stringify(writes[0]!.body));
});
await test('modify/delete: entry_id is mapped to its CURRENT OU (fail closed if unknown); a move INTO a protected OU is refused', async () => {
  reset(); writeMode(); setProt();
  filterRows = [{ EntryId: 7, OUID: 8 }, { EntryId: 8, OUID: 5 }];
  await refused('modify entry in protected OU', () => ouFilterManageTool.execute({ action: 'modify', entries: [{ entry_id: 7, active: false }] }));
  await refused('delete entry in protected OU', () => ouFilterManageTool.execute({ action: 'delete', entries: [{ entry_id: 7 }] }));
  await refused('modify unprotected entry INTO protected OU', () => ouFilterManageTool.execute({ action: 'modify', entries: [{ entry_id: 8, ou_id: 8 }] }));
  filterRows = [{ EntryId: 8, OUID: 5 }];
  await refused('unknown entry (fail closed)', () => ouFilterManageTool.execute({ action: 'delete', entries: [{ entry_id: 99 }] }));
  filterRows = { not: 'an array' };
  await refused('unparseable list (fail closed)', () => ouFilterManageTool.execute({ action: 'modify', entries: [{ entry_id: 8, active: true }] }));
  filterRows = [{ EntryId: 8, OUID: 5 }];
  writes.length = 0;
  let r = await ouFilterManageTool.execute({ action: 'modify', entries: [{ entry_id: 8, active: false }] });
  assert(!r.isError && sent() === 'POST /api/v1/oufilter/modify', sent());
  writes.length = 0;
  r = await ouFilterManageTool.execute({ action: 'delete', entries: [{ entry_id: 8 }] });
  assert(!r.isError && sent() === 'POST /api/v1/oufilter/delete', sent());
});
await test('new_device_options default_ou: protected refused, unprotected sends resolved id', async () => {
  reset(); writeMode(); setProt();
  await refused('default_ou protected', () => newDeviceOptionsTool.execute({ action: 'set', default_ou: 8 }));
  await refused('default_ou unknown id', () => newDeviceOptionsTool.execute({ action: 'set', default_ou: 9999 }));
  reset(); writeMode(); setProt();
  const r = await newDeviceOptionsTool.execute({ action: 'set', default_ou: 5, deactivate_new_devices: true });
  assert(!r.isError && sent() === 'POST /api/v1/NewDeviceOptions/set' && JSON.stringify(writes[0]!.body).includes('"DefaultOU":5'), sent());
});

// ── admins.ts ─────────────────────────────────────────────────────────────────
console.log('\nadmin_manage update_admin (root_ou / root_ou_fmd)');
await test('protected root_ou / root_ou_fmd refused; unprotected sends the resolved ids', async () => {
  reset(); writeMode(); setProt(); process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
  await refused('root_ou', () => adminManageTool.execute({ action: 'update_admin', admin_id: 7, root_ou: 8, confirm: true }));
  await refused('root_ou_fmd', () => adminManageTool.execute({ action: 'update_admin', admin_id: 7, root_ou: 5, root_ou_fmd: 9, confirm: true }));
  reset(); writeMode(); setProt(); process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
  const r = await adminManageTool.execute({ action: 'update_admin', admin_id: 7, root_ou: 5, root_ou_fmd: 6, confirm: true });
  assert(!r.isError && sent() === 'POST /api/v1/admins/modify', `${sent()} ${text(r)}`);
  const b = writes[0]!.body as Record<string, unknown>;
  assert(b['RootOu'] === 5 && b['RootOUFMD'] === 6, JSON.stringify(b));
});

// ── ou.ts ─────────────────────────────────────────────────────────────────────
console.log('\nou_manage: rename/converttobase, destinations, root/base gate, import, test scope');
await test('rename / converttobase of a protected OU (path variants, id, disagree) -> refused', async () => {
  reset(); writeMode(); setProt();
  for (const x of [{ path: PROT }, { path: '/northcreek/CUSTOMERS/' }, { id: 8 }, { id: 5, path: PROT }, { ouRef: '/NorthCreek/Customers/CLALIT' }]) {
    await refused(`rename ${JSON.stringify(x)}`, () => ouManageTool.execute({ action: 'rename', newname: 'x', ...x }));
    await refused(`converttobase ${JSON.stringify(x)}`, () => ouManageTool.execute({ action: 'converttobase', ...x }));
  }
  reset(); writeMode(); setProt();
  const r = await ouManageTool.execute({ action: 'rename', id: 5, path: '/northcreek/imprivata', newname: 'Imp2' });
  assert(!r.isError && sent() === 'PUT /api/v1/ou?id=5&newname=Imp2', sent());
});
await test('add / move without ANY destination is refused gate-side and audited', async () => {
  reset(); writeMode();
  await refused('add no dest', () => ouManageTool.execute({ action: 'add', name: 'New' }), /destination OU/);
  await refused('move no dest', () => ouManageTool.execute({ action: 'move', id: 5 }), /destination OU/);
  await refused('rename no target', () => ouManageTool.execute({ action: 'rename', newname: 'x' }), /target OU/);
});
await test('top-level OU needs SCOUT_ALLOW_BASE_WRITES, derived from the tree: /ou/root is never called (404 on dev)', async () => {
  reset(); writeMode();
  await refused('delete top-level SKY', () => ouManageTool.execute({ action: 'delete', id: 4 }), /SCOUT_ALLOW_BASE_WRITES/);
  await refused('rename top-level NorthCreek by path', () => ouManageTool.execute({ action: 'rename', path: '/northcreek', newname: 'x' }), /SCOUT_ALLOW_BASE_WRITES/);
  assert(rootCalls === 0, `no /ou/root call (${rootCalls})`);
  // child OU: not top-level, proceeds although /ou/root would 404
  reset(); writeMode();
  let r = await ouManageTool.execute({ action: 'rename', id: 5, newname: 'x' });
  assert(!r.isError && rootCalls === 0 && writes.length === 1, `child ok: ${text(r)}`);
  // armed: top-level proceeds
  reset(); writeMode(); process.env.SCOUT_ALLOW_BASE_WRITES = 'true';
  r = await ouManageTool.execute({ action: 'delete', id: 4 });
  assert(!r.isError && sent() === 'DELETE /api/v1/ou?id=4' && rootCalls === 0, `${sent()} ${text(r)}`);
});
await test('unreadable tree: mutating ou_manage fails closed (no write)', async () => {
  reset(); writeMode();
  tree = () => ({ response: { status: { msg: {} } } });
  await refused('unparseable tree', () => ouManageTool.execute({ action: 'rename', id: 5, newname: 'x' }));
});
await test('structure_import: shape validated, parent gated, unenumerable payload needs SCOUT_ALLOW_BASE_WRITES', async () => {
  const payload = { parentOuId: 5, data: { anything: [1] }, importOuStructure: true };
  reset(); writeMode();
  await refused('unarmed (fail closed, payload not enumerable)', () => ouManageTool.execute({ action: 'structure_import', importPayload: payload }), /SCOUT_ALLOW_BASE_WRITES/);
  reset(); writeMode(); process.env.SCOUT_ALLOW_BASE_WRITES = 'true'; setProt();
  await refused('protected parent even when armed', () => ouManageTool.execute({ action: 'structure_import', importPayload: { ...payload, parentOuId: 8 } }));
  await refused('parent id vs ouRef disagree', () => ouManageTool.execute({ action: 'structure_import', ouRef: PROT, importPayload: payload }));
  await refused('unknown key in payload', () => ouManageTool.execute({ action: 'structure_import', importPayload: { ...payload, evil: true } }), /unexpected key/);
  await refused('dryRun inside the payload', () => ouManageTool.execute({ action: 'structure_import', importPayload: { ...payload, dryRun: false } }), /unexpected key/);
  await refused('no data', () => ouManageTool.execute({ action: 'structure_import', importPayload: { parentOuId: 5 } }), /data/);
  await refused('bad flag type', () => ouManageTool.execute({ action: 'structure_import', importPayload: { ...payload, importDevices: 'yes' } }), /boolean/);
  reset(); writeMode(); process.env.SCOUT_ALLOW_BASE_WRITES = 'true'; setProt();
  const r = await ouManageTool.execute({ action: 'structure_import', ouId: 5, dryRun: true, importPayload: payload });
  assert(!r.isError && sent() === 'POST /api/v1/ou/structure/import', `${sent()} ${text(r)}`);
  assert(JSON.stringify(writes[0]!.body) === '{"data":{"anything":[1]},"importOuStructure":true,"parentOuId":5,"dryRun":true}', JSON.stringify(writes[0]!.body));
});
await test('SCOUT_ENV=test: segment-prefix scope on the RESOLVED path, also id-only ("/X2" no longer passes for "/X")', async () => {
  assert(testScopeViolation('/MCP-Test2', 'Target OU') === null, 'no-op outside SCOUT_ENV=test');
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Imprivata';
  assert(testScopeViolation('/NorthCreek/Imprivata', 'x') === null && testScopeViolation('/northcreek/IMPRIVATA/sub', 'x') === null, 'inside');
  assert(testScopeViolation('/NorthCreek/Imprivata2', 'x') !== null && testScopeViolation('/NorthCreek/ImprivataX/a', 'x') !== null, 'sibling with same prefix is outside');
  reset(); writeMode();
  tree = () => renamed('SmartCard', 'Imprivata2'); // OU 6 = /NorthCreek/Imprivata2 (id-only target below)
  await refused('delete by id only, outside scope (prefix-sibling)', () => ouManageTool.execute({ action: 'delete', id: 6 }), /outside SCOUT_TEST_OU_PATH/);
  await refused('rename child of the prefix-sibling by id', () => ouManageTool.execute({ action: 'rename', id: 14, newname: 'q' }), /outside SCOUT_TEST_OU_PATH/);
  await refused('add under prefix-sibling destination by id', () => ouManageTool.execute({ action: 'add', name: 'n', destouid: 6 }), /outside SCOUT_TEST_OU_PATH/);
  const r = await ouManageTool.execute({ action: 'rename', id: 5, newname: 'x' });
  assert(!r.isError && writes.length === 1, `inside scope: ${text(r)}`);
});

// ── device.ts ─────────────────────────────────────────────────────────────────
console.log('\ndevice_manage: destination required, test scope on resolved id');
await test('add / move with no destination at all (and no working OU) -> refused gate-side, audited', async () => {
  reset(); writeMode();
  await refused('add', () => deviceManageTool.execute({ action: 'add', newDeviceName: 'n', newDeviceMac: '00:11:22:33:44:55' }), /destination OU/);
  await refused('move', () => deviceManageTool.execute({ action: 'move', name: 'thin01' }), /destination OU/);
});
await test('device add/move: destination by id only is test-scoped (prefix sibling refused)', async () => {
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Imprivata';
  reset(); writeMode();
  tree = () => renamed('SmartCard', 'Imprivata2');
  await refused('add dest id 6', () => deviceManageTool.execute({ action: 'add', newDeviceName: 'n', newDeviceMac: '00:11:22:33:44:55', destouid: 6 }), /outside SCOUT_TEST_OU_PATH/);
  await refused('move dest id 6', () => deviceManageTool.execute({ action: 'move', name: 'thin01', destouid: 6 }), /outside SCOUT_TEST_OU_PATH/);
});

// ── workflow.ts ───────────────────────────────────────────────────────────────
console.log('\nonboard_branch / bulk_command / move_devices_by_filter');
await test('onboard_branch: protected parent (path variants / id / disagree) refused; unprotected sends only destouid', async () => {
  reset(); writeMode(); setProt();
  for (const x of [{ parentOuPath: PROT }, { parentOuPath: '/northcreek/CUSTOMERS/' }, { parentOuId: 8 }, { parentOuId: 5, parentOuPath: PROT }]) {
    await refused(JSON.stringify(x), () => onboardBranchTool.execute({ name: 'Branch', ...x }));
  }
  reset(); writeMode(); setProt();
  const r = await onboardBranchTool.execute({ name: 'Branch', parentOuPath: '/northcreek/imprivata' });
  assert(!r.isError && sent() === 'POST /api/v1/ou?destouid=5&name=Branch', sent());
});
await test('onboard_branch: SCOUT_ENV=test scope runs on the resolved parent (id-only, prefix sibling refused)', async () => {
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Imprivata';
  reset(); writeMode();
  tree = () => renamed('SmartCard', 'Imprivata2');
  await refused('parent by id', () => onboardBranchTool.execute({ name: 'B', parentOuId: 6 }), /outside SCOUT_TEST_OU_PATH/);
});
await test('bulk_command: protected source (path variants / id / disagree / protected sub-OU under includeSubOus) refused; unprotected sends per-device commands', async () => {
  reset(); writeMode(); setProt();
  for (const x of [{ sourceOuPath: PROT }, { sourceOuPath: '/northcreek/customers' }, { sourceOuId: '8' }, { sourceOuId: '5', sourceOuPath: PROT }, { sourceOuPath: '/NorthCreek', includeSubOus: true }]) {
    await refused(JSON.stringify(x), () => bulkCommandTool.execute({ searchTerm: '*', command: 'restart', confirm: true, ...x }));
  }
  reset(); writeMode(); setProt();
  const r = await bulkCommandTool.execute({ sourceOuPath: '/northcreek/imprivata', searchTerm: '*', command: 'restart', confirm: true });
  assert(!r.isError && sent() === 'POST /api/v1/command/device/restart?name=thin01', `${sent()} ${text(r)}`);
});
const mv = (extra: Record<string, unknown> = {}) => ({ sourceOuPath: '/NorthCreek/AD', searchTerm: '*', confirm: true, ...extra });
await test('move_devices_by_filter: confirm prompt names the RESOLVED destination, not the raw input', async () => {
  reset(); writeMode();
  const prompts: string[] = [];
  const server = { getClientCapabilities: () => ({ elicitation: {} }), elicitInput: async (req: { message: string }) => { prompts.push(req.message); return { action: 'accept', content: { confirmed: true } }; } };
  const r = await moveDevicesByFilterTool.execute(mv({ destOuId: 5, destOuPath: '/northcreek//IMPRIVATA/' }), { server } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert(!r.isError && prompts.length === 1, text(r));
  assert(prompts[0]!.includes('"/NorthCreek/Imprivata" (OU id 5)') && !prompts[0]!.includes('IMPRIVATA'), prompts[0]!);
  assert(sent() === 'PUT /api/v1/device/move?name=thin01&destouid=5', sent());
});
await test('move_devices_by_filter: protected destination (id / variants / disagree) refused with no prompt and no move', async () => {
  reset(); writeMode(); setProt();
  const prompts: string[] = [];
  const server = { getClientCapabilities: () => ({ elicitation: {} }), elicitInput: async (req: { message: string }) => { prompts.push(req.message); return { action: 'accept', content: { confirmed: true } }; } };
  for (const x of [{ destOuId: 8 }, { destOuPath: '/northcreek/customers/' }, { destOuId: 5, destOuPath: PROT }]) {
    await refused(JSON.stringify(x), () => moveDevicesByFilterTool.execute(mv(x), { server } as any)); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  assert(prompts.length === 0, 'user is never asked to confirm a refused move');
});
await test('move_devices_by_filter: destination renamed mid-run -> remaining batches are NOT moved (re-asserted per batch)', async () => {
  reset(); writeMode();
  devices = Array.from({ length: 60 }, (_, i) => ({ Name: `thin${String(i).padStart(2, '0')}`, OUID: 10 }));
  // tree reads: dest gate(1), source gate(2), pre-loop assert(3), batch 2 (4), batch 3 (5 = first renamed read)
  tree = (n) => (n <= 4 ? LIVE : renamed('Imprivata', 'Moved'));
  const r = await moveDevicesByFilterTool.execute(mv({ destOuPath: '/NorthCreek/Imprivata', limit: 60, overrideBlastRadius: true }));
  const moves = writes.filter((w) => w.path.startsWith('/api/v1/device/move'));
  assert(!r.isError && /"status": "aborted"/.test(text(r)), text(r));
  assert(moves.length === 50, `moved exactly the first two batches (${moves.length})`);
});
await test('move_devices_by_filter: SCOUT_ENV=test scope on the resolved destination/source (id only, prefix sibling)', async () => {
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Imprivata';
  reset(); writeMode();
  tree = () => renamed('SmartCard', 'Imprivata2');
  await refused('dest id 6', () => moveDevicesByFilterTool.execute(mv({ sourceOuPath: '/NorthCreek/Imprivata', destOuId: 6 })), /outside SCOUT_TEST_OU_PATH/);
  await refused('source id 6', () => moveDevicesByFilterTool.execute(mv({ sourceOuPath: undefined, sourceOuId: '6', destOuPath: '/NorthCreek/Imprivata' })), /outside SCOUT_TEST_OU_PATH/);
});

// ── context.ts ────────────────────────────────────────────────────────────────
console.log('\nscout_context set_ou: name/path from the parsed tree');
await test('set_ou by id -> name/path from the tree rows (OUID/Name), never a numeric string', async () => {
  reset();
  const r = await contextTool.execute({ action: 'set_ou', id: 5 });
  assert(!r.isError, text(r));
  assert(getWorkingOu()?.name === 'Imprivata' && getWorkingOu()?.path === '/NorthCreek/Imprivata', JSON.stringify(getWorkingOu()));
  const r2 = await contextTool.execute({ action: 'set_ou', path: '/northcreek/smartcard/' });
  assert(!r2.isError && getWorkingOu()?.name === 'SmartCard' && getWorkingOu()?.path === '/NorthCreek/SmartCard', JSON.stringify(getWorkingOu()));
});
await test('set_ou: unknown id / disagreeing refs / unreadable tree -> error and NO working OU (fail soft)', async () => {
  reset();
  for (const x of [{ id: 9999 }, { id: 5, path: '/NorthCreek/SmartCard' }]) {
    clearWorkingOu();
    const r = await contextTool.execute({ action: 'set_ou', ...x });
    assert(r.isError === true && getWorkingOu() === null, `${JSON.stringify(x)}: ${text(r)}`);
  }
  tree = () => ({ nope: true });
  const r = await contextTool.execute({ action: 'set_ou', id: 5 });
  assert(r.isError === true && getWorkingOu() === null, text(r));
});

// ── Security round: F1 ancestors, F2 includeSubOus, F3/F4 test scope ───────────
console.log('\nSEC F1: ancestor of a protected OU is protected for subtree-affecting actions');
const CL = '/NorthCreek/Customers/CLALIT'; // OU 9, child of Customers (8), grandchild of NorthCreek (2)
const setCl = (): void => { process.env.SCOUT_PROTECTED_OUS = CL; };
await test('exact repro: protected=CLALIT; delete/rename/converttobase/move of PARENT id 8 and grandparent -> refused', async () => {
  reset(); writeMode(); setCl(); process.env.SCOUT_ALLOW_BASE_WRITES = 'true';
  await refused('delete 8', () => ouManageTool.execute({ action: 'delete', id: 8 }), /protected/);
  await refused('rename 8', () => ouManageTool.execute({ action: 'rename', id: 8, newname: 'x' }), /protected/);
  await refused('converttobase 8', () => ouManageTool.execute({ action: 'converttobase', id: 8 }), /protected/);
  await refused('move the ancestor 8', () => ouManageTool.execute({ action: 'move', id: 8, destouid: 5 }), /protected/);
  await refused('delete grandparent 2 by path', () => ouManageTool.execute({ action: 'delete', path: '/northcreek' }), /protected/);
  await refused('structure_import under ancestor 8', () => ouManageTool.execute({ action: 'structure_import', ouId: 8, importPayload: { data: {} } }), /protected/);
});
await test('non-protected sibling / unrelated OU still allowed; allow-list: ancestor of an allowed entry refused', async () => {
  reset(); writeMode(); setCl();
  let r = await ouManageTool.execute({ action: 'delete', id: 17 }); // DNIe, sibling of CLALIT
  assert(!r.isError && sent() === 'DELETE /api/v1/ou?id=17', `${sent()} ${text(r)}`);
  reset(); writeMode(); setCl();
  r = await ouManageTool.execute({ action: 'rename', id: 5, newname: 'x' });
  assert(!r.isError && writes.length === 1, text(r));
  reset(); writeMode(); process.env.SCOUT_ALLOWED_OUS = '/NorthCreek/Customers/CLALIT';
  await refused('delete ancestor of the allowed OU', () => ouManageTool.execute({ action: 'delete', id: 8 }));
});
await test('subtree-affecting fan-out: device_command/notification/bulk over an ancestor of a protected OU refused', async () => {
  reset(); writeMode(); setCl();
  await refused('device_command', () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '8', body: { includeSubOus: true } }));
  await refused('notification', () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 8, body: { includeSubOus: true } }));
  await refused('bulk', () => bulkCommandTool.execute({ sourceOuId: '8', searchTerm: '*', command: 'restart', confirm: true, includeSubOus: true }));
});

console.log('\nSEC F2: includeSubOus normalised strictly');
await test('every non-false variant triggers the subtree gate; the server gets a boolean', async () => {
  for (const v of [true, 1, '1', 'true', 'TRUE', 'yes', 'false', 0 as unknown, [], {}, ['x']]) {
    reset(); writeMode(); setCl();
    await refused(`device_command ${JSON.stringify(v)}`, () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '8', body: { includeSubOus: v } }));
    await refused(`notification ${JSON.stringify(v)}`, () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 8, body: { includeSubOus: v } }));
  }
  reset(); writeMode(); setCl();
  let r = await deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { includeSubOus: 'yes' } });
  assert(!r.isError && (writes[0]!.body as Record<string, unknown>)['includeSubOus'] === true, JSON.stringify(writes[0]?.body));
  reset(); writeMode(); setCl();
  r = await notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 17, body: { includeSubOus: 1 } });
  assert(!r.isError && (writes[0]!.body as Record<string, unknown>)['includeSubOus'] === true, JSON.stringify(writes[0]?.body));
  // explicit false / absent: no subtree gate
  reset(); writeMode(); setCl();
  r = await deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '8', body: { includeSubOus: false } });
  assert(!r.isError && (writes[0]!.body as Record<string, unknown>)['includeSubOus'] === false && /id=8/.test(writes[0]!.path), `${sent()} ${JSON.stringify(writes[0]?.body)}`);
  reset(); writeMode(); setCl();
  r = await bulkCommandTool.execute({ sourceOuId: '8', searchTerm: '*', command: 'restart', confirm: true });
  assert(!r.isError, text(r));
});

console.log('\nSEC F3/F4: config_update and device move source honour SCOUT_ENV=test');
await test('config_update target=ou outside SCOUT_TEST_OU_PATH refused (repro /MCP-Test vs /NorthCreek/Customers)', async () => {
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/MCP-Test';
  reset(); writeMode();
  await refused('by path', () => configUpdateTool.execute({ target: 'ou', section: 'network', body: {}, confirm: true, skipValidation: true, ouPath: '/NorthCreek/Customers' }), /outside SCOUT_TEST_OU_PATH/);
  await refused('by id', () => configUpdateTool.execute({ target: 'ou', section: 'network', body: {}, confirm: true, skipValidation: true, ouId: 8 }), /outside SCOUT_TEST_OU_PATH/);
});
await test('device_manage move: SOURCE OU outside the test scope refused', async () => {
  process.env.SCOUT_ENV = 'test'; process.env.SCOUT_TEST_OU_PATH = '/NorthCreek/Imprivata';
  reset(); writeMode(); // device thin01 lives in OU 10 (/NorthCreek/AD); destination in scope
  await refused('move', () => deviceManageTool.execute({ action: 'move', name: 'thin01', destouid: 5 }), /Source OU/);
});

console.log('\nSEC F6: OU-ish body keys stripped case/separator-insensitively; F7: config_update subtree gate');
await test('F6 repro: IncludeSubOus / includesubous / INCLUDESUBOUS with ouRef=8 -> subtree gate applies (refused)', async () => {
  for (const k of ['IncludeSubOus', 'includesubous', 'INCLUDESUBOUS', 'include_sub_ous', 'Include-Sub-Ous']) {
    reset(); writeMode(); setCl();
    await refused(`device_command ${k}`, () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '8', body: { [k]: true } }));
    await refused(`notification ${k}`, () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 8, body: { [k]: 'yes' } }));
  }
});
await test('F6/F9: body OU keys naming a DIFFERENT OU than the gated one -> refused (device_command, notification); agreeing ones dropped', async () => {
  for (const extra of [{ OUID: 9 }, { ouid: 9 }, { ouPATH: CL }, { Dest_OU_Id: 9, destOuId: 9, TargetOu: 9, GroupID: 9, Path: CL, id: 9, OU: 9 }]) {
    reset(); writeMode(); setCl();
    await refused(`device_command ${JSON.stringify(extra)}`, () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { keep: 1, ...extra } }));
    await refused(`notification ${JSON.stringify(extra)}`, () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 17, body: { keep: 1, ...extra } }));
  }
  // same OU (17 = /NorthCreek/Customers/DNIe) under many spellings: dropped, only the canonical id is sent
  const agree = { Dest_OU_Id: 17, destOuId: '17', TargetOu: 17, GroupID: 17, Path: '/northcreek/customers/dnie', id: 17, OU: 17, OUID: 17 };
  reset(); writeMode(); setCl();
  const r = await deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { keep: 1, ...agree } });
  assert(!r.isError && JSON.stringify(writes[0]?.body) === '{"keep":1,"ouId":17}', `${text(r)} ${JSON.stringify(writes[0]?.body)}`);
  reset(); writeMode(); setCl();
  const n = await notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 17, body: { keep: 1, ...agree } });
  assert(!n.isError && JSON.stringify(writes[0]?.body) === '{"keep":1}', `${text(n)} ${JSON.stringify(writes[0]?.body)}`);
});
await test('F6: bulk_command strips OU-ish keys from commandBody; a key naming another OU is refused', async () => {
  reset(); writeMode(); setCl();
  const r = await bulkCommandTool.execute({ sourceOuPath: '/NorthCreek/Imprivata', searchTerm: '*', command: 'restart', confirm: true, commandBody: { keep: 1, OUID: 5, IncludeSubOus: true, ou_path: '/northcreek/imprivata' } });
  assert(!r.isError && JSON.stringify(writes[0]?.body) === '{"keep":1}', JSON.stringify(writes[0]?.body));
  reset(); writeMode(); setCl();
  await refused('other OU', () => bulkCommandTool.execute({ sourceOuPath: '/NorthCreek/Imprivata', searchTerm: '*', command: 'restart', confirm: true, commandBody: { OUID: 9 } }));
});

console.log('\nSEC F8/F9: app_manage create body + robust key normaliser');
await test('F8 repro: app_manage create scope=ou ouId=17 body {ouId:9, OU:9, includeSubOus:true} -> refused (names OU 9); agreeing keys dropped', async () => {
  reset(); writeMode(); setCl();
  await refused('F8 exact repro', () => appManageTool.execute({ action: 'create', scope: 'ou', applicationType: 'citrix', ouId: 17, body: { ouId: 9, OU: 9, includeSubOus: true } }));
  reset(); writeMode(); setCl();
  const r = await appManageTool.execute({ action: 'create', scope: 'ou', applicationType: 'citrix', ouId: 17, body: { name: 'app', ouId: 17, OU: '17', includeSubOus: true, path: 'C:\\x', id: 3, nested: { OUID: 17 } } });
  assert(!r.isError && sent() === 'POST /api/v1/applications/ou/citrix?id=17', `${sent()} ${text(r)}`);
  assert(JSON.stringify(writes[0]!.body) === '{"name":"app","path":"C:\\\\x","id":3,"nested":{}}', JSON.stringify(writes[0]!.body));
});
await test('F9: key variants (tab, zero-width, NBSP, fullwidth, ou.id, ou[id], ouIds, parentOuId, sourceOuId, targetOUId, organizationalUnit, nested, arrays) naming another OU are refused', async () => {
  const keys = ['\tOUID', 'ou\u200bId', 'ou\u00a0id', '\uff4f\uff55\uff49\uff44', 'ou.id', 'ou[id]', 'ouIds', 'parentOuId', 'sourceOuId', 'targetOUId', 'organizationalUnit', 'organizationalUnitId', 'Ou_Path', 'destinationOu'];
  for (const k of keys) {
    const v = k.toLowerCase().includes('path') ? CL : 9;
    reset(); writeMode(); setCl();
    await refused(`command ${JSON.stringify(k)}`, () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { [k]: v } }));
    await refused(`notification ${JSON.stringify(k)}`, () => notificationManageTool.execute({ action: 'set', target: 'ou', type: 'delivery', ouId: 17, body: { [k]: v } }));
    await refused(`app create ${JSON.stringify(k)}`, () => appManageTool.execute({ action: 'create', scope: 'ou', applicationType: 'x', ouId: 17, body: { [k]: v } }));
  }
  reset(); writeMode(); setCl();
  await refused('nested object', () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { a: { b: { ouId: 9 } } } }));
  await refused('array of objects', () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { list: [{ targetOu: 9 }] } }));
  await refused('array value', () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { ouIds: [17, 9] } }));
  await refused('unknown OU value fails closed', () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body: { ouName: 'does-not-exist' } }));
});
await test('F9: variants naming the SAME OU are dropped; prototype keys dropped; includeSubOus variants (zero-width/fullwidth) still gate', async () => {
  reset(); writeMode(); setCl();
  const body = JSON.parse('{"keep":1,"__proto__":{"ouId":9},"constructor":{"x":1},"ou.id":17,"ou[id]":17,"parentOuId":17}');
  const r = await deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '17', body });
  assert(!r.isError && JSON.stringify(writes[0]?.body) === '{"keep":1,"ouId":17}', `${text(r)} ${JSON.stringify(writes[0]?.body)}`);
  for (const k of ['include\u200bSubOus', '\uff29ncludeSubOus', 'include.sub.ous', 'INCLUDE_SUB_OUS']) {
    reset(); writeMode(); setCl();
    await refused(`subtree ${JSON.stringify(k)}`, () => deviceCommandTool.execute({ target: 'ou', command: 'restart', ouRef: '8', body: { [k]: true } }));
  }
});

await test('F7: config_update on an ANCESTOR of a protected OU refused (id 8, grandparent by path); sibling allowed; allow-list ancestor refused', async () => {
  const cfg2 = (extra: Record<string, unknown>) => ({ target: 'ou', section: 'network', body: {}, confirm: true, skipValidation: true, ...extra });
  reset(); writeMode(); setCl();
  await refused('ancestor id 8', () => configUpdateTool.execute(cfg2({ ouId: 8 })), /protected/);
  await refused('grandparent by path', () => configUpdateTool.execute(cfg2({ ouPath: '/northcreek' })), /protected/);
  reset(); writeMode(); setCl();
  let r = await configUpdateTool.execute(cfg2({ ouId: 17 })); // sibling DNIe
  assert(!r.isError && writes.length === 1, text(r));
  reset(); writeMode(); setCl();
  r = await configUpdateTool.execute(cfg2({ ouId: 5 }));
  assert(!r.isError && writes.length === 1, text(r));
  reset(); writeMode(); process.env.SCOUT_ALLOWED_OUS = CL;
  await refused('ancestor of the allowed OU', () => configUpdateTool.execute(cfg2({ ouId: 8 })));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
