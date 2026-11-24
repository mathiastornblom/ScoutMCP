/**
 * Unit tests for src/auth/oidc.ts and src/auth/middleware.ts — OIDC bearer-token
 * verification for the Streamable-HTTP transport's connection-level auth gate.
 *
 * Fully offline: a local RSA key pair is generated with `jose`, tokens are signed locally,
 * and `verifyBearerTokenWithJwks` is used to verify against a local JWKS (created from the
 * same key pair) rather than fetching a real issuer's JWKS over the network. No live OIDC
 * provider, no real network calls.
 *
 * Run with: npx tsx tests/oidc-auth.test.ts
 */

import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import {
  extractBearerToken,
  verifyBearerTokenWithJwks,
  loadOidcConfig,
  OidcAuthError,
  type OidcConfig,
} from '../src/auth/oidc.js';

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  assert(threw, message);
}

// ─── Test fixtures: a local key pair, never touching a real network ──────────────

const ISSUER = 'https://fake-issuer.invalid/';
const AUDIENCE = 'scout-mcp-server';
const config: OidcConfig = { issuerUrl: ISSUER, audience: AUDIENCE };

const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = 'test-key-1';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

const localJwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [publicJwk] });

// A second, unrelated key pair to simulate a token signed by an untrusted/wrong key.
const { privateKey: wrongPrivateKey } = await generateKeyPair('RS256');

async function signToken(opts: {
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  signingKey?: CryptoKey;
  kid?: string;
}): Promise<string> {
  const {
    issuer = ISSUER,
    audience = AUDIENCE,
    expiresInSeconds = 3600,
    signingKey = privateKey,
    kid = 'test-key-1',
  } = opts;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: 'test-user' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt(now)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(now + expiresInSeconds)
    .sign(signingKey);
}

// ─── extractBearerToken ─────────────────────────────────────────────────────────

console.log('\nextractBearerToken');

test('extracts token from well-formed header', () => {
  assert(extractBearerToken('Bearer abc.def.ghi') === 'abc.def.ghi', 'expected extracted token');
});

test('is case-insensitive on "Bearer" keyword', () => {
  assert(extractBearerToken('bearer abc.def.ghi') === 'abc.def.ghi', 'expected extracted token');
});

test('returns undefined for missing header', () => {
  assert(extractBearerToken(undefined) === undefined, 'expected undefined');
  assert(extractBearerToken(null) === undefined, 'expected undefined');
});

test('returns undefined for malformed header (no Bearer prefix)', () => {
  assert(extractBearerToken('Basic abc123') === undefined, 'expected undefined for Basic auth');
});

test('returns undefined for empty string', () => {
  assert(extractBearerToken('') === undefined, 'expected undefined');
});

test('trims surrounding whitespace', () => {
  assert(extractBearerToken('  Bearer   abc.def.ghi  ') === 'abc.def.ghi', 'expected trimmed token');
});

// ─── loadOidcConfig ──────────────────────────────────────────────────────────────

console.log('\nloadOidcConfig');

test('returns undefined when both env vars are missing', () => {
  delete process.env.SCOUT_OIDC_ISSUER_URL;
  delete process.env.SCOUT_OIDC_AUDIENCE;
  assert(loadOidcConfig() === undefined, 'expected undefined');
});

test('returns undefined when only issuer is set', () => {
  process.env.SCOUT_OIDC_ISSUER_URL = ISSUER;
  delete process.env.SCOUT_OIDC_AUDIENCE;
  assert(loadOidcConfig() === undefined, 'expected undefined when audience missing');
  delete process.env.SCOUT_OIDC_ISSUER_URL;
});

test('returns undefined when only audience is set', () => {
  process.env.SCOUT_OIDC_AUDIENCE = AUDIENCE;
  delete process.env.SCOUT_OIDC_ISSUER_URL;
  assert(loadOidcConfig() === undefined, 'expected undefined when issuer missing');
  delete process.env.SCOUT_OIDC_AUDIENCE;
});

test('returns config when both are set', () => {
  process.env.SCOUT_OIDC_ISSUER_URL = ISSUER;
  process.env.SCOUT_OIDC_AUDIENCE = AUDIENCE;
  const cfg = loadOidcConfig();
  assert(cfg !== undefined, 'expected config');
  assert(cfg!.issuerUrl === ISSUER, 'expected issuerUrl to match');
  assert(cfg!.audience === AUDIENCE, 'expected audience to match');
  delete process.env.SCOUT_OIDC_ISSUER_URL;
  delete process.env.SCOUT_OIDC_AUDIENCE;
});

// ─── verifyBearerTokenWithJwks: the core verification logic ─────────────────────

console.log('\nverifyBearerTokenWithJwks — valid token passes');

await test('valid token with correct issuer/audience/signature passes', async () => {
  const token = await signToken({});
  const payload = await verifyBearerTokenWithJwks(token, config, localJwks);
  assert(payload.sub === 'test-user', 'expected sub claim to round-trip');
});

console.log('\nverifyBearerTokenWithJwks — rejections');

await test('missing token throws OidcAuthError', async () => {
  await assertRejects(
    verifyBearerTokenWithJwks('', config, localJwks),
    'expected rejection for empty token',
  );
});

await test('malformed token (not a JWT) throws OidcAuthError', async () => {
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks('not-a-real-jwt', config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for malformed token');
});

await test('expired token is rejected', async () => {
  const token = await signToken({ expiresInSeconds: -10 });
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks(token, config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for expired token');
});

await test('wrong audience is rejected', async () => {
  const token = await signToken({ audience: 'some-other-app' });
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks(token, config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for wrong audience');
});

await test('wrong issuer is rejected', async () => {
  const token = await signToken({ issuer: 'https://some-other-issuer.invalid/' });
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks(token, config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for wrong issuer');
});

await test('token signed by an untrusted key is rejected (bad signature)', async () => {
  const token = await signToken({ signingKey: wrongPrivateKey });
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks(token, config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for untrusted signing key');
});

await test('token with unknown kid is rejected', async () => {
  const token = await signToken({ kid: 'nonexistent-key-id' });
  let caught: unknown;
  try {
    await verifyBearerTokenWithJwks(token, config, localJwks);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OidcAuthError, 'expected OidcAuthError for unknown kid');
});

// ─── Summary ────────────────────────────────────────────────────────────────────

const passedCount = results.filter((r) => r.status === 'PASS').length;
const failedCount = results.filter((r) => r.status === 'FAIL').length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passedCount} passed, ${failedCount} failed (${results.length} total)`);

if (failedCount > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => r.status === 'FAIL')) {
    console.log(`  ✗ ${r.name}`);
    if (r.error) console.log(`    ${r.error}`);
  }
}

process.exit(failedCount > 0 ? 1 : 0);
