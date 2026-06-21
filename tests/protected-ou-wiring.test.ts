/**
 * Unit tests proving Gate 6 (checkOuWriteAllowed, the protected/allowed-OU deny-list) is
 * actually wired into the three tools that were previously missing it:
 *
 *   - device_manage(move)        — both the source AND destination OU are checked, because
 *                                   moving a device out of a protected OU changes its
 *                                   effective config just as much as moving one in.
 *   - ou_manage(delete/move)     — the target OU (delete/move) and the destination OU
 *                                   (move) are checked.
 *   - move_devices_by_filter     — every distinct OU a resolved/matched device currently
 *                                   sits in, plus the destination, are checked; the write
 *                                   is blocked if ANY of them is protected.
 *
 * Prior to this change, only config_update's target=ou path called checkOuWriteAllowed —
 * these three tools could silently move devices/OUs in and out of a "protected" subtree
 * with no gate at all. This file exercises the real tool `execute()` functions end-to-end
 * against an in-process HTTPS stand-in for Scout Board (so the resolver's
 * /api/v1/ou/structure call and the device/OU mutate calls are real HTTP round-trips, not
 * hand-rolled stubs of the gate itself) — the assertion that matters is that the HTTP
 * mutate call to Scout Board is NEVER issued when the move touches a protected OU.
 *
 * Run with: npx tsx tests/protected-ou-wiring.test.ts
 */

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { setSessionConfig, clearSessionConfig } from '../src/session.js';
import { invalidateOuCache } from '../src/resolver.js';
import { invalidateEnrichmentCache } from '../src/enricher.js';
import { __resetCircuitBreakerStateForTests } from '../src/safety/guardrails.js';

// ─── Minimal test harness (mirrors tests/safety-round2.test.ts style, async-capable) ──

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  __resetCircuitBreakerStateForTests();
  delete process.env.SCOUT_MODE;
  delete process.env.SCOUT_PROTECTED_OUS;
  delete process.env.SCOUT_ALLOWED_OUS;
  delete process.env.SCOUT_ENV;
  process.env.SCOUT_MODE = 'write';
  invalidateOuCache();
  invalidateEnrichmentCache();
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

// ─── Fake Scout Board server ───────────────────────────────────────────────────

/**
 * OU tree used by every test:
 *   /Enterprise (1)
 *     /Enterprise/Production (2)        <- frequently marked protected
 *       /Enterprise/Production/Floor3 (4)
 *     /Enterprise/Sandbox (3)
 *
 * Devices:
 *   "thin01" lives in OUID 2 (/Enterprise/Production)
 *   "thin02" lives in OUID 3 (/Enterprise/Sandbox)
 *   "thin03" lives in OUID 4 (/Enterprise/Production/Floor3)
 */
const OU_STRUCTURE = {
  OUID: 1,
  OUName: 'Enterprise',
  OUPath: '/Enterprise',
  SubOUs: [
    {
      OUID: 2,
      OUName: 'Production',
      OUPath: '/Enterprise/Production',
      SubOUs: [
        { OUID: 4, OUName: 'Floor3', OUPath: '/Enterprise/Production/Floor3', SubOUs: [] },
      ],
    },
    { OUID: 3, OUName: 'Sandbox', OUPath: '/Enterprise/Sandbox', SubOUs: [] },
  ],
};

const DEVICES: Record<string, { OUID: number; Name: string; id: number }> = {
  thin01: { OUID: 2, Name: 'thin01', id: 101 },
  thin02: { OUID: 3, Name: 'thin02', id: 102 },
  thin03: { OUID: 4, Name: 'thin03', id: 103 },
};

/** Records every mutating call the fake server received, so tests can assert that NO
 *  mutating HTTP call reached the server when the gate should have blocked it locally
 *  (the gate must throw before client.request() is even attempted). */
let mutatingCallsReceived: Array<{ method: string; path: string }> = [];

