# Scout release compatibility

Which MCP features depend on the Scout Board release, and how well each is known to work.
The machine-readable source is `src/compat/registry.ts`; `tests/compat.test.ts` fails if the
ids, minimum versions or statuses in the table below drift from it. Update both in the same PR.

Versions are year-month release numbers (`2611` = Scout 2611). `-` means no source establishes
a minimum release. Status values:

- `verified-live` - confirmed against a real Scout server (cited in the README).
- `har-only` - shape taken from a browser HAR capture; never exercised by this MCP against a live server.
- `untested` - implemented from the OpenAPI spec or config only.

## Feature matrix

| Capability id | Min Scout | Status | 2605 | 2609 | 2611 | Notes |
|---------------|-----------|--------|------|------|------|-------|
| `elias` | 2611 | verified-live | ? | ? | yes | Private `/api/v1/systemcheck/elias` and friends; 16 read-only `elias_*` tools. README: "built into Scout Board 2611". Verified live on Scout 26.11.0 (2026-11-24): `systemcheck/elias` reachable, `elias_container_list` (11 containers), `elias_rights` (all six rights true), over Bearer auth. The other 13 tools (incl. every container-scoped one that needs the per-container grant) are not yet exercised live. |
| `ourights-preflight` | - | har-only | ? | ? | route | `GET /api/v1/ourights?ouId=` seen in the HAR. No source gives the release that introduced it. The probe omits `ouId`; the server answers 404 `OuId not found` (no 400 path), which counts as available, while a plain route-404 means unavailable. On 26.11.0 the probe reported the route as available (404 `OuId not found`, 2026-11-24); the rights map and a preflight refusal have not been exercised live. UX aid only; the preflight proceeds when the endpoint is missing or errors. |
| `advanced-file-entries` | - | untested | ? | ? | route | Public `/config/advanced/*/fileEntries` are in `openapi.json`. On 26.11.0 the capability probe reported the route available (2026-11-24); `config_resolve` has not been run against it live. Only `config_resolve` consumes them. |
| `ou-filter-and-or` | 2605 | verified-live | yes | ? | ? | README: AND/OR, bracket grouping and prefix matching "confirmed working against Scout 2605". Earlier releases not tested. |
| `ccauth-login` | - | untested | ? | ? | ? | Citrix Cloud service-principal login; config-driven (`SCOUT_CC_*` variables), not probeable. Server-side support release unknown. |
| `elias-write-containers` | 2611 | untested | ? | ? | ? | ELIAS container write foundation: `POST /api/v1/containers/import {name}` (`elias_container_create`). Off by default (`SCOUT_ELIAS_WRITES`). The request body is known from vendor source/e2e only; no live capture exists, so the tool is NOT registered (rule D0) until a scrubbed live capture is recorded `verified-live` with an evidence record (see below). Not probeable. |
| `healthcheck` | - | verified-live | ? | ? | yes | Public `/api/v1/healthcheck`; present in the shipped OpenAPI spec. `health_check` ran on 26.11.0 (2026-11-24): `healthState: ok`, database layer available. |

Legend: `yes` = verified on that release, `route` = only the endpoint's existence was verified (probe),
`expected` = implied by the minimum release but not verified, `?` = no evidence either way.

## Verified live (log)

| Date | Scout release | What was exercised | Result |
|------|---------------|--------------------|--------|
| 2026-11-24 | 26.11.0 | `health_check`: version detection and capability probes | Version `26.11.0`, confidence `medium`, `healthState: ok`; probes: `elias`, `advanced-file-entries`, `healthcheck`, `ourights-preflight` available; ELIAS `reachable`; database layer available. `ou-filter-and-or` and `ccauth-login` are not probeable. |
| 2026-11-24 | 26.11.0 | `elias_container_list`, `elias_rights` (Bearer auth, read-only mode) | 11 containers (`uc-elux7-2507` ... `uc-elux7-2612`, `uc-rp6-x64`); all six ELIAS rights allowed |
| 2026-11-24 | 26.11.0 | `ourights` probe | Before the 404-message fix it reported unavailable; after, available (the 404 `OuId not found` means the route exists) |

## ELIAS write tools: body evidence (rule D0)

