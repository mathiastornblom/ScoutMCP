/**
 * Unit tests for the startup-auth cleanup:
 *   - login timeout headroom (direct login and the Citrix exchange step) vs the default
 *     request timeout, against an in-process HTTPS stand-in
 *   - shouldClearCredentialsAfterAuthFailure decision helper
 *
 * Run with: npx tsx tests/startup-auth.test.ts
 * Offline only — never touches a real Scout or Citrix Cloud endpoint.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScoutClient, ScoutError } from '../src/client.js';
import type { ScoutConfig } from '../src/session.js';
import { shouldClearCredentialsAfterAuthFailure } from '../src/startup_auth.js';

// Default request timeout is shrunk so the headroom is observable without a 90s wait.
process.env.SCOUT_REQUEST_TIMEOUT_MS = '200';
const DELAY_MS = 600;

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

function fakeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
  return `h.${payload}.s`;
}

// Per-endpoint behaviour of the stand-in: delay then status.
const behaviour = {
  login: { delay: 0, status: 200 },
  mint: { delay: 0, status: 200 },
  exchange: { delay: 0, status: 200 },
};
function resetBehaviour(): void {
  behaviour.login = { delay: 0, status: 200 };
  behaviour.mint = { delay: 0, status: 200 };
  behaviour.exchange = { delay: 0, status: 200 };
}

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'scout-mcp-startup-auth-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return new Promise((resolve) => {
    const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
      req.resume();
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'https://localhost').pathname;
        let b: { delay: number; status: number } | null = null;
        let okBody = '{}';
        if (path === '/rest/auth/v1/login') {
          b = behaviour.login;
          okBody = JSON.stringify({ token: fakeJwt() });
        } else if (path.startsWith('/cctrustoauth2/')) {
          b = behaviour.mint;
          okBody = JSON.stringify({ access_token: randomUUID(), expires_in: '3600' });
        } else if (path === '/rest/auth/v1/ccauth/login') {
          b = behaviour.exchange;
          okBody = JSON.stringify({ token: fakeJwt() });
        }
        const send = (): void => {
          res.setHeader('Content-Type', 'application/json');
          if (!b) {
            res.statusCode = 404;
            res.end('{}');
            return;
          }
          res.statusCode = b.status;
          res.end(b.status === 200 ? okBody : JSON.stringify({ message: 'rejected' }));
        };
        setTimeout(send, b?.delay ?? 0);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `https://127.0.0.1:${port}` });
    });
  });
}

function pwConfig(baseUrl: string): ScoutConfig {
  return { baseUrl, ignoreTls: true, username: 'u', password: randomUUID() };
}
function ccConfig(baseUrl: string): ScoutConfig {
  return {
    baseUrl,
    authMethod: 'citrix-cloud',
    ignoreTls: true,
    ccClientId: randomUUID(),
    ccClientSecret: randomUUID(),
    ccCustomerId: 'acme',
    ccTokenUrl: `${baseUrl}/cctrustoauth2/acme/tokens/clients`,
  };
}

async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof ScoutError, `expected ScoutError, got ${String(e)}`);
    return e.statusCode;
  }
  throw new Error('expected a rejection');
}

async function main(): Promise<void> {
  const { server, baseUrl } = await startServer();

  console.log('\nLogin timeout headroom');

  await test('password login tolerates a response slower than the default timeout', async () => {
    resetBehaviour();
    behaviour.login.delay = DELAY_MS;
    const c = new ScoutClient(pwConfig(baseUrl));
    await c.login();
    assert(c.isAuthenticated(), 'authenticated after delayed login');
  });

  await test('password login ScoutError carries 401 and 500 after a slow response', async () => {
    for (const status of [401, 500]) {
      resetBehaviour();
      behaviour.login = { delay: DELAY_MS, status };
      const got = await statusOf(() => new ScoutClient(pwConfig(baseUrl)).login());
      assert(got === status, `expected ${status}, got ${String(got)}`);
    }
  });

  await test('citrix exchange step tolerates a response slower than the default timeout', async () => {
    resetBehaviour();
    behaviour.exchange.delay = DELAY_MS;
    const c = new ScoutClient(ccConfig(baseUrl));
    await c.login();
    assert(c.isAuthenticated(), 'authenticated after delayed exchange');
  });

  await test('citrix exchange ScoutError carries 401 and 500 after a slow response', async () => {
    for (const status of [401, 500]) {
      resetBehaviour();
      behaviour.exchange = { delay: DELAY_MS, status };
      const got = await statusOf(() => new ScoutClient(ccConfig(baseUrl)).login());
      assert(got === status, `expected ${status}, got ${String(got)}`);
    }
  });

  await test('citrix mint step still times out at the default timeout', async () => {
    resetBehaviour();
    behaviour.mint.delay = DELAY_MS;
    const c = new ScoutClient(ccConfig(baseUrl));
    let threw = false;
    try {
      await c.login();
    } catch {
      threw = true;
    }
    assert(threw, 'mint step should time out');
    assert(!c.isAuthenticated(), 'not authenticated after mint timeout');
  });

  console.log('\nshouldClearCredentialsAfterAuthFailure');

  const captured: ScoutConfig = { baseUrl: 'https://scout.example:22160', username: 'u', password: randomUUID() };
  const same: ScoutConfig = { ...captured };
  const replaced: ScoutConfig = { ...captured, username: 'other' };

  await test('clears on 400/401/403 when config unchanged', () => {
    for (const s of [400, 401, 403]) {
      assert(shouldClearCredentialsAfterAuthFailure(new ScoutError('x', s), captured, same), `status ${s}`);
    }
  });

  await test('keeps on timeout, network error and 5xx', () => {
    assert(!shouldClearCredentialsAfterAuthFailure(new ScoutError('timeout'), captured, same), 'no status');
    assert(!shouldClearCredentialsAfterAuthFailure(new Error('ECONNRESET'), captured, same), 'network');
    assert(!shouldClearCredentialsAfterAuthFailure(new ScoutError('x', 500), captured, same), '500');
    assert(!shouldClearCredentialsAfterAuthFailure(new ScoutError('x', 503), captured, same), '503');
  });

  await test('keeps when config was replaced via scout_configure', () => {
    assert(!shouldClearCredentialsAfterAuthFailure(new ScoutError('x', 401), captured, replaced), 'replaced');
  });

  await test('keeps when config was already cleared', () => {
    assert(!shouldClearCredentialsAfterAuthFailure(new ScoutError('x', 401), captured, null), 'cleared');
  });

  server.close();
  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
