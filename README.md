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

### Option B — Build from source

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

### Option C — Build Docker image from source

```bash
docker build \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --build-arg VERSION=$(node -p "require('./package.json').version") \
  -t scout-mcp:latest \
  -t scout-mcp:$(git rev-parse --short HEAD) \
  .
```

#### Running the local image

```bash
cp .env.example .env            # fill in SCOUT_BASE_URL etc.; keep SCOUT_MODE=read-only at first
docker compose build
docker compose run --rm -i scout-mcp
```

For an MCP client (e.g. Claude Desktop) use:

```json
{ "command": "docker",
  "args": ["run", "-i", "--rm", "--env-file", "/absolute/path/to/.env", "-v", "scout-logs:/app/logs", "scout-mcp:local"] }
```

The audit log and pre-write snapshots go to `/app/logs` (the `scout-logs` volume). The container talks to
your Scout server over the network; a self-signed certificate needs `SCOUT_IGNORE_TLS=true`.
The container uses stdio. HTTP mode (`SCOUT_TRANSPORT=http`) additionally requires the OIDC settings.

---

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SCOUT_BASE_URL` | yes | `https://your-server:22160` — must use `https://` |
| `SCOUT_USERNAME` | password auth | Scout Board login username (not needed with `SCOUT_AUTH=citrix-cloud`) |
| `SCOUT_PASSWORD` | password auth | Scout Board login password (not needed with `SCOUT_AUTH=citrix-cloud`) |
| `SCOUT_AUTH` | no | `password` (default, unchanged behavior) \| `citrix-cloud` — auth method to Scout Board, see [Citrix Cloud service-principal auth](#citrix-cloud-service-principal-auth) |
| `SCOUT_CC_CLIENT_ID` | citrix-cloud auth | Citrix Cloud service-principal client ID |
| `SCOUT_CC_CLIENT_SECRET` | citrix-cloud auth | Citrix Cloud service-principal client secret |
| `SCOUT_CC_CUSTOMER_ID` | citrix-cloud auth | Citrix Cloud customer ID (not needed for `staging` region or with `SCOUT_CC_TOKEN_URL`) |
| `SCOUT_CC_REGION` | citrix-cloud auth | Token endpoint region: `us` \| `eu` \| `ap-s` \| `jp` \| `staging` |
| `SCOUT_CC_TOKEN_URL` | no | Full Citrix Cloud token-endpoint URL override — takes precedence over region/customer id |
| `SCOUT_DOMAIN` | no | Login domain (leave empty if not required) |
| `SCOUT_IGNORE_TLS` | no | `true` to accept self-signed certificates |
| `SCOUT_REQUEST_TIMEOUT_MS` | no | HTTP timeout in ms (default: 30000) |
| `SCOUT_TEST_OU_PATH` | tests only | OU path for integration tests, e.g. `/MCP-Test` |
| `SCOUT_ENV` | tests only | Set `test` to restrict destructive operations to `SCOUT_TEST_OU_PATH` |
| `SCOUT_ENABLE_PRIVATE_ENDPOINTS` | no | `true` to expose 11 additional private endpoint tools (see below) |
| `SCOUT_MODE` | no | `read-only` (default) \| `dry-run` \| `write` — global write gate, see [Safety gates](#safety-gates) below |
| `SCOUT_ALLOW_BASE_WRITES` | no | `true` to allow writes targeting Base config scope, a top-level OU (no parent in the OU tree) or an OU structure import (default off, independent of `SCOUT_MODE`) |
| `SCOUT_MAX_BLAST_RADIUS` | no | Max devices a single bulk write may affect (default `25`, hard ceiling `500` — cannot be raised past the ceiling via config) |
| `SCOUT_PROTECTED_OUS` | no | Comma-separated or JSON-array list of OU paths that can never be written to, regardless of `SCOUT_MODE`. Blocks the listed OU **and all of its descendants** (see [Safety gates](#safety-gates)). Default: empty (nothing protected). |
| `SCOUT_ALLOWED_OUS` | no | Comma-separated or JSON-array list of OU paths. If set (non-empty), writes are restricted to **only** these OUs and their descendants — everything else is blocked. Default: empty (no restriction; opt-in allow-list). |
| `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION` | no | `true` to allow high-risk private endpoints (`db_cleanup` delete, `system_settings` writes, `admin_manage` delete_admin) to mutate when `SCOUT_MODE=write`. Default off — these are hard-disabled in production even with `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`. No effect in `read-only`/`dry-run` (Gate 1 already covers those). |
| `SCOUT_ALLOW_AUDIT_PURGE` | no | `true` to let `db_cleanup` purge `ADMIN_LOGS` (id 1, the Scout activity log). Default off: any filter containing id 1 is refused. Even when set, the call must pass `confirm=true` and `confirm_audit_purge=true`. Independent of, and additional to, the mode and private-write gates. |
| `SCOUT_CIRCUIT_BREAKER_MAX_OPS` | no | Max destructive ops allowed within the window before the breaker trips (default `10`). |
| `SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS` | no | Sliding window size in seconds for the circuit breaker (default `60`). |
| `SCOUT_AUDIT_LOG_PATH` | no | Path to the append-only, newline-delimited-JSON audit log (default `./logs/scout-audit.log`). Directory is created if missing. |
| `SCOUT_AUDIT_ACTOR` | no | Identity string recorded as `actor` in audit log entries. Default: `"unknown"` — there is no per-call MCP caller identity available to this server (single stdio session), so this is honestly reported rather than guessed unless a wrapping deployment sets it explicitly. |
| `SCOUT_SNAPSHOT_DIR` | no | Directory for pre-write effective-config snapshots (default `./logs/scout-snapshots`). |
| `SCOUT_KILL_SWITCH_FILE` | no | Path to a sentinel file (default `./KILL_SWITCH`). If the file exists, **every** mutating call is forced read-only regardless of `SCOUT_MODE`. See [Safety gates](#safety-gates) for the operator workflow. |
| `SCOUT_TRANSPORT` | no | `stdio` (default) \| `http` — selects the MCP transport. `stdio` is unchanged local-process behavior. `http` starts the Streamable-HTTP transport instead — see [HTTP transport & OIDC auth](#http-transport--oidc-auth) below. |
| `SCOUT_HTTP_PORT` | no | TCP port for the HTTP transport (default `3000`). Only read when `SCOUT_TRANSPORT=http`. |
| `SCOUT_OIDC_ISSUER_URL` | http transport only | OIDC issuer URL (e.g. your Entra ID or Okta tenant). **Required** when `SCOUT_TRANSPORT=http` — the server refuses to start without it, since HTTP is a network-reachable surface. |
| `SCOUT_OIDC_AUDIENCE` | http transport only | Expected `aud` claim on incoming bearer tokens. **Required** when `SCOUT_TRANSPORT=http`. |

**OU path format.** Wherever an OU path appears (`SCOUT_PROTECTED_OUS`/`SCOUT_ALLOWED_OUS`, `ouPath`, `ou_manage` `path`/`parent_path`, resolver output) it is `/` followed by the OU names from the top-level OU down, joined by `/`, with no trailing slash: `/NorthCreek/Browser/Google-CEP`. Scout's `/ou/structure` returns no path field, so the server derives it from the tree (`src/ou_tree.ts`). There is no synthetic `/` root (top-level OUs are siblings) and OU names containing `/` are refused. If the tree cannot be parsed, every check that needs it refuses (fails closed).

Path comparison for the protected/allowed lists is canonical: surrounding whitespace is trimmed, repeated and trailing `/` are collapsed, case is folded, and `.`/`..` segments or control characters make the write refuse. Write gates resolve the target through the OU tree (fresh read) and gate on the server-derived path, not on the string the caller typed. `device_manage` `move` refuses if the device's source OU cannot be determined (it requires a numeric `OUID` on the single-device record; `GroupID` is not assumed to be the OU id).

**Gate coverage.** Every tool that mutates with an OU path or id goes through one shared gate (`src/safety/ou_gate.ts`): `ou_manage` (add, rename, delete, move, converttobase, structure_import), `device_manage` (add, move), `move_devices_by_filter`, `bulk_command`, `onboard_branch`, `config_update` (target=ou), `device_command` (target=ou), `notification_manage` (target=ou), `app_manage` (scope=ou, copy, move, set_inheritance), `ou_filter_manage` (add, modify, delete), `new_device_options` (`default_ou`) and `admin_manage` `update_admin` (`root_ou`, `root_ou_fmd`). `SCOUT_PROTECTED_OUS` / `SCOUT_ALLOWED_OUS`, the `SCOUT_ENV=test` scope and the top-level-OU base-write rule are applied to the OU's server-derived canonical path, every refusal is audit-logged, and the request carries only the resolved id. `SCOUT_ENV=test` compares by path segment (`/MCP-Test2` is outside `/MCP-Test`) on the resolved path, also when the OU is given by id only. `ou_manage` / `device_manage` `add` and `move` with no destination at all are refused rather than left to the server. A top-level OU (no parent in the tree) needs `SCOUT_ALLOW_BASE_WRITES=true` for `ou_manage` rename/delete/move/converttobase/structure_import; this is derived from the OU tree, not from `GET /api/v1/ou/root` (which returns 404 on some servers).

`ou_manage structure_import` validates `importPayload` against the documented request shape (`data`, optional `parentOuId` and `import*` booleans; any other key is refused) and gates the parent OU. The export payload format is not documented, so the OUs an import would create or overwrite cannot be listed and checked one by one; such an import therefore also requires `SCOUT_ALLOW_BASE_WRITES=true` (fail closed). With that flag set, OUs inside the payload are not checked against the protected/allowed lists.

Subtree-affecting actions (`ou_manage` rename, delete, move of the moved OU, converttobase, and `structure_import`'s parent) check the OU's whole subtree: if any descendant is protected, or falls outside `SCOUT_ALLOWED_OUS`, the action is refused, so an ancestor of a protected OU cannot be renamed, deleted, moved or re-based. `device_command`, `notification_manage` and `bulk_command` do the same for every sub-OU when `includeSubOus` is anything other than absent or boolean `false`, and send a normalised boolean. `config_update` target=ou checks the OU and its whole subtree against the lists, plus the `SCOUT_ENV=test` scope on the resolved path: writing config on an ancestor of a protected OU is refused, because it inherits down into the protected OU. Caller bodies forwarded with a gated OU (`device_command`, `notification_manage`, `bulk_command`) have every OU-looking key removed (matched case- and separator-insensitively: `ouId`, `OUID`, `ou_path`, `IncludeSubOus`, `targetOu`, `destOuId`, `groupId`, ...); only the resolved `ouId` and a normalised boolean `includeSubOus` are sent, and any case variant of `includeSubOus` counts as requested for the subtree gate. `device_manage` move applies the `SCOUT_ENV=test` scope to the device's source OU as well.

`move_devices_by_filter` and `bulk_command` re-check the gated OU path before every batch of 25 devices and stop (status `aborted`) if it changed; the confirm prompt names the resolved destination path.

**Known gaps (protected/allowed-OU gate coverage).** These writes cannot be tied to one OU from their input, so the lists do NOT apply to them; use `SCOUT_MODE=read-only` or server-side OU rights:
- `device_command` / `notification_manage` with `target=device|devicelist|ddg`, `device_manage` `rename`/`delete`, and `bulk_command` per-device (a device is not mapped to an OU unless the record carries a numeric `OUID`; `GroupID` is not assumed to be an OU id).
- `schedule_manage` `update`/`delete` (a `scheduleId` does not identify its OU) and `ou_filter_manage` `set_settings` (global).
- Base/global scope: `app_manage` `scope=base`, labels, rules, predefined commands/images/paths, license, maintenance windows, server instances, system settings, `db_cleanup`, `admin_manage` add/delete.
- `ou_filter_manage` modify/delete look up the entry's current OU in `GET /api/v1/oufilter` (fields `EntryId`/`OUID`, shape not verified live) only when a list or `SCOUT_ENV=test` is active, and refuse if it cannot be determined.

When a write names the OU by more than one reference (for example `ouId` plus `ouPath`), all references must resolve to the same OU or the write is refused, and the request sent to Scout carries only the resolved id.

**Known residual risks (blast radius).** `config_update target=ou` counts devices from the OU tree's `DeviceCount`. That field is cumulative on the one live capture checked (Scout 26.11.0), but it is unverified whether it includes hidden or pending devices, so the count can undercount against the cap; the parser also falls back to the undocumented `count` field when `DeviceCount` is absent. The count and the write are two separate calls (not atomic), so devices moved in between are not reflected; the gated path is re-checked against a fresh tree after counting, but that does not close the gap. Validate against a manual device search on your server before relying on `SCOUT_MAX_BLAST_RADIUS` for OU-scope writes.

> **Note:** You can also configure credentials at runtime using the `scout_configure` tool — no `.env` file needed.

> **Warning:** `SCOUT_IGNORE_TLS=true` disables certificate verification. Use only with self-signed certificates in controlled environments.

### HTTP transport & OIDC auth

By default this server runs over **stdio** — a local trusted process, with no connection-level
auth needed (whoever can spawn the process can talk to it). Setting `SCOUT_TRANSPORT=http`
switches to the **Streamable-HTTP** transport instead, for hosted/remote deployments where the
server isn't a local child process.

This is a *different* auth layer from `SCOUT_USERNAME`/`SCOUT_PASSWORD` (which authenticate
*this server* to the Scout Board REST API, and are unaffected by transport choice). HTTP mode
adds a connection-level gate in front of MCP message handling: every request to `/mcp` must
carry a valid `Authorization: Bearer <token>` issued by the OIDC provider configured via
`SCOUT_OIDC_ISSUER_URL` / `SCOUT_OIDC_AUDIENCE`. The token's signature, issuer, audience, and
expiry are verified against the provider's JWKS (resolved via standard OIDC discovery at
`<issuer>/.well-known/openid-configuration`) using the [`jose`](https://github.com/panva/jose)
library. Requests without a valid token are rejected with `401` before reaching any tool
dispatch — this is independent of, and does not replace, the `SCOUT_MODE`/guardrails
write-safety gates described below, which still apply to every write regardless of transport.

This is also unrelated to eLux device OIDC (the `[OpenId]` section of `terminal.ini`) — that
configures device-to-IdP auth for managed endpoints, a separate concern from admin-to-MCP-server
auth.

Both env vars are required when `SCOUT_TRANSPORT=http` — the server refuses to start otherwise,
since an HTTP listener with no auth would be a network-reachable surface with no gate. `stdio`
mode never reads or requires these vars.

This implementation only validates bearer tokens (resource-server role) — it does not implement
a full OIDC client (no login/consent flow, no refresh tokens). That's standard for an
OIDC-protected API and out of scope here.

### Safety gates

All write-capable tools (`config_update`, `device_manage`, `ou_manage`, `move_devices_by_filter`, `bulk_command`, `onboard_branch`, and private write endpoints) funnel through a single chokepoint module (`src/safety/guardrails.ts`). As of this round there are eight gates plus two non-blocking side-effecting helpers (audit log, snapshot):

1. **Mode tiers (`SCOUT_MODE`)** — defaults to `read-only`, which blocks every mutating call outright. `dry-run` resolves and reports what a write *would* do without performing it. `write` is required for any mutation to actually happen.
2. **Base/root write-protection (`SCOUT_ALLOW_BASE_WRITES`)** — Base config scope and top-level OUs (no parent in the OU tree) inherit to a whole fleet or subtree, so writes targeting them are blocked unless this is explicitly set to `true`. This is independent of `SCOUT_MODE=write` — both must be satisfied.
3. **Blast-radius cap (`SCOUT_MAX_BLAST_RADIUS`)** — bulk operations that resolve a device count (OU-scope writes — the actual device count under the OU is resolved and checked, not just a `confirm` boolean — and bulk `deviceIds`) are capped at `25` devices by default. Raise it via env up to a hard ceiling of `500` devices, which cannot be exceeded by configuration alone. A single call can still pass `overrideBlastRadius: true` to exceed the configured cap (up to the ceiling) for that one call.
4. **Kill switch (`SCOUT_KILL_SWITCH_FILE`)** — if the sentinel file exists, every mutating call is forced read-only immediately, regardless of `SCOUT_MODE`. Operator workflow: `touch ./KILL_SWITCH` to engage, `rm ./KILL_SWITCH` to clear. Checked fresh on every call (no caching, no restart needed either way).
5. **Circuit breaker (`SCOUT_CIRCUIT_BREAKER_MAX_OPS` / `SCOUT_CIRCUIT_BREAKER_WINDOW_SECONDS`)** — if more than the configured number of destructive ops occur within the configured sliding window, the breaker trips and **all** mutating calls are refused, regardless of mode, until an explicit re-arm. Re-arm is intentionally NOT automatic/time-based — it requires an explicit call to `resetCircuitBreaker()` (or a process restart, which clears the in-memory window) — see the gate's doc comment in `guardrails.ts` for the tradeoff rationale (a purely time-based cooldown would let a runaway agent simply wait out the window and resume).
6. **Protected/allowed OU lists (`SCOUT_PROTECTED_OUS` / `SCOUT_ALLOWED_OUS`)** — a deny-list of OU paths that can never be written to (blocks the OU itself **and every descendant** — protecting an OU always protects its whole subtree, by design; there is no way to protect only the OU's own config while leaving children writable). An optional allow-list, if set, restricts ALL writes to only the listed OUs and their descendants. Deny always wins if an OU is in both lists.
7. **Private-endpoint writes hard-off in production (`SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION`)** — belt-and-suspenders on top of `SCOUT_ENABLE_PRIVATE_ENDPOINTS`: when `SCOUT_MODE=write`, the highest-risk private endpoints (`db_cleanup` delete, all `system_settings` writes, `admin_manage` delete_admin) are hard-disabled by default and require this additional flag to re-enable, even though private endpoints are otherwise on.
8. **Append-only audit log (`SCOUT_AUDIT_LOG_PATH`)** — every mutation attempt (allowed or refused, by which gate) is appended as one JSON line, opened with the append flag and never truncated. Not a forensic-grade system: no rotation, no size cap, no tamper-evidence — just a plain "what happened" trail.
8b. **Snapshot-before-mutate (`SCOUT_SNAPSHOT_DIR`)** — before a fleet-scope write (OU-scope or multi-device bulk) executes, the effective config (via the RSoP engine) is captured to a timestamped JSON file as a manual rollback reference point. Not an automatic rollback mechanism. Git-based snapshotting was considered and explicitly deferred — see the doc comment on `writeSnapshot()`.

A note on actor identity in the audit log: this server runs as a single stdio MCP session with one Scout Board credential set — there is no per-call upstream-caller identity threaded through today. Rather than fabricate one, the `actor` field honestly reports `"unknown"` unless `SCOUT_AUDIT_ACTOR` is set by a wrapping deployment that knows who/what triggered the session.

---

## Version check

On every MCP reconnect (each `docker run` is a fresh startup) the server checks the latest GitHub release and logs to stderr:

```
[scout-mcp] Version v1.5.1 is up to date.
# or:
[scout-mcp] Update available: v1.5.1 → v1.6.0. Rebuild the Docker image to get the latest version.
```

No action is taken automatically — the check is informational only.

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

## Available Tools (22 public + 11 private)

### Core tools

| Tool | Description |
|------|-------------|
| `scout_configure` | Set, inspect, or clear Scout Board credentials at runtime |
| `scout_context` | Set, inspect, or clear the session-level working OU default |
| `health_check` | Ping or authenticated system status check |
| `ou_get` | Read OUs — single, root, search, subordinates, structure, device status |
| `ou_manage` | Add, rename, delete, move OUs; export/import OU structures |
| `device_get` | Get device info, search in OU, runtime status, config origins; **`search_with_config` mode** fetches a config section for every matched device in one call |
| `device_manage` | Add, rename, delete, move devices |
| `device_command` | Send commands to devices/OUs/groups (restart, update, factory reset, etc.) |
| `device_diagnostics` | Async diagnostics: `run` (auto trigger→poll→download URL with progress), or manual `trigger` → `poll` → `download_url` |
| `app_list` | List base or OU-scoped applications |
| `app_manage` | Create, delete, copy, move applications; manage inheritance |
| `config_get` | Read configuration sections for base, OU, or device scope |
| `config_update` | Write configuration sections for base, OU, or device scope; pass `deviceIds[]` to update multiple devices in parallel |
| `config_compare` | Fetch a config section for a list of device IDs in parallel and group by identical config — `uniform: true` means all devices match, otherwise shows differing groups |
| `label_manage` | CRUD labels for dynamic device configuration |
| `rule_manage` | CRUD rules, validate expressions, manage label associations |
| `schedule_manage` | View and manage scheduled commands for OUs and devices |
| `maintenance_window_manage` | CRUD maintenance windows |
| `notification_manage` | Set and delete notifications for devices, OUs, and groups |
| `scout_update` | Check for and apply server updates |

### Fleet workflow tools

These tools compress common multi-step operations into a single call.

| Tool | Replaces | Description |
|------|----------|-------------|
| `onboard_branch` | `ou_manage(add)` + `ou_filter_manage(add)` | Create a new OU branch with filters in one call |
| `move_devices_by_filter` | `device_get(search)` + N×`device_manage(move)` | Find devices by search term and move them all to a target OU |
| `bulk_command` | `device_get(search)` + N×`device_command` | Find devices by search term and send a command to all of them |

All workflow tools support `dryRun=true` (preview without writing) and `confirm=true` (required for large/destructive operations). Max 500 devices per bulk operation.

**Typical fleet ops workflow:**

```
1. device_get mode=search_with_config ouRef=NorthCreek searchTerm=2603 searchFields=osVersion configSection=firmware
   → Returns each matched device with its firmware config in one call

2. config_compare deviceIds=[48,43,55,59] section=firmware
   → Groups devices by identical config; uniform=false shows which differ

3. config_update target=device section=firmware deviceIds=[55,59] body={...}
   → Applies the corrected config to the outlier devices in parallel
```

### Private endpoint tools (opt-in)

These tools target Scout Board internal endpoints discovered from browser network traffic — they are **not** in the public OpenAPI spec. Enable with `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`.

> **Warning:** These endpoints are unsupported and undocumented. They may change or disappear in future Scout Board releases without notice.

| Tool | Actions | Description |
|------|---------|-------------|
| `system_info` | `status_summary`, `device_count`, `device_distribution`, `device_image_files`, `recovery_settings`, `db_diags`, `system_check`, `tree_filter`, `missed_notifications`, `auth_user` | Read-only system status and diagnostic data |
| `system_settings` | `get_logging` / `set_logging`, `get_discover` / `set_discover`, `get_retain_local_config` / `set_retain_local_config`, `get_device_name_options` / `set_device_name_options`, `get_recovery_settings` / `set_recovery_settings`, `set_device_password` | Read and write server-wide settings |
| `predefined_commands` | `list`, `add`, `modify`, `delete`, `auth`, `list_templates`, `modify_templates` | Manage predefined device commands |
| `predefined_paths` | `list`, `add`, `delete` | Manage predefined firmware update paths |
| `predefined_images` | `list_images`, `list_uefi` | List predefined IDF images and UEFI files |
| `license_manage` | `get`, `check_availability`, `reconfigure` | Read and reconfigure Scout Board licensing |
| `admin_manage` | `list`, `permissions`, `advanced_rights`, `configuration_rights`, `update_rights`, `add_admin`, `update_admin`, `delete_admin` | Read and write admin accounts and UI permissions |
| `server_instances` | `list`, `modify`, `delete` | Manage Scout Board server instances |
| `db_cleanup` | `list`, `delete` | List and delete database records by filter |
| `ou_filter_manage` | `get_settings`, `list`, `set_settings`, `add`, `modify`, `delete` | Manage OU filter rules — **subnet filter** (IP network, e.g. `192.168.1.0/24`) and **user-defined filter** (ELUX_* property expressions, see syntax below) |
| `new_device_options` | `get`, `set` | Read or update new device enrollment options |

#### User-defined filter syntax (`custom_filter`)

Confirmed working against Scout 2605:

| Syntax | Example |
|--------|---------|
| Simple match | `ELUX_HOSTNAME=NorthCreek` |
| Prefix match (built-in) | `ELUX_HOSTNAME=North` — matches all hostnames starting with "North" |
| AND | `ELUX_HOSTNAME=NorthCreek AND ELUX_OSVERSION=2603` |
| OR | `ELUX_HOSTNAME=NorthCreek OR ELUX_HOSTNAME=LiveStick` |
| Grouped with brackets | `\(ELUX_HOSTNAME=NorthCreek OR ELUX_HOSTNAME=LiveStick\) AND ELUX_OSVERSION=2603` |

**Notes:**
- `AND` / `OR` must be uppercase
- Brackets must be escaped: `\(` and `\)`
- The `=` operator is the documented comparison operator; `!=` `>` `<` may work but are not in the official Scout 2605 docs
- No explicit wildcard character — prefix matching is built-in
- Multiple filter entries targeting the same OU are ANDed at evaluation time

---

## ELIAS tools (read-only phase, Scout 2611+)

ELIAS is built into Scout Board 2611 and served on the same host under `/api/v1/...` (no `/rest` prefix); it is not in `openapi.json`. These tools are **private endpoints**: they exist only when `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true` and need Scout 2611 or later. This phase is strictly **read-only** (GET only).

| Tool | Endpoint(s) |
|------|-------------|
| `elias_health` | `GET /systemcheck/elias` |
| `elias_container_list` | `GET /containers` |
| `elias_container_files` | `GET /containers/{id}/files` |
| `elias_rights` | `GET /containers/rights`, `GET /containers/{id}/rights` |
| `elias_package_list` | `GET /epms/getAll/{id}`; with `name`: `GET /epms/{id}/{name}.epm/fpms` |
| `elias_image_list` | `GET /images/getAll/{id}` |
| `elias_certificate_list` / `elias_certificate_get` | `GET /certificates/getAll/{id}`, `/certificates/{id}/{certId}`, `/certificates/signing/{id}` |
| `elias_upload_status` | `GET /files/upload/{id}/status` |
| `elias_container_get` | `GET /containers/{id}` |
| `elias_container_capabilities` | `GET /containers/capabilities` |
| `elias_container_rules` | `GET /containers/{id}/rules` |
| `elias_package_versions` / `elias_package_dependencies` | `GET /epms/{containerId}/{id}/versions`, `/dependencies` |
| `elias_image_get` | `GET /images/{containerId}/{id}` |
| `elias_my_roles` | `POST /elias/my-container-roles` (read behind a POST; body `{containerIds}` only) |

Safeguards: container/certificate/upload ids must be GUIDs and package names match a strict charset (no `..`, `/`, `%`, `?`, `#`); every segment is `encodeURIComponent`-encoded into a fixed path template. Lists use a minimal projection with `limit`/`offset` (default 50) and a 100 KB output cap. Certificates are metadata-only (PEM only via `includePem` for `CRT` public certs, never for the signing certificate); all responses pass through a recursive redaction filter for private-key/secret-looking fields. A 404 on the signing certificate is reported as `{"signingCertificate":"none"}`. Server text is untrusted data. Container ids are upper-cased before use (DBLayer only accepts the spelling `GET /containers` lists). Container-scoped calls need a per-container grant that the Scout Board proxy mints for any authenticated caller. Note: on CCAUTH installs Bearer-only calls outside `/rest` get a JSON 401, and on OIDC installs the `oidcToken` cookie is also required, so ELIAS/private tools may not work there. See [docs/reference/elias-api-notes.md](docs/reference/elias-api-notes.md) for rights, grant behaviour and what is deliberately not exposed.

Not implemented (later, Security-gated phase): container import/delete, image delete/save, upload init/complete, solver solve/generateRules, lock set/release. `POST /images/{id}/{name}.idf/idf` (IDF text export) is also left out: the HAR shows a POST with body `{}` returning text/plain but cannot prove it has no side effects, and `rawRequest()` parses JSON only.

## Scout version compatibility

`health_check` (mode `healthcheck`) reports `scoutVersion`, `versionSource` and a per-feature `capabilities` map (`available` / `unavailable` / `unknown`, plus a `verified-live` / `har-only` / `untested` status). Version detection is best-effort (medium confidence from the documented healthcheck/instances sources; verified on Scout 26.11.0); read-only capability probes are the source of truth. The `elias_*` tools return "requires Scout >=2611 (detected X)" instead of a raw 404 on older servers. See [docs/compatibility.md](docs/compatibility.md) for the release matrix; the registry lives in `src/compat/registry.ts`.

## Response enrichment

Tool responses that contain numeric OUID fields (e.g. `device_get`, `device_manage`) are automatically annotated with human-readable `_OUIDName` and `_OUIDPath` siblings, so the AI has full context without a follow-up `ou_get` call:

```json
{ "Name": "Thin01", "OUID": 42, "_OUIDName": "Berlin Office", "_OUIDPath": "/Enterprise/Germany/Berlin", "Status": "active" }
```

The enrichment is best-effort — if the OU tree cannot be fetched the original response is returned unchanged. The OU map is cached for 5 minutes and invalidated automatically after any `ou_manage` mutation.

---

## Fuzzy suggestions on 404

When an `ou_get` or `ou_manage` call returns HTTP 404, the error automatically includes a ranked "Did you mean?" list:

```
ou_get failed: OU not found at path "/Enterprise/Germany/Berln" (HTTP 404)

Did you mean one of these OUs?
  • "Berlin Office"  →  /Enterprise/Germany/Berlin
  • "Berlin HQ"      →  /Enterprise/Germany/BerlinHQ
```

Matching ranks by: exact → prefix → substring → edit-distance similarity. When `device_get` or `device_manage` returns 404, the error includes a hint to use `device_get mode=search` to locate the device by partial name.

---

## Working OU (session context)

Set a default OU once per session and omit it from every subsequent call:

```
scout_context action=set_ou path=/Enterprise/Germany/Berlin
→ Working OU set to "Berlin Office" (/Enterprise/Germany/Berlin)

device_get mode=search searchTerm=thin*          # no ouPath needed
ou_get mode=subordinate                          # no path needed
device_manage action=add newDeviceName=Thin99 newDeviceMac=AA:BB:CC:DD:EE:FF
```

The working OU is session-scoped (in-memory, cleared on restart). Use `scout_context action=get_ou` to inspect and `action=clear_ou` to unset.

**Tools that respect the working OU default:** `device_get mode=search` and `mode=search_with_config`, `ou_get mode=subordinate` and `mode=device_status`, `device_manage action=add` and `action=move`.

---

## MCP Prompts (workflow templates)

Five pre-built workflow templates are exposed via the MCP `prompts/list` and `prompts/get` endpoints:

| Prompt | Description | Key arguments |
|--------|-------------|---------------|
| `scout_connect` | Connect to a server and prepare the session | `base_url`, `username`, `ou_path` (opt) |
| `onboard_device` | Add a new device to Scout Board | `device_name`, `mac_address`, `ou_path` (opt) |
| `audit_ou` | List and summarise device health in an OU | `ou_path` (opt), `include_sub_ous` (opt) |
| `mass_command` | Send a command to all devices in an OU | `command`, `ou_path` (opt), `confirm` (opt) |
| `move_devices` | Find devices by name and move them | `search_term`, `target_ou`, `source_ou` (opt) |

---

## Destructive operation safeguards

- `device_command` with `factoryreset` or `halt` requires `confirm: true`
- `bulk_command` and `move_devices_by_filter` require `confirm: true` for operations affecting more than one device
- When `SCOUT_ENV=test`, all write operations are restricted to `SCOUT_TEST_OU_PATH`

---

## Authentication

Scout Board uses JWT authentication. The client sends credentials to `POST /rest/api/v1/user/login` and receives a token stored in-memory. The token is sent as a `Cookie: ScoutBoardAuthJWT=<token>` header on every request. On a 401 response the client re-authenticates once and retries automatically.

### Citrix Cloud service-principal auth

As an alternative to username/password, set `SCOUT_AUTH=citrix-cloud` to authenticate with a
Citrix Cloud **service principal** — no shared admin credentials needed. The flow is three
calls: (1) mint a Citrix Cloud bearer token via an OAuth2 client-credentials grant at
`POST <token_base>/cctrustoauth2/<customer_id>/tokens/clients` (the body **must** be
`application/x-www-form-urlencoded`); (2) exchange it at
`POST https://<scout_host>/rest/auth/v1/ccauth/login` with a **standard** `Authorization: Bearer <token>`
header (not Citrix's `CwsAuth Bearer=` prefix); (3) use the returned Scout Board JWT exactly like
password auth. Tokens live 1 hour and are re-minted automatically on 401.

Token endpoint bases per region:

| `SCOUT_CC_REGION` | Base URL |
|---|---|
| `us` | `https://api-us.cloud.com` |
| `eu` | `https://api-eu.cloud.com` |
| `ap-s` | `https://api-ap-s.cloud.com` |
| `jp` | `https://api.citrixcloud.jp` |
| `staging` | `https://api.cloudburrito.com` — uses `/root/` in place of `/<customer_id>/` in the token path (no customer id needed) |

Troubleshooting:

| Symptom | Cause / fix |
|---|---|
| 401 minting the CC token | Wrong `client_id`/`client_secret` (or region) — verify the service principal credentials |
| 403 minting the CC token | Token endpoint region doesn't match the service principal's tenant region — pick the right `SCOUT_CC_REGION` |
| 400 minting the CC token | Request body not form-urlencoded (JSON is rejected) |
| 401 exchanging at `/ccauth/login` | Scout Board can't validate the CC token — server-side CC service configuration issue, contact the Scout Board admin |
| 403 exchanging at `/ccauth/login` | CC token is valid but the service principal's client_id UUID isn't registered as a Scout Board user — add it under Users with **Login + WebService** rights (no auto-provisioning) |

Password auth remains the default and is completely unchanged.

---

## Running tests

`npm test` runs the live integration suite — it requires a real Scout Board server, and all write operations are scoped to `SCOUT_TEST_OU_PATH`.

```bash
cp .env.example .env   # fill in your values
npm test
```

The integration suite aborts immediately if `SCOUT_TEST_OU_PATH` is not set.

`npm run test:unit` runs pure unit tests (the safety-gate logic in `src/safety/guardrails.ts`, the RSoP merge engine, config validation, and read-only/gate-wiring guarantees) — no live server or credentials needed:

```bash
npm run test:unit
```

---

## Architecture

```
src/
  index.ts        MCP server entry point — startup auth, version check, tool dispatch
  client.ts       ScoutClient — JWT cookie auth, undici TLS control
  session.ts      Runtime credential store and ~/.scout-mcp.json persistence
  types.ts        Shared helpers: ok(), fail(), buildQuery()
  enricher.ts     Annotates OUID fields with human-readable OU names/paths (5-min cache)
  fuzzy.ts        Ranked "Did you mean?" suggestions on 404 responses
  resolver.ts     Resolves OU names/partial names to IDs for natural-language inputs
  resources.ts    MCP Resources — live OU tree + device inventory
  progress.ts     ProgressReporter — wires server.sendLoggingMessage into long-running tools
  safety/
    guardrails.ts Single chokepoint for all 8 write-safety gates (mode tiers, base/root
                  protection, blast-radius cap, kill switch, circuit breaker, protected/
                  allowed OU lists, private-writes-in-production) + audit log + snapshot
  tools/          One file per functional group
logs/             Runtime-generated, gitignored: scout-audit.log, scout-snapshots/
catalog/
  server.yaml     Docker MCP Registry submission metadata
  tools.json      Static tool list for registry build validation
.github/
  workflows/
    update-mcp-registry.yml   Auto-updates registry PR on every push to main
    cleanup-runs.yml          Deletes failed workflow runs automatically
```
