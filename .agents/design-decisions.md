# Design Decisions — Scout Board MCP Server

**Status:** AWAITING SECURITY REVIEW  
**Date:** 2026-05-19  
**Author:** Arkitekten

---

## 1. API Overview

The Scout Board REST API (v25.11.0, Citrix/Unicon) exposes **412 endpoints** across 13 tag groups:

| Tag | Endpoints | Notes |
|-----|-----------|-------|
| Configuration | 185 | base/ou/device × many config sections |
| Advanced Configuration | 86 | base/ou/device × advanced config sections |
| Commands | 47 | restart/halt/factory-reset etc. per target scope |
| Notifications | 35 | per device/devicelist/OU/DDG |
| OU | 13 | CRUD + search + structure |
| Applications | 12 | base/ou CRUD + copy/move/inheritance |
| Rules | 10 | CRUD + label linking + validate |
| Device | 7 | CRUD + search + status |
| Labels | 5 | CRUD |
| Schedules | 4 | get/update/delete |
| Maintenance Window | 4 | CRUD |
| Authentication | 2 | password login + Citrix Cloud SP login |
| Health check | 2 | /ping (unauthenticated) + /healthcheck (authenticated) |

---

## 2. Project Structure

```
src/
  index.ts          — MCP server entry, registers all tools
  client.ts         — ScoutClient: auth, HTTP wrapper, TLS control
  types.ts          — shared Zod schemas and TypeScript interfaces
  tools/
    health.ts       — tool: health_check
    ou.ts           — tools: ou_get, ou_manage
    device.ts       — tools: device_get, device_manage
    command.ts      — tools: device_command, device_diagnostics
    application.ts  — tools: app_list, app_manage
    config.ts       — tools: config_get, config_update
    label.ts        — tool: label_manage
    rule.ts         — tool: rule_manage
    schedule.ts     — tool: schedule_manage
    maintenance.ts  — tool: maintenance_window_manage
    notification.ts — tool: notification_manage
tests/
  integration.ts    — all integration tests (tsx runner, no Jest)
.env.example
package.json
tsconfig.json
```

---

## 3. Authentication Flow

### 3.1 Mechanism

The API uses **JWT via cookie**. Despite the `/auth/v1/login` description mentioning `Authorization: Bearer`, every authenticated endpoint uses:

```
Cookie: ScoutBoardAuthJWT=<JWT>
```

This is confirmed by the `AuthToken` parameter definition: `in: cookie, name: ScoutBoardAuthJWT`.

### 3.2 Login request

```
POST /auth/v1/login
Content-Type: application/json

{ "loginData64": "<base64(JSON({username, password, domain}))>" }
```

- `domain` may be empty string — see `SCOUT_DOMAIN` env var (optional, defaults to `""`)
- Response: `{ "token": "<JWT>" }`

### 3.3 ScoutClient auth logic

```
ScoutClient (singleton)
  ├── token: string | null          // in-memory only, never persisted
  ├── ensureAuth()                  // login if no token; called before every request
  ├── request(method, path, body?)  // wraps fetch, sets cookie header
  └── on HTTP 401: re-login once, then retry; if still 401 → throw
```

**Token refresh:** No refresh endpoint exists. On 401 response, re-login from env credentials and retry exactly once. If second attempt also fails, surface the error.

**Token storage:** In-memory only. Never written to disk, logs, or env.

### 3.4 TLS control

When `SCOUT_IGNORE_TLS=true`, use a custom `https.Agent` with `rejectUnauthorized: false`. Pass via `dispatcher` option to native fetch (Node 22: `undici.Agent`). Do **not** set `NODE_TLS_REJECT_UNAUTHORIZED` globally — that would affect the entire process.

```typescript
// In client.ts:
import { Agent } from 'undici';
const dispatcher = ignoreTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
// Pass as fetch option: { dispatcher }
```

---

## 4. MCP Tool Inventory

The 412 endpoints are covered by **16 MCP tools**. The design favors composable, general tools over one-tool-per-endpoint.

### 4.1 Tool names and mappings

