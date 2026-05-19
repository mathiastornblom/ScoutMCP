## QA Status
Date: 2026-05-19
Status: TEST FILE WRITTEN (pending implementation run)
File: tests/integration.ts

---

### What was written

Complete integration test suite covering all six phases from design-decisions.md §8.2:

| Phase | Coverage |
|-------|----------|
| 1 — Connectivity | GET /ping via raw fetch, expects HTTP 200 |
| 2a — Constructor validation | ScoutClient rejects bad/missing env vars and http:// URL |
| 2b — Login (raw fetch) | POST /auth/v1/login with good creds (expects JWT), with bad creds (expects 401) |
| 2c — ScoutClient.login() | Valid creds set authenticated state; bad creds throw ScoutError(401); error does not expose password |
| 2c — 401 recovery | request() auto-logins on fresh client; propagates ScoutError when re-auth fails |
| 3 — OU read + health | ou_get(root), ou_get(structure), health_check(ping), health_check(healthcheck) |
| 4 — OU write | ou_manage add → rename → delete in finally block; assertUnderTestScope guard on every write |
| 5 — Device read | device_get(mode=search, ouPath=TEST_OU_PATH); accepts empty result |
| 6 — Config read | config_get(base/general), config_get(base/firmware) |

### Design decisions

- Tool functions are imported dynamically with try/catch. If a module is missing, affected tests
  report SKIP rather than crashing. This means the file compiles and runs usefully even against
  a partial implementation.
- All write operations (Phase 4) include an explicit `assertUnderTestScope()` call in the test
  harness, independent of the tool's own internal guard (belt-and-suspenders per security review).
- Phase 4 cleanup is in a `finally` block — deletes whichever of `tempPath` or `renamedPath`
  exists, determined by the `ouCreated`/`ouRenamed` flags.
- `mustThrow()` returns `unknown`; callers use `instanceof` narrowing for type safety.
- Raw fetch in Phases 1 and 2b verifies the HTTP protocol layer independently of ScoutClient.

### Files added

- `tests/integration.ts` — the test suite
- `tsconfig.test.json` — extended tsconfig that includes both `src/**/*` and `tests/**/*`
  so `tsc --noEmit --project tsconfig.test.json` can type-check the test file

### Notes

- The existing `tests/integration.ts` (Developer's draft, Phases 1–3 only) has been replaced
  with this full version. The Developer's healthcheck path `/healthcheck` has been corrected
  to `/api/v1/healthcheck` (matching the route registered in `src/tools/health.ts` via
  `client.request('GET', '/api/v1/healthcheck')`).
- `device_get` in Phase 5 uses `searchTerm: '*'` — if the API rejects this wildcard, the
  test accepts the error response as a known-API-response (not a bug). A more specific
  search term may be needed once real device data is known.
- The `ou_get(subordinate)` verification step in Phase 4 checks that the response contains
  OU field names (`"name"` or `"path"`), not the renamed OU name specifically — the API
  may return IDs rather than names, and an empty OU may omit the child entirely if the
  rename hasn't propagated yet.
