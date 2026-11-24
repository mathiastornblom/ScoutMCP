/**
 * Connection-level auth gate for the Streamable-HTTP transport.
 *
 * Sits in front of StreamableHTTPServerTransport#handleRequest: every HTTP request is
 * checked here BEFORE it reaches MCP message parsing or tool dispatch. This is distinct
 * from (and does not replace) guardrails.ts, which gates individual *write* tool calls
 * after they've already been dispatched — this gate decides whether the connection is
 * allowed to talk to the server at all.
 *
 * Only invoked when SCOUT_TRANSPORT=http. stdio mode never constructs this middleware.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearerToken, verifyBearerToken, type OidcConfig } from './oidc.js';

/**
 * Returns true if the request was authenticated and the caller should proceed to MCP
 * handling. Returns false if the middleware already wrote a 401 response and the caller
 * must stop processing this request.
 */
export async function requireBearerAuth(
  req: IncomingMessage,
  res: ServerResponse,
  config: OidcConfig,
): Promise<boolean> {
  const token = extractBearerToken(req.headers['authorization']);
  if (!token) {
    writeUnauthorized(res, 'Missing or malformed Authorization header (expected: Bearer <token>)');
    return false;
  }

  try {
    await verifyBearerToken(token, config);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed';
    writeUnauthorized(res, message);
    return false;
  }
}

function writeUnauthorized(res: ServerResponse, message: string): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'unauthorized', message }));
}
