# Changelog

## Unreleased

### Added
- Build identifier: `health_check` returns `mcpBuild` (`version`, `gitSha`, `builtAt`, `build` e.g. `1.6.0+a1b2c3d`) and MCP `serverInfo.version` is now the build string. Baked in via Docker build args `GIT_SHA`/`BUILD_DATE`; `npm run docker:build` sets them locally.
- `health_check` now returns `mcpServerVersion` (the version of this MCP server). The version is read from `package.json` (`src/version.ts`) and also feeds MCP `serverInfo`, so the two cannot drift.

### Fixed
- Startup login no longer blocks the MCP handshake (cold Scout servers can take >30s to log in); credentials are cleared only on explicit rejection (400/401/403). Login timeout is 90s. (PR #42)

### Changed
- Integration suite aligned with the 1.6.0 gates; run with `SCOUT_MODE=write SCOUT_ALLOWED_OUS=/MCP-Test npm test` (PR #43).

## 1.6.0 (2026-11-25)

Verified live against Scout Board 26.11.0 (read-only plus `dry-run`; no write was sent). Every change below went through independent Security and QA review (`.agents/`).

### Added
- **Safety layer** (`src/safety/guardrails.ts`): `SCOUT_MODE` (read-only | dry-run | write, default read-only), Base-write lock, blast-radius cap, protected/allowed OU lists, private-writes-in-production lock, circuit breaker, kill switch, append-only audit log, snapshot-before-mutate.
- **Protected/allowed-OU gate for every OU-scoped write tool** via one shared gate (`src/safety/ou_gate.ts`): fresh-tree resolution, ancestor/subtree protection, canonical path comparison, only the resolved id is sent, strict `includeSubOus` and body-key sanitising, per-device source-OU checks (device OU from the live `GroupID`).
- **RSoP engine** (`config_resolve`) with per-key provenance, advanced file entries, pre-write validation, extended `config_compare`; eLux config schema (659 keys) as MCP resources.
- **Scout 26.11 / ELIAS (read-only):** 16 `elias_*` tools behind `SCOUT_ENABLE_PRIVATE_ENDPOINTS`; version detection and capability probes (`health_check`, `docs/compatibility.md`); `ourights` preflight (a UX aid, never a security boundary).
- **Transports/auth:** Streamable-HTTP transport with OIDC bearer auth; Citrix Cloud service-principal auth (`SCOUT_AUTH=citrix-cloud`); elicitation with `confirm:true` fallback; progress notifications.
- **ELIAS write-phase foundation** (no write tool registered): closed operation table, unforgeable single-use mutation token, gate pipeline, write-ahead audit, fixture scrubber.
- Docker: image ships the schema and `openapi.json`, writable logs volume, `docker-compose.yml`.

### Fixed
- OU resolver could not parse the live `ou/structure` response (no OU could be resolved by name); new strict `src/ou_tree.ts`.
- `device_manage` single-device source check failed open (now fails closed) and could not read the live envelope; bulk tools (`move_devices_by_filter`, `bulk_command`) returned HTTP 400 (missing `searchFields`); the per-device source gate now runs before preview and confirmation.
- `admin_manage`, `recoverySettings`, `dbCleanUp` and OU-filter type 4 use the real server routes/bodies; purging the activity log needs `SCOUT_ALLOW_AUDIT_PURGE=true` plus `confirm_audit_purge`.
- 401 handling (at most one re-login, rights denials reported as denials), `health_check` body-level errors, `elias_container_rules` output dropped over 100 KB.
- Security: dependency updates incl. undici (TLS validation bypass), proxy-addr, hono; `SCOUT_IGNORE_TLS` still the only way to accept self-signed certificates.

### Known gaps
`schedule_manage` is not tied to an OU; `target=devicelist|ddg` commands are not OU-gated; bulk writes address devices by name; `zod` 4 migration pending (advisory GHSA-mrhx-c7xc-m3w5); ELIAS write tools not yet available. See the README "Known gaps".
