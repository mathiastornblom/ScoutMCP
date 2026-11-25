# QA review PR #42 (fix/startup-auth-nonblocking)

## Verified
- `npx tsc --noEmit`: clean.
- `npm run test:unit`: passes (tail shows 20/20 in last suite; no failures seen).
- The 3rd argument to fetchWithTimeout is applied ONLY at the password login call (client.ts ~L187-194). Other callers keep the default `this.timeoutMs`. `Math.max(timeoutMs, 90000)` means a user override above 90s is respected.
- Startup: login runs in a detached async IIFE, so the handshake no longer waits. The IIFE catches all errors, so no unhandled rejection.
- Clearing: only ScoutError with statusCode 400/401/403. AbortError (timeout), network errors and 5xx are not ScoutError-with-status, so credentials are kept. Login non-ok errors carry res.status, so the mapping works.
- No credentials: unchanged `else` branch, no login attempted.
- scout_configure after failed startup: with creds kept (transient), configure re-sets the config and the client is rebuilt (getClient keyed by config). With creds cleared (400/401/403), the existing "not configured" path applies. OK.
- Token expiry: untouched; ensureAuth re-logins lazily when token is null/expired.
- Concurrent first tool call during background login: ensureAuth has no in-flight de-dup, so two logins can run. Both return valid JWTs and the last write wins. Harmless functionally (only extra server load / duplicate session). A shared `loginPromise` would be nicer but is not needed for this PR.
- Race nuance: if the background login is rejected with 400/401/403 AFTER the user has already run scout_configure with new credentials, `clearSessionConfig()` would wipe the NEW config. Narrow window, and only if the old creds are rejected while the user is reconfiguring. Low severity; optional guard: compare `resolveConfig()` to `startupConfig` before clearing.

## Findings
1. (Non-blocking, recommend) Citrix Cloud path gets no headroom. Step 1 (mint) hits Citrix Cloud and is fine at 30s. Step 2 (`ccauth/login` exchange, client.ts ~L260) hits the Scout server, which is the one that is slow when cold, so it should get `Math.max(this.timeoutMs, LOGIN_TIMEOUT_MS)` too. Suggest applying it to the exchange only.
2. (Non-blocking) No unit test covers the new behaviour. Cheap to add.

## Suggested test (cheap, offline) - tests/login-timeout.test.ts, add to test:unit
Reuse the in-process HTTPS stand-in pattern from tests/ccauth.test.ts.
- Case A: set `SCOUT_REQUEST_TIMEOUT_MS=200`; stand-in `/rest/auth/v1/login` delays 600ms then returns `{token}`; `new ScoutClient(cfg).login()` must resolve (proves the 90s headroom). Before the change this aborts at 200ms.
- Case B: login endpoint returns 401 -> rejects with ScoutError.statusCode===401 (the contract index.ts relies on to clear). Login endpoint returns 500 -> statusCode===500 (kept).
- Case C (if Citrix headroom is added): same delay on `ccauth/login` exchange.
The index.ts clear/keep branching is top-level module code and is hard to unit test; extracting `shouldClearCredentials(err)` into a small exported function would make it testable (optional).

QA: APPROVED
