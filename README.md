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
| `SCOUT_ENABLE_PRIVATE_ENDPOINTS` | no | `true` to expose 11 additional private endpoint tools (see below) |

> **Note:** You can also configure credentials at runtime using the `scout_configure` tool — no `.env` file needed.

> **Warning:** `SCOUT_IGNORE_TLS=true` disables certificate verification. Use only with self-signed certificates in controlled environments.

---

## Resources

Scout MCP exposes browsable MCP Resources so AI clients can read Scout Board context without consuming tool calls. Resources are built from the live connected server at query time.

| Resource URI | Type | Description |
|-------------|------|-------------|
| `scout://ou-tree` | Concrete | Full OU hierarchy snapshot (names, paths, IDs) |
| `scout://ou/<path>` | Concrete (enumerated) | Single OU details — one resource per OU in your tree |
| `scout://devices/{+ouPath}` | Template | Devices in an OU. Example: `scout://devices/Enterprise/Germany/Berlin`. Add `?includeSubOus=true` to include sub-OUs. |

**Example efficiency gain:** Instead of calling `ou_get(mode=structure)` to understand your environment, an AI client reads `scout://ou-tree` once as ambient context — zero tool slots consumed.

---

## Available Tools (17 public + 11 private)
## Available Tools (18 public + 11 private)

| Tool | Description |
|------|-------------|
| `scout_configure` | Set, inspect, or clear Scout Board credentials at runtime |
| `scout_context` | Set, inspect, or clear the session-level working OU default |
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

### Private endpoint tools (opt-in)

These tools target Scout Board internal endpoints discovered from browser network traffic — they are **not** in the public OpenAPI spec. They are **hidden by default** and must be enabled with `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`.

> **Warning:** These endpoints are unsupported and undocumented. They may change or disappear in future Scout Board releases without notice.

| Tool | Actions | Description |
|------|---------|-------------|
| `system_info` | `status_summary`, `device_count`, `device_distribution`, `device_image_files`, `recovery_settings`, `db_diags`, `system_check`, `tree_filter`, `missed_notifications`, `auth_user` | Read-only system status and diagnostic data |
| `system_settings` | `get_logging` / `set_logging`, `get_discover` / `set_discover`, `get_retain_local_config` / `set_retain_local_config`, `get_device_name_options`, `set_device_password` | Read and write server-wide settings |
| `predefined_commands` | `list`, `add`, `modify`, `delete`, `auth`, `list_templates`, `modify_templates` | Manage predefined device commands |
| `predefined_paths` | `list`, `add`, `delete` | Manage predefined firmware update paths |
| `predefined_images` | `list_images`, `list_uefi` | List predefined IDF images and UEFI files |
| `license_manage` | `get`, `check_availability`, `reconfigure` | Read and reconfigure Scout Board licensing |
| `admin_manage` | `list`, `permissions`, `advanced_rights`, `configuration_rights`, `update_rights` | Read admin accounts and UI permissions |
| `server_instances` | `list`, `modify`, `delete` | Manage Scout Board server instances |
| `db_cleanup` | `list` | List database record counts by type for cleanup |
| `ou_filter_manage` | `get_settings`, `list`, `set_settings`, `add`, `modify`, `delete` | Manage OU filter rules — **subnet filter** (IP network, e.g. `192.168.1.0/24`) and **user-defined filter** (ELUX_* property expressions with `=`, `!=`, `>`, `<`, `*` wildcard) |
| `new_device_options` | `get`, `set` | Read or update new device enrollment options |

### Response enrichment

Tool responses that contain numeric OUID fields (e.g. `device_get`, `device_manage`) are automatically annotated with human-readable `_OUIDName` and `_OUIDPath` siblings, so the AI has full context without a follow-up `ou_get` call:

```json
{ "Name": "Thin01", "OUID": 42, "_OUIDName": "Berlin Office", "_OUIDPath": "/Enterprise/Germany/Berlin", "Status": "active" }
```

The enrichment is best-effort — if the OU tree cannot be fetched the original response is returned unchanged. The OU map is cached for 5 minutes and invalidated automatically after any `ou_manage` mutation.
### Fuzzy suggestions on failure

When an `ou_get` or `ou_manage` call returns HTTP 404 (OU not found), the error automatically includes a ranked "Did you mean?" list of similar OUs from the cached OU tree:

```
ou_get failed: OU not found at path "/Enterprise/Germany/Berln" (HTTP 404)

Did you mean one of these OUs?
  • "Berlin Office"  →  /Enterprise/Germany/Berlin
  • "Berlin HQ"      →  /Enterprise/Germany/BerlinHQ
```

Matching ranks by: exact → prefix → substring → edit-distance similarity. The suggestion list is cached alongside the enricher OU map (5-minute TTL) and never causes a tool call to fail.

When a `device_get` or `device_manage` call returns 404, the error includes a hint to use `device_get mode=search` to locate the device by partial name.
### Working OU (session context)

Set a default OU once per session and omit it from every subsequent call:

```
scout_context action=set_ou path=/Enterprise/Germany/Berlin
→ Working OU set to "Berlin Office" (/Enterprise/Germany/Berlin)

device_get mode=search searchTerm=thin*          # no ouPath needed
ou_get mode=subordinate                          # no path needed
device_manage action=add newDeviceName=Thin99 newDeviceMac=AA:BB:CC:DD:EE:FF
```

The working OU is session-scoped (in-memory, cleared on restart). Use `scout_context action=get_ou` to inspect the current value and `action=clear_ou` to unset it.

**Tools that respect the working OU default:** `device_get mode=search`, `ou_get mode=subordinate` and `mode=device_status`, `device_manage action=add` and `action=move`.
### MCP Prompts (workflow templates)

Five pre-built workflow templates are exposed via the MCP `prompts/list` and `prompts/get` endpoints. Clients that support MCP prompts (e.g. Claude Desktop) can invoke them by name:

| Prompt | Description | Key arguments |
|--------|-------------|---------------|
| `scout_connect` | Connect to a server and prepare the session | `base_url`, `username`, `ou_path` (opt) |
| `onboard_device` | Add a new device to Scout Board | `device_name`, `mac_address`, `ou_path` (opt) |
| `audit_ou` | List and summarise device health in an OU | `ou_path` (opt), `include_sub_ous` (opt) |
| `mass_command` | Send a command to all devices in an OU | `command`, `ou_path` (opt), `confirm` (opt) |
| `move_devices` | Find devices by name and move them | `search_term`, `target_ou`, `source_ou` (opt) |

Each prompt resolves any missing OU arguments from the working OU (set with `scout_context`) and includes a preview/confirmation step before destructive operations.

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
  resources.ts    MCP Resources — live OU tree + device inventory
  tools/          One file per functional group (17 public + 11 private endpoint tools)
catalog/
  server.yaml     Docker MCP Registry submission metadata
  tools.json      Static tool list for registry build validation
.github/
  workflows/
    update-mcp-registry.yml   Auto-updates registry PR on every push to main
    cleanup-runs.yml          Deletes failed workflow runs automatically
```