| MCP Tool | Covers | Notes |
|----------|--------|-------|
| `health_check` | GET /ping, GET /healthcheck | Returns system status + optional license info |
| `ou_get` | GET /ou, /ou/root, /ou/search, /ou/subordinate, /ou/structure, /ou/device/status | `mode` param selects sub-operation |
| `ou_manage` | POST/PUT/DELETE /ou, /ou/move, /ou/converttobase, /ou/structure/export, /ou/structure/import | `action` param |
| `device_get` | GET /device, /device/search, /device/status, /device/configOrigins | `mode` param |
| `device_manage` | POST/PUT/DELETE /device, PUT /device/move | `action` param |
| `device_command` | POST /command/{target}/{commandType} | `target`: device\|devicelist\|ou\|ddg; `command`: restart\|halt\|start\|factoryreset\|update\|updateuefi\|custom\|predefined\|delivery\|message |
| `device_diagnostics` | GET /command/device/diagnostics, /diagnostics/poll, /diagnostics/download | `action`: trigger\|poll\|download |
| `app_list` | GET /applications/base, /applications/ou | Returns base or OU-scoped apps |
| `app_manage` | POST/PUT/DELETE /applications/base/{type}, /applications/ou/{type}, /applications/copy, /applications/move, /applications/inheritance | `action` param |
| `config_get` | GET /configuration/{target}/{section} | `target`: base\|ou\|device; `section`: general\|firmware\|network\|display\|etc. |
| `config_update` | POST /configuration/{target}/{section} | Same target/section as config_get |
| `label_manage` | GET/POST/PUT/DELETE /labels, /labels/{id} | `action` param |
| `rule_manage` | GET/POST/PUT/DELETE /rules, /rules/{id}, /rules/validate, /rules/{id}/labels | `action` param |
| `schedule_manage` | GET /schedule/device, /schedule/ou; POST /schedule/update; DELETE /schedule/delete | `action` param |
| `maintenance_window_manage` | GET/POST/PUT/DELETE /maintenanceWindows | `action` param |
| `notification_manage` | POST/DELETE /notification/{target}/{type} | `target`: device\|devicelist\|ou\|ddg; `type`: delivery\|devicerelocation\|updatefirmware\|updateuefi\|configurationupdate |

> **Advanced Configuration** (86 endpoints) is intentionally omitted from v1 scope. The `config_get`/`config_update` tools cover `/configuration/` (standard config). Advanced config under `/config/advanced/` can be added in v2 without breaking the tool surface.

### 4.2 Destructive operations

The following tools can trigger **irreversible actions** on live devices:

| Tool | Destructive actions |
|------|---------------------|
| `device_command` | `factoryreset`, `halt`, `update`, `updateuefi` |
| `device_manage` | `delete` |
| `ou_manage` | `delete` |
| `app_manage` | `delete` |

**Guard rule:** For any destructive action, the implementation MUST verify that the target device or OU is under `SCOUT_TEST_OU_PATH` when running in test mode (`SCOUT_ENV=test`). In production mode (`SCOUT_ENV=production`), there is no automatic guard — the MCP caller is responsible. This distinction must be documented clearly in each tool's description.

---

## 5. Validation Strategy (Zod)

Every MCP tool input is validated with Zod before any HTTP call is made:

```typescript
// Pattern for each tool:
const inputSchema = z.object({ ... });
type Input = z.infer<typeof inputSchema>;

export const myTool: Tool = {
  name: 'tool_name',
  inputSchema: zodToJsonSchema(inputSchema),
  async execute(raw: unknown) {
    const input = inputSchema.parse(raw);  // throws McpError on invalid input
    ...
  }
};
```

Key validation rules:
- OU paths: must start with `/`
- MAC addresses: validated format (for device identification by MAC)
- Enum values: all `action`/`mode`/`target`/`command` params use `z.enum([...])`
- No `z.any()` anywhere without an explicit `// reason: <why>` comment

---

## 6. HTTP Client Design

```typescript
class ScoutClient {
  private baseUrl: string;       // from SCOUT_BASE_URL
  private token: string | null;
  private dispatcher?: Agent;    // undici agent for TLS bypass

  async request<T>(method: string, path: string, body?: unknown): Promise<T>
  async login(): Promise<void>
  private async ensureAuth(): Promise<void>
}
```

- All requests go to `${SCOUT_BASE_URL}/rest${path}` (note: `/rest` prefix from openapi server definition)
- Cookie header set on every request: `Cookie: ScoutBoardAuthJWT=${this.token}`
- Request timeout: 30s default, configurable via `SCOUT_REQUEST_TIMEOUT_MS`
- Retry: only on 401 (re-auth), no other retries to avoid thundering herd on errors
- Error responses: parse `{ code, message }` from body and throw `McpError` with that message

