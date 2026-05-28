# Citrix Unicon Management Scout

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes the Unicorn Scout Board MDM REST API as tools for AI assistants and Claude Desktop.

Manage devices, OUs, applications, configurations, labels, rules, schedules, maintenance windows, and notifications — all through natural language.

---

## Install via Docker MCP Toolkit (recommended)

If you have [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the MCP Toolkit enabled, find **Citrix Unicon Management Scout** in the catalog at [hub.docker.com/mcp](https://hub.docker.com/mcp) and click **Add**. Configure your Scout Board URL, username, and password in the UI — no CLI needed.

---

## Manual installation

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — or Node.js 20+ for source installs

### Option A — Docker (recommended)

```bash
# Pull and run
docker pull mcp/scout-mcp
echo "" | docker run --rm -i \
  -e SCOUT_BASE_URL=https://your-server:22160 \
  -e SCOUT_USERNAME=admin@example.com \
  -e SCOUT_PASSWORD=secret \
  mcp/scout-mcp
```

Add to your MCP client config (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "scout": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/path/to/.env",
        "mcp/scout-mcp"
      ]
    }
  }
}
```

### Option B — From source

```bash
git clone https://github.com/mathiastornblom/ScoutMCP.git
cd ScoutMCP
npm install
npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "scout": {
      "command": "node",
      "args": ["/path/to/ScoutMCP/dist/index.js"],
      "env": {
        "SCOUT_BASE_URL": "https://your-server:22160",
        "SCOUT_USERNAME": "admin@example.com",
        "SCOUT_PASSWORD": "secret"
      }
    }
  }
}
```

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SCOUT_BASE_URL` | yes | `https://your-server:22160` — must use `https://` |
| `SCOUT_USERNAME` | yes | Scout Board login username |
| `SCOUT_PASSWORD` | yes | Scout Board login password |
| `SCOUT_DOMAIN` | no | Login domain (leave empty if not required) |
| `SCOUT_IGNORE_TLS` | no | `true` to accept self-signed certificates |
| `SCOUT_REQUEST_TIMEOUT_MS` | no | HTTP timeout in ms (default: 30000) |
| `SCOUT_TEST_OU_PATH` | tests only | OU path for integration tests, e.g. `/MCP-Test` |
| `SCOUT_ENV` | tests only | Set `test` to restrict destructive operations to `SCOUT_TEST_OU_PATH` |

> **Note:** You can also configure credentials at runtime using the `scout_configure` tool — no `.env` file needed.

> **Warning:** `SCOUT_IGNORE_TLS=true` disables certificate verification. Use only with self-signed certificates in controlled environments.

---

## Available Tools (17)

| Tool | Description |
|------|-------------|
| `scout_configure` | Set, inspect, or clear Scout Board credentials at runtime |
| `health_check` | Ping or authenticated system status check |
| `ou_get` | Read OUs — single, root, search, subordinates, structure, device status |
| `ou_manage` | Add, rename, delete, move OUs; export/import OU structures |
| `device_get` | Get device info, search in OU, runtime status, config origins |
| `device_manage` | Add, rename, delete, move devices |
| `device_command` | Send commands to devices/OUs/groups (restart, update, factory reset, etc.) |
| `device_diagnostics` | Async diagnostics: trigger → poll → download URL |
| `app_list` | List base or OU-scoped applications |
| `app_manage` | Create, delete, copy, move applications; manage inheritance |
| `config_get` | Read configuration sections for base, OU, or device scope |
| `config_update` | Write configuration sections for base, OU, or device scope |
| `label_manage` | CRUD labels for dynamic device configuration |
| `rule_manage` | CRUD rules, validate expressions, manage label associations |
| `schedule_manage` | View and manage scheduled commands for OUs and devices |
| `maintenance_window_manage` | CRUD maintenance windows |
| `notification_manage` | Set and delete notifications for devices, OUs, and groups |

### Destructive operation safeguards

- `device_command` with `factoryreset` or `halt` requires `confirm: true`
- When `SCOUT_ENV=test`, all write operations are restricted to `SCOUT_TEST_OU_PATH`

---

## Authentication

Scout Board uses JWT authentication. The client sends credentials to `POST /rest/api/v1/user/login` and receives a token stored in-memory. The token is sent as a `Cookie: ScoutBoardAuthJWT=<token>` header on every request. On a 401 response the client re-authenticates once and retries automatically.

---

## Running tests

Tests require a live Scout Board server. All write operations are scoped to `SCOUT_TEST_OU_PATH`.

```bash
cp .env.example .env   # fill in your values
npm test
```

The test suite aborts immediately if `SCOUT_TEST_OU_PATH` is not set.

---

## Architecture

```
src/
  index.ts        MCP server entry point (stdio transport)
  client.ts       ScoutClient — JWT cookie auth, undici TLS control
  session.ts      Runtime credential store and ~/.scout-mcp.json persistence
  types.ts        Shared helpers: ok(), fail(), buildQuery()
  tools/          One file per functional group (17 tools total)
catalog/
  server.yaml     Docker MCP Registry submission metadata
  tools.json      Static tool list for registry build validation
.github/
  workflows/
    update-mcp-registry.yml   Auto-updates registry PR on every push to main
    cleanup-runs.yml          Deletes failed workflow runs automatically
```