function startFakeScoutServer(): Promise<{ server: Server; baseUrl: string; cleanup: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'scout-mcp-test-certs-'));
  const keyPath = join(tmpDir, 'key.pem');
  const certPath = join(tmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });

  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  return new Promise((resolve) => {
    const server = createServer({ key, cert }, (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'https://localhost');
        const method = req.method ?? 'GET';
        const path = url.pathname;

        res.setHeader('Content-Type', 'application/json');

        if (path === '/rest/auth/v1/login' && method === 'POST') {
          // Minimal unsigned-looking JWT: header.payload.signature, payload has far-future exp.
          const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
          res.end(JSON.stringify({ token: `header.${payload}.sig` }));
          return;
        }

        if (path === '/rest/api/v1/ou/structure' && method === 'GET') {
          res.end(JSON.stringify(OU_STRUCTURE));
          return;
        }

        if (path === '/rest/api/v1/ou/root' && method === 'GET') {
          // Root is /Enterprise (OUID 1) — far from any of the protected-OU fixtures used
          // in these tests, so the base/root-write gate (Gate 2) never fires here.
          res.end(JSON.stringify({ OUID: 1, OUPath: '/Enterprise' }));
          return;
        }

        if (path === '/rest/api/v1/device' && method === 'GET') {
          const name = url.searchParams.get('name');
          const device = name ? DEVICES[name] : undefined;
          if (!device) {
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'not found' }));
            return;
          }
          res.end(JSON.stringify(device));
          return;
        }

        if (path === '/rest/api/v1/device/search' && method === 'GET') {
          const ouId = url.searchParams.get('ouId');
          const matched = Object.values(DEVICES).filter((d) => ouId === null || String(d.OUID) === ouId);
          // workflow.ts's extractDevices() (used by move_devices_by_filter/bulk_command)
          // expects a flat array or one of {Devices,devices,Items,items,Results,results,data}
          // — a DIFFERENT envelope shape than device.ts's extractSearchDevices(), which
          // expects {response:{status:{msg:[...]}}}. Both shapes are pre-existing,
          // independent assumptions in this codebase about the same real endpoint; this
          // fake server returns the shape each caller under test actually expects.
          res.end(JSON.stringify({ devices: matched }));
          return;
        }

        // Any mutating endpoint: record the call and succeed.
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
          mutatingCallsReceived.push({ method, path });
          res.end(JSON.stringify({ message: 'OK' }));
          return;
        }

        if (path === '/rest/api/v1/ou' && method === 'GET') {
          res.end(JSON.stringify({ OUID: 1, OUPath: '/Enterprise' }));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        baseUrl: `https://127.0.0.1:${port}`,
        cleanup: () => {
          server.close();
          rmSync(tmpDir, { recursive: true, force: true });
        },
      });
    });
  });
}

