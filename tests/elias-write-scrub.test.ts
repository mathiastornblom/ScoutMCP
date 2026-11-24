/**
 * Offline tests for the fixture scrubber and the repo-wide secret scan (Security C13).
 * Synthetic secrets are assembled at runtime so no credential-looking literal sits in this file.
 *
 * Run with: npx tsx tests/elias-write-scrub.test.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { scanForSecrets, scrubCapture, toPathTemplate } from '../src/elias/fixture-scrub.js';

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

const ROOT = new URL('../', import.meta.url).pathname;

// Synthetic secret material, built from parts.
const FAKE_PW = ['hunter', '2', '-FAKE-', 'pw'].join('');
const FAKE_JWT = [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), ['eyJ', 'zdWIiOiJ4eHh4In0'].join(''), 'c2lnbmF0dXJl'].join('.');
const FAKE_COOKIE = `ScoutBoardAuthJWT=${FAKE_JWT}`;
const FAKE_HOST = ['scout01', 'lab', 'example', 'net'].join('.');
const FAKE_MAIL = ['admin', ['corp', 'example', 'com'].join('.')].join('@');
const GUID = '11111111-2222-3333-4444-555555555555';
const FAKE_NAME = 'MCPTEST-20261124-abcdef01';

function har(): unknown {
  const e = (method: string, url: string, req?: unknown, status = 200, res?: unknown) => ({
    request: {
      method,
      url,
      headers: [{ name: 'Cookie', value: FAKE_COOKIE }, { name: 'Authorization', value: `Bearer ${FAKE_JWT}` }],
      postData: req === undefined ? undefined : { text: JSON.stringify(req) },
    },
    response: { status, content: { text: res === undefined ? '' : JSON.stringify(res) } },
  });
  return {
    log: {
      entries: [
        e('POST', `https://${FAKE_HOST}/rest/auth/v1/login`, { loginData64: Buffer.from(FAKE_PW).toString('base64'), username: FAKE_MAIL, password: FAKE_PW }, 200, { token: FAKE_JWT }),
        e('POST', `https://${FAKE_HOST}:22160/api/v1/containers/import?debug=1&token=${FAKE_JWT}`, { name: FAKE_NAME, owner: FAKE_MAIL, password: FAKE_PW, signaturePEM: 'x', nested: { apiKey: 'k', depth: [{ a: 1 }] } }, 201, { id: GUID, token: FAKE_JWT }),
        e('PUT', `https://${FAKE_HOST}/api/v1/images/${GUID}/some-Image.epm`, { enabled: true, count: 3 }, 200),
        e('POST', `https://${FAKE_HOST}/api/v1/certificates/sign/${GUID}/idf1`, { pfx: 'x' }, 200),
        e('POST', `https://${FAKE_HOST}/api/v1/certificates/${GUID}/signing-upload-key`, {}, 200),
        e('GET', `https://${FAKE_HOST}/api/v1/containers`, undefined, 200, [{ id: GUID, name: 'uc-elux7-2507' }]),
      ],
    },
  };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|md|json|txt|ya?ml|csv|har)$/i.test(f)) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  console.log('scanForSecrets');
  await test('detects JWT, cookie, authorization, password, login data, PEM (non-strict) and email/host/IP (strict)', () => {
    assert(scanForSecrets(FAKE_JWT).includes('jwt'), 'jwt');
    assert(scanForSecrets(`Cookie: ${FAKE_COOKIE}`).includes('cookie-value'), 'cookie');
    assert(scanForSecrets(FAKE_COOKIE).includes('session-cookie-value'), 'session cookie');
    assert(scanForSecrets(`Authorization: Bearer ${FAKE_JWT}`).includes('authorization-value'), 'authorization');
    assert(scanForSecrets(`{"password": "${FAKE_PW}"}`).includes('password-value'), 'password json');
    assert(scanForSecrets(`password = '${FAKE_PW}'`).includes('password-value'), 'password assignment');
    assert(scanForSecrets(`"loginData64": "${Buffer.from(FAKE_PW + FAKE_PW).toString('base64')}"`).includes('login-data'), 'login data');
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----\n', 'A'.repeat(64), '\n-----END ', 'PRIVATE KEY-----'].join('');
    assert(scanForSecrets(pem).includes('pem'), 'pem');
    assert(scanForSecrets(FAKE_MAIL).length === 0 && scanForSecrets(FAKE_MAIL, { strict: true }).includes('email'), 'email strict only');
    assert(scanForSecrets(FAKE_HOST, { strict: true }).includes('hostname'), 'hostname strict');
    assert(scanForSecrets('10.1.2.3', { strict: true }).includes('ipv4'), 'ipv4 strict');
  });
  await test('placeholders and code are not flagged (type words, template expressions)', () => {
    for (const ok of ['"password": "string"', '"password": "redacted"', 'Authorization: `Bearer ${this.token}`', 'Cookie: `ScoutBoardAuthJWT=${this.token}`', "password: this.config.password ?? ''", 'the password is rotated', 'eyJ short']) {
      assert(scanForSecrets(ok).length === 0, `false positive on: ${ok}`);
    }
  });

  console.log('scrubCapture (allow-list extraction)');
  const result = scrubCapture(har());
  await test('output contains method, path template, key names, types and status', () => {
    const c = result.contracts.find((x) => x.pathTemplate === '/api/v1/containers/import')!;
    assert(c.method === 'POST' && c.status === 201, 'method/status');
    assert(JSON.stringify(c.queryKeys) === '["debug"]', 'query key names only, credential-like key dropped');
    const req = c.requestShape as Record<string, unknown>;
    assert(req.name === 'string' && req.owner === 'string', 'types');
    assert(JSON.stringify((req.nested as Record<string, unknown>).depth) === '[{"a":"integer"}]', 'nested arrays keep a shape');
    const put = result.contracts.find((x) => x.method === 'PUT')!;
    assert(put.pathTemplate === '/api/v1/images/{guid}/{x}', `template ${put.pathTemplate}`);
    assert(JSON.stringify(put.requestShape) === '{"count":"integer","enabled":"boolean"}', 'shape');
    const resp = result.contracts.find((x) => x.method === 'GET')!;
    assert(JSON.stringify(resp.responseShape) === '[{"id":"string","name":"string"}]', 'response shape');
  });
  await test('output contains NO password, token, cookie, host, e-mail, guid value, container name or base64 login data', () => {
    const out = result.json;
    for (const secret of [FAKE_PW, FAKE_JWT, FAKE_COOKIE, FAKE_HOST, FAKE_MAIL, GUID, FAKE_NAME, 'uc-elux7-2507', Buffer.from(FAKE_PW).toString('base64'), 'Bearer', 'Cookie']) {
      assert(!out.includes(secret), `leaked: ${secret.slice(0, 20)}`);
    }
    assert(scanForSecrets(out, { strict: true }).length === 0, 'strict scan clean');
  });
  await test('credential-like keys are omitted from shapes (password, signaturePEM, apiKey, token)', () => {
    const out = result.json;
    for (const k of ['password', 'signaturePEM', 'apiKey', '"token"', 'pfx']) assert(!out.includes(k), `key present: ${k}`);
    assert(result.omittedKeys >= 4, `omittedKeys=${result.omittedKeys}`);
  });
  await test('authentication exchanges and Tier C traffic are skipped, and counted', () => {
    assert(result.skipped.auth === 1, `auth ${result.skipped.auth}`);
    assert(result.skipped.tierC === 2, `tierC ${result.skipped.tierC}`);
    assert(!result.contracts.some((c) => /certificates|sign|login/.test(c.pathTemplate)), 'no such template emitted');
  });
  await test('the fixture hash is stable and covers the contract content', () => {
    const again = scrubCapture(har());
    assert(again.fixtureSha256 === result.fixtureSha256 && /^[0-9a-f]{64}$/.test(result.fixtureSha256), 'stable sha');
    const h = har() as { log: { entries: Array<{ request: { postData?: { text: string } } }> } };
    h.log.entries[2].request.postData = { text: JSON.stringify({ enabled: true, count: 3, extra: 'x' }) };
    assert(scrubCapture(h).fixtureSha256 !== result.fixtureSha256, 'a new key changes the hash');
  });
  await test('toPathTemplate: ids, numbers and odd segments become placeholders; host and values dropped', () => {
    const t = toPathTemplate(`https://${FAKE_HOST}/api/v1/files/upload/${GUID}/chunk?x-chunk-index=3`);
    assert(t.pathTemplate === '/api/v1/files/upload/{guid}/chunk' && JSON.stringify(t.queryKeys) === '["x-chunk-index"]', JSON.stringify(t));
    assert(toPathTemplate('/api/v1/lock/set').pathTemplate === '/api/v1/lock/set', 'static path unchanged');
    assert(toPathTemplate('/api/v1/a/12345').pathTemplate === '/api/v1/a/{int}', 'integer');
    assert(toPathTemplate(`/api/v1/x/${FAKE_MAIL}`).pathTemplate === '/api/v1/x/{x}', 'e-mail segment');
  });
  await test('CLI: scripts/scrub-fixture.ts writes only the scrubbed contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-cli-'));
    const input = join(dir, 'capture.json');
    const output = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(har()));
    execFileSync('npx', ['tsx', join(ROOT, 'scripts/scrub-fixture.ts'), input, output], { cwd: ROOT, stdio: 'pipe' });
    const text = readFileSync(output, 'utf-8');
    assert(scanForSecrets(text, { strict: true }).length === 0 && !text.includes(FAKE_PW) && !text.includes(FAKE_HOST), 'clean output');
    assert(JSON.parse(text).length === result.contracts.length, 'same contracts');
  });

  console.log('repo scan (C13)');
  await test('no password / JWT / cookie / authorization value / PEM in tests/fixtures, docs, .agents, src, scripts', () => {
    const offenders: string[] = [];
    for (const dir of ['tests/fixtures', 'docs', '.agents', 'src', 'scripts']) {
      for (const f of walk(join(ROOT, dir))) {
        const found = scanForSecrets(readFileSync(f, 'utf-8'));
        if (found.length > 0) offenders.push(`${relative(ROOT, f)} (${found.join(', ')})`);
      }
    }
    assert(offenders.length === 0, `secret-like content in: ${offenders.join('; ')}`);
  });
  await test('no HAR file is tracked or present in the repository tree', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' }).split('\n');
    assert(!tracked.some((p) => /\.har(\.json)?$/i.test(p)), 'a HAR file is tracked');
    const ignored = execFileSync('git', ['check-ignore', '-q', 'capture.har'], { cwd: ROOT, stdio: 'pipe' });
    assert(ignored !== undefined, '*.har is ignored');
  });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
