/**
 * Unit tests for the "fix existing tools" round (SBD-UI review findings):
 *   - client 401 policy (one re-login at most, rights denials never re-login, fresh token never re-logins,
 *     clear final message, other denial codes carry the server body message)
 *   - admin_manage: POST /admins/add, POST /admins/modify, DELETE /admins?adminName= (+ gates, audit)
 *   - system_settings set_recovery_settings: POST /recoverySettings
 *   - db_cleanup: POST {filter:[{id,from,to}]}, ADMIN_LOGS hard gate
 *   - ou_filter_manage: FilterType 4 + length caps, types 1/2 mapping unchanged
 *   - health_check: body-level error becomes an error result
 *   - device delete/move post-condition (dropped ids reported)
 *
 * Offline only: an in-process HTTPS stand-in. Run with: npx tsx tests/fix-existing-tools.test.ts
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { setSessionConfig, clearSessionConfig } from '../src/session.js';
import { resetCircuitBreaker } from '../src/safety/guardrails.js';
import { ScoutClient, ScoutError, extractServerMessage, isRightsDenialBody } from '../src/client.js';
import { adminManageTool } from '../src/tools/admins.js';
import { dbCleanupTool, parseCleanupFilter } from '../src/tools/db_cleanup.js';
import { systemSettingsTool } from '../src/tools/system_settings.js';
import {
  buildFilterWireEntry,
  MAX_EXPRESSION_LENGTH,
  MAX_CONDITION_LENGTH,
  MAX_RULE_ENVELOPE_LENGTH,
} from '../src/tools/ou_filtering.js';
import { healthCheckTool, assessHealthBody } from '../src/tools/health.js';
import { deviceManageTool } from '../src/tools/device.js';
import { assessDeviceWriteResult } from '../src/device_result.js';

// ─── harness ──────────────────────────────────────────────────────────────────

const results: Array<{ name: string; ok: boolean }> = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  resetCircuitBreaker(); // each test is its own scenario; the breaker is covered in guardrails tests
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: boolean, m: string): asserts c {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}
function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0]?.text ?? '';
}

// ─── fake server ──────────────────────────────────────────────────────────────

function ouNode(id: number, name: string, parent: number, children: unknown[] = []): Record<string, unknown> {
  return { OUID: id, Name: name, count: 0, DeviceCount: 0, ParentID: parent, UseParent: 1, children };
}
const OU_TREE = {
  code: 200,
  message: 'OK',
  response: {
    status: { result: 0, msg: { treeStructure: [ouNode(1, 'Root', -1, [ouNode(3, 'A', 1), ouNode(4, 'B', 1)])] } },
  },
};

interface Rec {
  method: string;
  path: string;
  query: string;
  body: string;
}
let recorded: Rec[] = [];
type Reply = { status: number; body: unknown };
let apiReply: (n: number, rec: Rec) => Reply = () => ({ status: 200, body: { message: 'OK' } });
let apiCalls = 0;
let logins = 0;

function fakeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
  return `h.${payload}.s`;
}

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'scout-mcp-fix-certs-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return new Promise((resolve) => {
    const server = createServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const u = new URL(req.url ?? '/', 'https://localhost');
          const rec: Rec = {
            method: req.method ?? 'GET',
            path: u.pathname,
            query: u.search,
            body: Buffer.concat(chunks).toString('utf-8'),
          };
          res.setHeader('Content-Type', 'application/json');
          if (u.pathname === '/rest/auth/v1/login') {
            logins += 1;
            res.end(JSON.stringify({ token: fakeJwt() }));
            return;
          }
          // The OU write gate resolves OUs from a fresh tree; serve it without recording it, so the
          // tests below still see exactly the mutating/driven calls.
          if (u.pathname === '/rest/api/v1/ou/structure' && rec.method === 'GET') {
            res.end(JSON.stringify(OU_TREE));
            return;
          }
          recorded.push(rec);
          apiCalls += 1;
          const r = apiReply(apiCalls, rec);
          res.statusCode = r.status;
          res.end(JSON.stringify(r.body));
        });
      },
    );
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, baseUrl: `https://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });
}

function reset(): void {
  recorded = [];
  apiCalls = 0;
  logins = 0;
  apiReply = () => ({ status: 200, body: { message: 'OK' } });
}

const ENV_KEYS = [
  'SCOUT_MODE',
  'SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION',
  'SCOUT_ALLOW_AUDIT_PURGE',
  'SCOUT_AUDIT_LOG_PATH',
  'SCOUT_ENV',
];

async function main(): Promise<void> {
  const { server, baseUrl } = await startServer();
  const auditPath = join(mkdtempSync(join(tmpdir(), 'scout-mcp-fix-audit-')), 'audit.log');
  process.env.SCOUT_AUDIT_LOG_PATH = auditPath;
  const cfg = { baseUrl, username: 'u', password: 'p', ignoreTls: true };
  const newClient = () => new ScoutClient(cfg);
  const auditLines = (): Array<Record<string, unknown>> =>
    existsSync(auditPath)
      ? readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  // ── 1. client 401 policy ────────────────────────────────────────────────────
  console.log('\nClient 401 / denial handling');

  await test('pure helpers: extractServerMessage / isRightsDenialBody', () => {
    assert(
      extractServerMessage({ message: 'not OK', response: { status: { result: 2, msg: 'not allowed action' } } }) === 'not allowed action',
      'nested status.msg preferred over generic "not OK"',
    );
    assert(extractServerMessage({ message: 'not OK', response: 'Internal server error' }) === 'Internal server error', 'string response');
    assert(extractServerMessage({ message: 'OK' }) === undefined, '"OK" ignored');
    assert(extractServerMessage({ message: 'Forbidden', response: { message: 'This route is not declared' } }) === 'Forbidden: This route is not declared', 'top + nested');
    assert(isRightsDenialBody({ response: { status: { msg: 'not allowed action' } } }), 'denial shape');
    assert(!isRightsDenialBody({ message: 'jwt expired' }), 'expiry is not denial');
  });

  await test('expired token (401 expiry body) -> exactly one re-login + retry, succeeds', async () => {
    reset();
    apiReply = (n) => (n === 1 ? { status: 401, body: { code: 401, message: 'Unauthorized' } } : { status: 200, body: { ok: 1 } });
    const c = newClient();
    await c.login();
    const out = await c.request<{ ok: number }>('GET', '/api/v1/ping');
    assert(out.ok === 1, 'retry succeeded');
    assert(logins === 2 && apiCalls === 2, `logins=${logins} apiCalls=${apiCalls}`);
  });

  await test('401 persists after the re-login -> stops (never loops), clear final message', async () => {
    reset();
    apiReply = () => ({ status: 401, body: { code: 401, message: 'Unauthorized' } });
    const c = newClient();
    await c.login();
    let err: unknown;
    try {
      await c.request('GET', '/api/v1/ping');
    } catch (e) {
      err = e;
    }
    assert(err instanceof ScoutError && err.statusCode === 401, 'ScoutError 401');
    assert(err.message.includes('access denied or session invalid'), err.message);
    assert(err.message.includes('rights denials'), err.message);
    assert(logins === 2 && apiCalls === 2, `exactly one re-login: logins=${logins} apiCalls=${apiCalls}`);
  });

  await test('rights-denial 401 body (not allowed action) -> no re-login, no replay', async () => {
    reset();
    apiReply = () => ({ status: 401, body: { code: 401, message: 'not OK', response: { status: { result: 2, msg: 'not allowed action' } } } });
    const c = newClient();
    await c.login();
    let err: unknown;
    const prevMode = process.env.SCOUT_MODE;
    process.env.SCOUT_MODE = 'write'; // N6: an undeclared DELETE is now mode-gated; this test is about 401 handling
    try {
      await c.request('DELETE', '/api/v1/device?id=1');
    } catch (e) {
      err = e;
    } finally {
      if (prevMode === undefined) delete process.env.SCOUT_MODE;
      else process.env.SCOUT_MODE = prevMode;
    }
    assert(err instanceof ScoutError, 'ScoutError');
    assert(err.message.includes('not allowed action') && err.message.includes('rights denials'), err.message);
    assert(logins === 1 && apiCalls === 1, `no re-login/replay: logins=${logins} apiCalls=${apiCalls}`);
  });

  await test('token minted by this very call -> a 401 is not answered with another login', async () => {
    reset();
    apiReply = () => ({ status: 401, body: { code: 401, message: 'Unauthorized' } });
    const c = newClient(); // no explicit login: ensureAuth logs in inside request()
    let err: unknown;
    try {
      await c.request('GET', '/api/v1/ou');
    } catch (e) {
      err = e;
    }
    assert(err instanceof ScoutError && err.message.includes('access denied or session invalid'), 'clear error');
    assert(logins === 1 && apiCalls === 1, `logins=${logins} apiCalls=${apiCalls}`);
  });

  await test('rawRequest follows the same policy (retry once, then clear error with private hint)', async () => {
    reset();
    apiReply = () => ({ status: 401, body: { message: 'Unauthorized' } });
    const c = newClient();
    await c.login();
    let err: unknown;
    try {
      await c.rawRequest('GET', '/api/v1/admins');
    } catch (e) {
      err = e;
    }
    assert(err instanceof ScoutError && err.statusCode === 401, 'ScoutError 401');
    assert(err.message.includes('access denied or session invalid') && err.message.includes('private'), err.message);
    assert(logins === 2 && apiCalls === 2, `logins=${logins} apiCalls=${apiCalls}`);
  });

  for (const [status, body, expect] of [
    [405, { code: 405, message: 'Unauthorized', response: { message: 'You do not have permission to perform this action' } }, 'You do not have permission'],
    [403, { code: 403, message: 'Forbidden', response: { message: 'This route is not declared and is therefore denied' } }, 'not declared'],
    [400, { code: 400, message: 'not OK', response: { status: { result: 1, msg: 'invalid input parameter' } } }, 'invalid input parameter'],
    [400, { code: 406, message: 'not OK', response: 'Internal server error' }, 'Internal server error'],
    [503, { message: 'Service Unavailable', response: { message: 'Maintenance window active' } }, 'Maintenance window active'],
    [402, { message: 'Payment Required', response: { message: 'license invalid' } }, 'license invalid'],
    [423, { message: 'Locked', response: { message: 'locked by another session' } }, 'locked by another session'],
  ] as Array<[number, unknown, string]>) {
    await test(`HTTP ${status} is reported with the server body message (request + rawRequest)`, async () => {
      reset();
      apiReply = () => ({ status, body });
      const c = newClient();
      await c.login();
      for (const call of [() => c.request('GET', '/api/v1/x'), () => c.rawRequest('GET', '/api/v1/x')]) {
        let err: unknown;
        try {
          await call();
        } catch (e) {
          err = e;
        }
        assert(err instanceof ScoutError && err.statusCode === status, `status ${status}`);
        assert(err.message.includes(expect), `message "${err.message}" should include "${expect}"`);
      }
      assert(logins === 1, 'non-401 never re-logs-in');
    });
  }

  // ── tool-level tests use the global client against the fake server ──────────
  clearSessionConfig();
  setSessionConfig(cfg);

  console.log('\nadmin_manage (privilege-sensitive write)');
  process.env.SCOUT_MODE = 'write';
  process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';

  await test('add_admin -> POST /api/v1/admins/add {Name, fullAccess, toBeDuplicatedAdmin}', async () => {
    reset();
    const r = await adminManageTool.execute({ action: 'add_admin', name: 'DOM\\bob', full_access: false, duplicate_from: 'alice', confirm: true });
    assert(!r.isError, text(r));
    const rec = recorded[0]!;
    assert(rec.method === 'POST' && rec.path === '/api/v1/admins/add', `${rec.method} ${rec.path}`);
    const b = JSON.parse(rec.body) as Record<string, unknown>;
    assert(b['Name'] === 'DOM\\bob' && b['fullAccess'] === false && b['toBeDuplicatedAdmin'] === 'alice', rec.body);
    assert(!('password' in b) && !('username' in b), 'no password/username fields');
    assert(auditLines().some((l) => l['opName'] === 'admin_manage(add_admin)' && l['target'] === 'DOM\\bob' && l['result'] === 'allowed'), 'audit entry written');
  });

  await test('add_admin without confirm is refused (no HTTP)', async () => {
    reset();
    const r = await adminManageTool.execute({ action: 'add_admin', name: 'x' });
    assert(r.isError === true && text(r).includes('blocked'), text(r));
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('add_admin with legacy password/email fields is rejected, not silently dropped', async () => {
    reset();
    const r = await adminManageTool.execute({ action: 'add_admin', name: 'x', password: 'p', confirm: true });
    assert(r.isError === true && text(r).includes('password'), text(r));
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('update_admin -> POST /api/v1/admins/modify {AdministratorID, RootOu, menuRightsArray}', async () => {
    reset();
    const r = await adminManageTool.execute({
      action: 'update_admin',
      admin_id: 7,
      root_ou: 3,
      menu_rights: [{ Id: 141, Value: 1 }],
      confirm: true,
    });
    assert(!r.isError, text(r));
    const rec = recorded[0]!;
    assert(rec.method === 'POST' && rec.path === '/api/v1/admins/modify', `${rec.method} ${rec.path}`);
    const b = JSON.parse(rec.body) as Record<string, unknown>;
    assert(b['AdministratorID'] === 7 && b['RootOu'] === 3 && Array.isArray(b['menuRightsArray']), rec.body);
  });

  await test('update_admin with nothing to change / without confirm is refused', async () => {
    reset();
    const r1 = await adminManageTool.execute({ action: 'update_admin', admin_id: 7, confirm: true });
    assert(r1.isError === true, 'needs a change');
    const r2 = await adminManageTool.execute({ action: 'update_admin', admin_id: 7, root_ou: 1 });
    assert(r2.isError === true, 'needs confirm');
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('delete_admin -> DELETE /api/v1/admins?adminName=<name>', async () => {
    reset();
    const r = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'DOM\\bob', confirm: true });
    assert(!r.isError, text(r));
    const rec = recorded[0]!;
    assert(rec.method === 'DELETE' && rec.path === '/api/v1/admins', `${rec.method} ${rec.path}`);
    assert(rec.query === '?adminName=DOM%5Cbob', rec.query);
  });

  await test('delete_admin without confirm / without admin_name is refused', async () => {
    reset();
    const r1 = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'x' });
    const r2 = await adminManageTool.execute({ action: 'delete_admin', confirm: true });
    assert(r1.isError === true && r2.isError === true, 'both refused');
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('admin writes: read-only blocks, dry-run skips, production gate blocks (no HTTP in any)', async () => {
    reset();
    process.env.SCOUT_MODE = 'read-only';
    const a = await adminManageTool.execute({ action: 'add_admin', name: 'x', confirm: true });
    assert(a.isError === true, 'read-only blocks add');
    process.env.SCOUT_MODE = 'dry-run';
    const b = await adminManageTool.execute({ action: 'update_admin', admin_id: 1, root_ou: 1, confirm: true });
    assert(!b.isError && text(b).includes('dry_run'), 'dry-run');
    process.env.SCOUT_MODE = 'write';
    delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
    const c = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'x', confirm: true });
    assert(c.isError === true && text(c).includes('blocked'), 'production gate blocks');
    const d = await adminManageTool.execute({ action: 'add_admin', name: 'x', confirm: true });
    assert(d.isError === true && text(d).includes('blocked'), 'production gate blocks add too');
    process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
    assert(recorded.length === 0, 'nothing sent');
  });

  console.log('\nsystem_settings set_recovery_settings');
  await test('POST /api/v1/recoverySettings (no /set suffix), gates kept', async () => {
    reset();
    const opts = { OsToRecover: 'elux7', Protocol: 'http', Server: 's', Proxy: '', User: '', Path: '', File: 'f', UserMustConfirm: true };
    const r = await systemSettingsTool.execute({ action: 'set_recovery_settings', recovery_options: opts });
    assert(!r.isError, text(r));
    const rec = recorded[0]!;
    assert(rec.method === 'POST' && rec.path === '/api/v1/recoverySettings', `${rec.method} ${rec.path}`);
    assert(JSON.parse(rec.body)['OsToRecover'] === 'elux7', 'body passed through');
    process.env.SCOUT_MODE = 'read-only';
    reset();
    const r2 = await systemSettingsTool.execute({ action: 'set_recovery_settings', recovery_options: opts });
    assert(r2.isError === true && recorded.length === 0, 'read-only still blocks');
    process.env.SCOUT_MODE = 'write';
  });

  console.log('\ndb_cleanup');
  const RANGE = '[{"id":0,"from":"2020-01-01","to":"2021-01-01"}]';
  await test('parseCleanupFilter validates ids, ranges, empty', () => {
    assert(parseCleanupFilter(RANGE, { requireRange: true })[0]!.id === 0, 'ok');
    for (const bad of ['[]', 'nope', '{"a":1}', '[{"id":9,"from":"a","to":"b"}]', '[{"id":0}]', '[{"id":0,"from":"a"}]']) {
      let threw = false;
      try {
        parseCleanupFilter(bad, { requireRange: true });
      } catch {
        threw = true;
      }
      assert(threw, `should reject ${bad}`);
    }
    assert(parseCleanupFilter('[]', { requireRange: false }).length === 0, 'list may be empty');
  });

  await test('parseCleanupFilter: from/to formats, ordering and plausibility', () => {
    const now = 1_800_000_000; // fixed clock
    const p = (f: unknown, t: unknown) => parseCleanupFilter(JSON.stringify([{ id: 0, from: f, to: t }]), { requireRange: true }, now);
    const e = p('2020-01-01', '2020-01-01T10:00:00Z')[0]!;
    assert(e.from === 1577836800 && e.to === 1577872800, JSON.stringify(e));
    assert(p('2020-01-01T00:00:00', '2020-01-02T00:00:00+01:00')[0]!.from === 1577836800, 'zone-less date-time is UTC');
    assert(p(1577836800, 1609459200)[0]!.to === 1609459200, 'numeric epoch seconds accepted (server contract)');
    assert(p('2020-01-01', '2020-01-01')[0]!.from === p('2020-01-01', '2020-01-01')[0]!.to, 'from == to allowed');
    const bad: Array<[unknown, unknown, string]> = [
      ['0', '1700000000', 'string zero'],
      ['99999999999', '99999999999', 'string huge'],
      [0, 1700000000, 'numeric 0'],
      [1, 1700000000, 'numeric 1'],
      [1577836800, 99999999999, 'numeric huge'],
      ['2021-01-01', '2020-01-01', 'from > to'],
      ['2020-13-45', '2021-01-01', 'unparseable'],
      ['yesterday', '2021-01-01', 'free text'],
      ['1999-12-31', '2021-01-01', 'before 2000'],
      ['2020-01-01', '2999-01-01', 'far future'],
      [1.5, 1700000000, 'non-integer'],
      [null, 1700000000, 'null'],
    ];
    for (const [f, t, why] of bad) {
      let threw = false;
      try {
        p(f, t);
      } catch {
        threw = true;
      }
      assert(threw, `should reject ${why}`);
    }
  });

  await test('db_cleanup tool rejects "0" / "99999999999" before any gate or HTTP', async () => {
    reset();
    for (const f of ['[{"id":0,"from":"0","to":"99999999999"}]', '[{"id":0,"from":0,"to":99999999999}]']) {
      const r = await dbCleanupTool.execute({ action: 'delete', filter: f, confirm: true });
      assert(r.isError === true, `rejected ${f}`);
    }
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('db_cleanup list normalises ISO dates to epoch seconds in the query', async () => {
    reset();
    await dbCleanupTool.execute({ action: 'list', filter: '[{"id":2,"from":"2020-01-01","to":"2021-01-01"}]' });
    assert(decodeURIComponent(recorded[0]!.query) === '?filter=[{"id":2,"from":1577836800,"to":1609459200}]', recorded[0]!.query);
  });

  await test('delete -> POST /api/v1/dbCleanUp with {filter:[{id,from,to}]}', async () => {
    reset();
    const r = await dbCleanupTool.execute({ action: 'delete', filter: RANGE, confirm: true });
    assert(!r.isError, text(r));
    const rec = recorded[0]!;
    assert(rec.method === 'POST' && rec.path === '/api/v1/dbCleanUp', `${rec.method} ${rec.path}`);
    const b = JSON.parse(rec.body) as { filter: Array<{ id: number; from: string; to: string }> };
    assert(b.filter.length === 1 && b.filter[0]!.id === 0 && b.filter[0]!.from === 1577836800 && b.filter[0]!.to === 1609459200, rec.body);
  });

  await test('delete: empty filter / unbounded range / no confirm are refused (no HTTP)', async () => {
    reset();
    const a = await dbCleanupTool.execute({ action: 'delete', filter: '[]', confirm: true });
    const b = await dbCleanupTool.execute({ action: 'delete', filter: '[{"id":0}]', confirm: true });
    const c = await dbCleanupTool.execute({ action: 'delete', filter: RANGE });
    assert(a.isError === true && b.isError === true && c.isError === true, 'all refused');
    assert(recorded.length === 0, 'nothing sent');
  });

  await test('list stays GET with the filter in the query', async () => {
    reset();
    const r = await dbCleanupTool.execute({ action: 'list' });
    assert(!r.isError, text(r));
    assert(recorded[0]!.method === 'GET' && recorded[0]!.query === '?filter=%5B%5D', recorded[0]!.query);
  });

  const AUDIT = '[{"id":1,"from":"2020-01-01","to":"2021-01-01"}]';
  await test('ADMIN_LOGS purge is hard-refused by default (even with confirm=true, mode=write)', async () => {
    reset();
    const r = await dbCleanupTool.execute({ action: 'delete', filter: AUDIT, confirm: true, confirm_audit_purge: true });
    assert(r.isError === true && text(r).includes('SCOUT_ALLOW_AUDIT_PURGE'), text(r));
    assert(recorded.length === 0, 'nothing sent');
    assert(auditLines().some((l) => l['gate'] === 'audit-purge' && l['result'] === 'refused'), 'refusal audited');
  });

  await test('ADMIN_LOGS purge with SCOUT_ALLOW_AUDIT_PURGE=true still needs confirm_audit_purge', async () => {
    reset();
    process.env.SCOUT_ALLOW_AUDIT_PURGE = 'true';
    const r1 = await dbCleanupTool.execute({ action: 'delete', filter: AUDIT, confirm: true });
    assert(r1.isError === true && text(r1).includes('confirm_audit_purge'), text(r1));
    assert(recorded.length === 0, 'nothing sent without the extra flag');
    assert(auditLines().some((l) => l['gate'] === 'audit-purge' && String(l['detail']).includes('confirm_audit_purge missing')), 'missing-flag refusal audited');
    const r2 = await dbCleanupTool.execute({ action: 'delete', filter: AUDIT, confirm: true, confirm_audit_purge: true });
    assert(!r2.isError && recorded.length === 1, text(r2));
    assert(auditLines().some((l) => l['opName'] === 'db_cleanup(delete)' && String(l['detail']).includes('ADMIN_LOGS')), 'purge audited');
    delete process.env.SCOUT_ALLOW_AUDIT_PURGE;
  });

  await test('ADMIN_LOGS in a mixed filter is refused too; other gates unchanged (read-only/prod)', async () => {
    reset();
    const mixed = '[{"id":0,"from":"2020-01-01","to":"2021-01-01"},{"id":1,"from":"2020-01-01","to":"2021-01-01"}]';
    const r = await dbCleanupTool.execute({ action: 'delete', filter: mixed, confirm: true, confirm_audit_purge: true });
    assert(r.isError === true, 'mixed refused');
    process.env.SCOUT_MODE = 'read-only';
    const r2 = await dbCleanupTool.execute({ action: 'delete', filter: RANGE, confirm: true });
    assert(r2.isError === true, 'read-only still refuses');
    process.env.SCOUT_MODE = 'write';
    delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
    const r3 = await dbCleanupTool.execute({ action: 'delete', filter: RANGE, confirm: true });
    assert(r3.isError === true && text(r3).includes('blocked'), 'production gate still refuses');
    process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
    assert(recorded.length === 0, 'nothing sent');
  });

  console.log('\nou_filter_manage FilterType 4');
  await test('types 1 and 2 map exactly as before', () => {
    const a = buildFilterWireEntry({ subnet_address: '10.0.0.0/24', ou_id: 5, active: true, order: 2 }, 'add');
    assert(JSON.stringify(a) === JSON.stringify({ FilterType: 1, SubnetAddress: '10.0.0.0/24', OrderNumber: 2, Active: true, OUID: 5 }), JSON.stringify(a));
    const b = buildFilterWireEntry({ custom_filter: 'ELUX_HOSTNAME=PC', ou_id: 5 }, 'add');
    assert(b['FilterType'] === 2 && b['CustomFilter'] === 'ELUX_HOSTNAME=PC' && b['OUID'] === 5, JSON.stringify(b));
    const m = buildFilterWireEntry({ entry_id: 9, custom_filter: 'X=1' }, 'modify');
    assert(m['EntryId'] === 9 && m['FilterType'] === 2, JSON.stringify(m));
    const m2 = buildFilterWireEntry({ entry_id: 9, active: false }, 'modify');
    assert(JSON.stringify(m2) === JSON.stringify({ EntryId: 9, Active: false }), 'modify without type keeps type untouched');
  });

  await test('type 4: envelope in CustomFilter, requires ou_id+active on add, Sequence for order', () => {
    const e = buildFilterWireEntry(
      { rule_condition: 'ELUX_IP=10.0.0.1', rule_blocks: [{ k: 1 }], ou_id: 4, active: true, order: 3 },
      'add',
    );
    assert(e['FilterType'] === 4 && e['OUID'] === 4 && e['Active'] === true && e['Sequence'] === 3, JSON.stringify(e));
    const env = JSON.parse(e['CustomFilter'] as string) as { conditionString: string; filterBlocks: unknown[] };
    assert(env.conditionString === 'ELUX_IP=10.0.0.1' && env.filterBlocks.length === 1, 'envelope');
    assert(!('SubnetAddress' in e), 'no subnet');
    let threw = false;
    try {
      buildFilterWireEntry({ rule_condition: 'x' }, 'add');
    } catch {
      threw = true;
    }
    assert(threw, 'ou_id/active required');
    const noBlocks = buildFilterWireEntry({ rule_condition: 'x', ou_id: 1, active: false }, 'add');
    assert((JSON.parse(noBlocks['CustomFilter'] as string) as { filterBlocks: unknown[] }).filterBlocks.length === 0, 'blocks default []');
  });

  await test('length caps: expression 4000, condition 32768, envelope 65535; mixing refused', () => {
    const tooLong = (e: Parameters<typeof buildFilterWireEntry>[0], mode: 'add' | 'modify' = 'add'): boolean => {
      try {
        buildFilterWireEntry(e, mode);
        return false;
      } catch {
        return true;
      }
    };
    assert(!tooLong({ custom_filter: 'a'.repeat(MAX_EXPRESSION_LENGTH) }), '4000 ok');
    assert(tooLong({ custom_filter: 'a'.repeat(MAX_EXPRESSION_LENGTH + 1) }), '4001 refused (add)');
    assert(tooLong({ entry_id: 1, custom_filter: 'a'.repeat(MAX_EXPRESSION_LENGTH + 1) }, 'modify'), '4001 refused (modify)');
    assert(tooLong({ rule_condition: 'a'.repeat(MAX_CONDITION_LENGTH + 1), ou_id: 1, active: true }), 'condition > 32768');
    assert(tooLong({ rule_condition: 'a'.repeat(MAX_CONDITION_LENGTH), rule_blocks: [{ b: 'z'.repeat(MAX_RULE_ENVELOPE_LENGTH) }], ou_id: 1, active: true }), 'envelope > 65535');
    assert(tooLong({ rule_condition: 'x', custom_filter: 'y', ou_id: 1, active: true }), 'rule + expression refused');
    assert(tooLong({ rule_blocks: [{}], custom_filter: 'y' }), 'blocks without condition refused');
    assert(tooLong({}), 'empty add refused');
  });

  console.log('\nhealth_check body-level errors');
  await test('assessHealthBody classifies the documented failure shapes', () => {
    assert(assessHealthBody({ message: 'OK', response: { scoutDBLayer: { status: { result: 0 } } } }).state === 'ok', 'ok');
    assert(assessHealthBody({ message: 'not OK', response: 'Internal server error' }).state === 'error', 'not OK');
    assert(assessHealthBody({ message: 'OK', response: { scoutDBLayer: false } }).state === 'error', 'scoutDBLayer false');
    assert(assessHealthBody({ message: 'OK', response: { scoutDBLayer: { status: { result: 1, msg: 'not available' } } } }).state === 'error', 'db layer down');
    const d = assessHealthBody({ message: 'OK', response: { scoutDBLayer: { status: { result: 0 } }, scoutServer: { status: { result: 2 } } } });
    assert(d.state === 'degraded' && d.problems.length === 1, 'partial -> degraded');
    assert(assessHealthBody(undefined).state === 'error', 'no body');
  });

  await test('health_check tool: HTTP 200 + {message:"not OK"} -> isError; healthy -> ok with healthState', async () => {
    reset();
    apiReply = () => ({ status: 200, body: { message: 'not OK', response: 'Internal server error' } });
    const bad = await healthCheckTool.execute({ mode: 'healthcheck', capabilities: false });
    assert(bad.isError === true && text(bad).includes('Internal server error'), text(bad));
    apiReply = () => ({ status: 200, body: { message: 'OK', response: { scoutDBLayer: { status: { result: 0, msg: 'available' } } } } });
    const good = await healthCheckTool.execute({ mode: 'healthcheck', capabilities: false });
    assert(!good.isError && text(good).includes('"healthState": "ok"'), text(good));
    // MCP server version is reported and equals package.json (single source of truth).
    const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;
    assert(
      (JSON.parse(text(good)) as { mcpServerVersion?: string }).mcpServerVersion === pkgVersion,
      `mcpServerVersion should be ${pkgVersion}: ${text(good)}`,
    );
  });

  console.log('\nDevice delete/move post-condition');
  await test('assessDeviceWriteResult: success shape, dropped ids, unconfirmed 2xx', () => {
    const okShape = { code: 200, message: 'OK', response: { status: { result: 0, msg: 'Device deleted' } } };
    assert(assessDeviceWriteResult(okShape, ['5']).confirmed, 'documented success');
    const part = assessDeviceWriteResult({ deviceId: [1, 3] }, ['1', '2', '3']);
    assert(!part.confirmed && part.droppedIds.join() === '2' && part.affectedIds.join() === '1,3', JSON.stringify(part));
    assert(assessDeviceWriteResult({ deviceId: ['01', '2'] }, ['1', '2']).droppedIds.length === 0, 'id canonicalisation');
    assert(!assessDeviceWriteResult({ message: 'OK' }, ['5']).confirmed, '2xx without status is not confirmed');
  });

  await test('device_manage delete: confirmed body unchanged; unconfirmed body gets mcpWarning + audit', async () => {
    reset();
    apiReply = () => ({ status: 200, body: { code: 200, message: 'OK', response: { status: { result: 0, msg: 'Device deleted' } } } });
    const r1 = await deviceManageTool.execute({ action: 'delete', id: '5' });
    assert(!r1.isError && !text(r1).includes('mcpWarning'), text(r1));
    apiReply = () => ({ status: 200, body: { message: 'OK' } });
    const r2 = await deviceManageTool.execute({ action: 'delete', id: '6' });
    assert(!r2.isError && text(r2).includes('mcpWarning'), text(r2));
    assert(auditLines().some((l) => l['opName'] === 'device_manage(delete)' && String(l['detail']).includes('unconfirmed') || String(l['detail']).includes('partial/unconfirmed')), 'audit entry');
  });


  console.log('\nSecurity/QA follow-ups');
  const fakeServer = (answer: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      server: {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async (req: { message: string }) => {
          calls.push(req.message);
          return { action: 'accept', content: { confirmed: answer } };
        },
      },
    };
  };

  await test('admin gates run BEFORE the confirm prompt (production gate, read-only), prompt shown only when allowed', async () => {
    reset();
    const f = fakeServer(true);
    delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = { server: f.server } as any;
    const r1 = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'x' }, ctx);
    assert(r1.isError === true && f.calls.length === 0, 'production gate refuses without prompting');
    process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
    process.env.SCOUT_MODE = 'read-only';
    const r2 = await adminManageTool.execute({ action: 'add_admin', name: 'x' }, ctx);
    assert(r2.isError === true && f.calls.length === 0, 'read-only refuses without prompting');
    process.env.SCOUT_MODE = 'dry-run';
    const r3 = await adminManageTool.execute({ action: 'update_admin', admin_id: 1, root_ou: 1 }, ctx);
    assert(!r3.isError && f.calls.length === 0 && recorded.length === 0, 'dry-run does not prompt');
    process.env.SCOUT_MODE = 'write';
    const r4 = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'x' }, ctx);
    assert(!r4.isError && f.calls.length === 1 && recorded.length === 1, 'allowed: prompted once, then the call is made');
  });

  await test('declined confirmation sends nothing', async () => {
    reset();
    const f = fakeServer(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await adminManageTool.execute({ action: 'delete_admin', admin_name: 'x' }, { server: f.server } as any);
    assert(r.isError === true && f.calls.length === 1 && recorded.length === 0, 'declined');
  });

  await test('update_admin prompt and audit show RootOu and capped Id=Value pairs; add/delete show name/flags', async () => {
    reset();
    const f = fakeServer(true);
    const rights = Array.from({ length: 35 }, (_, i) => ({ Id: 100 + i, Value: 1 as const }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = { server: f.server } as any;
    await adminManageTool.execute({ action: 'update_admin', admin_id: 7, root_ou: 3, root_ou_fmd: 4, menu_rights: rights, base_rights: [{ Id: 5, Value: '0' }] }, ctx);
    const msg = f.calls[0]!;
    assert(msg.includes('RootOu=3') && msg.includes('RootOUFMD=4'), msg);
    assert(msg.includes('100=1') && msg.includes('129=1') && !msg.includes('130=1') && msg.includes('+5 more'), msg);
    assert(msg.includes('baseRights: [5=0]'), msg);
    const a = auditLines().filter((l) => l['opName'] === 'admin_manage(update_admin)').pop()!;
    assert(String(a['detail']).includes('RootOu=3') && String(a['detail']).includes('+5 more') && String(a['detail']).includes('5=0'), String(a['detail']));
    await adminManageTool.execute({ action: 'add_admin', name: 'DOM\\eve', full_access: true, duplicate_from: 'alice' }, ctx);
    assert(f.calls[1]!.includes('fullAccess=true') && f.calls[1]!.includes('alice'), f.calls[1]!);
    const a2 = auditLines().filter((l) => l['opName'] === 'admin_manage(add_admin)').pop()!;
    assert(String(a2['detail']).includes('fullAccess=true') && String(a2['detail']).includes('duplicateFrom="alice"'), String(a2['detail']));
    await adminManageTool.execute({ action: 'delete_admin', admin_name: 'bob' }, ctx);
    assert(f.calls[2]!.includes('"bob"'), f.calls[2]!);
    assert(String(auditLines().filter((l) => l['opName'] === 'admin_manage(delete_admin)').pop()!['detail']).includes('bob'), 'delete audit detail');
  });

  await test('username alias and duplicate_from are capped at 256 chars', async () => {
    reset();
    let threw = 0;
    for (const a of [{ username: 'u'.repeat(257) }, { name: 'ok', duplicate_from: 'd'.repeat(257) }]) {
      try {
        await adminManageTool.execute({ action: 'add_admin', confirm: true, ...a });
      } catch {
        threw += 1;
      }
    }
    assert(threw === 2 && recorded.length === 0, 'both rejected by schema');
  });

  await test('update_rights stays mode-gated only (private GET that refreshes the caller own cache): works in write without the production flag', async () => {
    reset();
    delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
    const r = await adminManageTool.execute({ action: 'update_rights' });
    assert(!r.isError && recorded[0]!.method === 'GET' && recorded[0]!.path === '/api/v1/updateuserrights', text(r));
    process.env.SCOUT_MODE = 'read-only';
    reset();
    const r2 = await adminManageTool.execute({ action: 'update_rights' });
    assert(r2.isError === true && recorded.length === 0, 'read-only still blocks');
    process.env.SCOUT_MODE = 'write';
    process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
  });

  await test('msgId from the server is control-char stripped and capped', async () => {
    reset();
    apiReply = () => ({ status: 400, body: { message: 'bad', msgId: 'a\nb\u0000c' + 'x'.repeat(200) } });
    const c = newClient();
    await c.login();
    let err: unknown;
    try {
      await c.rawRequest('GET', '/api/v1/x');
    } catch (e) {
      err = e;
    }
    const id = (err as ScoutError).msgId ?? '';
    // eslint-disable-next-line no-control-regex
    assert(!/[\u0000-\u001f]/.test(id) && id.length <= 101 && id.startsWith('a b c'), JSON.stringify(id));
  });

  await test('204 / empty-body device delete+move: no spurious unconfirmed warning', async () => {
    reset();
    assert(assessDeviceWriteResult(undefined, ['5']).confirmed, 'undefined body confirmed');
    apiReply = () => ({ status: 204, body: '' });
    const r = await deviceManageTool.execute({ action: 'delete', id: '9' });
    assert(!r.isError && !text(r).includes('mcpWarning'), text(r));
  });

  server.close();
  for (const k of ENV_KEYS) delete process.env[k];
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