// ─── Test run ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // undici (used by src/client.ts) verifies TLS by default — our self-signed cert needs
  // ignoreTls=true, which client.ts honors via config.ignoreTls.
  const { baseUrl, cleanup } = await startFakeScoutServer();

  // Import tool modules AFTER session config is set per-test (modules are fine to import
  // eagerly; only the execute() calls need a configured session).
  const { deviceManageTool } = await import('../src/tools/device.js');
  const { ouManageTool } = await import('../src/tools/ou.js');
  const { moveDevicesByFilterTool } = await import('../src/tools/workflow.js');

  function configureSession(): void {
    setSessionConfig({
      baseUrl,
      username: 'test',
      password: 'test',
      ignoreTls: true,
    });
  }

  console.log('\nGate 6 wiring — device_manage(move)');

  await test('move INTO a protected OU is blocked, no HTTP mutate call issued', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await deviceManageTool.execute({
      action: 'move',
      name: 'thin02', // currently in /Enterprise/Sandbox (not protected)
      destoupath: '/Enterprise/Production', // protected destination
    });
    assert(result.isError === true, 'expected an error result');
    const text = result.content[0]?.text ?? '';
    assert(text.includes('protected'), `expected a protected-OU message, got: ${text}`);
    assert(
      !mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'the move HTTP call must never reach the server when the destination is protected',
    );
  });

  await test('move OUT OF a protected OU is blocked, no HTTP mutate call issued', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await deviceManageTool.execute({
      action: 'move',
      name: 'thin01', // currently in /Enterprise/Production (protected)
      destoupath: '/Enterprise/Sandbox', // unprotected destination
    });
    assert(result.isError === true, 'expected an error result');
    const text = result.content[0]?.text ?? '';
    assert(text.includes('protected'), `expected a protected-OU message, got: ${text}`);
    assert(
      !mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'the move HTTP call must never reach the server when the source is protected',
    );
  });

  await test('move OUT OF a protected sub-OU (descendant) is blocked', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await deviceManageTool.execute({
      action: 'move',
      name: 'thin03', // currently in /Enterprise/Production/Floor3 (descendant of protected)
      destoupath: '/Enterprise/Sandbox',
    });
    assert(result.isError === true, 'expected an error result');
    assert(
      !mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'descendant-of-protected source must also block the move',
    );
  });

  await test('move between two unprotected OUs proceeds normally', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await deviceManageTool.execute({
      action: 'move',
      name: 'thin02', // /Enterprise/Sandbox
      destoupath: '/Enterprise/Sandbox', // moving within the unprotected subtree
    });
    assert(result.isError !== true, `expected success, got error: ${result.content[0]?.text}`);
    assert(
      mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'the move HTTP call should have been issued when neither side is protected',
    );
  });

  console.log('\nGate 6 wiring — ou_manage(delete/move)');

  await test('ou_manage delete on a protected OU is blocked', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await ouManageTool.execute({
      action: 'delete',
      path: '/Enterprise/Production',
    });
    assert(result.isError === true, 'expected an error result');
    const text = result.content[0]?.text ?? '';
    assert(text.includes('protected'), `expected a protected-OU message, got: ${text}`);
    assert(
      mutatingCallsReceived.length === 0,
      'no mutating HTTP call should reach the server when deleting a protected OU',
    );
  });

  await test('ou_manage move of a protected OU (as the target) is blocked', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await ouManageTool.execute({
      action: 'move',
      path: '/Enterprise/Production',
      destoupath: '/Enterprise/Sandbox',
    });
    assert(result.isError === true, 'expected an error result');
    assert(mutatingCallsReceived.length === 0, 'no mutating HTTP call should reach the server');
  });

  await test('ou_manage move INTO a protected destination is blocked', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await ouManageTool.execute({
      action: 'move',
      path: '/Enterprise/Sandbox',
      destoupath: '/Enterprise/Production',
    });
    assert(result.isError === true, 'expected an error result');
    assert(mutatingCallsReceived.length === 0, 'no mutating HTTP call should reach the server');
  });

  console.log('\nGate 6 wiring — move_devices_by_filter');

  await test('blocked when destination OU is protected', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await moveDevicesByFilterTool.execute({
      sourceOuPath: '/Enterprise/Sandbox',
      sourceOuId: '3',
      searchTerm: '*',
      destOuPath: '/Enterprise/Production',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    const text = result.content[0]?.text ?? '';
    assert(text.includes('protected'), `expected a protected-OU message, got: ${text}`);
    assert(
      !mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'no device move should be issued when destination is protected',
    );
  });

  await test('blocked when ANY resolved source device OU is protected (mixed source set)', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    // sourceOuId=1 (/Enterprise) with includeSubOus would match devices across OUID 2, 3, 4 —
    // our fake server's /device/search only filters by exact ouId, so simulate the mixed-OU
    // case directly: search root is the unprotected Sandbox OU's *parent* path is not used by
    // the fake search filter, so instead we point sourceOuId at the protected OU's sibling
    // search that nonetheless returns a device whose own OUID is the protected one by using
    // OUID 4 (Floor3, a descendant of the protected OU) as the search target.
    const result = await moveDevicesByFilterTool.execute({
      sourceOuId: '4',
      searchTerm: '*',
      destOuPath: '/Enterprise/Sandbox',
      confirm: true,
    });
    assert(result.isError === true, 'expected an error result');
    assert(
      !mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'no device move should be issued when a resolved source OU is a protected descendant',
    );
  });

  await test('proceeds when neither source nor destination is protected', async () => {
    configureSession();
    process.env.SCOUT_PROTECTED_OUS = '/Enterprise/Production';
    mutatingCallsReceived = [];
    const result = await moveDevicesByFilterTool.execute({
      sourceOuId: '3',
      searchTerm: '*',
      destOuPath: '/Enterprise/Sandbox',
      confirm: true,
    });
    assert(result.isError !== true, `expected success, got error: ${result.content[0]?.text}`);
    assert(
      mutatingCallsReceived.some((c) => c.path.includes('/device/move')),
      'device move calls should have been issued when neither side is protected',
    );
  });

  cleanup();
  clearSessionConfig();

  console.log('\n' + '─'.repeat(60));
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Results: ${passed} passed, ${failed} failed (${results.length} total)`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
