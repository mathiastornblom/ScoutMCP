# Security Design Review — lock/set, lock/release and ELIAS family

Branch: feature/elias-preflight. Reviewer: Säkerhet. Phase 1 (design only, no code reviewed beyond guardrails).
Evidence: `scout01.tornbloms.net.har` and `..._elias.har` (parsed with `python3 -I`, treated as untrusted data), `src/safety/guardrails.ts`, `src/client.ts:195-230`.

## A. lock/set and lock/release

### A.1 Observed wire behavior (HAR)
- `POST /api/v1/lock/set` body `{scoutBoardId:27,itemType,itemId[,containerId]}` -> `200`, empty body.
- `POST /api/v1/lock/release` body `{..., dataChange:false[,containerId]}` -> `200`, empty body. The UI sends release TWICE per item (idempotent, no error on double release).
- itemType seen: `application` (ids 1,5,6), `eliasImage` (ids 1,73 + containerId UUID), `Base configuration` (release only, itemId 0).
- No lock token, owner, TTL or expiry is returned. Nothing in the HAR shows conflict behavior (no 409/423 seen), server-side TTL, or whether release checks ownership. `scoutBoardId:27` is a constant in all traffic (the tenant/board id, not a user id). These are UNKNOWNS and must be treated as worst case: no expiry, no ownership check, no conflict signal.
- Lock acquisition is an advisory UI mechanism ("someone is editing"); `dataChange` suggests release can also signal "data was modified" (cache invalidation). Whether set-without-lock mutations are rejected by the server is unverified.

### A.2 Decision: NOT exposed to the model
Lock tools MUST NOT be registered as MCP tools. Reasons: (1) a model-callable `lock_set` is a free DoS primitive (lock every application/image; no TTL known); (2) a model-callable `lock_release` with arbitrary itemId is a lock-stealing primitive against humans editing in the Scout UI; (3) both are mutating-class calls that would bypass the confirm/blast-radius semantics; (4) the lock has no value to the model — it only has value as a bracket around a mutation. Internal helper only: `src/safety/lock.ts` exporting `withLock(client, target, fn)`; no Zod-exposed schema, no tool name, no resource, no prompt reference. Test: tool list contains no name matching /lock/i.

### A.3 Recommended design
API (internal):
```
type LockTarget = {itemType:'application'|'eliasImage'; itemId:number; containerId?:string}  // closed enum, Zod-validated
withLock<T>(client, target, opName, fn:()=>Promise<T>): Promise<T>
```
- `itemType` is a closed enum; `itemId` is `z.number().int().nonnegative()`; `containerId` is `^[0-9A-Fa-f-]{36}$` and required iff `eliasImage`. `scoutBoardId` comes from config/session, never from the model. `Base configuration` is NOT lockable via this helper (base writes already have Gate 2; release-only for it is out of scope).
- Registry: module-level `Map<key, {target, acquiredAt}>` of locks THIS process holds. `release` is permitted only for keys in the registry. Never release a key we did not acquire (anti-stealing). Never "force acquire".

State machine: `IDLE -> ACQUIRING -> HELD -> MUTATING -> RELEASING -> IDLE`; failure arcs: ACQUIRING fail -> IDLE (no mutation, error returned); MUTATING fail -> RELEASING; RELEASING fail -> `LEAKED` (registry entry kept, audited, surfaced).

