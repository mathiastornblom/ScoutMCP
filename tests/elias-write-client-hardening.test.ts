/**
 * Offline tests for the ELIAS client hardening slice (re-verification findings N1-N7).
 * Credentials are random per run and built at runtime (no literal username/password pairs).
 * fetch() is intercepted at ScoutClient.fetchWithTimeout, so "the URL that is sent" is asserted
 * byte for byte, not inferred.
 *
 * Run with: npx tsx tests/elias-write-client-hardening.test.ts
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScoutClient } from '../src/client.js';
import { GuardrailError, resetCircuitBreaker, isDryRunSkip } from '../src/safety/guardrails.js';
import { mintMutationToken, isMutationToken } from '../src/elias/token.js';
import {
  BODY_KEY_DENY,
  assertBodyAllowed,
  BodyDenied,
  isLegacyMutating,
  isCanonicalSentPath,
  classifyRequest,
} from '../src/elias/optable.js';
import { appendAuditRow, readAuditRows, __setAuditFsForTests } from '../src/elias/audit.js';
import { scrubCapture, keyPlaceholder } from '../src/elias/fixture-scrub.js';

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
async function thrown(p: Promise<unknown>): Promise<Error | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e as Error;
  }
}
const isGate = (e: unknown, g?: string): boolean => e instanceof GuardrailError && (g === undefined || e.gate === g);

// Random per run, assembled at runtime: nothing credential-shaped sits in this file.
const FAKE_USER = `u${randomBytes(4).toString('hex')}`;
const FAKE_SECRET = randomBytes(12).toString('hex');
const tmp = mkdtempSync(join(tmpdir(), 'elias-client-hardening-'));
let n = 0;

function env(mode = 'write'): string {
  n += 1;
  const p = join(tmp, `audit-${n}.log`);
  process.env.SCOUT_AUDIT_LOG_PATH = p;
  process.env.SCOUT_KILL_SWITCH_FILE = join(tmp, 'no-ks');
  process.env.SCOUT_MODE = mode;
  process.env.SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION = 'true';
  __setAuditFsForTests();
  resetCircuitBreaker();
  return p;
}

interface Spy {
  urls: string[];
  methods: string[];
}
/** A client whose network layer is a recorder: no socket is ever opened. */
function spyClient(baseUrl = 'https://scout.corp'): { c: ScoutClient; spy: Spy } {
  const c = new ScoutClient({ baseUrl, username: FAKE_USER, password: FAKE_SECRET, ignoreTls: true });
  const spy: Spy = { urls: [], methods: [] };
  const anyC = c as unknown as {
    ensureAuth: () => Promise<boolean>;
    fetchWithTimeout: (url: string, init: { method?: string }) => Promise<unknown>;
  };
  anyC.ensureAuth = async () => true;
  anyC.fetchWithTimeout = async (url: string, init: { method?: string }) => {
    spy.urls.push(url);
    spy.methods.push(String(init?.method));
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  return { c, spy };
}

async function main(): Promise<void> {
  console.log('N1: validated path === sent path');
  await test('rawRequest(POST, "api/v1/license/reconfigure") (no leading slash) is refused: no host rewrite, nothing sent', async () => {
    env();
    const { c, spy } = spyClient('https://scout.corp');
    for (const p of ['api/v1/license/reconfigure', 'api/v1/license/reConfigure']) {
      const e = await thrown(c.rawRequest('PUT', p, {}, { mutating: true, opName: 'x' }));
      assert(isGate(e, 'mutation-token'), `${p}: ${String(e)}`);
    }
    assert(spy.urls.length === 0, `nothing was sent: ${spy.urls.join()}`);
  });
  await test('non-canonical spellings of legacy/op paths are refused (//, case, trailing slash, %-encoding)', async () => {
    env();
    const { c, spy } = spyClient();
    const variants = [
      '/api/v1//license/reconfigure', '/API/V1/LICENSE/RECONFIGURE', '/api/v1/license/reconfigure/', '//api/v1/license/reconfigure',
      '/Api/v1/license/reconfigure', '/api/v1/license/%72econfigure', '/api/v1/license//reconfigure',
    ];
    for (const p of variants) {
      for (const m of ['PUT', 'POST']) {
        const e = await thrown(c.rawRequest(m, p, {}, { mutating: true, opName: 'x' }));
        assert(isGate(e), `${m} ${p} must be refused: ${String(e)}`);
      }
    }
    const tok = mintMutationToken({ proceed: true }, { opId: 'o', opName: 'elias_container_create', method: 'POST', pathTemplate: '/api/v1/containers/import', concretePath: '/api/v1/containers/import', bodySha256: 'x' });
    for (const p of ['/api/v1//containers/import', '/API/V1/Containers/Import', '/api/v1/containers/import/', 'api/v1/containers/import']) {
      const e = await thrown(c.rawRequest('POST', p, { name: 'x' }, { mutationToken: tok }));
      assert(isGate(e), `token + ${p} must be refused: ${String(e)}`);
    }
    assert(spy.urls.length === 0, `nothing was sent: ${spy.urls.join()}`);
  });
  await test('the canonical legacy path is sent verbatim (intercepted fetch URL === baseUrl + path)', async () => {
    env();
    const { c, spy } = spyClient('https://scout.corp');
    // Callers spell some legacy paths in mixed case (reConfigure): allowed, sent exactly as given.
    await c.rawRequest('PUT', '/api/v1/license/reConfigure', {}, { mutating: true, opName: 'x' });
    await c.rawRequest('POST', '/api/v1/admins/add', { Name: 'x' }, { mutating: true, opName: 'x' });
    assert(spy.urls[0] === 'https://scout.corp/api/v1/license/reConfigure', spy.urls[0]);
    assert(spy.urls[1] === 'https://scout.corp/api/v1/admins/add', spy.urls[1]);
  });
  await test('request(): non-GET paths without a leading "/" or with an empty segment are refused (no /rest escape)', async () => {
    env();
    const { c, spy } = spyClient('https://scout.corp');
    for (const p of ['api/v1/ou', '/api/v1//ou', '//evil.example/x', '/api/v1/ou/']) {
      const e = await thrown(c.request('POST', p, {}));
      assert(isGate(e), `${p}: ${String(e)}`);
    }
    assert(spy.urls.length === 0, 'nothing sent');
    await c.request('POST', '/api/v1/rules/validate', {});
    assert(spy.urls[0] === 'https://scout.corp/rest/api/v1/rules/validate', spy.urls[0]);
  });
  await test('isCanonicalSentPath / classifyRequest: structural helpers', () => {
    assert(isCanonicalSentPath('/api/v1/x') && isCanonicalSentPath('/api/v1/x?a=//b'), 'plain + query may contain //');
    assert(!isCanonicalSentPath('api/v1/x') && !isCanonicalSentPath('/a//b') && !isCanonicalSentPath('/a/b/') && !isCanonicalSentPath('//a'), 'bad forms');
    assert(isCanonicalSentPath('/api/v1/images/Some-ID/X.epm', '/api/v1/images/{c}/{id}'), 'ids may be mixed case');
    assert(!isCanonicalSentPath('/Api/v1/images/a/b', '/api/v1/images/{c}/{id}'), 'fixed segments exact');
    assert(classifyRequest('POST', 'api/v1/license/reconfigure').kind === 'rejected', 'classify rejects a missing leading slash');
    assert(classifyRequest('POST', '/api/v1//license/reconfigure').kind === 'rejected', 'classify rejects //');
  });

  console.log('N2: signing/cert material deny-list');
  await test('substring-style matching denies signing/cert/key material in any spelling', () => {
    const denied = [
      'signkey', 'signKey', 'sign_key', 'Sign-Key', 'pemfile', 'pemFile', 'certfile', 'certFile', 'mycert', 'myCert', 'cacert', 'caCert', 'CACERT',
      'x509', 'X509Cert', 'signer', 'signerName', 'keystore', 'keyStore', 'key_store', 'privateKey', 'private_key', 'PRIVATEKEY', 'privkey',
      'thumbprint', 'pem', 'certPem', 'signingKey', 'password', 'clientSecret', 'trustAnchor', 'pkcs12', 'pfx', 'p12', 'cert', 'sign', 'signed',
    ];
    for (const k of denied) assert(BODY_KEY_DENY.test(k), `${k} must be denied`);
    const allowed = ['design', 'designer', 'assign', 'assignedTo', 'Assigned_To', 'resign', 'consign', 'name', 'containerId', 'pempty', 'description', 'significant', 'concert', 'certain'];
    for (const k of allowed) assert(!BODY_KEY_DENY.test(k), `${k} must be allowed`);
  });
  await test('assertBodyAllowed catches nested objects and arrays (depth <= 8)', () => {
    for (const body of [
      { a: { b: { signKey: 1 } } },
      { list: [{ ok: 1 }, { deep: [{ myCert: 'x' }] }] },
      [{ pemfile: 'x' }],
      { a: { b: { c: { d: { e: { f: { g: { keystore: 1 } } } } } } } },
    ]) {
      const e = (() => { try { assertBodyAllowed(body); return undefined; } catch (x) { return x; } })();
      assert(e instanceof BodyDenied, JSON.stringify(body));
    }
    assertBodyAllowed({ name: 'x', items: [{ assignedTo: 'a', design: 'b' }] });
    const tooDeep = JSON.parse('{"a":'.repeat(12) + '1' + '}'.repeat(12));
    assert((() => { try { assertBodyAllowed(tooDeep); return false; } catch (x) { return x instanceof BodyDenied; } })(), 'too deep is denied');
  });

  console.log('N3: legacy allow-list pins the method');
  await test('PUT/PATCH/DELETE/POST on a path listed for another verb is refused even with mutating:true', async () => {
    env();
    const { c, spy } = spyClient();
    assert(isLegacyMutating('/api/v1/license/reconfigure', '', 'PUT') && !isLegacyMutating('/api/v1/license/reconfigure', '', 'PATCH'), 'helper pins method');
    assert(isLegacyMutating('/api/v1/admins/add', '', 'POST') && !isLegacyMutating('/api/v1/admins/add', '', 'PUT') && !isLegacyMutating('/api/v1/admins/add', '', 'DELETE'), 'POST-only');
    assert(isLegacyMutating('/api/v1/admins', 'adminName=x', 'DELETE') && !isLegacyMutating('/api/v1/admins', 'adminName=x', 'POST'), 'DELETE-only with query');
    const cases: Array<[string, string]> = [
      ['PATCH', '/api/v1/license/reconfigure'], ['POST', '/api/v1/license/reconfigure'], ['DELETE', '/api/v1/license/reconfigure'],
      ['PUT', '/api/v1/admins/add'], ['DELETE', '/api/v1/admins/add'], ['PATCH', '/api/v1/admins/modify'],
      ['POST', '/api/v1/admins?adminName=x'], ['PUT', '/api/v1/oufilter/delete'],
    ];
    for (const [m, p] of cases) {
      const e = await thrown(c.rawRequest(m, p, {}, { mutating: true, opName: 'x' }));
      assert(isGate(e, 'mutation-token'), `${m} ${p}: ${String(e)}`);
    }
    assert(spy.urls.length === 0, 'nothing sent');
    await c.rawRequest('DELETE', '/api/v1/admins?adminName=x', undefined, { mutating: true, opName: 'x' });
    await c.rawRequest('PUT', '/api/v1/ui/instances', {}, { mutating: true, opName: 'x' });
    assert(spy.methods.join() === 'DELETE,PUT', spy.methods.join());
  });

  console.log('N4: token is immutable and mints only from its own typed input');
  await test('expiresAt and binding cannot be rewritten; the instance is frozen', () => {
    const t = mintMutationToken({ proceed: true }, { opId: 'o', opName: 'n', method: 'POST', pathTemplate: '/a', concretePath: '/a', bodySha256: '' }, 1000);
    const before = t.expiresAt;
    const attempts: Array<() => void> = [
      () => { (t as unknown as { expiresAt: number }).expiresAt = Date.now() + 1e9; },
      () => { (t as unknown as { binding: unknown }).binding = {}; },
      () => { (t as unknown as { extra: number }).extra = 1; },
      () => { Object.defineProperty(t, 'expiresAt', { value: 1 }); },
    ];
    for (const a of attempts) {
      let threw = false;
      try { a(); } catch { threw = true; }
      assert(threw, 'rewrite must throw (strict mode)');
    }
    assert(t.expiresAt === before && Object.isFrozen(t) && Object.isFrozen(t.binding), 'unchanged and frozen');
    assert(isMutationToken(t), 'still a minted token');
  });
  await test('mintMutationToken rejects look-alike checks (getter, extra keys, class instance, proxy, truthy non-true)', () => {
    const binding = { opId: 'o', opName: 'n', method: 'POST', pathTemplate: '/a', concretePath: '/a', bodySha256: '' };
    class Fake { proceed = true; }
    const getter = Object.defineProperty({}, 'proceed', { get: () => true, enumerable: true });
    const bad: unknown[] = [
      new Fake(), getter, { proceed: true, extra: 1 }, { proceed: 1 }, { proceed: 'true' }, new Proxy({ proceed: true }, {}), Object.create({ proceed: true }),
      null, undefined, 'x', { proceed: false },
    ];
    for (const b of bad) {
      let threw = false;
      try { mintMutationToken(b as never, binding); } catch (e) { threw = isGate(e, 'mutation-token'); }
      assert(threw, `must refuse ${Object.prototype.toString.call(b)} ${JSON.stringify(b)}`);
    }
    assert(isMutationToken(mintMutationToken({ proceed: true, dryRunNotice: 'x' }, binding)), 'the real result shape works');
    let badBinding = false;
    try { mintMutationToken({ proceed: true }, { ...binding, opId: 5 as unknown as string }); } catch { badBinding = true; }
    assert(badBinding, 'binding fields must be strings');
    let badTtl = false;
    try { mintMutationToken({ proceed: true }, binding, 1e12); } catch { badTtl = true; }
    assert(badTtl, 'ttl above the default is refused');
  });

  console.log('N5: a failed write cannot glue the next audit row on its line');
  await test('a partial row (no newline) is followed by a fresh line; every later row parses', () => {
    const p = env();
    appendAuditRow({ opName: 'op-a', opId: 'a', phase: 'intent', tier: 'A', target: 't' } as never);
    // Row 2: the device accepts half the bytes, then fails.
    let first = true;
    __setAuditFsForTests({
      writeSync: ((fd: number, buf: unknown, ...rest: unknown[]) => {
        if (first && typeof buf === 'string') {
          first = false;
          nodeFs.writeSync(fd, buf.slice(0, Math.floor(buf.length / 2)));
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        return (nodeFs.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
      }) as typeof nodeFs.writeSync,
    });
    const ok = appendAuditRow({ opName: 'op-b', opId: 'b', phase: 'intent', tier: 'A', target: 't' } as never);
    assert(ok === false, 'the failing write is reported');
    __setAuditFsForTests();
    assert(!readFileSync(p, 'utf-8').endsWith('\n'), 'precondition: the file ends mid-row');
    appendAuditRow({ opName: 'op-c', opId: 'c', phase: 'intent', tier: 'A', target: 't' } as never);
    const lines = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } });
    assert(parsed[0]?.opId === 'a', 'row a intact');
    assert(parsed[1] === null, 'the torn row stays on its own (unparseable) line');
    assert(parsed[2]?.opId === 'c' && parsed.length === 3, `row c is on its own line: ${lines.join(' | ').slice(0, 300)}`);
    assert(readAuditRows(p).map((r) => r.opId).join() === 'a,c', 'reader sees a and c');
    assert(readFileSync(p, 'utf-8').endsWith('\n'), 'file ends with a newline again');
  });
  await test('an empty or newline-terminated file gets no extra blank line', () => {
    const p = env();
    appendAuditRow({ opName: 'x', opId: '1', phase: 'intent', tier: 'A', target: 't' } as never);
    appendAuditRow({ opName: 'x', opId: '2', phase: 'intent', tier: 'A', target: 't' } as never);
    assert(!readFileSync(p, 'utf-8').includes('\n\n'), 'no blank lines');
    writeFileSync(join(tmp, 'empty.log'), '');
    process.env.SCOUT_AUDIT_LOG_PATH = join(tmp, 'empty.log');
    appendAuditRow({ opName: 'x', opId: '3', phase: 'intent', tier: 'A', target: 't' } as never);
    assert(!readFileSync(join(tmp, 'empty.log'), 'utf-8').startsWith('\n'), 'no leading newline in an empty file');
  });

  console.log('N6: request() PUT/PATCH/DELETE are mode-gated even without mutating:true');
  await test('read-only refuses, dry-run skips, write sends; a bare POST (read/search) is unaffected', async () => {
    env('read-only');
    const { c, spy } = spyClient();
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      const e = await thrown(c.request(m, '/api/v1/device?id=1'));
      assert(isGate(e, 'mode'), `${m} read-only: ${String(e)}`);
    }
    assert(spy.urls.length === 0, 'nothing sent in read-only');
    env('dry-run');
    const skipped = await c.request('DELETE', '/api/v1/device?id=1');
    assert(isDryRunSkip(skipped) && spy.urls.length === 0, 'dry-run skips');
    env('read-only');
    await c.request('POST', '/api/v1/rules/validate', {}); // a read-class POST still works in read-only
    assert(spy.urls.length === 1, 'bare POST sent');
    env('write');
    await c.request('DELETE', '/api/v1/device?id=1');
    assert(spy.urls.length === 2 && spy.methods[1] === 'DELETE', 'write mode sends');
  });

  console.log('N7: scrubber does not keep data-like object keys');
  await test('GUID, numeric and name-like keys become placeholders; plain field names stay', () => {
    const guid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const dict: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) dict[`Customer${randomBytes(3).toString('hex')}`] = { state: 'x' };
    const r = scrubCapture([
      {
        method: 'POST',
        url: 'https://h.invalid/api/v1/containers/import',
        requestBody: { name: 'x' },
        status: 200,
        responseBody: {
          [guid]: { rights: true },
          'uc-elux7-2507': { view: true },
          'My Container 1': { view: true },
          '12345': { n: 1 },
          status: 'ok',
          dictionary: dict,
        },
      },
    ]);
    const shape = r.contracts[0].responseShape as Record<string, unknown>;
    assert(!r.json.includes(guid) && !r.json.includes('uc-elux7') && !r.json.includes('My Container') && !r.json.includes('12345'), r.json);
    assert('{guid}' in shape && '{key}' in shape && '{int}' in shape && shape.status === 'string', JSON.stringify(Object.keys(shape)));
    const dshape = shape.dictionary as Record<string, unknown>;
    assert(Object.keys(dshape).join() === '{key}', `a 25-key dictionary collapses: ${Object.keys(dshape).join()}`);
    assert(!r.json.includes('Customer'), 'no dictionary key leaks');
    assert(keyPlaceholder('containerId', false) === null && keyPlaceholder('rights', false) === null, 'field names kept');
    assert(keyPlaceholder('a-b', false) === '{key}' && keyPlaceholder('x1234', false) === '{key}', 'odd keys replaced');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
