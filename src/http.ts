/**
 * Streamable-HTTP transport wiring for the MCP server, selected via SCOUT_TRANSPORT=http
 * (default remains stdio — see index.ts). This module owns:
 *
 *   - The raw `node:http` listener and routing for the single `/mcp` endpoint
 *     (POST for client→server messages and session init, GET for the server→client SSE
 *     stream, DELETE for explicit session termination), per the MCP Streamable HTTP spec.
 *   - Per-session StreamableHTTPServerTransport instances, keyed by the `mcp-session-id`
 *     header the SDK manages for us (stateful mode — `sessionIdGenerator: randomUUID`).
 *     Each new session gets its own transport instance, but all sessions share the one
 *     `Server` instance from index.ts (its tool/resource/prompt handlers are stateless
 *     w.r.t. session — per-call state like progressToken is already scoped to the request).
 *   - The OIDC bearer-auth gate (src/auth/middleware.ts), invoked before any request body
 *     is parsed or handed to the transport. This is a connection-level admission check,
 *     distinct from and in addition to guardrails.ts (which gates write *tool calls* after
 *     dispatch, regardless of transport).
 *
 * Session handling note: Streamable-HTTP is stateful by design when `sessionIdGenerator`
 * is supplied — the first POST (an `initialize` request, no `mcp-session-id` header yet)
 * creates a transport and the SDK assigns/returns a session ID; every subsequent request
 * for that session must carry `mcp-session-id` so we route it to the same transport
 * instance. This mirrors the SDK's own reference implementation
 * (examples/server/simpleStreamableHttp.ts) adapted to plain node:http instead of Express.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadOidcConfig, type OidcConfig } from './auth/oidc.js';
import { requireBearerAuth } from './auth/middleware.js';
import { resolveHttpPort } from './transport.js';

const MCP_PATH = '/mcp';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Starts the Streamable-HTTP listener. `mcpServer` is the single Server instance built and
 * configured by index.ts (tools/resources/prompts already registered) — this function only
 * adds the HTTP transport layer in front of it, it does not construct or configure the
 * Server itself.
 */
export async function startHttpTransport(mcpServer: Server): Promise<void> {
  const port = resolveHttpPort(process.env.SCOUT_HTTP_PORT);

  const oidcConfig = loadOidcConfig();
  if (!oidcConfig) {
    throw new Error(
      'SCOUT_TRANSPORT=http requires SCOUT_OIDC_ISSUER_URL and SCOUT_OIDC_AUDIENCE to be set. ' +
        'The HTTP transport is a network-reachable surface and must not run without connection-level auth.',
    );
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJsonRpcError(res, 400, 'Bad Request: invalid JSON body');
      return;
    }

    try {
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
    } catch (err) {
      process.stderr.write(`[scout-mcp] HTTP transport error: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, 'Internal server error');
      }
    }
  }

  async function handleMcpGetOrDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  const httpServer = createServer((req, res) => {
    void routeRequest(req, res, oidcConfig, handleMcpPost, handleMcpGetOrDelete);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  process.stderr.write(
    `[scout-mcp] Streamable-HTTP transport listening on port ${port} (${MCP_PATH}), ` +
      `OIDC issuer=${oidcConfig.issuerUrl} audience=${oidcConfig.audience}\n`,
  );

  const shutdown = async () => {
    for (const transport of transports.values()) {
      try {
        await transport.close();
      } catch {
        // best-effort cleanup
      }
    }
    httpServer.close();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  oidcConfig: OidcConfig,
  handlePost: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  handleGetOrDelete: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Connection-level auth gate — runs before any MCP message parsing or tool dispatch.
  // Independent of guardrails.ts (the write-level gate, which still applies per-tool-call
  // regardless of transport).
  const authenticated = await requireBearerAuth(req, res, oidcConfig);
  if (!authenticated) return; // requireBearerAuth already wrote the 401 response

  if (req.method === 'POST') {
    await handlePost(req, res);
  } else if (req.method === 'GET' || req.method === 'DELETE') {
    await handleGetOrDelete(req, res);
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, DELETE' });
    res.end('Method Not Allowed');
  }
}
