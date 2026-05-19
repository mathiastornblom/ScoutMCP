# Scout Board MCP Server

An MCP (Model Context Protocol) server that exposes the Unicorn Scout Board REST API as tools for AI assistants. Built with TypeScript, Zod validation, and native fetch.

## Requirements

- Node.js 20+
- Access to a Scout Board server (Unicon/Citrix)

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SCOUT_BASE_URL` | yes | e.g. `https://scoutsrv.example.com:22160` — must use `https://` |
| `SCOUT_USERNAME` | yes | Scout Board login username |
| `SCOUT_PASSWORD` | yes | Scout Board login password |
| `SCOUT_DOMAIN` | no | Login domain (leave empty if not required) |
| `SCOUT_IGNORE_TLS` | no | Set `true` to accept self-signed certificates |
| `SCOUT_TEST_OU_PATH` | yes (tests) | OU path for integration tests, e.g. `/MCP-Test` |
| `SCOUT_REQUEST_TIMEOUT_MS` | no | HTTP timeout in ms (default: 30000) |
| `SCOUT_ENV` | no | Set `test` to enable destructive-operation guards |

> **Warning:** `SCOUT_IGNORE_TLS=true` disables certificate verification. Use only in controlled environments with self-signed certs — never in production against a CA-signed certificate.

## Running

```bash
# Development (tsx, loads .env automatically)
npm run dev

# Production (compiled)
npm run build
npm start
```

## Integration with Claude Desktop / Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "scout": {
      "command": "node",
      "args": ["/path/to/ScoutMCP/dist/index.js"],
      "env": {
        "SCOUT_BASE_URL": "https://your-server:22160",
        "SCOUT_USERNAME": "your-user",
        "SCOUT_PASSWORD": "your-password",
        "SCOUT_IGNORE_TLS": "true"
      }
    }
  }
}
```

## Testing

Tests run against the live Scout Board server. All write operations are scoped to `SCOUT_TEST_OU_PATH`.

```bash
npm test
```

The test suite aborts immediately if `SCOUT_TEST_OU_PATH` is not set.

## Available Tools (16)

| Tool | Description |
|------|-------------|
| `health_check` | Ping or authenticated system status |
| `ou_get` | Read OU info, root, search, subordinates, structure, device status |
| `ou_manage` | Add, rename, delete, move OUs; export/import structure |
| `device_get` | Get device info, search, status, config origins |
| `device_manage` | Add, rename, delete, move devices |
| `device_command` | Send commands to devices/OUs/groups (restart, halt, update, etc.) |
| `device_diagnostics` | Trigger, poll, and download device diagnostics |
| `app_list` | List base or OU-scoped applications |
| `app_manage` | Create, update, delete, copy, move applications |
| `config_get` | Read any configuration section (base/OU/device) |
| `config_update` | Write any configuration section (base/OU/device) |
| `label_manage` | CRUD labels |
| `rule_manage` | CRUD rules, validate conditions, manage label links |
| `schedule_manage` | Get, update, delete device and OU schedules |
| `maintenance_window_manage` | CRUD maintenance windows |
| `notification_manage` | Set and delete notifications for devices/OUs/groups |

### Destructive operations

`device_command` with `command=factoryreset` or `command=halt` requires `confirm: true` in the tool input. This prevents accidental invocation by AI clients.

When `SCOUT_ENV=test`, write operations are restricted to paths under `SCOUT_TEST_OU_PATH`.

## Architecture

```
src/
  index.ts        MCP server entry point (stdio transport)
  client.ts       ScoutClient — JWT cookie auth, undici TLS control, 401 retry
  types.ts        Shared Zod schemas and response helpers
  tools/          One file per functional group (16 tools total)
```

Authentication uses `POST /rest/auth/v1/login` with base64-encoded credentials. The returned JWT is stored in-memory and sent as a cookie (`ScoutBoardAuthJWT`) on every request. On a 401 response the client re-authenticates once and retries automatically.
