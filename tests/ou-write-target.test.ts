/**
 * Security re-verification round (N1-N5): the gated OU and the written OU must be the same by
 * construction (all references resolved + must agree; requests carry only the resolved id),
 * path re-assert right before the write, audit entries for invalid-path refusals, malformed env
 * entries named in the error, NFC normalisation. Client methods are instance-patched (no network).
 * Run: npx tsx tests/ou-write-target.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSessionConfig } from '../src/session.js';
import { getClient } from '../src/client.js';
import { invalidateOuCache } from '../src/resolver.js';
import { checkOuWriteAllowed, __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';
import { ouManageTool } from '../src/tools/ou.js';
import { deviceManageTool } from '../src/tools/device.js';
import { configUpdateTool } from '../src/tools/config.js';
import { moveDevicesByFilterTool } from '../src/tools/workflow.js';

setSessionConfig({ baseUrl: 'https://fake-scout-board.invalid:22160', username: 'u', password: 'p' });
const AUDIT = join(mkdtempSync(join(tmpdir(), 'scout-wt-')), 'audit.log');
process.env.SCOUT_AUDIT_LOG_PATH = AUDIT;
process.env.SCOUT_KILL_SWITCH_FILE = join(tmpdir(), 'scout-wt-no-kill-switch');
process.env.SCOUT_SNAPSHOT_DIR = join(tmpdir(), 'scout-wt-snapshots');

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, 'fixtures', 'ou-structure-live.json'), 'utf8'));
const renamed = (from: string, to: string) => JSON.parse(JSON.stringify(LIVE).replace(`"Name":"${from}"`, `"Name":"${to}"`));

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

let structureFetches = 0;
let tree: (n: number) => unknown = () => LIVE;
const writes: string[] = [];
const c = getClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
c.request = async (method: string, path: string) => {
  if (method !== 'GET') { writes.push(`${method} ${path}`); return { ok: true }; }
  if (path.startsWith('/api/v1/ou/structure')) return tree(++structureFetches);
  if (path.startsWith('/api/v1/ou/root')) return { OUID: 2, OUPath: '/NorthCreek' };
  if (path.startsWith('/api/v1/device/search')) return { response: { status: { msg: { visibleDevices: [{ Name: 'thin01', OUID: 10 }], hiddenDevices: 0 } } } };
  if (path.startsWith('/api/v1/device?')) return { OUID: 10, Name: 'thin01' };
  return {};
};
const reset = (): void => { tree = () => LIVE; structureFetches = 0; writes.length = 0; };
const writeMode = (): void => { process.env.SCOUT_MODE = 'write'; };
const cfg = (extra: Record<string, unknown>) =>
  ({ target: 'ou', section: 'network', body: {}, confirm: true, skipValidation: true, ...extra });
const auditText = (): string => readFileSync(AUDIT, 'utf8');

console.log('\nN1 config_update: gated OU == written OU');
const PROT = '/NorthCreek/Customers'; // OU 8; OU 5 = /NorthCreek/Imprivata (unprotected)
await test('EXACT REPRO: ouId=<allowed> + ouPath=<protected> -> refused, no POST', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  const r = await configUpdateTool.execute(cfg({ ouId: 5, ouPath: PROT }));
  assert(r.isError === true && writes.length === 0, `refused, writes=${writes.join('|')}: ${r.content[0]?.text}`);
  assert(/different OUs/.test(r.content[0]!.text), 'refused for conflicting references');
});
await test('path-only protected -> refused; id-only protected -> refused; both consistent protected -> refused', async () => {
  for (const extra of [{ ouPath: PROT }, { ouId: 8 }, { ouId: 8, ouPath: '/northcreek/CUSTOMERS' }]) {
    reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
    const r = await configUpdateTool.execute(cfg(extra));
    assert(r.isError === true && writes.length === 0, `${JSON.stringify(extra)} refused: ${r.content[0]?.text}`);
  }
});
await test('unprotected: path-only / id-only / both-consistent are written, and ONLY ?id=<resolved> is sent', async () => {
  for (const extra of [{ ouPath: '/northcreek/imprivata' }, { ouId: 5 }, { ouId: 5, ouPath: '/NorthCreek/Imprivata' }]) {
    reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
    const r = await configUpdateTool.execute(cfg(extra));
    assert(!r.isError && writes.length === 1, `${JSON.stringify(extra)}: ${r.content[0]?.text}`);
    assert(writes[0]!.endsWith('/api/v1/configuration/ou/network?id=5'), `only id sent: ${writes[0]}`);
  }
});

console.log('\nN1 ou_manage / device_manage: same rule');
await test('ou_manage delete id=5 + protected path -> refused; consistent -> DELETE carries only id', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  let r = await ouManageTool.execute({ action: 'delete', id: 5, path: PROT, confirm: true });
  assert(r.isError === true && writes.length === 0, 'mismatch refused');
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  r = await ouManageTool.execute({ action: 'delete', id: 5, path: '/northcreek/Imprivata', confirm: true });
  assert(!r.isError && writes.length === 1 && writes[0] === 'DELETE /api/v1/ou?id=5', `got ${writes[0]}`);
});
await test('ou_manage move: destination id + protected destoupath mismatch refused; write carries only ids', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  let r = await ouManageTool.execute({ action: 'move', path: '/NorthCreek/Imprivata', destouid: 5, destoupath: PROT, confirm: true });
  assert(r.isError === true && writes.length === 0, 'refused');
  reset(); writeMode();
  r = await ouManageTool.execute({ action: 'move', path: '/NorthCreek/Imprivata', destoupath: '/NorthCreek/SmartCard', confirm: true });
  assert(!r.isError && writes[0] === 'PUT /api/v1/ou/move?id=5&destouid=6', `got ${writes[0]}`);
});
await test('device_manage move: destouid + protected destoupath mismatch refused; write carries only destouid', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  let r = await deviceManageTool.execute({ action: 'move', name: 'thin01', destouid: 5, destoupath: PROT });
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
  reset(); writeMode();
  r = await deviceManageTool.execute({ action: 'move', name: 'thin01', destoupath: '/NorthCreek/Imprivata' });
  assert(!r.isError && writes[0] === 'PUT /api/v1/device/move?name=thin01&destouid=5', `got ${writes[0]}`);
});

console.log('\nN2 path re-asserted immediately before the write');
await test('ou_manage: OU renamed between gate and write -> refused, no write', async () => {
  reset(); writeMode();
  tree = (n) => (n === 1 ? LIVE : renamed('Imprivata', 'Moved'));
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Imprivata', confirm: true });
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
  assert(/no longer has the path/.test(r.content[0]!.text), 'path-changed refusal');
});
await test('config_update: OU renamed after the gate/prompt -> refused, no POST', async () => {
  reset(); writeMode();
  let calls = 0;
  tree = () => (++calls <= 3 ? LIVE : renamed('Imprivata', 'Moved')); // gate, count, recheck-before-count OK; final recheck sees rename
  const r = await configUpdateTool.execute(cfg({ ouId: 5 }));
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
});
await test('device_manage move: destination renamed between gate and write -> refused', async () => {
  reset(); writeMode();
  tree = (n) => (n <= 2 ? LIVE : renamed('Imprivata', 'Moved'));
  const r = await deviceManageTool.execute({ action: 'move', name: 'thin01', destoupath: '/NorthCreek/Imprivata' });
  assert(r.isError === true && writes.length === 0, `refused: ${r.content[0]?.text}`);
});

console.log('\nN3/N4 invalid paths are audited; malformed env entries are named');
await test("ou_manage with '..' path: refused AND audit entry gate=protected-ou", async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  const before = auditText().length;
  const r = await ouManageTool.execute({ action: 'delete', path: '/NorthCreek/Imprivata/../Customers', confirm: true });
  assert(r.isError === true && writes.length === 0, 'refused');
  const added = auditText().slice(before);
  assert(/"gate":"protected-ou"/.test(added) && /\.\./.test(added), `audit entry written: ${added}`);
});
await test("config_update / device_manage with '..' refs: audited refusals", async () => {
  reset(); writeMode();
  let before = auditText().length;
  let r = await configUpdateTool.execute(cfg({ ouPath: '/NorthCreek/./Imprivata' }));
  assert(r.isError === true && /"gate":"protected-ou"/.test(auditText().slice(before)), 'config audited');
  before = auditText().length;
  r = await deviceManageTool.execute({ action: 'move', name: 'thin01', destoupath: '/NorthCreek/../SKY' });
  assert(r.isError === true && /"gate":"protected-ou"/.test(auditText().slice(before)), 'device audited');
});
for (const [envVar, bad] of [['SCOUT_PROTECTED_OUS', '/A/..'], ['SCOUT_ALLOWED_OUS', '/NorthCreek/\u0007x']] as const) {
  await test(`malformed ${envVar} entry ${JSON.stringify(bad)}: message names the variable + entry, audited`, () => {
    process.env[envVar] = bad;
    const before = auditText().length;
    let msg = '';
    try { checkOuWriteAllowed({ targetPath: '/NorthCreek/Imprivata' }); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes(envVar) && msg.includes(JSON.stringify(bad).slice(1, -1).replace('\\u0007', '\\u0007')) , `names var+entry: ${msg}`);
    assert(!msg.includes('/NorthCreek/Imprivata'), 'does not blame the target path');
    assert(/"gate":"protected-ou"/.test(auditText().slice(before)), 'audited');
  });
}

console.log('\nN5 NFC normalisation');
await test('NFD env entry protects the NFC-named OU (and vice versa)', () => {
  const nfc = '/NorthCreek/Café';
  const nfd = '/NorthCreek/Café';
  process.env.SCOUT_PROTECTED_OUS = nfd;
  let blocked = false; try { checkOuWriteAllowed({ targetPath: nfc }); } catch { blocked = true; }
  assert(blocked, 'NFC candidate blocked by NFD entry');
  process.env.SCOUT_PROTECTED_OUS = nfc;
  blocked = false; try { checkOuWriteAllowed({ targetPath: nfd }); } catch { blocked = true; }
  assert(blocked, 'NFD candidate blocked by NFC entry');
});

console.log('\nN1 move_devices_by_filter destination (re-verification round 3)');
const mv = (extra: Record<string, unknown>) =>
  ({ sourceOuPath: '/NorthCreek/AD', searchTerm: '*', confirm: true, ...extra });
const moves = (): string[] => writes.filter((w) => w.startsWith('PUT /api/v1/device/move'));
await test('protected destination via path variant (case/slashes) -> refused, no move', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  for (const destOuPath of [PROT, '/northcreek/CUSTOMERS/', ' //NorthCreek//Customers ']) {
    const r = await moveDevicesByFilterTool.execute(mv({ destOuPath }));
    assert(r.isError === true && moves().length === 0, `${destOuPath} refused, moves=${moves().join('|')}: ${r.content[0]?.text}`);
  }
});
await test('protected destination via id -> refused, no move', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  const r = await moveDevicesByFilterTool.execute(mv({ destOuId: 8 }));
  assert(r.isError === true && moves().length === 0, `refused: ${r.content[0]?.text}`);
});
await test('protected child via id (descendant of protected) -> refused', async () => {
  reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
  const r = await moveDevicesByFilterTool.execute(mv({ destOuId: 9 }));
  assert(r.isError === true && moves().length === 0, `refused: ${r.content[0]?.text}`);
});
await test('mixed disagreeing refs (allowed id + protected path, and reverse) -> refused, no move', async () => {
  for (const extra of [{ destOuId: 5, destOuPath: PROT }, { destOuId: 8, destOuPath: '/NorthCreek/Imprivata' }]) {
    reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
    const r = await moveDevicesByFilterTool.execute(mv(extra));
    assert(r.isError === true && moves().length === 0, `${JSON.stringify(extra)} refused: ${r.content[0]?.text}`);
    assert(/different OUs/.test(r.content[0]!.text), 'refused for disagreement');
  }
});
await test('consistent unprotected (path / id / both) -> moves; request carries ONLY destouid=<resolved>', async () => {
  for (const extra of [{ destOuPath: '/northcreek/imprivata' }, { destOuId: 5 }, { destOuId: 5, destOuPath: '/NorthCreek/Imprivata' }]) {
    reset(); writeMode(); process.env.SCOUT_PROTECTED_OUS = PROT;
    const r = await moveDevicesByFilterTool.execute(mv(extra));
    assert(!r.isError && moves().length === 1, `${JSON.stringify(extra)}: ${r.content[0]?.text}`);
    assert(moves()[0] === 'PUT /api/v1/device/move?name=thin01&destouid=5', `only resolved id sent: ${moves()[0]}`);
  }
});
await test('destination renamed after the gate -> refused, no move', async () => {
  reset(); writeMode();
  tree = (n) => (n <= 1 ? LIVE : renamed('Imprivata', 'Moved'));
  const r = await moveDevicesByFilterTool.execute(mv({ destOuPath: '/NorthCreek/Imprivata' }));
  assert(r.isError === true && moves().length === 0, `refused: ${r.content[0]?.text}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