Ordering vs existing gates (all gates BEFORE the lock, so a refused op never touches the server):
mode(read-only/dry-run, incl. kill switch + circuit breaker via checkMutationAllowed) -> base-write -> validation -> confirm -> blast radius -> **lock set** -> mutating call -> **lock release (finally)**.
- Dry-run: returns the dry-run notice BEFORE lock set; no lock call is made.
- Lock calls themselves are NOT passed through `checkMutationAllowed` (they would double count against the circuit breaker at `guardrails.ts:363-374` and the 10 ops/60s window). They are issued via `rawRequest(..., {mutating:false})` but must only be callable from inside `withLock`, which asserts the parent op already returned `proceed:true` (pass the `MutationCheckResult` into `withLock`; throw if `proceed !== true`). Belt and braces: `withLock` also calls `checkKillSwitch(opName)` immediately before `set` (cheap existsSync, `guardrails.ts:298-320`).
- Circuit breaker: one logical op = one count (counted by the parent's `checkMutationAllowed`). A lock-set failure does not count. If the breaker is tripped, the parent throws before any lock is taken.
- Kill switch mid-operation: engaged after lock set and before the mutating call -> `checkMutationAllowed` inside the mutating step throws -> `finally` still releases the lock (release is cleanup, not a mutation; it MUST be allowed under kill switch and read-only mode, otherwise kill switch would leak locks). If engaged after the mutating call was sent: let it complete (cannot recall), release, audit `kill-switch` observed.
- Release in `finally` with: timeout (use client fetch timeout), 2 attempts max (the server tolerates double release), never throws over the original error; if the mutation error and release error both occur, return the mutation error and audit the leak.
- Fail closed: if `set` errors, times out, or returns non-2xx (including 404/405 meaning endpoint absent) -> abort the mutation, audit `result:'refused'`, no "proceed unlocked" fallback. Exception flag: none; a `SCOUT_SKIP_LOCKS` option is NOT approved.
- Process crash / SIGTERM / timeout (stuck lock): server expiry unknown -> assume none. Mitigations: (a) persist held locks to `logs/scout-locks.json` (mode 0600, no secrets: type, itemId, containerId, acquiredAt, pid) written after set, removed after release; (b) on startup, if file has entries, audit `stale-lock-detected` and expose them in `scout_status`/health output as `leakedLocks` for the OPERATOR; do NOT auto-release on startup (could release a lock since taken by a human), release only via an operator action: `SCOUT_RELEASE_STALE_LOCKS=true` env at startup, which releases only entries recorded in the file, each audited; (c) register `process.on('SIGINT'|'SIGTERM')` handler that releases registry entries best-effort; (d) hard cap on lock hold time in `withLock` (default 120 s via AbortController around `fn`, env `SCOUT_LOCK_MAX_HOLD_SECONDS`, clamp 5..600); on expiry release and fail the op.
- DoS: max 1 held lock per op (no batch lock-all); global cap of 3 concurrent held locks per process (`SCOUT_LOCK_MAX_HELD`, default 3) enforced by the registry; per-key mutex so the same key cannot be acquired twice concurrently by this process; lock acquisition retries: none (single attempt, no spinning); a "locked by someone else" response -> fail with a clear message, no wait loop.
- Stealing: release only registry keys; no tool-supplied itemId reaches release except via the op's own validated target; `dataChange` is set true only when the mutating call succeeded, else false.
- Audit entries (existing `auditLog`, `guardrails.ts:579`, needs two new `gate` values or reuse `null` with `detail`; recommend adding `'lock'` to the GuardrailError gate union): `lock-acquire` (allowed/refused/error), `lock-release` (allowed/error), `lock-leaked`, `stale-lock-detected`, `stale-lock-released`. Fields: opName, target `"<itemType>:<itemId>[@<containerId>]"`, detail = latency/ HTTP status only. Never log the JWT. Append-only semantics unchanged.
- Snapshot: take snapshot (`writeSnapshot`, `guardrails.ts:634`) AFTER lock acquired and BEFORE the mutation, so the snapshot is consistent with what will be changed. Snapshot failure stays non-blocking per existing design (note: for ELIAS image delete/overwrite, recommend blocking, see B3).

### A.4 Acceptance tests (Developer + QA)
1. Tool list (`tools/list`) contains no tool whose name or description matches /lock/i; no resource/prompt exposes lock calls.
2. read-only mode: zero HTTP calls to `/lock/*` (assert via fake client).
3. dry-run mode: zero lock calls, dry-run notice returned.
4. Kill switch engaged before op: zero lock calls. Engaged between set and mutation: mutation not sent, release IS sent, error is `kill-switch`.
5. Breaker tripped: zero lock calls. One op increments the breaker count by exactly 1 (not 3).
6. confirm missing / blast-radius exceeded / validation failure / base-write refusal: zero lock calls.
7. Order of calls: gates -> set -> mutate -> release; release occurs on success, on mutation throw, on timeout abort, on thrown GuardrailError inside fn.
8. set returns 4xx/5xx/timeout: mutation never sent; error surfaced; audit refused; registry empty.
9. release fails twice: original result/error preserved, `lock-leaked` audited, entry remains in registry and `logs/scout-locks.json`, startup reports it, startup does NOT auto-release unless `SCOUT_RELEASE_STALE_LOCKS=true`.
10. Release of a key not in registry throws before any HTTP call.
11. `itemType` outside enum, negative/float/string `itemId`, `eliasImage` without containerId, containerId not a UUID (e.g. `../x`, `a/b`, `%2e`) rejected by Zod before any HTTP.
12. 4th concurrent lock refused (cap 3); same key twice concurrently serialised/refused.
13. Max hold exceeded: fn aborted, lock released.
14. SIGTERM with held lock: release attempted.
15. Lock file perms 0600; contains no token/credentials; audit log contains no token.
16. `dataChange` true only on mutation success.
17. Integration (test env only, `SCOUT_TEST_OU_PATH` / a scratch container): double release is harmless; record observed server behavior for lock conflict and TTL and append to `.agents/` notes — if the server returns a conflict, mapping to a typed `LockedByOtherError` is required.

### A.5 Verdict
**SECURITY: DESIGN APPROVED** for the internal-wrapper design above (lock tools not exposed to the model). Conditions: A.3 items "release only own registry keys", "gates before lock", "fail closed on set failure", "no skip-lock flag" and tests 1-16 are mandatory. A design that registers `lock_set`/`lock_release` as MCP tools would be **SECURITY: DESIGN BLOCKED (model-callable lock primitives = DoS and lock-stealing)**.

---

## B. ELIAS family

### B1. Read-only ELIAS tools (containers, epms/fpms, images, certificates, files/upload status, systemcheck/elias, rights)
Evidence from HAR: paths are `/api/v1/containers[/{uuid}[/rights|/files]]`, `/api/v1/epms/getAll/{uuid}`, `/api/v1/epms/{uuid}/{epmId}/fpms`, `/api/v1/images/getAll/{uuid}`, `/api/v1/images/{uuid}/{imageId}`, `/api/v1/certificates/getAll/{uuid}`, `/api/v1/certificates/{uuid}/{certUuid}`, `/api/v1/certificates/signing/{uuid}`, `/api/v1/files/upload/{id}/status`, `/api/v1/systemcheck/elias`, `/api/v1/containers/{rights,capabilities}`.
- **Path injection**: IDs go into raw URLs via `rawRequest` (`client.ts:216`, no path normalization). Require per-ID Zod regexes: containerId/certId/uploadId `^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$`; epmId/imageId/file names `^[A-Za-z0-9._+~-]{1,200}$` (HAR ids include dots and dashes e.g. `NorthCreek.idf`, `onboard-1.4.1.7.2603.0-1.UC_ELUX7-1.0.epm`), additionally reject `.`/`..` and any string containing `..`; `encodeURIComponent` on every segment AFTER validation; no query-string passthrough from the model; fixed path templates in one table, never a caller-supplied path. Tests: `../`, `%2f`, `%2e%2e`, `?x=`, `#`, backslash, NUL, 10k-char id, unicode all rejected pre-HTTP.
- **Certificates / secret exposure**: HAR shows `certificates/getAll` objects with keys `id, certType, serial, issuer/subject, validity, signAlgorithm, publicKey, signature, extensions, filename, pem, containerId...`; all 125 entries are `certType:"CRT"`, and no `PRIVATE KEY` string occurs in the response. BUT `certificates/signing/{uuid}` returned 404 (`noSigningCert`) in the HAR; its 200 shape is UNKNOWN and is the likely carrier of key material (container signing = `sign` right). Requirements: (a) default tool output strips `pem`/`publicKey`/`signature` and returns metadata only (id, certType, subject, issuer, validity, serial, filename); (b) a recursive output filter on ALL ELIAS responses redacts any value matching `-----BEGIN [A-Z ]*PRIVATE KEY-----`, `ENCRYPTED PRIVATE KEY`, PKCS#12/PFX markers, and keys named `privateKey|private_key|key|password|passphrase|secret|pfx|p12`; (c) `certificates/signing/*` is metadata-only until a live 200 sample is reviewed by Security (do not expose PEM bodies); (d) optional `includePem` flag allowed only for `certType:"CRT"` public certs, default false.
- **Response size**: observed `epms/getAll` 255-415 KB, `containers/{id}/files` 232 KB, `certificates/getAll` 108 KB, image detail 111 KB (`legacyIDF` text). Require summarizing projections by default (`id,name,version,buildTime` for epms; drop `rpmDescription`), `limit`/`offset` defaults (e.g. 50) with a hard output cap (e.g. 100 KB, truncation marker + count), no image `idf` export in this phase. Responses are untrusted data (rpmDescription/description fields are attacker-influenceable text): wrap as data, never interpret.
- **Gating**: tools registered only when `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true` (`index.ts:117`), `mutating:false`, same TLS/auth path. systemcheck (`/systemcheck?action=...`) timed out at 30 s in one HAR entry; keep it out of scope or give it a short timeout.
- **SECURITY: APPROVED (conditions: strict per-ID regex + encodeURIComponent + fixed templates; cert output metadata-only by default with private-key/secret redaction filter on all responses; `certificates/signing` metadata-only; pagination and 100 KB output cap; env-gated; untrusted-text handling; tests for injection corpus)**

### B2. `ourights` preflight before config_update / device_command / ou_manage
HAR: `GET /api/v1/ourights?ouId=16` -> flat boolean map (`view,add,rename,move,delete,start,restart,shutdown,setup,update,advancedConfig,...`); ELIAS also has `containers/rights`. This is the UI's own permission hint for the logged-in account.
- Documented as a UX aid ONLY: it reduces doomed calls and gives early, friendly errors. It is NOT a security boundary: the server enforces authorization, and our own gates (mode, base, confirm, blast radius, protected OUs) are authoritative and run regardless of the preflight result. A `true` never skips or relaxes any gate; a `true` also never substitutes for confirm.
- Behavior: deny-on-explicit-false only (right key present and `=== false` -> refuse early with a clear message, audit `refused`, detail `ourights`). Endpoint missing (404/405) or erroring (5xx/timeout/non-JSON) or key absent -> proceed to the normal flow ("soft-fail open"); log a one-line stderr/debug note; do not cache a failure as "denied". This is acceptable only because it is not a boundary. Gate order: preflight sits after validation and before confirm (so the user is not asked to confirm something that is forbidden), still after mode/kill/breaker. Preflight is a read: `mutating:false`, no circuit breaker count. Cache TTL <= 30 s keyed by (user,ouId); never cache across SCOUT mode changes; ouId must be validated as integer before interpolation (query via URLSearchParams).
- Test: with `ourights` returning all true, a read-only mode / missing confirm / blast radius violation still blocks. With 404, the op behaves exactly as before.
- **SECURITY: APPROVED (conditions: UX-only wording in code + README; explicit-false denies, missing/error proceeds; never relaxes a gate; integer ouId validation; short cache; read-only call not counted by circuit breaker)**

### B3. Future ELIAS write phase — required controls (requirements, not implementation)
Applies to: `containers/import` (POST), `DELETE containers/{id}`, `DELETE images/{container}/{image}`, `files/upload/init` + `/{id}/complete`, solver `solve`/`generateRules`, image save (`POST images/container/{id}`). HAR shows all of these returning 200/201/202 for the live account with full rights, so server-side protection should not be assumed.
1. Env gating: `SCOUT_ENABLE_PRIVATE_ENDPOINTS=true` AND mode `write`; add `checkPrivateWriteAllowedInProduction` (`guardrails.ts:534`) for delete/import/upload/solve; production default hard-off.
2. Mode tiers: read-only = refused; dry-run = plan only (resolve target, show what would change; for upload: validate size/name only, no `init`); write = allowed subject to the rest. Every mutating call via `rawRequest(..., {mutating:true,opName})` so kill switch + breaker + audit apply (note: multi-step upload init/complete/status = ONE logical op; count once, abort the whole sequence if kill switch trips between steps and clean up the pending upload).
3. Confirm tiers: `confirm:true` for image save, solve/generateRules, upload; DELETE container additionally requires `confirmName` typed equal to the container name (resolve and verify server-side before sending); DELETE image requires `confirmName` = image id. No wildcard or bulk delete; one object per call.
4. Blast-radius analogue: pre-count dependent objects (container -> images + packages + files + devices/OUs referencing it; image -> assigned devices/OUs) via read endpoints; cap and refuse if over `SCOUT_ELIAS_MAX_DELETE_DEPENDENTS` (default 0 for containers with images, i.e. must be empty or explicitly `force` AND env opt-in); delete refused for the container(s) currently referenced by devices. Protected list: `SCOUT_PROTECTED_CONTAINERS` (ids/names) always refused.
5. Test-scope restriction: in `SCOUT_ENV=test`, writes limited to containers whose name matches `SCOUT_TEST_CONTAINER_PREFIX` (analogue of `SCOUT_TEST_OU_PATH`); all destructive tests use scratch containers created in-test (HAR: import -> delete flow of `New-container-1`).
6. Snapshot: before image save/overwrite and image/container delete, export the object (image `legacyIDF` via `images/{c}/{i}/idf`, container metadata, epm list) with `writeSnapshot`; for DELETE image/container, snapshot failure BLOCKS (unlike config writes) since delete is irreversible; note the container delete is not recoverable from metadata alone, so refuse deleting non-empty containers.
7. Lock wrapping per Section A for `eliasImage` operations (image save/delete/solver on an image) with containerId; container-level ops (import/delete) have no known itemType: do not invent one, serialize via in-process per-container mutex instead.
8. Upload controls: filename regex, extension allowlist (`zip,fpm,epm,idf`), size cap (`SCOUT_ELIAS_MAX_UPLOAD_MB`), `contents` enum (HAR: `packages`), `transfer` enum (`direct`), file path from operator-allowed directory only (no arbitrary local read: realpath under `SCOUT_UPLOAD_DIR`, no symlink escape), checksum logged; upload status poll bounded (max N polls, timeout) and uploaded content never executed locally. Signature/`signaturePEM` handling: no tool to supply or return signing keys.
9. Solver `solve/generateRules`: potentially long-running and resource intensive: one at a time per container (mutex), timeout + cancel path, input size cap; output treated as data.
10. Audit: every step audited with container id/name, image id, sizes and result; no PEM, token, or file contents in logs.
11. Rights: consult `containers/{id}/rights` as UX preflight only (same rule as B2).
12. Verdict deferral: this phase needs its own design review and `SECURITY: APPROVED` before any code.
- **SECURITY: APPROVED (conditions: requirements 1-12 are mandatory; no implementation before a dedicated design review of the write phase; container/image delete and upload specifically gated on items 3, 4, 6, 8)**

---
## Summary (10 lines)
1. Lock tools are NOT exposed to the model; internal `withLock` wrapper only (A: SECURITY: DESIGN APPROVED).
2. Server lock semantics (TTL, ownership, conflict code, response body) are unknown from HAR: set/release return 200 with empty body, release is idempotent (UI double-releases); design assumes worst case.
3. Gate order: mode/kill/breaker -> base -> validation -> confirm -> blast radius -> lock set -> mutate -> release in finally; lock calls never count toward the circuit breaker.
4. Release only keys held in the process registry (no stealing); closed itemType enum; Zod-validated ids; no skip-lock flag; fail closed on set failure.
5. Leak handling: persisted 0600 lock file, stale-lock report at startup, release only by explicit operator opt-in, SIGTERM best-effort release, max hold timeout, cap of 3 held locks.
6. Release must work under kill switch/read-only (cleanup, not mutation); 17 acceptance tests listed.
7. B1 read-only ELIAS: APPROVED with strict per-ID regex + encodeURIComponent, metadata-only certs, key/secret redaction filter, `certificates/signing` unknown shape (404 in HAR), pagination and 100 KB cap.
8. B2 ourights preflight: APPROVED as UX aid only; explicit false denies, missing/error proceeds, never relaxes a gate.
9. B3 ELIAS writes: APPROVED as requirements only (12 controls: confirmName, dependents cap, protected containers, blocking snapshots for deletes, upload allowlists, per-op locks); needs its own design review before code.
10. Next: Developer implements lock helper + B1/B2 per this file; Security re-reviews code (Phase 2) and the live lock behavior notes from test 17.

SECURITY: DESIGN APPROVED (A: lock internal-wrapper design)
