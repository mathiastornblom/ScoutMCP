/**
 * OIDC bearer-token validation for the Streamable-HTTP transport.
 *
 * This is a DIFFERENT auth layer from SCOUT_USERNAME/SCOUT_PASSWORD (which authenticates
 * *this server* to the Scout Board REST API). This module answers a different question:
 * who is allowed to connect to *this MCP server* over HTTP. It validates an incoming
 * `Authorization: Bearer <token>` against a configured OIDC provider's JWKS endpoint
 * (Entra ID, Okta, or any standards-compliant OIDC issuer).
 *
 * It is also unrelated to eLux device OIDC (the `[OpenId]` terminal.ini section) — that is
 * device-to-IdP auth for managed endpoints, configured elsewhere and untouched by this file.
 *
 * Scope is intentionally minimal: signature + issuer + audience + expiry verification via
 * JWKS, resolved through standard OIDC discovery (`/.well-known/openid-configuration`).
 * No login flow, no refresh tokens, no token issuance — this server is a resource server,
 * not an OIDC client/relying party.
 *
 * Only used when SCOUT_TRANSPORT=http. stdio mode (local trusted process) never imports
 * or calls into this module's verification path.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface OidcConfig {
  issuerUrl: string;
  audience: string;
}

/**
 * Reads SCOUT_OIDC_ISSUER_URL / SCOUT_OIDC_AUDIENCE from the environment.
 * Returns undefined if either is missing — callers decide whether that's fatal
 * (HTTP transport requires both; stdio never calls this).
 */
export function loadOidcConfig(): OidcConfig | undefined {
  const issuerUrl = process.env.SCOUT_OIDC_ISSUER_URL;
  const audience = process.env.SCOUT_OIDC_AUDIENCE;
  if (!issuerUrl || !audience) return undefined;
  return { issuerUrl, audience };
}

export class OidcAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcAuthError';
  }
}

// Per-issuer caches: resolved jwks_uri (from OIDC discovery) and the JWKS remote key set
// fetcher keyed by that URI. createRemoteJWKSet already caches/refreshes the actual key
// material internally — these maps just avoid re-running discovery and re-constructing a
// fetcher (with its own cache) on every single request.
const discoveryCache = new Map<string, string>();
const jwksByUri = new Map<string, JWTVerifyGetKey>();

/** Exposed for tests to inject a fake jwks_uri without hitting the network. */
export function _resetCachesForTests(): void {
  discoveryCache.clear();
  jwksByUri.clear();
}

async function resolveJwksUri(issuerUrl: string): Promise<string> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached) return cached;

  const wellKnownUrl = new URL(
    '.well-known/openid-configuration',
    issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`,
  );
  let res: Response;
  try {
    res = await fetch(wellKnownUrl);
  } catch (err) {
    throw new OidcAuthError(
      `OIDC discovery request failed for issuer ${issuerUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new OidcAuthError(`OIDC discovery failed for issuer ${issuerUrl}: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) {
    throw new OidcAuthError(`OIDC discovery document for ${issuerUrl} is missing jwks_uri`);
  }
  discoveryCache.set(issuerUrl, doc.jwks_uri);
  return doc.jwks_uri;
}

async function getJwksForIssuer(issuerUrl: string): Promise<JWTVerifyGetKey> {
  const jwksUri = await resolveJwksUri(issuerUrl);
  let jwks = jwksByUri.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksByUri.set(jwksUri, jwks);
  }
  return jwks;
}

/**
 * Extracts the bearer token from an `Authorization` header value.
 * Returns undefined if the header is missing or not in `Bearer <token>` form.
 */
export function extractBearerToken(authHeader: string | undefined | null): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Verifies a bearer token against the configured OIDC issuer's JWKS (resolved via OIDC
 * discovery). Throws OidcAuthError on any failure — missing token, bad signature, wrong
 * issuer/audience, expired, or discovery/network failure. Callers should reject the
 * request with 401 on throw.
 */
export async function verifyBearerToken(token: string, config: OidcConfig): Promise<JWTPayload> {
  if (!token) {
    throw new OidcAuthError('Missing bearer token');
  }

  let jwks: JWTVerifyGetKey;
  try {
    jwks = await getJwksForIssuer(config.issuerUrl);
  } catch (err) {
    if (err instanceof OidcAuthError) throw err;
    throw new OidcAuthError(
      `Failed to resolve JWKS for issuer ${config.issuerUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuerUrl,
      audience: config.audience,
    });
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OidcAuthError(`Bearer token verification failed: ${message}`);
  }
}

/**
 * Allows tests to inject a fully custom JWKS-getter (e.g. a local jose `jwtVerify`-compatible
 * key set built from a test key pair) and bypass network discovery entirely. Production code
 * never calls this — only verifyBearerTokenWithJwks (used internally by tests) does.
 */
export async function verifyBearerTokenWithJwks(
  token: string,
  config: OidcConfig,
  jwks: JWTVerifyGetKey,
): Promise<JWTPayload> {
  if (!token) {
    throw new OidcAuthError('Missing bearer token');
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuerUrl,
      audience: config.audience,
    });
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OidcAuthError(`Bearer token verification failed: ${message}`);
  }
}
