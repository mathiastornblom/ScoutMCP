/**
 * Offline tests for the ELIAS write foundation: closed op table, Tier C exclusion (C14), body deny-list,
 * registration rule D0 / evidence (C12), default tool list unchanged, static source checks (C1, C14).
 *
 * Run with: npx tsx tests/elias-write-optable.test.ts
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPS,
  BODY_KEY_DENY,
  BodyDenied,
  NotInOpTable,
  assertBodyAllowed,
  buildContainerCreateRequest,
  classifyRequest,
  isTierCPath,
  lookupOp,
} from '../src/elias/optable.js';
import { WRITE_BODY_CONTRACTS, isBodyVerifiedLive, hasValidEvidence, type WriteBodyContract } from '../src/compat/registry.js';
import { evaluateRegistration } from '../src/elias/registration.js';
import { loadEliasWriteConfig } from '../src/elias/config.js';
import { getEliasWriteTools } from '../src/tools/elias_write.js';
import { eliasTools } from '../src/tools/elias.js';
import { scrubCapture } from '../src/elias/fixture-scrub.js';
import { canonicalJson, sha256Hex } from '../src/elias/sanitize.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

const CID = '11111111-2222-3333-4444-555555555555';
const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const ENV_KEYS = [
  'SCOUT_ENABLE_PRIVATE_ENDPOINTS',
  'SCOUT_ELIAS_WRITES',
  'SCOUT_ENV',
  'SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES',
  'SCOUT_ELIAS_ALLOWED_CONTAINERS',
];

async function main(): Promise<void> {
  for (const k of ENV_KEYS) delete process.env[k];

  console.log('closed op table');
  await test('keys unique; every template matches its own concrete example; every op is classified', () => {
    assert(new Set(OPS.map((o) => o.key)).size === OPS.length, 'duplicate keys');
    for (const o of OPS) {
      const concrete = o.template.replace(/\{[a-z]+\}/g, 'abc');
      const c = classifyRequest(o.method, concrete);
      assert(c.kind === 'op', `${o.key}: ${concrete} not classified`);
      assert(['A0', 'A', 'B', 'internal', 'legacy'].includes(o.tier), `${o.key} tier`);
    }
  });
  await test('only the expected ops are enabled in this build', () => {
    const enabled = OPS.filter((o) => o.enabled).map((o) => o.key).sort();
    assert(
      JSON.stringify(enabled) === JSON.stringify(['containers.import', 'elias.myContainerRoles', 'legacy.treefilter']),
      `enabled: ${enabled.join(',')}`,
    );
    const writes = OPS.filter((o) => o.kind === 'write' && o.enabled);
    assert(writes.length === 1 && writes[0].key === 'containers.import', 'exactly one enabled write op');
  });
  await test('A0 read-class POSTs are deferred (not enabled) until live non-mutation evidence exists (C28)', () => {
    for (const o of OPS.filter((x) => x.tier === 'A0' && x.key !== 'elias.myContainerRoles')) assert(!o.enabled, `${o.key} enabled`);
  });
  await test('every Tier B op and every internal op is disabled', () => {
    for (const o of OPS.filter((x) => x.tier === 'B' || x.tier === 'internal')) assert(!o.enabled, `${o.key}`);
  });
  await test('unknown requests and traversal tricks are unknown, GET is read', () => {
    for (const p of ['/api/v1/foo', '/api/v1/containers/../images/a/b', '/api/v1/containers/%2e%2e/x', '/api/v1/containers/a%2fb', '/api/v1//containers/import']) {
      assert(classifyRequest('POST', p).kind !== 'op', `${p} must not match an op`);
    }
    assert(classifyRequest('GET', '/api/v1/containers').kind === 'read', 'GET is read');
    let threw = false;
    try {
      lookupOp('POST', '/api/v1/foo');
    } catch (e) {
      threw = e instanceof NotInOpTable && e.reason === 'unknown';
    }
    assert(threw, 'lookupOp throws NotInOpTable(unknown)');
  });

  console.log('Tier C (C14)');
  const tierCPaths = [
    '/api/v1/certificates/signing',
    `/api/v1/certificates/signing/${CID}`,
    `/api/v1/certificates/sign/${CID}/idf1`,
    `/api/v1/certificates/${CID}/signing-upload-key`,
    `/api/v1/certificates/${CID}/import`,
    `/api/v1/certificates/${CID}/importPem`,
    `/api/v1/certificates/${CID}/defaults`,
    `/api/v1/certificates/${CID}/${CID}`,
    '/api/v1/CERTIFICATES/x',
    '/api/v1/%63ertificates/x',
    '/api/v1/certificates/signing?x=1',
    `/api/v1/containers/${CID}/signing`,
    `/api/v1/images/${CID}/a/sign`,
    `/api/v1/trust/${CID}`,
    '/api/v1/certificates/%E0%A4%A',
  ];
  await test('every Tier C path is Tier C for POST/PUT/DELETE/PATCH, never reachable via lookupOp', () => {
    for (const p of tierCPaths) {
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        assert(isTierCPath(m, p), `${m} ${p} must be Tier C`);
        assert(classifyRequest(m, p).kind === 'tier-c', `${m} ${p} classify`);
        let reason = '';
        try {
          lookupOp(m, p);
        } catch (e) {
          reason = e instanceof NotInOpTable ? e.reason : 'other';
        }
        assert(reason === 'tier-c', `${m} ${p} lookupOp -> ${reason}`);
      }
    }
  });
  await test('no op-table entry is a Tier C path; no op tool name looks like signing/trust/certificate write', () => {
    for (const o of OPS) {
      const concrete = o.template.replace(/\{[a-z]+\}/g, 'abc');
      assert(!isTierCPath(o.method, concrete), `${o.key} is Tier C`);
      if (o.tool) assert(!/sign|trust|certificate/i.test(o.tool), `${o.key} tool ${o.tool}`);
    }
  });
  await test('GET on certificate metadata is NOT Tier C (existing read tools keep working)', () => {
    assert(!isTierCPath('GET', `/api/v1/certificates/signing/${CID}`), 'GET signing metadata');
    assert(!isTierCPath('GET', `/api/v1/certificates/getAll/${CID}`), 'GET getAll');
  });
  await test('legacy mutating paths with look-alike words are not Tier C (assignDevices etc.)', () => {
    for (const p of ['/api/v1/ou/assignDevices', '/api/v1/oufilter/add', '/api/v1/admins/add', '/api/v1/NewDeviceOptions/set', '/api/v1/recoverySettings']) {
      assert(!isTierCPath('POST', p), p);
    }
  });
  await test('body deny-list refuses sign/cert/pem/trust/signature/password/secret keys, nested and in arrays', () => {
    for (const k of ['signature', 'signingCert', 'certPem', 'trustAnchor', 'pem', 'password', 'clientSecret', 'Sign']) {
      for (const body of [{ [k]: 1 }, { a: { b: { [k]: 1 } } }, [{ [k]: 1 }]]) {
        let threw = false;
        try {
          assertBodyAllowed(body);
        } catch (e) {
          threw = e instanceof BodyDenied;
        }
        assert(threw, `${k} must be denied`);
      }
    }
    assertBodyAllowed({ name: 'x', containerId: CID });
    assert(BODY_KEY_DENY.test('signaturePEM'), 'regex');
  });
  await test('the create builder emits exactly {name} to the import template', () => {
    const r = buildContainerCreateRequest('MCPTEST-20261124-abcdef01');
    assert(r.method === 'POST' && r.path === '/api/v1/containers/import', 'method/path');
    assert(JSON.stringify(r.body) === '{"name":"MCPTEST-20261124-abcdef01"}', 'body');
    assert(r.op.key === 'containers.import', 'op');
  });
  await test('no tool schema takes a path/url/method/header/query parameter; no proxy-like tool exists', () => {
    process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS = 'true';
    process.env.SCOUT_ELIAS_WRITES = 'b';
    process.env.SCOUT_ENV = 'test';
    process.env.SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES = 'true';
    const tools = [...getEliasWriteTools(), ...eliasTools];
    for (const k of ENV_KEYS) delete process.env[k];
    assert(tools.length > 2, 'tools');
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      for (const prop of Object.keys(schema.properties ?? {})) {
        assert(!/^(path|url|uri|method|headers?|query|endpoint|body|raw)$/i.test(prop), `${t.name} has param ${prop}`);
      }
      assert(!/proxy|raw_?request|call_api/i.test(t.name), `${t.name} looks like a proxy`);
      assert(!/(^|_)(sign|trust)|certificate_(import|delete|restore)|lock|session/i.test(t.name), `${t.name} forbidden name`);
    }
    for (const t of getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'a', SCOUT_ENV: 'test', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' })) {
      const schema = t.inputSchema as { additionalProperties?: unknown };
      assert(schema.additionalProperties === false, `${t.name} schema is not strict`);
    }
  });
  await test('write tool descriptions and annotations make no rollback/undo/reversible claims (C19)', () => {
    const tools = getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'a', SCOUT_ENV: 'test', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' });
    assert(tools.length === 2, 'status + create');
    for (const t of tools) {
      assert(!/rollback|undo|reversib|restorable|restore/i.test(t.description), `${t.name} description`);
      assert(!/\b(lock|session|sign|trust)/i.test(t.description), `${t.name} mentions lock/session/sign/trust`);
    }
    const create = tools.find((t) => t.name === 'elias_container_create')!;
    assert(create.annotations?.readOnlyHint === false && create.annotations?.idempotentHint === false, 'annotations');
  });

  console.log('registration, default tool list, rule D0 / C12');
  await test('with default config the write tool list is empty (tool list unchanged)', () => {
    assert(getEliasWriteTools({}).length === 0, 'empty env');
    assert(getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true' }).length === 0, 'private only');
    assert(getEliasWriteTools({ SCOUT_ELIAS_WRITES: 'a' }).length === 0, 'writes without private');
    assert(getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'off' }).length === 0, 'off');
    assert(getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'A' }).length === 0, 'uppercase A is invalid -> off');
    assert(getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'yes' }).length === 0, 'garbage -> off');
  });
  await test('writes=a lists only the status tool: create stays unregistered without verified-live evidence', () => {
    const names = getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'a' }).map((t) => t.name);
    assert(JSON.stringify(names) === '["elias_write_status"]', names.join(','));
    const b = getEliasWriteTools({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'b' }).map((t) => t.name);
    assert(JSON.stringify(b) === '["elias_write_status"]', 'b');
  });
  await test('the registry marks create untested and without evidence (no live capture exists)', () => {
    const c = WRITE_BODY_CONTRACTS.find((x) => x.toolName === 'elias_container_create')!;
    assert(c.bodyStatus === 'untested' && c.evidence === undefined, 'untested, no evidence');
    assert(!isBodyVerifiedLive('elias_container_create'), 'not verified-live');
  });
  await test('escape hatch: needs SCOUT_ENV=test and the explicit switch; ignored otherwise', () => {
    const base = { SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'a' };
    const has = (env: Record<string, string>) => getEliasWriteTools(env).some((t) => t.name === 'elias_container_create');
    assert(has({ ...base, SCOUT_ENV: 'test', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' }), 'test env + switch');
    assert(!has({ ...base, SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' }), 'no SCOUT_ENV');
    assert(!has({ ...base, SCOUT_ENV: 'production', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' }), 'SCOUT_ENV=production');
    assert(!has({ ...base, SCOUT_ENV: 'test' }), 'no switch');
    assert(!has({ ...base, SCOUT_ENV: 'test', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: '1' }), 'only the literal true');
    assert(!has({ ...base, SCOUT_ENV: 'TEST', SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES: 'true' }), 'only the literal test');
  });
  await test('evidence: verified-live without a valid evidence record does not register and is not "verified"', () => {
    const base: WriteBodyContract = { toolName: 'elias_container_create', opKey: 'containers.import', bodyStatus: 'verified-live' };
    const cfg = loadEliasWriteConfig({ SCOUT_ENABLE_PRIVATE_ENDPOINTS: 'true', SCOUT_ELIAS_WRITES: 'a' });
    assert(!isBodyVerifiedLive(base.toolName, [base]), 'no evidence');
    assert(!evaluateRegistration(base.toolName, 'A', cfg, [base]).registered, 'registration without evidence');
    const bad = { ...base, fixture: 'x.json', evidence: { date: '2026-11-24', captureId: 'cap-001', fixtureSha256: 'nothex' } };
    assert(!hasValidEvidence(bad), 'bad hash');
    assert(!evaluateRegistration(base.toolName, 'A', cfg, [bad]).registered, 'bad evidence');
    const good: WriteBodyContract = { ...base, fixture: 'x.json', evidence: { date: '2026-11-24', captureId: 'cap-001', fixtureSha256: 'a'.repeat(64) } };
    assert(hasValidEvidence(good), 'good evidence');
    const reg = evaluateRegistration(base.toolName, 'A', cfg, [good]);
    assert(reg.registered && reg.unverified === false, 'verified-live registers as verified');
    const stat = { ...good, bodyStatus: 'har-only' as const };
    assert(!isBodyVerifiedLive(base.toolName, [stat]), 'har-only is not verified-live');
  });
  await test('every verified-live contract has a fixture whose sha256 matches and whose shape equals the builder output (test 19)', () => {
    const dir = new URL('./fixtures/elias/contracts/', import.meta.url).pathname;
    for (const c of WRITE_BODY_CONTRACTS.filter((x) => x.bodyStatus === 'verified-live')) {
      assert(hasValidEvidence(c), `${c.toolName} evidence`);
      const fixture = JSON.parse(readFileSync(join(dir, c.fixture!), 'utf-8')) as Array<Record<string, unknown>>;
      assert(sha256Hex(canonicalJson(fixture)) === c.evidence!.fixtureSha256, `${c.toolName} fixture sha`);
    }
  });
  await test('builder output equals a scrubbed contract fixture (mechanism check with a synthetic fixture)', () => {
    const built = buildContainerCreateRequest('MCPTEST-20261124-abcdef01');
    const scrubbed = scrubCapture([{ method: built.method, url: `https://lab.invalid${built.path}`, requestBody: built.body, status: 201, responseBody: { id: CID } }]);
    const fixtureDir = mkdtempSync(join(tmpdir(), 'elias-fixture-'));
    writeFileSync(join(fixtureDir, 'c.json'), scrubbed.json);
    const fixture = JSON.parse(readFileSync(join(fixtureDir, 'c.json'), 'utf-8')) as Array<{ method: string; pathTemplate: string; requestShape: unknown }>;
    assert(sha256Hex(canonicalJson(fixture)) === scrubbed.fixtureSha256, 'sha over the committed bytes');
    assert(fixture[0].method === built.method && fixture[0].pathTemplate === built.op.template, 'method/template');
    const again = scrubCapture([{ method: built.method, url: `https://lab.invalid${built.path}`, requestBody: built.body, status: 201 }]);
    assert(canonicalJson(again.contracts[0].requestShape) === canonicalJson(fixture[0].requestShape), 'request shape equals fixture');
    const tampered = scrubCapture([{ method: 'POST', url: `https://lab.invalid${built.path}`, requestBody: { name: 'x', extra: 1 }, status: 201 }]);
    assert(canonicalJson(tampered.contracts[0].requestShape) !== canonicalJson(fixture[0].requestShape), 'a different body shape is detected');
  });

  console.log('static source checks (C1, C14)');
  const files = walk(SRC);
  await test('mintMutationToken is referenced only by the pipeline and its own module', () => {
    for (const f of files) {
      const rel = f.slice(SRC.length);
      if (['elias/token.ts', 'elias/pipeline.ts'].includes(rel)) continue;
      assert(!/mintMutationToken/.test(readFileSync(f, 'utf-8')), `${rel} references mintMutationToken`);
    }
  });
  await test('the write tool module never touches the client raw methods; only pipeline/client use them in src/elias', () => {
    assert(!/rawRequest/.test(readFileSync(join(SRC, 'tools/elias_write.ts'), 'utf-8')), 'tools/elias_write.ts uses rawRequest');
    for (const f of files.filter((x) => x.includes('/src/elias/'))) {
      const rel = f.slice(SRC.length);
      const text = readFileSync(f, 'utf-8');
      assert(!/rawRequestBytes/.test(text), `${rel} references rawRequestBytes`);
      if (!['elias/pipeline.ts', 'elias/container-create.ts'].includes(rel)) assert(!/rawRequest\s*[<(]/.test(text), `${rel} calls rawRequest`);
      assert(!/rawRequest\s*(<[^>]*>)?\s*\(\s*['"`](POST|PUT|DELETE|PATCH)/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')) || rel === 'elias/pipeline.ts', `${rel} sends a non-GET`);
    }
    const create = readFileSync(join(SRC, 'elias/container-create.ts'), 'utf-8');
    assert(!/rawRequest\s*(<[^>]*>)?\s*\(\s*['"`](POST|PUT|DELETE|PATCH)/.test(create), 'container-create sends only GET reads');
  });
  await test('no src file sends a non-GET to a certificates / signing / trust path', () => {
    const re = /['"`](POST|PUT|DELETE|PATCH)['"`]\s*,[^;]{0,200}?(certificates|signing|trust)/;
    for (const f of files) {
      const rel = f.slice(SRC.length);
      assert(!re.test(readFileSync(f, 'utf-8')), `${rel} has a non-GET to a Tier C path`);
    }
  });
  await test('no src file defines a generic request tool (a name with path/method params)', () => {
    for (const f of files.filter((x) => x.includes('/src/tools/'))) {
      const text = readFileSync(f, 'utf-8');
      assert(!/name:\s*['"](elias_)?(raw_?request|proxy|call_api|http_request)['"]/.test(text), `${f} defines a proxy-like tool`);
    }
  });
  await test('.gitignore lists *.har and *.har.json (C13)', () => {
    const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf-8').split('\n').map((l) => l.trim());
    assert(gi.includes('*.har') && gi.includes('*.har.json'), '.gitignore');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
