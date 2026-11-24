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
| `elias` | 2611 | har-only | ? | ? | expected | Private `/api/v1/systemcheck/elias` and friends; 9 read-only `elias_*` tools. README: "built into Scout Board 2611". The HAR host exposes it, but its own Scout version was not captured. |
| `ourights-preflight` | - | har-only | ? | ? | ? | `GET /api/v1/ourights?ouId=` seen in the HAR. No source gives the release that introduced it. UX aid only; the preflight proceeds when the endpoint is missing or errors. |
| `advanced-file-entries` | - | untested | ? | ? | ? | Public `/config/advanced/*/fileEntries` are in `openapi.json`; never exercised live. Only `config_resolve` consumes them. |
| `ou-filter-and-or` | 2605 | verified-live | yes | ? | ? | README: AND/OR, bracket grouping and prefix matching "confirmed working against Scout 2605". Earlier releases not tested. |
| `ccauth-login` | - | untested | ? | ? | ? | Citrix Cloud service-principal login; config-driven (`SCOUT_CC_*` variables), not probeable. Server-side support release unknown. |
| `healthcheck` | - | untested | ? | ? | ? | Public `/api/v1/healthcheck`; present in the shipped OpenAPI spec. |

Legend: `yes` = verified on that release, `expected` = implied by the minimum release but not
verified, `?` = no evidence either way.

## Added in (sourced facts only)

- **2605**: user-defined OU filter syntax with AND/OR, bracket grouping and built-in prefix matching confirmed working (README).
- **2609**: no Scout Board facts are sourced. (Devices in the HAR report eLux client OS `7.2609.x`; that is the client OS, not the Scout Board release.)
- **2611**: ELIAS built into Scout Board (README).

The `docs/reference/` tables cite `7.2603`, `7.2605` and similar; those are **eLux client OS**
releases for terminal.ini settings and say nothing about the Scout Board server release.

## How the version is detected

`health_check` (mode `healthcheck`) reports `scoutVersion`, `versionSource`, `versionConfidence`
and a `capabilities` map. Sources, in order, all best-effort:

| Source | Used as server version? | Confidence |
|--------|-------------------------|------------|
| `GET /api/v1/ui/instances` (private) - `version`/`scoutVersion` on the body, `response`, or each array item (also under `scoutServer`) | yes, if present | low (shape not verified in any capture) |
| `GET /api/v1/healthcheck?scoutServer=true` - `scoutServer.version`/`scoutVersion` (optionally under `response`) | yes, if present | low (OpenAPI example shows none) |
| Capability inference: working ELIAS probe | as lower bound `>=2611` | low |
| `openapi.json` `info.version` (`25.11.0`) | no - spec snapshot only, reported as `specVersion` | n/a |

Only those fixed paths are read (no deep search), and the value is sanitised: at most 32 characters of `[0-9A-Za-z._+-]`, otherwise it is dropped and the version is reported as unknown.

When the version table and a probe disagree, the probe wins and the disagreement is reported
in `capabilityDisagreements`. Probes are read-only GETs: 2xx = available, 404 = unavailable,
401/403 = unknown (forbidden), 5xx/network/timeout = unknown; a 200 with a non-JSON body counts as available. Concurrent detections share one in-flight run. Private-endpoint probes only run
when `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`. Results are cached per client for 5 minutes.

## Open questions

- Which field (if any) of `/api/v1/ui/instances` or `/api/v1/healthcheck` carries the Scout Board version on a real server.
- Release that introduced `ourights`; whether a call without `ouId` returns 400 (assumed "available") or something else.
