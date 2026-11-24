/**
 * Offline tests for client.ts enforcement of ELIAS writes (Security C1, C2, C14) plus the per-call
 * timeout and empty-body tolerance. An in-process HTTPS stand-in records every request, so "refused
 * before any network traffic" is asserted by an empty request log (not even a login).
 *
 * Run with: npx tsx tests/elias-write-client.test.ts
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ScoutClient, resolveCallTimeout, readResponseBody, MAX_CALL_TIMEOUT_MS } from '../src/client.js';
import { GuardrailError, resetCircuitBreaker, isCircuitBreakerTripped } from '../src/safety/guardrails.js';
import { mintMutationToken, MutationToken, isMutationToken } from '../src/elias/token.js';
import { BodyDenied } from '../src/elias/optable.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  resetCircuitBreaker();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: boolean, m: string): asserts c {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}

interface Rec {
  method: string;
  path: string;
  body: string;
}
let recorded: Rec[] = [];
let logins = 0;
let reply: (n: number, rec: Rec) => { status: number; body?: string; delayMs?: number } = () => ({ status: 200, body: '{}' });
let calls = 0;

function fakeJwt(): string {
  return `h.${Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')}.s`;
}

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'elias-write-certs-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return new Promise((resolve) => {
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'https://localhost');
        if (u.pathname === '/rest/auth/v1/login') {
          logins += 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ token: fakeJwt() }));
          return;
        }
        const rec = { method: req.method ?? 'GET', path: u.pathname + u.search, body: Buffer.concat(chunks).toString('utf-8') };
        recorded.push(rec);
        calls += 1;
        const r = reply(calls, rec);
        setTimeout(() => {
          res.statusCode = r.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(r.body ?? '');
        }, r.delayMs ?? 0);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, baseUrl: `https://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` });
    });
  });
}

function reset(): void {
  recorded = [];
  logins = 0;
  calls = 0;
  reply = () => ({ status: 200, body: '{}' });
}

async function gate(p: Promise<unknown>): Promise<GuardrailError | Error | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e as Error;
  }
}
const isGate = (e: unknown, gateName: string): boolean => e instanceof GuardrailError && e.gate === gateName;

const IMPORT = '/api/v1/containers/import';
const CID = '11111111-2222-3333-4444-555555555555';
const binding = (over: Partial<{ opId: string; opName: string; method: string; pathTemplate: string }> = {}) => ({
  opId: 'op-1',
  opName: 'elias_container_create',
  method: 'POST',
  pathTemplate: IMPORT,
  ...over,
});
const mint = (over = {}, ttl?: number): MutationToken => mintMutationToken({ proceed: true }, binding(over), ttl);

async function main(): Promise<void> {
  const { server, baseUrl } = await startServer();
  const tmp = mkdtempSync(join(tmpdir(), 'elias-write-client-'));
  process.env.SCOUT_AUDIT_LOG_PATH = join(tmp, 'audit.log');
  process.env.SCOUT_KILL_SWITCH_FILE = join(tmp, 'no-such-kill-switch');
  delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
  const client = () => new ScoutClient({ baseUrl, username: 'u', password: 'p', ignoreTls: true });
  const setMode = (m: string | undefined): void => {
    if (m === undefined) delete process.env.SCOUT_MODE;
    else process.env.SCOUT_MODE = m;
  };

  console.log('token (C1)');
  await test('minting needs a proceeding check; tokens are branded, single-use objects', () => {
    let threw = false;
    try {
      mintMutationToken({ proceed: false }, binding());
    } catch (e) {
      threw = isGate(e, 'mutation-token');
    }
    assert(threw, 'proceed:false refused');
    const t = mint();
    assert(isMutationToken(t) && !t.used, 'branded and unused');
    assert(!isMutationToken({ ...t }) && !isMutationToken({ consume() {} }), 'forged objects are not tokens');
  });

  console.log('non-GET policy before any network traffic');
  await test('a non-GET without token and without mutating:true is refused (unknown path)', async () => {
    reset();
    setMode('write');
    for (const [m, p] of [['PUT', `/api/v1/containers/${CID}`], ['POST', '/api/v1/somethingnew'], ['DELETE', `/api/v1/images/${CID}/a`], ['PATCH', '/api/v1/x']] as const) {
      const e = await gate(client().rawRequest(m, p, {}));
      assert(isGate(e, 'mutation-token'), `${m} ${p}: ${String(e)}`);
    }
    assert(recorded.length === 0 && logins === 0, 'zero network traffic (not even a login)');
  });
  await test('ELIAS write ops need a token: bare call refused, mutating:true refused (no pipeline bypass)', async () => {
    reset();
    setMode('write');
    const e1 = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }));
    assert(isGate(e1, 'mutation-token') && /needs a mutation token/.test(e1!.message), `bare: ${e1?.message}`);
    const e2 = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutating: true, opName: 'x' }));
    assert(isGate(e2, 'mutation-token') && /pipeline/.test(e2!.message), `mutating:true: ${e2?.message}`);
    assert(recorded.length === 0 && logins === 0, 'no traffic');
    assert(!isCircuitBreakerTripped(), 'no breaker side effect');
  });
  await test('Tier C is refused for every method, with and without token or mutating:true', async () => {
    reset();
    setMode('write');
    const paths = [`/api/v1/certificates/sign/${CID}/idf1`, '/api/v1/certificates/signing', `/api/v1/certificates/${CID}/signing-upload-key`, `/api/v1/certificates/${CID}/defaults`, `/api/v1/certificates/${CID}/${CID}`];
    for (const p of paths) {
      for (const m of ['POST', 'PUT', 'DELETE']) {
        for (const opts of [undefined, { mutating: true, opName: 'x' }, { mutationToken: mint({ method: m, pathTemplate: p }) }]) {
          const e = await gate(client().rawRequest(m, p, {}, opts));
          assert(isGate(e, 'tier-c'), `${m} ${p}: ${String(e)}`);
        }
      }
    }
    assert(recorded.length === 0 && logins === 0, 'no traffic');
  });
  await test('classified-but-disabled ops are refused even with a token (deferred ops are unreachable)', async () => {
    reset();
    setMode('write');
    for (const [m, p] of [['PUT', `/api/v1/containers/${CID}`], ['DELETE', `/api/v1/containers/${CID}`], ['DELETE', `/api/v1/images/${CID}/a`], ['POST', '/api/v1/files/upload/init'], ['POST', `/api/v1/solver/${CID}/solve`], ['PUT', '/api/v1/images/addEpm']] as const) {
      const e = await gate(client().rawRequest(m, p, {}, { mutationToken: mint({ method: m, pathTemplate: p }) }));
      assert(isGate(e, 'mutation-token') && /not enabled/.test(e!.message), `${m} ${p}: ${e?.message}`);
    }
    assert(recorded.length === 0 && logins === 0, 'no traffic');
  });
  await test('internal session/lock plumbing and unverified A0 read-class POSTs are refused', async () => {
    reset();
    setMode('write');
    for (const p of ['/api/v1/lock/set', '/api/v1/lock/release', '/api/v1/heartbeat', '/api/v1/ui/unregister', `/api/v1/images/${CID}/a/idf`, `/api/v1/images/${CID}/parseIdf`, `/api/v1/images/${CID}/a/verify`, `/api/v1/solver/${CID}/hasConflicts`]) {
      const e = await gate(client().rawRequest('POST', p, {}));
      assert(isGate(e, 'mutation-token'), `${p}: ${String(e)}`);
    }
    assert(recorded.length === 0 && logins === 0, 'no traffic');
  });
  await test('closed read-class POST list works without a token; a token is not valid for it', async () => {
    reset();
    setMode(undefined);
    reply = () => ({ status: 200, body: '{"ok":1}' });
    const out = await client().rawRequest<{ ok: number }>('POST', '/api/v1/elias/my-container-roles', { containerIds: [CID] });
    assert(out.ok === 1 && recorded.length === 1 && recorded[0].method === 'POST', 'my-container-roles sent');
    await client().rawRequest('POST', '/api/v1/treefilter', { searchValue: 'a' });
    assert(recorded.length === 2, 'treefilter sent');
    const e = await gate(client().rawRequest('POST', '/api/v1/elias/my-container-roles', {}, { mutationToken: mint({ pathTemplate: '/api/v1/elias/my-container-roles' }) }));
    assert(isGate(e, 'mutation-token'), 'token on a read-class POST refused');
  });
  await test('legacy non-ELIAS private writes (mutating:true on an unknown path) still go through checkMutationAllowed', async () => {
    reset();
    setMode('read-only');
    const e = await gate(client().rawRequest('POST', '/api/v1/oufilter/add', {}, { mutating: true, opName: 'ou_filter_manage' }));
    assert(isGate(e, 'mode'), `read-only blocks: ${String(e)}`);
    assert(recorded.length === 0, 'not sent');
    setMode('write');
    process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
    await client().rawRequest('POST', '/api/v1/oufilter/add', {}, { mutating: true, opName: 'ou_filter_manage' });
    delete process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION;
    assert(recorded.length === 1 && recorded[0].path === '/api/v1/oufilter/add', 'legacy write sent');
  });
  await test('GET is unaffected by the policy', async () => {
    reset();
    setMode(undefined);
    reply = () => ({ status: 200, body: '[]' });
    await client().rawRequest('GET', '/api/v1/containers');
    assert(recorded.length === 1, 'sent');
  });

  console.log('token consumption (single use, binding, mode, kill switch)');
  await test('a valid token sends exactly one request; the same token cannot be reused', async () => {
    reset();
    setMode('write');
    reply = () => ({ status: 201, body: `{"id":"${CID}"}` });
    const c = client();
    const t = mint();
    let status = 0;
    const out = await c.rawRequest<{ id: string }>('POST', IMPORT, { name: 'MCPTEST-20261124-abcdef01' }, { mutationToken: t, expect: 'any', onResponse: (m) => (status = m.status) });
    assert(out.id === CID && status === 201, 'sent, status reported');
    assert(recorded.length === 1 && recorded[0].body === '{"name":"MCPTEST-20261124-abcdef01"}', 'one request with the body');
    assert(t.used, 'token consumed');
    const e = await gate(c.rawRequest('POST', IMPORT, { name: 'again' }, { mutationToken: t }));
    assert(isGate(e, 'mutation-token') && /already used/.test(e!.message), 'reuse refused');
    assert(recorded.length === 1, 'no second request');
  });
  await test('a token bound to another method/path template cannot be used (and is burned)', async () => {
    reset();
    setMode('write');
    const t = mint({ pathTemplate: '/api/v1/containers/{id}', method: 'PUT' });
    const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: t }));
    assert(isGate(e, 'mutation-token') && /different request/.test(e!.message), `${e?.message}`);
    assert(t.used && recorded.length === 0, 'burned, nothing sent');
  });
  await test('an expired token is refused', async () => {
    reset();
    setMode('write');
    const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: mint({}, -1) }));
    assert(isGate(e, 'mutation-token') && /expired/.test(e!.message), `${e?.message}`);
    assert(recorded.length === 0, 'nothing sent');
  });
  await test('mode is re-checked at consumption: read-only and dry-run refuse a valid token', async () => {
    for (const m of ['read-only', 'dry-run', undefined]) {
      reset();
      setMode(m);
      const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: mint() }));
      assert(isGate(e, 'mutation-token') && /not "write"/.test(e!.message), `${String(m)}: ${e?.message}`);
      assert(recorded.length === 0, 'nothing sent');
    }
  });
  await test('the kill switch is re-checked at consumption (token minted before it was engaged)', async () => {
    reset();
    setMode('write');
    const t = mint();
    const ks = join(tmp, 'ks');
    process.env.SCOUT_KILL_SWITCH_FILE = ks;
    writeFileSync(ks, '');
    const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: t }));
    process.env.SCOUT_KILL_SWITCH_FILE = join(tmp, 'no-such-kill-switch');
    assert(isGate(e, 'kill-switch'), `${String(e)}`);
    assert(recorded.length === 0, 'nothing sent');
  });
  await test('forged token objects are refused', async () => {
    reset();
    setMode('write');
    const forged = { binding: binding(), consume() {}, used: false } as unknown as MutationToken;
    const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: forged }));
    assert(isGate(e, 'mutation-token') && /invalid mutation token/.test(e!.message), `${e?.message}`);
    assert(recorded.length === 0, 'nothing sent');
  });
  await test('the body deny-list is enforced by the client too (C14)', async () => {
    reset();
    setMode('write');
    const e = await gate(client().rawRequest('POST', IMPORT, { name: 'x', signaturePEM: 'y' }, { mutationToken: mint() }));
    assert(e instanceof BodyDenied, `${String(e)}`);
    assert(recorded.length === 0, 'nothing sent');
  });
  await test('a token does not touch the circuit breaker (the single count is taken at gate 13)', async () => {
    reset();
    setMode('write');
    process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS = '1';
    reply = () => ({ status: 201, body: '{}' });
    for (let i = 0; i < 4; i++) await client().rawRequest('POST', IMPORT, { name: 'x' }, { mutationToken: mint(), expect: 'any' });
    delete process.env.SCOUT_CIRCUIT_BREAKER_MAX_OPS;
    assert(!isCircuitBreakerTripped(), 'client never counts');
  });
  await test('a 401 replays the request once after re-login; the token is consumed once (single re-send)', async () => {
    reset();
    setMode('write');
    reply = (n) => (n === 1 ? { status: 401, body: '{"message":"Unauthorized"}' } : { status: 201, body: '{"id":"x"}' });
    const c = client();
    await c.login();
    const out = await c.rawRequest<{ id: string }>('POST', IMPORT, { name: 'x' }, { mutationToken: mint(), expect: 'any' });
    assert(out.id === 'x' && recorded.length === 2 && logins === 2, `requests=${recorded.length} logins=${logins}`);
  });

  console.log('per-call timeout and empty bodies');
  await test('resolveCallTimeout: positive override, clamp, invalid -> default', () => {
    assert(resolveCallTimeout(undefined, 30_000) === 30_000, 'undefined');
    assert(resolveCallTimeout(0, 30_000) === 30_000 && resolveCallTimeout(-5, 30_000) === 30_000 && resolveCallTimeout(NaN, 30_000) === 30_000, 'invalid');
    assert(resolveCallTimeout(60_000, 30_000) === 60_000, 'override above default');
    assert(resolveCallTimeout(10_000_000, 30_000) === MAX_CALL_TIMEOUT_MS && MAX_CALL_TIMEOUT_MS === 330_000, 'clamped');
  });
  await test('a per-call timeoutMs aborts a slow response; without it the default applies', async () => {
    reset();
    setMode(undefined);
    reply = () => ({ status: 200, body: '{}', delayMs: 600 });
    const t0 = Date.now();
    const e = await gate(client().rawRequest('GET', '/api/v1/slow', undefined, { timeoutMs: 100 }));
    assert(e !== undefined && Date.now() - t0 < 450, `aborted fast: ${String(e)} after ${Date.now() - t0}ms`);
    const ok = await client().rawRequest<unknown>('GET', '/api/v1/slow');
    assert(ok !== undefined, 'default timeout lets it finish');
  });
  await test('readResponseBody: json strict, empty/any tolerate an empty body, 204 is undefined', async () => {
    const R = (s: string, status = 200) => new Response(s, { status });
    assert((await readResponseBody(R('{"a":1}'))) !== undefined, 'json');
    let threw = false;
    try {
      await readResponseBody(R(''), 'json');
    } catch {
      threw = true;
    }
    assert(threw, 'strict json rejects empty');
    assert((await readResponseBody(R(''), 'any')) === undefined, 'any: empty');
    assert((await readResponseBody(R('  \n'), 'empty')) === undefined, 'empty: whitespace');
    assert(JSON.stringify(await readResponseBody(R('{"a":1}'), 'any')) === '{"a":1}', 'any: json');
    assert((await readResponseBody(R('plain'), 'any')) === 'plain', 'any: text');
    assert((await readResponseBody({ status: 204, text: async () => 'x' }, 'json')) === undefined, '204');
  });
  await test('a 200/201 with an empty body works with expect:any and still fails by default (json)', async () => {
    reset();
    setMode(undefined);
    reply = () => ({ status: 200, body: '' });
    const empty = await client().rawRequest<unknown>('POST', '/api/v1/treefilter', {}, { expect: 'any' });
    assert(empty === undefined, 'tolerated');
    const e = await gate(client().rawRequest('POST', '/api/v1/treefilter', {}));
    assert(e !== undefined, 'default stays strict');
  });

  server.close();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
