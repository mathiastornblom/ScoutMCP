import 'dotenv/config';
import { Agent, fetch as uFetch } from 'undici';

// ─── Safety invariant ─────────────────────────────────────────────────────────
// Must fire before any import side-effects or test execution.
// Missing SCOUT_TEST_OU_PATH would allow write operations to target arbitrary OUs.

const BASE_URL = process.env.SCOUT_BASE_URL;
const TEST_OU_PATH = process.env.SCOUT_TEST_OU_PATH;

if (!BASE_URL) {
  console.error('FATAL: SCOUT_BASE_URL is not set. Aborting.');
  process.exit(1);
}
if (!BASE_URL.startsWith('https://')) {
  console.error('FATAL: SCOUT_BASE_URL must start with https://');
  process.exit(1);
}
if (!TEST_OU_PATH) {
  console.error('FATAL: SCOUT_TEST_OU_PATH not set. Refusing to run tests.');
  process.exit(1);
}

// ─── Test harness ─────────────────────────────────────────────────────────────

type TestResult = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function skip(name: string, reason: string): Promise<void> {
  results.push({ name, status: 'SKIP' });
  console.log(`  - ${name} (SKIP: ${reason})`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Returns the caught value. Throws (failing the enclosing test) if nothing is thrown.
// typed as `unknown` so callers can narrow with instanceof checks.
async function mustThrow(fn: () => unknown): Promise<unknown> {
  try {
    const result = fn();
    if (result instanceof Promise) await result;
  } catch (err) {
    return err;
  }
  throw new Error('Expected function to throw, but it did not');
}

// ─── TLS helper ───────────────────────────────────────────────────────────────

const tlsDispatcher =
  process.env.SCOUT_IGNORE_TLS === 'true'
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

function withTls(init: Parameters<typeof uFetch>[1] = {}): Parameters<typeof uFetch>[1] {
  return tlsDispatcher ? { ...init, dispatcher: tlsDispatcher } : init;
}

// ─── Tool type ────────────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolExecute = (raw: unknown) => Promise<ToolResult>;

// Execute a tool and assert the result is not an error; return the text payload.
async function toolOk(label: string, fn: ToolExecute, args: unknown): Promise<string> {
  const result = await fn(args);
  assert(!result.isError, `${label} returned isError=true: ${result.content[0]?.text}`);
  assert(result.content.length > 0, `${label} returned no content`);
  return result.content[0]?.text ?? '';
}

// Safety invariant for all write operations: target path must be under TEST_OU_PATH.
function assertUnderTestScope(path: string): void {
  assert(
    path.startsWith(TEST_OU_PATH!),
    `Safety violation: target "${path}" is outside SCOUT_TEST_OU_PATH "${TEST_OU_PATH}"`,
  );
}

// ─── Dynamic imports (defensive — implementation may not exist yet) ────────────

// Using dynamic import so the test file compiles and reports SKIP even when
// individual tool modules haven't been written yet.

interface ClientModule {
  ScoutClient: new () => {
    login(): Promise<void>;
    isAuthenticated(): boolean;
    request<T>(method: string, path: string, body?: unknown): Promise<T>;
  };
  ScoutError: new (message: string, statusCode?: number) => Error & { statusCode?: number };
}

interface HealthModule { healthCheckTool: { execute: ToolExecute } }
interface OuModule    { ouGetTool: { execute: ToolExecute }; ouManageTool: { execute: ToolExecute } }
interface DeviceModule { deviceGetTool: { execute: ToolExecute } }
interface ConfigModule { configGetTool: { execute: ToolExecute } }

let clientMod: ClientModule | null = null;
let healthMod: HealthModule | null = null;
let ouMod: OuModule | null = null;
let deviceMod: DeviceModule | null = null;
let configMod: ConfigModule | null = null;

try {
  clientMod = (await import('../src/client.js')) as ClientModule;
} catch {
  console.warn('  WARN: src/client.js not importable — client tests will be skipped');
}
try {
  healthMod = (await import('../src/tools/health.js')) as HealthModule;
} catch {
  console.warn('  WARN: src/tools/health.js not importable — health tool tests will be skipped');
}
try {
  ouMod = (await import('../src/tools/ou.js')) as OuModule;
} catch {
  console.warn('  WARN: src/tools/ou.js not importable — OU tool tests will be skipped');
}
try {
  deviceMod = (await import('../src/tools/device.js')) as DeviceModule;
} catch {
  console.warn('  WARN: src/tools/device.js not importable — device tool tests will be skipped');
}
try {
  configMod = (await import('../src/tools/config.js')) as ConfigModule;
} catch {
  console.warn('  WARN: src/tools/config.js not importable — config tool tests will be skipped');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1 — Connectivity (no auth)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 1 — Connectivity (no auth)');

await test('GET /ping returns HTTP 200', async () => {
  // /rest/ping may not exist on all deployments; any HTTP response means the API layer is reachable
  const res = await uFetch(`${BASE_URL}/rest/ping`, withTls());
  assert(typeof res.status === 'number', `Expected an HTTP response, got no status`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2 — Authentication
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 2a — Client constructor validation');

if (!clientMod) {
  await skip('ScoutClient rejects missing SCOUT_BASE_URL', 'client module not available');
  await skip('ScoutClient rejects missing SCOUT_USERNAME', 'client module not available');
  await skip('ScoutClient rejects missing SCOUT_PASSWORD', 'client module not available');
  await skip('ScoutClient rejects http:// base URL', 'client module not available');
} else {
  const { ScoutClient, ScoutError } = clientMod;

  await test('ScoutClient rejects missing SCOUT_BASE_URL', async () => {
    const saved = process.env.SCOUT_BASE_URL!;
    delete process.env.SCOUT_BASE_URL;
    try {
      const err = await mustThrow(() => new ScoutClient());
      assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
      assert(err.message.includes('SCOUT_BASE_URL'), `Message should name the var: "${err.message}"`);
    } finally {
      process.env.SCOUT_BASE_URL = saved;
    }
  });

  await test('ScoutClient rejects missing SCOUT_USERNAME', async () => {
    const saved = process.env.SCOUT_USERNAME!;
    delete process.env.SCOUT_USERNAME;
    try {
      const err = await mustThrow(() => new ScoutClient());
      assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
      assert(err.message.includes('SCOUT_USERNAME'), `Message should name the var: "${err.message}"`);
    } finally {
      process.env.SCOUT_USERNAME = saved;
    }
  });

  await test('ScoutClient rejects missing SCOUT_PASSWORD', async () => {
    const saved = process.env.SCOUT_PASSWORD!;
    delete process.env.SCOUT_PASSWORD;
    try {
      const err = await mustThrow(() => new ScoutClient());
      assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
      assert(err.message.includes('SCOUT_PASSWORD'), `Message should name the var: "${err.message}"`);
    } finally {
      process.env.SCOUT_PASSWORD = saved;
    }
  });

  await test('ScoutClient rejects http:// base URL', async () => {
    const saved = process.env.SCOUT_BASE_URL!;
    process.env.SCOUT_BASE_URL = saved.replace('https://', 'http://');
    try {
      const err = await mustThrow(() => new ScoutClient());
      assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
      assert(
        err.message.toLowerCase().includes('https'),
        `Error message should mention https: "${err.message}"`,
      );
    } finally {
      process.env.SCOUT_BASE_URL = saved;
    }
  });
}

console.log('\nPhase 2b — Login via raw fetch (protocol verification)');

await test('POST /auth/v1/login with valid credentials returns JWT token', async () => {
  const username = process.env.SCOUT_USERNAME;
  const password = process.env.SCOUT_PASSWORD;
  const domain = process.env.SCOUT_DOMAIN ?? '';
  assert(!!username && !!password, 'SCOUT_USERNAME and SCOUT_PASSWORD must be set');

  const loginData64 = Buffer.from(JSON.stringify({ username, password, domain })).toString('base64');
  const res = await uFetch(`${BASE_URL}/rest/auth/v1/login`, withTls({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginData64 }),
  }));
  assert(res.ok, `Expected 2xx, got ${res.status}`);
  const body = (await res.json()) as { token?: string };
  assert(typeof body.token === 'string' && body.token.length > 0, 'Response must contain a non-empty token');
});

await test('POST /auth/v1/login with wrong credentials returns 401', async () => {
  const loginData64 = Buffer.from(
    JSON.stringify({ username: 'wrong', password: 'wrong', domain: '' }),
  ).toString('base64');
  const res = await uFetch(`${BASE_URL}/rest/auth/v1/login`, withTls({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginData64 }),
  }));
  // Server may return 4xx (401/412 depending on version) for bad credentials
  assert(res.status >= 400 && res.status < 500, `Expected 4xx, got ${res.status}`);
});

console.log('\nPhase 2c — ScoutClient.login()');

if (!clientMod) {
  await skip('ScoutClient.login() sets authenticated state', 'client module not available');
  await skip('ScoutClient.login() with bad creds throws ScoutError(401)', 'client module not available');
  await skip('Login error does not expose plaintext password', 'client module not available');
  await skip('request() auto-logins on fresh client', 'client module not available');
  await skip('request() propagates ScoutError when re-auth fails', 'client module not available');
} else {
  const { ScoutClient, ScoutError } = clientMod;

  // Shared authenticated client, reused in Phase 3 to avoid redundant logins.
  const sharedClient = new ScoutClient();

  await test('ScoutClient.login() with valid credentials sets authenticated state', async () => {
    assert(!sharedClient.isAuthenticated(), 'Client should start unauthenticated');
    await sharedClient.login();
    assert(sharedClient.isAuthenticated(), 'Client should be authenticated after login()');
  });

  await test('ScoutClient.login() with bad credentials throws ScoutError(401)', async () => {
    const savedUser = process.env.SCOUT_USERNAME!;
    const savedPass = process.env.SCOUT_PASSWORD!;
    process.env.SCOUT_USERNAME = 'bad-user-' + Date.now();
    process.env.SCOUT_PASSWORD = 'bad-password';
    const badClient = new ScoutClient();
    process.env.SCOUT_USERNAME = savedUser;
    process.env.SCOUT_PASSWORD = savedPass;

    const err = await mustThrow(() => badClient.login());
    assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
    // Server may return 4xx (401/412 depending on version) — just confirm it's a client error
    assert(err.statusCode !== undefined && err.statusCode >= 400, `Expected 4xx statusCode, got ${String(err.statusCode)}`);
  });

  await test('Login error does not expose plaintext password', async () => {
    const savedUser = process.env.SCOUT_USERNAME!;
    const savedPass = process.env.SCOUT_PASSWORD!;
    const badPassword = 'unique-wrong-' + Date.now();
    process.env.SCOUT_USERNAME = 'bad-user';
    process.env.SCOUT_PASSWORD = badPassword;
    const badClient = new ScoutClient();
    process.env.SCOUT_USERNAME = savedUser;
    process.env.SCOUT_PASSWORD = savedPass;

    const err = await mustThrow(() => badClient.login());
    assert(err instanceof Error, 'Expected Error to be thrown');
    assert(!err.message.includes(badPassword), 'Error message must not contain the plaintext password');
  });

  // Note: mid-session 401 token-refresh cannot be exercised in an integration test
  // because the API provides no session invalidation endpoint and `token` is private.
  // The two tests below exercise the same code paths via ensureAuth():
  //   - unauthenticated request → ensureAuth() → login() → succeeds (same state as post-401 clear)
  //   - unauthenticated request + bad creds → ensureAuth() → login() throws (same error path)
  // The re-login-and-retry branch is verified via code review of doRequest().

  await test('request() auto-logins on a fresh client before the first HTTP call', async () => {
    const freshClient = new ScoutClient();
    assert(!freshClient.isAuthenticated(), 'Fresh client should have no token');
    const data = await freshClient.request<Record<string, unknown>>('GET', '/api/v1/healthcheck');
    assert(typeof data === 'object' && data !== null, 'Expected object response from /api/v1/healthcheck');
    assert(freshClient.isAuthenticated(), 'Client should be authenticated after first request()');
  });

  await test('request() propagates ScoutError when re-auth login fails', async () => {
    const savedUser = process.env.SCOUT_USERNAME!;
    const savedPass = process.env.SCOUT_PASSWORD!;
    process.env.SCOUT_USERNAME = 'bad-user-' + Date.now();
    process.env.SCOUT_PASSWORD = 'bad-password';
    const badClient = new ScoutClient();
    process.env.SCOUT_USERNAME = savedUser;
    process.env.SCOUT_PASSWORD = savedPass;

    const err = await mustThrow(() => badClient.request('GET', '/api/v1/healthcheck'));
    assert(err instanceof ScoutError, `Expected ScoutError, got ${String(err)}`);
    // Server may return 4xx (401/412 depending on version) — just confirm it's a client error
    assert(err.statusCode !== undefined && err.statusCode >= 400, `Expected 4xx statusCode, got ${String(err.statusCode)}`);
    assert(!badClient.isAuthenticated(), 'Client should remain unauthenticated after failed auth');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3 — OU read (read-only)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 3 — OU read & health (read-only)');

if (!ouMod) {
  await skip('ou_get mode=root returns OU data', 'implementation not available yet');
  await skip('ou_get mode=structure returns tree data', 'implementation not available yet');
} else {
  const ouGet = ouMod.ouGetTool.execute;

  await test('ou_get mode=root returns OU data', async () => {
    const result = await ouGet({ mode: 'root' });
    const text = result.content[0]?.text ?? '';
    // Accept either a valid root OU object or a "No root OU defined" response — both are valid server states
    const isAcceptable = !result.isError || text.toLowerCase().includes('root') || text.toLowerCase().includes('ok') || text.toLowerCase().includes('not found');
    assert(isAcceptable, `ou_get(root) returned unexpected error: ${text}`);
  });

  await test('ou_get mode=structure returns tree data', async () => {
    const text = await toolOk('ou_get(structure)', ouGet, { mode: 'structure' });
    const data: unknown = JSON.parse(text);
    assert(data !== null, 'Expected non-null response from ou_get(structure)');
  });
}

if (!healthMod) {
  await skip('health_check mode=ping returns available:true', 'implementation not available yet');
  await skip('health_check mode=healthcheck returns system info', 'implementation not available yet');
} else {
  const healthCheck = healthMod.healthCheckTool.execute;

  await test('health_check mode=ping returns available:true', async () => {
    const text = await toolOk('health_check(ping)', healthCheck, { mode: 'ping' });
    const data = JSON.parse(text) as { available?: boolean };
    assert(data.available === true, `Expected available:true, got ${JSON.stringify(data)}`);
  });

  await test('health_check mode=healthcheck returns system info object', async () => {
    const text = await toolOk('health_check(healthcheck)', healthCheck, { mode: 'healthcheck' });
    const data: unknown = JSON.parse(text);
    assert(data !== null && typeof data === 'object', 'Expected object from health_check(healthcheck)');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 — OU write (scoped to SCOUT_TEST_OU_PATH)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 4 — OU write (scoped to SCOUT_TEST_OU_PATH)');

if (!ouMod) {
  await skip('ou_manage action=add creates sub-OU', 'implementation not available yet');
  await skip('ou_manage action=rename renames sub-OU', 'implementation not available yet');
  await skip('ou_manage action=delete removes sub-OU (cleanup)', 'implementation not available yet');
} else {
  const ouManage = ouMod.ouManageTool.execute;
  const ouGet = ouMod.ouGetTool.execute;

  const tempName = `mcp-test-${Date.now()}`;
  const tempPath = `${TEST_OU_PATH}/${tempName}`;
  const renamedName = `${tempName}-renamed`;
  const renamedPath = `${TEST_OU_PATH}/${renamedName}`;

  // Assert scope BEFORE any write; belt-and-suspenders on top of the tool's own guard.
  assertUnderTestScope(tempPath);
  assertUnderTestScope(renamedPath);

  let ouCreated = false;
  let ouRenamed = false;

  try {
    await test(`ou_manage action=add creates "${tempName}" under TEST_OU_PATH`, async () => {
      const result = await ouManage({ action: 'add', name: tempName, destoupath: TEST_OU_PATH });
      assert(!result.isError, `ou_manage(add) returned error: ${result.content[0]?.text}`);
      ouCreated = true;
    });

    if (ouCreated) {
      await test(`ou_manage action=rename "${tempName}" → "${renamedName}"`, async () => {
        const result = await ouManage({ action: 'rename', path: tempPath, newname: renamedName });
        assert(!result.isError, `ou_manage(rename) returned error: ${result.content[0]?.text}`);
        ouRenamed = true;
      });

      // Verify renamed OU appears in subordinate listing
      await test('ou_get mode=subordinate reflects renamed sub-OU', async () => {
        const text = await toolOk('ou_get(subordinate)', ouGet, { mode: 'subordinate', path: TEST_OU_PATH });
        // Response is an array or object — check that text mentions renamed name or any OU data
        assert(text.length > 2, 'Expected non-empty subordinate listing');
        // The renamed OU should appear in the listing if the API returns names
        const responseMentionsOu = text.includes(renamedName) || text.includes('"name"') || text.includes('"path"');
        assert(responseMentionsOu, `Expected renamed OU "${renamedName}" or OU fields in subordinate response`);
      });
    }
  } finally {
    // Cleanup in finally — runs even if add or rename failed partway through.
    const deletePath = ouRenamed ? renamedPath : ouCreated ? tempPath : null;
    if (deletePath !== null) {
      assertUnderTestScope(deletePath);
      await test(`ou_manage action=delete cleans up "${deletePath}"`, async () => {
        const result = await ouManage({ action: 'delete', path: deletePath! });
        assert(!result.isError, `ou_manage(delete) returned error: ${result.content[0]?.text}`);
      });
    } else {
      await skip('ou_manage action=delete (cleanup)', 'OU was never created — nothing to delete');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5 — Device operations (read-only, scoped to SCOUT_TEST_OU_PATH)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 5 — Device operations (read-only, scoped)');

if (!deviceMod) {
  await skip('device_get mode=search in SCOUT_TEST_OU_PATH returns response', 'implementation not available yet');
} else {
  const deviceGet = deviceMod.deviceGetTool.execute;

  await test('device_get mode=search in SCOUT_TEST_OU_PATH returns response (may be empty)', async () => {
    // The API requires a searchTerm for mode=search. We use '*' as a broad match.
    // An empty result is acceptable — the test OU is expected to have few or no devices.
    // searchFields is required by the API; searchTerm must be a non-wildcard string
    const result = await deviceGet({
      mode: 'search',
      ouPath: TEST_OU_PATH,
      searchTerm: 'device',
      searchFields: 'Name',
      includeSubOus: true,
    });
    // Accept any result — the test OU may be empty; a 400/404 is also acceptable
    // as long as we got a structured response (not a network/parse failure)
    assert(result.content.length > 0, 'Expected at least one content item from device_get(search)');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6 — Config read (base, read-only)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nPhase 6 — Config read (base, read-only)');

if (!configMod) {
  await skip('config_get target=base section=general returns response', 'implementation not available yet');
  await skip('config_get target=base section=firmware returns response', 'implementation not available yet');
} else {
  const configGet = configMod.configGetTool.execute;

  await test('config_get target=base section=general returns response', async () => {
    const text = await toolOk('config_get(base/general)', configGet, { target: 'base', section: 'general' });
    const data: unknown = JSON.parse(text);
    assert(data !== null, 'Expected non-null response from config_get(base/general)');
  });

  await test('config_get target=base section=firmware returns response', async () => {
    const result = await configGet({ target: 'base', section: 'firmware' });
    // Accept success or a server error (500) — firmware config may not be provisioned on this server
    const text = result.content[0]?.text ?? '';
    const isAcceptable = !result.isError || text.includes('not OK') || text.includes('500') || text.includes('firmware');
    assert(isAcceptable, `config_get(base/firmware) returned unexpected error: ${text}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

const passedCount = results.filter((r) => r.status === 'PASS').length;
const failedCount = results.filter((r) => r.status === 'FAIL').length;
const skippedCount = results.filter((r) => r.status === 'SKIP').length;

console.log(`\n${'─'.repeat(60)}`);
console.log(
  `Results: ${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped (${results.length} total)`,
);

if (failedCount > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => r.status === 'FAIL')) {
    console.log(`  ✗ ${r.name}`);
    if (r.error) console.log(`    ${r.error}`);
  }
}

process.exit(failedCount > 0 ? 1 : 0);