A write tool is registered only when its request body is `verified-live` AND the registry carries an
evidence record (`date`, `captureId`, `fixtureSha256` of the scrubbed contract fixture under
`tests/fixtures/elias/contracts/`). A status string alone is self-attested and is not enough. The one
exception is the test-environment escape hatch (`SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES=true` with
`SCOUT_ENV=test`), limited to names matching `MCPTEST-<8 digits>-<8 hex>` and audited with `unverified:true`.
Fixtures are produced by `scripts/scrub-fixture.ts` (allow-list extraction: method, path template, body key
names and types, status; no values, hosts, cookies, tokens or credentials). Raw HARs are gitignored and must
never be committed.

| Tool | Endpoint | Body status | Evidence |
|------|----------|-------------|----------|
| `elias_container_create` | `POST /api/v1/containers/import {name}` | untested | none (no live capture yet) |

Not yet exercised live: the container-scoped ELIAS tools (need the per-container grant), `elias_my_roles`, `config_resolve` with advanced file entries, every write tool.

## Added in (sourced facts only)

- **2605**: user-defined OU filter syntax with AND/OR, bracket grouping and built-in prefix matching confirmed working (README).
- **2609**: no Scout Board facts are sourced. (Devices in the HAR report eLux client OS `7.2609.x`; that is the client OS, not the Scout Board release.)
- **2611**: ELIAS built into Scout Board (README); confirmed reachable on a live 26.11.0 server (see the log above). The ELIAS OpenAPI (Scout 26.11, DBLayer 15.2611+) is consistent with this.

Scout releases are versioned `YY.MM.patch` (e.g. `26.11.0` = `2611`). The public `openapi.json` `info.version` `25.11.0` is the release that spec was taken from (2511), not the version of any server under test; `src/compat/detect.ts` parses `YY.MM`.

The `docs/reference/` tables cite `7.2603`, `7.2605` and similar; those are **eLux client OS**
releases for terminal.ini settings and say nothing about the Scout Board server release.

## How the version is detected

`health_check` (mode `healthcheck`) reports `scoutVersion`, `versionSource`, `versionConfidence`
and a `capabilities` map. Sources, in order, all best-effort:

| Source | Used as server version? | Confidence |
|--------|-------------------------|------------|
| `GET /api/v1/ui/instances` (private) - `Version` on rows with `InstanceType` 1 (Server), 6 (DBLayer) or 8 (Scout Board) | yes | medium (documented in the Scout Board source review; not yet seen live) |
| `GET /rest/api/v1/healthcheck?scoutServer` - `response.scoutServer.scoutServer[].Version`, e.g. `15.2611` | yes | medium (documented; public healthcheck returns HTTP 200 even on errors, which are in the body) |
| `GET /rest/api/v1/healthcheck?scoutDatabase` - `response.scoutDatabase.version` | yes | medium (documented; format unverified, `26.11.0` plausible) |
| Generic `version`/`scoutVersion` scan of the same bodies, incl. `/api/v1/healthcheck?scoutServer=true` (fallback) | yes, if present | low |
| Capability inference: working ELIAS probe | as lower bound `>=2611` | low |
| `openapi.json` `info.version` (`25.11.0`) | no - spec snapshot only, reported as `specVersion` | n/a |

Only those fixed paths are read (no deep search), and the value is sanitised: at most 32 characters of `[0-9A-Za-z._+-]`, otherwise it is dropped and the version is reported as unknown.

When the version table and a probe disagree, the probe wins and the disagreement is reported
in `capabilityDisagreements`. Probes are read-only GETs: 2xx = available, 404 = unavailable,
401/403 = unknown (forbidden), 5xx/network/timeout = unknown; a 200 with a non-JSON body counts as available. Concurrent detections share one in-flight run. Private-endpoint probes only run
when `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`. Results are cached per client for 5 minutes.

## Open questions

- Which documented source supplied `26.11.0` on the live server: `health_check` reported it at `medium` confidence, but the `versionSource` value was not recorded here. Record it, then promote that source in the table above.
- Release that introduced `ourights`. (A call without `ouId` returns 404 `OuId not found` on 26.11.0, not 400.)
