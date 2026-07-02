/**
 * Unit tests for Citrix Cloud service-principal auth (SCOUT_AUTH=citrix-cloud).
 *
 * Covers:
 *   - config resolution from env vars (and password mode unchanged when SCOUT_AUTH unset)
 *   - missing-field validation errors
 *   - token URL construction: region map, staging /root/ quirk, ccTokenUrl precedence
 *   - login flow against an in-process HTTPS stand-in: form-urlencoded mint body,
 *     standard `Bearer` (not `CwsAuth Bearer=`) exchange header, string expires_in
 *   - failure mapping for 401/403 on mint and exchange
 *   - 401 on an API call triggers a full re-mint (both steps) and the retry succeeds
 *
 * Run with: npx tsx tests/ccauth.test.ts
 * Offline only — never touches a real Citrix Cloud or Scout endpoint.
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  resolveConfig,
  clearSessionConfig,
  buildCcTokenUrl,
  missingCcFields,
  type ScoutConfig,
} from '../src/session.js';
import { ScoutClient, ScoutError } from '../src/client.js';
import { configureTool } from '../src/tools/configure.js';

// ─── Minimal test harness ─────────────────────────────────────────────────────

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

const CC_ENV_KEYS = [
  'SCOUT_AUTH',
  'SCOUT_BASE_URL',
  'SCOUT_USERNAME',
  'SCOUT_PASSWORD',
  'SCOUT_DOMAIN',
  'SCOUT_IGNORE_TLS',
  'SCOUT_CC_CLIENT_ID',
  'SCOUT_CC_CLIENT_SECRET',
  'SCOUT_CC_CUSTOMER_ID',
  'SCOUT_CC_REGION',
  'SCOUT_CC_TOKEN_URL',
];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  clearSessionConfig();
  for (const k of CC_ENV_KEYS) delete process.env[k];
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function expectError(fn: () => Promise<unknown> | unknown, substr: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes(substr), `expected error containing "${substr}", got "${msg}"`);
    return;
  }
  throw new Error(`expected an error containing "${substr}", but nothing was thrown`);
}

// ─── Fake combined Citrix-Cloud + Scout Board stand-in server ─────────────────

interface RecordedRequest {
  method: string;
  path: string;
  contentType: string | undefined;
  authorization: string | undefined;
  body: string;
}

interface Scenario {
  mintStatus: number;
  exchangeStatus: number;
  /** Number of times an /rest/api call should 401 before succeeding. */
  apiUnauthorizedCount: number;
}

const scenario: Scenario = { mintStatus: 200, exchangeStatus: 200, apiUnauthorizedCount: 0 };
let recorded: RecordedRequest[] = [];

function resetScenario(): void {
  scenario.mintStatus = 200;
  scenario.exchangeStatus = 200;
  scenario.apiUnauthorizedCount = 0;
  recorded = [];
}

function fakeScoutJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
  return `header.${payload}.sig`;
}

function startFakeServer(): Promise<{ server: Server; baseUrl: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'scout-mcp-ccauth-certs-'));
  const keyPath = join(tmpDir, 'key.pem');
  const certPath = join(tmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });

  return new Promise((resolve) => {
    const server = createServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const path = new URL(req.url ?? '/', 'https://localhost').pathname;
          recorded.push({
            method: req.method ?? 'GET',
            path,
            contentType: req.headers['content-type'],
            authorization: req.headers['authorization'],
            body,
          });
          res.setHeader('Content-Type', 'application/json');

          // Citrix Cloud token endpoint stand-in
          if (path.startsWith('/cctrustoauth2/')) {
            if (scenario.mintStatus !== 200) {
              res.statusCode = scenario.mintStatus;
              res.end(JSON.stringify({ error: 'mint failed' }));
              return;
            }
            // expires_in is intentionally a STRING, matching the real CC response.
            res.end(
              JSON.stringify({
                token_type: 'bearer',
                access_token: 'cc-token-abc123',
                expires_in: '3600',
              }),
            );
            return;
          }

          // Scout Board ccauth exchange stand-in
          if (path === '/rest/auth/v1/ccauth/login') {
            if (scenario.exchangeStatus !== 200) {
              res.statusCode = scenario.exchangeStatus;
              res.end(JSON.stringify({ message: 'exchange failed' }));
              return;
            }
            res.end(
              JSON.stringify({
                token: fakeScoutJwt(),
                user: { email: 'sp-client-id', displayName: 'SP Name' },
              }),
            );
            return;
          }

          // Generic API endpoint used by the 401-retry test
          if (path === '/rest/api/v1/ping') {
            if (scenario.apiUnauthorizedCount > 0) {
              scenario.apiUnauthorizedCount -= 1;
              res.statusCode = 401;
              res.end(JSON.stringify({ message: 'token expired' }));
              return;
            }
            res.end(JSON.stringify({ pong: true }));
            return;
          }

          res.statusCode = 404;
          res.end(JSON.stringify({ message: 'not found' }));
        });
      },
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `https://127.0.0.1:${port}` });
    });
  });
}

