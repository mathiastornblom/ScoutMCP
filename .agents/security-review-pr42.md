# Security review: PR #42 (fix/startup-auth-nonblocking)

Scope: src/index.ts, src/client.ts (diff origin/main...HEAD). Read-only review.

## Findings

1. Credential leakage in logs: NONE. Success line logs baseUrl + username / ccClientId (same as before).
   New "did not complete" line logs only `err.message` (ScoutError message from server body or fixed strings; no password/secret/token interpolated). Login payload is never in messages. OK.

2. Race: stale startup login vs scout_configure (LOW-MEDIUM, non-blocking). Previously startup login was awaited, so
   it could not interleave with a tool call. Now, if the background login is slow (up to 90s) and the user calls
   scout_configure (new, valid creds) in that window, a late 400/401/403 for the OLD creds runs unconditional
   clearSessionConfig() and silently wipes the NEW session config. Fail-safe direction (loses access, no leak, no gate
   bypass), recoverable by re-running scout_configure. Recommended hardening (follow-up OK):
   `if (getSessionConfig() === savedConfig-at-start) clearSessionConfig()` (compare object identity captured before login).
   Note: resolveConfig() may fall back to env vars, which clearSessionConfig does not touch, same as before.

3. Double login / token state: no single-flight in ensureAuth(), so a tool call arriving during the background login
   triggers a second concurrent login on the same ScoutClient instance. Both write this.token; last writer wins; both tokens
   valid. Harmless (extra login, no corruption, no privilege change). Optional: memoize an in-flight login promise.
   If scout_configure swaps creds, getClient() builds a new instance (key mismatch); the stale login only writes the old,
   orphaned instance. No cross-contamination.

4. Keeping credentials on transient failure: does not weaken anything. Credentials were already in memory/disk (~/.scout-mcp.json
   or env) and are only used against the same https baseUrl (https enforced in constructor). Timeout/network errors do not
   expand where creds are sent. Repeated retry on each tool call against a rejecting server is bounded to the lazily-triggered
   login (400/401/403 are still cleared at startup; later tool-call 401s follow existing one-retry policy). Minor: a
   tool-call-path 401 does not clear creds, same as before.

5. 90s login timeout: applies to tool-call logins too (Math.max(timeoutMs, 90s)); only a longer wait, not a bypass. A hung
   server holds a request up to 90s; acceptable. Timer is cleared in finally (pre-existing).

6. HTTP transport: startHttpTransport still awaited after the (now non-blocking) login kickoff; OIDC bearer gate in http.ts
   is unaffected. The background login uses the server-wide env/session Scout credential exactly as before; no change in
   which Scout identity HTTP callers act as. No new unauthenticated surface.

7. Safety gates (dry-run, destructive confirmations, SCOUT_TEST_OU_PATH, private-endpoint flag): untouched by diff; no bypass.
   Unhandled rejection: async IIFE has try/catch around getClient()+login(), so no unhandled rejection / crash.

## Verdict
No blocking issues. Recommend follow-up (not required for merge): identity guard before clearSessionConfig (finding 2),
optional in-flight login memoization (finding 3).

SECURITY: APPROVED
