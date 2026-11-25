# Security review: PR #44 (feat/health-mcp-version)

Scope: git diff origin/main...HEAD (version.ts, health.ts, index.ts, test, CHANGELOG).

1. Information disclosure: LOW / acceptable. The MCP server version is not a secret. It is returned only to the connected MCP client (stdio), which already receives it via serverInfo. It does not expose the Scout server version, host, URL or credentials. The failure message adds only the version string plus the pre-existing err.message.
2. File-read path safety: OK. readFileSync target is the fixed literal '../package.json' resolved against import.meta.url. There is no user input, env var or tool argument in the path, so traversal and injection are not possible. It reads once at module load.
3. Missing package.json: handled. try/catch returns 'unknown', and non-string or empty versions also return 'unknown'. There is no crash and no throw at import time. The Dockerfile copies package*.json into both the builder and the runtime stage at /app, next to dist/, so the relative path resolves in the image. The .dockerignore does not exclude package.json.
4. Secrets: none. JSON.parse of our own package.json is typed and only the version field is used. Nothing else from the file is surfaced.
5. Behaviour: mcpServerVersion is placed before the ...data spread, so a Scout response containing a same-named key could override it. This is a cosmetic integrity nit, not a security issue (non-blocking suggestion: place it after the spread).
6. No new network, write, destructive or env surface. Test reads package.json only.

Non-blocking: import order in health.ts places the new import above zod (style only).

SECURITY: APPROVED
