# Security review: fix/startup-auth-cleanup (uncommitted)
Checks: `npx tsc --noEmit` clean; `npm run test:unit` all pass (startup-auth 9/9).

1. Citrix exchange headroom (client.ts): OK. Math.max(timeoutMs, 90s) applied only to the ccauth/login exchange (Scout-side, slow when cold); the mint step (Citrix Cloud) keeps the default timeout, and a test asserts it. Same pattern as the direct login; a longer wait, no bypass. https still enforced upstream.

2. shouldClearCredentialsAfterAuthFailure + index.ts:
- Late rejection vs newer creds: closed. Clears only on ScoutError 400/401/403 AND current !== null AND sameConfig(captured, current). scout_configure replacing the config, or an earlier clear, means no wipe. Fail-safe direction on any doubt (keeps).
- Comparison/leak: sameConfig is a by-value strict-equality loop over the union of keys. It never logs or stringifies values and returns only a boolean. All ScoutConfig fields are primitives, so secrets (password, ccClientSecret) are compared with no shallow-compare blind spot. Not constant-time, but this is an in-process comparison of the user's own config, with no attacker timing channel. Absent vs undefined keys compare equal, which is correct.
- Env vs session: resolveConfig() returns _session if set, otherwise builds a fresh object from env or the saved file, so equality by value (not identity) is the right call. If config comes from env and the user then sets a session config, the two differ and nothing is cleared. If they are identical in value, clearSessionConfig is a harmless no-op on env config (same as before).
- Logged text: only err.message (pre-existing) plus baseUrl/username/ccClientId in the success line (pre-existing, non-secret). No new secret exposure.
- Tests: passwords and cc secrets use randomUUID(); no literal secrets (username 'u', fake JWT payload only). Temp key/cert is generated at runtime in tmpdir, not committed.

Finding A (LOW, non-blocking, recommend fix): in the catch block, `resolveConfig()` is called as an argument and can throw (e.g. session was cleared via scout_configure while env has SCOUT_AUTH=citrix-cloud incomplete, or an invalid SCOUT_AUTH/SCOUT_CC_REGION). The detached async IIFE has no outer catch, so this would be an unhandled rejection, which on Node 15+ terminates the process. It needs a narrow combination (a session-sourced startup config, the session cleared later, invalid env, and a 400/401/403 rejection arriving afterwards). The impact is a self-DoS of the MCP server, with no leak or gate bypass. Suggested fix: wrap the decision in try/catch and treat a throw as "keep" (`let current = null; try { current = resolveConfig(); } catch {}`), or add `.catch()` on the IIFE.

Finding B (INFO): the existing success-path `getClient()` is inside the try, so a throw there is caught. Good. A stale-client race is not a concern: getClient is keyed by config.

No gate, OU-protection or destructive-path changes. Net effect is strictly safer than PR #42 (closes its finding 2 race).

SECURITY: APPROVED