function ccConfig(baseUrl: string): ScoutConfig {
  return {
    baseUrl,
    authMethod: 'citrix-cloud',
    ignoreTls: true,
    ccClientId: 'client-uuid',
    ccClientSecret: 'shh-secret',
    ccCustomerId: 'acme',
    // Point the "Citrix Cloud" token endpoint at the same stand-in server.
    ccTokenUrl: `${baseUrl}/cctrustoauth2/acme/tokens/clients`,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nToken URL construction');

  await test('region map builds the right URL per region', () => {
    const base: ScoutConfig = {
      baseUrl: 'https://scout:22160',
      authMethod: 'citrix-cloud',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccCustomerId: 'cust1',
    };
    assert(
      buildCcTokenUrl({ ...base, ccRegion: 'us' }) ===
        'https://api-us.cloud.com/cctrustoauth2/cust1/tokens/clients',
      'us region',
    );
    assert(
      buildCcTokenUrl({ ...base, ccRegion: 'eu' }) ===
        'https://api-eu.cloud.com/cctrustoauth2/cust1/tokens/clients',
      'eu region',
    );
    assert(
      buildCcTokenUrl({ ...base, ccRegion: 'ap-s' }) ===
        'https://api-ap-s.cloud.com/cctrustoauth2/cust1/tokens/clients',
      'ap-s region',
    );
    assert(
      buildCcTokenUrl({ ...base, ccRegion: 'jp' }) ===
        'https://api.citrixcloud.jp/cctrustoauth2/cust1/tokens/clients',
      'jp region',
    );
  });

  await test('staging region substitutes /root/ for the customer id', () => {
    const url = buildCcTokenUrl({
      baseUrl: 'https://scout:22160',
      authMethod: 'citrix-cloud',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccRegion: 'staging',
    });
    assert(
      url === 'https://api.cloudburrito.com/cctrustoauth2/root/tokens/clients',
      `staging URL uses /root/, got ${url}`,
    );
  });

  await test('ccTokenUrl override takes precedence over region+customer', () => {
    const url = buildCcTokenUrl({
      baseUrl: 'https://scout:22160',
      authMethod: 'citrix-cloud',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccCustomerId: 'cust1',
      ccRegion: 'us',
      ccTokenUrl: 'https://custom.example.com/token',
    });
    assert(url === 'https://custom.example.com/token', 'override wins');
  });

  console.log('\nConfig resolution');

  await test('password mode unchanged when SCOUT_AUTH unset', () => {
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_USERNAME = 'admin@example.com';
    process.env.SCOUT_PASSWORD = 'pw';
    process.env.SCOUT_DOMAIN = 'dom';
    const cfg = resolveConfig();
    assert(cfg !== null, 'config resolves');
    assert(cfg.authMethod === undefined, 'no authMethod set in password env mode');
    assert(cfg.username === 'admin@example.com' && cfg.password === 'pw', 'creds preserved');
    assert(cfg.domain === 'dom', 'domain preserved');
  });

  await test('citrix-cloud mode resolves from env vars without username/password', () => {
    process.env.SCOUT_AUTH = 'citrix-cloud';
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_CC_CLIENT_ID = 'client-uuid';
    process.env.SCOUT_CC_CLIENT_SECRET = 'secret';
    process.env.SCOUT_CC_CUSTOMER_ID = 'acme';
    process.env.SCOUT_CC_REGION = 'eu';
    const cfg = resolveConfig();
    assert(cfg !== null, 'config resolves');
    assert(cfg.authMethod === 'citrix-cloud', 'authMethod is citrix-cloud');
    assert(cfg.ccClientId === 'client-uuid' && cfg.ccRegion === 'eu', 'cc fields resolved');
    assert(cfg.username === undefined && cfg.password === undefined, 'no username/password needed');
  });

  await test('citrix-cloud mode with missing fields fails with a clear message', async () => {
    process.env.SCOUT_AUTH = 'citrix-cloud';
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_CC_CLIENT_ID = 'client-uuid';
    // secret, customer/region/tokenUrl all missing
    await expectError(() => resolveConfig(), 'Missing');
    await expectError(() => resolveConfig(), 'SCOUT_CC_CLIENT_SECRET');
    await expectError(() => resolveConfig(), 'SCOUT_CC_REGION');
  });

  await test('citrix-cloud non-staging region without customer id is invalid', () => {
    const missing = missingCcFields({
      baseUrl: 'https://scout:22160',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccRegion: 'us',
    });
    assert(missing.length === 1 && missing[0]!.includes('ccCustomerId'), 'customerId flagged');
  });

  await test('citrix-cloud staging region needs no customer id', () => {
    const missing = missingCcFields({
      baseUrl: 'https://scout:22160',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccRegion: 'staging',
    });
    assert(missing.length === 0, `expected valid, missing: ${missing.join('; ')}`);
  });

  await test('invalid SCOUT_CC_REGION is rejected', async () => {
    process.env.SCOUT_AUTH = 'citrix-cloud';
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_CC_CLIENT_ID = 'a';
    process.env.SCOUT_CC_CLIENT_SECRET = 'b';
    process.env.SCOUT_CC_REGION = 'mars';
    await expectError(() => resolveConfig(), 'Invalid SCOUT_CC_REGION');
  });

  await test('http:// ccTokenUrl is rejected via env path (fails closed)', async () => {
    process.env.SCOUT_AUTH = 'citrix-cloud';
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_CC_CLIENT_ID = 'a';
    process.env.SCOUT_CC_CLIENT_SECRET = 'b';
    process.env.SCOUT_CC_TOKEN_URL = 'http://evil.example.com/token';
    await expectError(() => resolveConfig(), 'ccTokenUrl (SCOUT_CC_TOKEN_URL) must start with https://');
  });

  await test('http:// ccTokenUrl is rejected via scout_configure path', async () => {
    const result = await configureTool.execute({
      action: 'set',
      authMethod: 'citrix-cloud',
      baseUrl: 'https://scout:22160',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccTokenUrl: 'http://evil.example.com/token',
      test: false,
    });
    assert(result.isError === true, 'scout_configure rejects http:// ccTokenUrl');
    const text = result.content[0]?.text ?? '';
    assert(
      text.includes('ccTokenUrl (SCOUT_CC_TOKEN_URL) must start with https://'),
      `error names the offending field, got "${text}"`,
    );
  });

  await test('https:// ccTokenUrl is accepted unchanged on all paths', async () => {
    // Validation helper accepts it
    const missing = missingCcFields({
      baseUrl: 'https://scout:22160',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccTokenUrl: 'https://custom.example.com/token',
    });
    assert(missing.length === 0, `expected valid, missing: ${missing.join('; ')}`);
    // buildCcTokenUrl returns it verbatim
    const url = buildCcTokenUrl({
      baseUrl: 'https://scout:22160',
      authMethod: 'citrix-cloud',
      ccClientId: 'a',
      ccClientSecret: 'b',
      ccTokenUrl: 'https://custom.example.com/token',
    });
    assert(url === 'https://custom.example.com/token', 'https URL passes through unchanged');
    // Env path resolves it
    process.env.SCOUT_AUTH = 'citrix-cloud';
    process.env.SCOUT_BASE_URL = 'https://scout:22160';
    process.env.SCOUT_CC_CLIENT_ID = 'a';
    process.env.SCOUT_CC_CLIENT_SECRET = 'b';
    process.env.SCOUT_CC_TOKEN_URL = 'https://custom.example.com/token';
    const cfg = resolveConfig();
    assert(cfg !== null && cfg.ccTokenUrl === 'https://custom.example.com/token', 'env path accepts https ccTokenUrl');
  });

  await test('buildCcTokenUrl throws on non-https ccTokenUrl (defense in depth)', async () => {
    await expectError(
      () =>
        buildCcTokenUrl({
          baseUrl: 'https://scout:22160',
          authMethod: 'citrix-cloud',
          ccClientId: 'a',
          ccClientSecret: 'b',
          ccTokenUrl: 'http://evil.example.com/token',
        }),
      'must start with https://',
    );
  });

  console.log('\nLogin flow (HTTPS stand-in)');

  const { server, baseUrl } = await startFakeServer();

  await test('successful mint+exchange stores the Scout JWT', async () => {
    resetScenario();
    const client = new ScoutClient(ccConfig(baseUrl));
    await client.login();
    assert(client.isAuthenticated(), 'client authenticated after login');
    const expiry = client.tokenExpiry();
    assert(expiry !== null && expiry > Date.now(), 'expiry parsed from Scout JWT');
  });

  await test('mint request body is form-urlencoded with the right fields', async () => {
    resetScenario();
    const client = new ScoutClient(ccConfig(baseUrl));
    await client.login();
    const mint = recorded.find((r) => r.path.startsWith('/cctrustoauth2/'));
    assert(mint !== undefined, 'mint request received');
    assert(
      (mint.contentType ?? '').startsWith('application/x-www-form-urlencoded'),
      `mint content-type is form-urlencoded, got ${mint.contentType}`,
    );
    const params = new URLSearchParams(mint.body);
    assert(params.get('grant_type') === 'client_credentials', 'grant_type present');
    assert(params.get('client_id') === 'client-uuid', 'client_id present');
    assert(params.get('client_secret') === 'shh-secret', 'client_secret present');
  });

  await test('exchange uses standard Bearer prefix (not CwsAuth Bearer=)', async () => {
    resetScenario();
    const client = new ScoutClient(ccConfig(baseUrl));
    await client.login();
    const exchange = recorded.find((r) => r.path === '/rest/auth/v1/ccauth/login');
    assert(exchange !== undefined, 'exchange request received');
    assert(
      exchange.authorization === 'Bearer cc-token-abc123',
      `exact header "Bearer <cc_token>" expected, got "${exchange.authorization}"`,
    );
  });

  await test('string expires_in in the mint response does not break login', async () => {
    // The stand-in always returns expires_in: "3600" (a string) — this test just
    // makes the invariant explicit: login succeeds and a usable expiry is stored.
    resetScenario();
    const client = new ScoutClient(ccConfig(baseUrl));
    await client.login();
    assert(client.isAuthenticated(), 'authenticated despite string expires_in');
  });

  console.log('\nFailure mapping');

  await test('401 on mint → check client_id/secret and region', async () => {
    resetScenario();
    scenario.mintStatus = 401;
    const client = new ScoutClient(ccConfig(baseUrl));
    await expectError(() => client.login(), 'check client_id/secret and region');
  });

  await test('403 on mint → region mismatch message', async () => {
    resetScenario();
    scenario.mintStatus = 403;
    const client = new ScoutClient(ccConfig(baseUrl));
    await expectError(
      () => client.login(),
      "token endpoint region doesn't match the service principal's tenant region",
    );
  });

  await test('400 on mint → body-encoding hint', async () => {
    resetScenario();
    scenario.mintStatus = 400;
    const client = new ScoutClient(ccConfig(baseUrl));
    await expectError(() => client.login(), 'body-encoding');
  });

  await test('401 on exchange → server-side CC configuration message', async () => {
    resetScenario();
    scenario.exchangeStatus = 401;
    const client = new ScoutClient(ccConfig(baseUrl));
    await expectError(
      () => client.login(),
      'Scout Board could not validate the Citrix Cloud token',
    );
  });

  await test('403 on exchange → service principal not registered message', async () => {
    resetScenario();
    scenario.exchangeStatus = 403;
    const client = new ScoutClient(ccConfig(baseUrl));
    await expectError(
      () => client.login(),
      'add its client_id under Users with Login + WebService rights',
    );
    try {
      await new ScoutClient(ccConfig(baseUrl)).login();
    } catch (e) {
      assert(e instanceof ScoutError && e.statusCode === 403, 'ScoutError with statusCode 403');
    }
  });

  console.log('\n401 re-mint on API calls');

  await test('401 on an API call triggers full re-mint (both steps) and retry succeeds', async () => {
    resetScenario();
    const client = new ScoutClient(ccConfig(baseUrl));
    await client.login();
    const mintsAfterLogin = recorded.filter((r) => r.path.startsWith('/cctrustoauth2/')).length;
    const exchangesAfterLogin = recorded.filter(
      (r) => r.path === '/rest/auth/v1/ccauth/login',
    ).length;
    assert(mintsAfterLogin === 1 && exchangesAfterLogin === 1, 'one mint+exchange at login');

    scenario.apiUnauthorizedCount = 1; // next API call 401s once
    const result = await client.request<{ pong: boolean }>('GET', '/api/v1/ping');
    assert(result.pong === true, 'retried API call succeeded');

    const mints = recorded.filter((r) => r.path.startsWith('/cctrustoauth2/')).length;
    const exchanges = recorded.filter((r) => r.path === '/rest/auth/v1/ccauth/login').length;
    assert(mints === 2, `expected a second mint after 401, got ${mints}`);
    assert(exchanges === 2, `expected a second exchange after 401, got ${exchanges}`);
    const apiCalls = recorded.filter((r) => r.path === '/rest/api/v1/ping').length;
    assert(apiCalls === 2, `expected the API call to be retried, got ${apiCalls}`);
  });

  server.close();

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