---

## 7. Dependencies

Changes from current `package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "dotenv": "^16.0.0",
    "zod": "^3.22.0",
    "zod-to-json-schema": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

**Removed:** `node-fetch` — replaced by native `fetch` (Node 18+) with `undici.Agent` for TLS.

---

## 8. Test Strategy

### 8.1 Runner

Plain TypeScript integration tests via `tsx tests/integration.ts`. No Jest. Tests run sequentially to avoid race conditions on shared server state.

### 8.2 Test phases

```
Phase 1 — Connectivity (read-only, no auth needed)
  ✓ GET /ping → expect 200

Phase 2 — Authentication
  ✓ POST /auth/v1/login with valid credentials → expect JWT
  ✓ POST /auth/v1/login with bad credentials → expect 401

Phase 3 — OU read (read-only)
  ✓ ou_get(mode=root) → expect root OU
  ✓ ou_get(mode=structure) → expect tree
  ✓ health_check() → expect system info

Phase 4 — OU write (scoped to SCOUT_TEST_OU_PATH)
  ✓ ou_manage(action=add, parent=SCOUT_TEST_OU_PATH, name=mcp-test-temp)
  ✓ ou_manage(action=rename, ... name=mcp-test-temp-renamed)
  ✓ ou_manage(action=delete, path=SCOUT_TEST_OU_PATH/mcp-test-temp-renamed)

Phase 5 — Device operations (scoped to SCOUT_TEST_OU_PATH)
  ✓ device_get(mode=search, ouPath=SCOUT_TEST_OU_PATH) → list devices
  — If devices exist: device_command(command=message, ...) — safe, non-destructive

Phase 6 — Config read (read-only)
  ✓ config_get(target=base, section=general)
  ✓ config_get(target=base, section=firmware)
```

### 8.3 Safety invariant

Test code MUST abort immediately if `SCOUT_TEST_OU_PATH` is not set. All write operations during tests MUST include the OU path check. Any test that creates resources must clean them up in a `finally` block.

---

## 9. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SCOUT_BASE_URL` | yes | — | e.g. `https://scoutsrv.tornbloms.net:22160` |
| `SCOUT_USERNAME` | yes | — | Login username |
| `SCOUT_PASSWORD` | yes | — | Login password |
| `SCOUT_DOMAIN` | no | `""` | Login domain (may be empty) |
| `SCOUT_IGNORE_TLS` | no | `false` | Set `true` for self-signed certs |
| `SCOUT_TEST_OU_PATH` | yes (for tests) | — | e.g. `/MCP-Test` |
| `SCOUT_REQUEST_TIMEOUT_MS` | no | `30000` | HTTP request timeout |
| `SCOUT_ENV` | no | `production` | Set `test` to enable test guards |

---

## 10. Open Questions (for Security Agent to review)

1. **Cookie vs Bearer auth:** The login endpoint description says Bearer header but all endpoints use cookie. Is cookie the correct mechanism, or should we also try sending `Authorization: Bearer <token>` in the header and fall back to cookie?

2. **TLS bypass scope:** Using `undici.Agent({ rejectUnauthorized: false })` only affects requests made through our client. Is this acceptable, or should we require a properly signed certificate in production?

3. **Token logging:** Should we log a redacted version of the JWT (e.g. first 10 chars + `...`) in debug mode, or suppress all token logging?

4. **Factory reset / halt guards:** Should these be disabled entirely via an env flag, or is the `SCOUT_TEST_OU_PATH` guard sufficient?

5. **Advanced Configuration endpoints:** Excluded from v1. Is this acceptable from a security standpoint (reduces attack surface), or are they needed?

---

## 11. Build Order for Developer

1. `package.json` — update deps (remove node-fetch, add zod, dotenv, zod-to-json-schema)
2. `tsconfig.json` — verify strict mode, ESM output
3. `src/client.ts` — ScoutClient (auth + HTTP)
4. `src/types.ts` — shared Zod schemas
5. `src/tools/health.ts` — simplest tool, validates the whole pipeline
6. `src/tools/ou.ts` + `src/tools/device.ts` — core read/write tools
7. `src/index.ts` — wire MCP server with health + ou + device tools, verify end-to-end
8. Remaining tools in parallel: command, application, config, label, rule, schedule, maintenance, notification
