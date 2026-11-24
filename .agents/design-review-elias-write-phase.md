# Security Design Review: ELIAS write phase

Branch: design/elias-write-phase. Reviewer: Security (veto). Subject: `.agents/design-elias-write-phase.md` (section numbers below refer to it).
Compared against my own `.agents/design-review-lock-elias.md` (A.x = lock design, B3.n = write requirements). Design only; no code reviewed.
Method: adversarial read of all 15 sections, B3 traceability re-derived from my text (not taken from section 13), repo checked for fixture/HAR hygiene.

## 1. B3 traceability, verified against my own text

| B3 | Verdict | Note |
|---|---|---|
| 1 env gating | OK | Stricter than required (G0, G4, section 9). |
| 2 `rawRequest(...,{mutating:true})` | DEVIATION, ruled below (R2) | Accepted only with a client-enforced token (C1). |
| 3 confirm tiers / confirmName | OK | Caveat C5/C6: confirmName is a speed bump; plan digest + sanitised prompt needed. |
| 4 dependents cap, protected list, "delete refused for containers referenced by devices" | PARTIAL | Image/package/file OK in principle. Container rule was swapped for empty-only: acceptable only with C17 (signing cert, hidden content). Dependents for image EDITS are missing (C15). |
| 5 test-prefix in SCOUT_ENV=test | OK | Strengthened to strict regex for delete/sweeper (C17, C23). |
| 6 blocking snapshots, no non-empty container delete | OK in structure, WRONG in one detail | Section 5 "redactSecrets over everything written" makes snapshots lossy yet labelled restorable (C19). |
| 7 locks / no invented itemType / mutex | OK | Session requirement is new (R1). |
| 8 upload controls | OK, hash pinning too weak | `expectedSha256` optional (C21). |
| 9 solver single-flight, timeout, cancel | OK | No server cancel exists; honest "unknown" outcome. Deferred to W5. |
| 10 audit, no secrets | PARTIAL | Write-ahead not durable and not blocking (C7). |
| 11 rights UX only | OK | |
| 12 own review | this file | |
| A (lock) | OK + extension | R1. |

## 2. Rulings on the points the Architect asked for (section 14)

**R1. Session register/heartbeat/unregister inside `lock.ts` (4.3): APPROVED WITH CONDITIONS (C8, C9).**
This extends my approved lock design; it is still internal-only, not a tool. The danger the design under-weights: if `GET ui/register` returns all of the account's sessions (the same account is logged in in the browser, session 27), "pick the row created for this call" can pick the human's session. Heartbeating or, worse, `ui/unregister` on it would drop the human's locks and kick their UI. That is lock stealing by construction. Q11 must be answered live before any code, and ambiguity must fail closed.

**R2. Mutating calls sent `mutating:false` after an explicit `checkMutationAllowed` (2.2): APPROVED WITH CONDITIONS (C1, C2).**
The goal (one breaker count, one "allowed" audit row, lock after gate) is right and consistent with A.3. "The helper is the only caller" is a convention, not a control. It must be enforced in `client.ts`, otherwise every future `mutating:false` POST is an unchecked write. Also note the breaker count at G13 happens before lock acquisition, so a failed lock-set after G13 does count. That supersedes my A.3 sentence "a lock-set failure does not count". I accept the stricter behaviour (fail-safe), but it must be documented and tested.

**R3. Lock wrapper now owning a session: APPROVED WITH CONDITIONS (R1, C8-C11).**

**R4. Tier C permanent exclusion: APPROVED, concur fully.** Reasons 1-3 are sufficient; I add that image/IDF body builders must be structurally unable to carry signature, cert, trust or PEM fields (C14). DELETE of CRT stays in Tier C.

**R5. Upload staging directory and path safety (6.1, 6.2): APPROVED WITH CONDITIONS (C21, C22).** The basename-only, owner/mode, O_NOFOLLOW, fstat, nlink, realpath-containment design is sound. Weak points: optional hash, no inode/mtime re-check across the two passes, confirmation text not bound to bytes, no epm/fpm sniff (so the only supply-chain control is a human-verified hash).

**R6. Per-switch off-by-default config (section 9): APPROVED WITH CONDITIONS (C4, C25).** Pattern is correct (unparseable falls to safe side, ceilings in code). Gaps: dangerous allow-list entries (`*`, short prefixes), name-only scope on non-unique container names.

**R7. Rule D0 (no write tool until body is live-captured and verified-live): APPROVED WITH CONDITIONS (C12, C13).** This is the single best control in the document: it prevents guessing bodies against a fleet-affecting server. A registry string is self-attested, so it needs an evidence record and a body-vs-fixture test. The escape hatch is accepted only for SCOUT_ENV=test inside the MCPTEST prefix, with an `unverified:true` audit marker.

**R8. Read-class POSTs in Tier A0 gated on a live before/after diff: APPROVED WITH CONDITIONS (C28).** A single diff on one image is weak evidence (timestamps, caches, verification state persisted server-side). Diff must cover container-level digests, and any persisted state reclassifies the tool as Tier A. These tools also return IDF text, which can carry secrets (C20).

## 3. Verdict per section

| Section | Verdict | Conditions |
|---|---|---|
| 0 Decisions D0-D9 | APPROVED WITH CONDITIONS | C12 |
| 1 Tiers A0 / A | APPROVED WITH CONDITIONS | C15, C20, C28 |
| 1 Tier B | APPROVED WITH CONDITIONS (each switch separately, later PRs) | C15-C18, C21 |
| 1 Tier C | APPROVED | C14 |
| 2.0 / 2.3 specs | APPROVED WITH CONDITIONS | C3, C20; `elias_image_update` patch-only |
| 2.1 gate chain | APPROVED WITH CONDITIONS | C3, C5, C6, C7 |
| 2.2 mutating:false deviation | APPROVED WITH CONDITIONS | C1, C2 |
| 3.1-3.4 policies | APPROVED WITH CONDITIONS | C4, C15 |
| 4.1, 4.2 lock state machine | APPROVED | C10, C11 |
| 4.3 session plumbing | APPROVED WITH CONDITIONS | C8, C9 |
| 4.4 client extensions | APPROVED WITH CONDITIONS | C1 |
| 5 snapshots | APPROVED WITH CONDITIONS | C19 |
| 6 upload | APPROVED WITH CONDITIONS | C21, C22 |
| 7 audit | APPROVED WITH CONDITIONS | C7, C26 |
| 8 failure handling | APPROVED WITH CONDITIONS | C10, C26 |
| 9 configuration | APPROVED WITH CONDITIONS | C4, C25 |
| 10 registry/docs | APPROVED WITH CONDITIONS | C12, C19 |
| 11 test strategy / sweeper | APPROVED WITH CONDITIONS | C13, C23, C24 |
| 12 acceptance tests | APPROVED, extend with section 5 below | |
| 15 open questions | Q1, Q2, Q3, Q11, Q12 are hard blockers for their ops; Q20 ruled in C24 | |

## 4. Mandatory conditions for the Developer

Pipeline and mutation control
- **C1 (2.2, 4.4).** A branded, single-use `MutationToken` is minted from the `MutationCheckResult` at G13, bound to `opId + opName + method + path template`. `client.ts` enforces: any non-GET sent with `mutating:false` is allowed only for a closed READ_POST list (A0 templates, `my-container-roles`, upload status, session plumbing, `lock/set|release` and only when called from `lock.ts`); every other non-GET requires a token, which is consumed per request (upload: bound to one uploadId, expires at max upload duration). Kill switch and mode are re-checked before every step. Tool modules must not import `rawRequest`/`rawRequestBytes` (static test).
- **C2.** Breaker is incremented exactly once per logical op at G13, including when lock/session acquisition later fails; refusals before G13 increment by 0. Document the supersession of A.3 "lock-set failure does not count" in `lock.ts` and README.
- **C3 (G6).** Every write uses a fresh `GET /containers` (no 15 s cache for scope decisions). Name-to-id binding is taken from that fresh list; two containers with the same name (Q6) make any name-based allow/deny entry refuse.
- **C4 (3.1, 9).** Scope entry hygiene: reject bare `*` and prefixes shorter than 4 characters; reject an ALLOWED entry that also matches PROTECTED; document that PROTECTED should list ids (names can be renamed); `elias_write_status` warns when PROTECTED contains no id.
- **C5 (G12/G13).** Confirmation is bound to a plan digest (target id and server name, dependents, body sha256, snapshot plan). Dependents, existence and baseSha256 are recomputed inside the lock/mutex, and any change from the confirmed digest aborts with `conflict` before the mutation.
- **C6 (G12, plans, errors, audit).** Server-derived strings (container names, image/package ids, filenames) shown in elicitation prompts, dry-run plans, errors and audit are restricted to the validated charset or escaped (control chars and newlines stripped, length cap 80). Free-text fields (descriptions, `rpmDescription`, server messages) never appear in a confirmation prompt. Elicitation text is built only from validated fields plus our own hashes. Server text in results is wrapped as untrusted data (B1).
- **C7 (section 7).** The intent row is written with append + fsync BEFORE the mutating call, and failure to write an intent row blocks the mutation (fail closed). Startup scans for intent rows without a result and emits `recovered-unknown` rows. The audit file is 0600. Tool output and `elias_write_status` return basenames/ids only, never absolute local paths (SECURITY.md Fas 1 item 6).

Lock and session
- **C8 (4.3).** The session id is accepted only if provably created by our own register call (set-difference or a single new `EntityID`); otherwise fail closed. Never heartbeat or unregister any other id; never use 27 or any configured id. Persist our session id in the 0600 lock file for stale cleanup. If Q11 shows register cannot be disambiguated, image-lock ops are not implemented.
- **C9.** Register only after G13 has proceeded in write mode (never at startup, in read-only, or in dry-run). A failed heartbeat means locks are LOST: no further mutation step is sent, the audit records it, the op reports `unknown` or `failed`. Idle-unregister only when the registry is empty and no op is in flight. Stale sessions/locks are cleaned only with `SCOUT_RELEASE_STALE_LOCKS=true`, as before.
- **C10 (4.2, 8).** `SCOUT_LOCK_MAX_HOLD_SECONDS` must be at least the sum of the op's step timeouts plus margin (checked at config load). An abort during MUTATING never releases the lock while the request may still be in flight: abort the socket, run the bounded reconcile read (<=15 s), then release.
- **C11.** Lock `itemId` comes only from the server image record for that exact container/image pair (Q3); otherwise the image write tools are not registered. A conflict maps to `LockedByOtherError` with no wait loop.

Evidence, fixtures, secrets
- **C12 (D0, 10).** `verified-live` requires an evidence record in the registry (date, capture id, sha256 of the scrubbed contract fixture). A unit test builds each op's request and compares it to that fixture (test 19). `SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES` works only with SCOUT_ENV=test, restricted by the MCPTEST rule, and every such audit row carries `unverified:true`. Body builders have no pass-through fields.
- **C13.** No raw HAR enters the repo. `.gitignore` currently has no `*.har` rule (checked): add `*.har` and `*.har.json` in the first PR. Fixtures are produced by a scrubber that extracts method, path template, body key names and types, status and response key shapes (allow-list extraction, not redaction of a copy). A test scans `tests/fixtures`, `docs`, `.agents` and `src` for passwords, JWTs, `Cookie`/`Authorization` values and PEM. Because a HAR with a plaintext lab password was handed to agent tooling, the user should rotate that account password.
- **C14 (Tier C).** Add to the closed-op-table tests: body builders cannot emit keys matching `/sign|cert|pem|trust|signature|password|secret/i`; upload `contents` is the literal `packages`; no tool registers a path, URL or method parameter; a generic proxy tool is a build failure.

Destructive operations
- **C15 (3.3, 2.3).** Image dependents are computed across the ENTIRE OU tree (`includeSubOus` does not recurse; `resolveOuRef` is unreliable; column names are known only from live 400s). Any incomplete enumeration or truncation is uncountable and refuses. The same cap applies to `elias_image_update`, `elias_image_add_package` and `elias_image_remove_package` as `SCOUT_ELIAS_MAX_EDIT_DEPENDENTS` (default 0, code ceiling 5), because editing an image devices boot from is fleet-affecting and not proven reversible.
- **C16.** `force` on image delete is NOT implemented in the first delete PR (and `SCOUT_ELIAS_ALLOW_FORCE` is not read). It returns only with its own Security review.
- **C17 (container delete).** All of: name matches the operator DELETABLE entry (and in SCOUT_ENV=test the strict regex `^MCPTEST-\d{8}-[0-9a-f]{8}$`); not PROTECTED; images, packages, files all zero AND `certificates/signing/{c}` answers 404 (a signing cert makes it non-empty; default trust CRTs are ignored); any read failure, pagination or truncation counts as non-empty; emptiness re-read inside the mutex immediately before sending; confirmName plus confirmId; counts against the delete budget. Audit says `restorable:false`.
- **C18 (package, file delete).** Package scan over more than 200 images refuses. Elicitation text and tool result must state "binary/content is not restorable". Dependents for file delete that are unknowable count as 1 when the name matches any package source (fail closed), not "best effort 0".

Snapshots and rollback honesty
- **C19 (section 5, supersedes "redactSecrets over everything written").** Snapshots are stored raw (IDF text may need secrets to be restorable) in a 0700 dir with 0600 files, never returned to the model, never copied into audit, referenced by basename + sha256, default under gitignored `logs/`, startup refuses a snapshot dir inside a tracked path, retention cleanup (`SCOUT_SNAPSHOT_RETENTION_DAYS`, default 30). Model-visible output and audit are redacted. No tool description, result, audit text or doc may use "rollback", "undo", "reversible" or "restorable:true" until registry capability `elias-snapshot-roundtrip` is `verified-live` (Q12); until then `restorable:false` and text "snapshot saved as a manual reference; no automatic restore exists". Remove "reversible" from Tier A tool annotations and descriptions.
- **C20.** `elias_image_update` ships patch-only: an allow-listed field set applied by our code to the raw IDF fetched inside the lock; full-IDF replace is not in the first release. Any input containing the redaction marker (`[REDACTED]` or equivalent) is refused, since a model that round-trips a redacted export would write literal placeholders over real secrets. `elias_image_export_idf` returns redacted, capped text plus the sha256 of the RAW idf (that hash is `baseSha256`).

Upload
- **C21.** `expectedSha256` is REQUIRED. The elicitation text shows filename, size and the sha256 we computed. The hash is verified over the bytes actually sent and compared before `complete`; `fstat` dev/ino/mtime/size are re-checked between passes. `elias_upload_staged_list` returns name, size, sha256 (cap 100 entries, hashing bounded by the size cap) so a human can compare out of band.
- **C22.** State the limitation in README and tool description: epm/fpm are not content-sniffed (Q14), so the human-verified hash is the only supply-chain control and the staging directory must contain only intended files. Name collision refuses (Q15). Upload sha256 is recorded in audit and linked in later `image_add_package` audit rows for the same package id when known.

Config, outcomes, test infrastructure
- **C25 (section 9).** Booleans accept only the literal `true`. All ceilings are code constants. `elias_write_status` prints effective values with no secrets or absolute paths.
- **C26 (7, 8).** An `unknown` outcome returns an error-class result (isError) with opId and "do not repeat blindly", never a success. `not-applied` is claimed only after a successful readback proving it; a failed readback stays `unknown`.
- **C23 (sweeper).** The sweeper deletes only containers matching the strict regex `^MCPTEST-\d{8}-[0-9a-f]{8}$` (not a prefix), server `created` older than 24 h, empty per C17 (including no signing cert), at most 5 per run. It runs only with SCOUT_ENV=test, `SCOUT_LIVE_WRITE_TESTS=1` and a host pin (`SCOUT_LIVE_TEST_HOST` equals the SCOUT_BASE_URL hostname). It prints candidates first and aborts if any candidate is PROTECTED, starts with `uc-`, or the count exceeds 5. Non-empty leftovers are reported only; there is no force path.
- **C24 (production-lab question, Q20).** The lab `scout01.tornbloms.net` holds the real `uc-elux7-*`/`uc-rp6-x64` containers that devices may boot from, and the only account has all rights, so our controls are the ONLY boundary. Approved for live tests only if: host pin as in C23; `uc-*` hard-coded into PROTECTED in the live test config; first live runs limited to W1 (create, rename, delete empty) inside `MCPTEST-*`; a human VM backup/snapshot before any W2+ run (images, packages, upload, solver); a restricted test account is strongly preferred (settles Q19 as well); no lock/session experiment touches an image outside an MCPTEST container; credentials from env, never files.
- **C27.** Solver, accept, import, generate, images-upload stay deferred to W5 with a separate mini review of live behaviour (Q4-Q6, Q10, Q18); `elias_solver_check` (A0) ships only with C28.
- **C28 (A0).** Per-endpoint classification: a before/after diff on a test container must show zero change in container-level digests (images, packages, files, rules, locks) and no timestamp/state change on the target image; any persisted effect reclassifies the tool as Tier A (mutating path, lock, token). A0 outputs pass redaction and the output cap.

Total: 28 conditions (C1-C28; numbering is not contiguous in text order).

## 5. Acceptance tests to add (beyond section 12's 48)

1. Client rejects `PUT/POST/DELETE` with `mutating:false` for a path not in READ_POST and without token (C1); a token cannot be reused or used for another opId/path (C1).
2. Static: no tool module imports `rawRequest`/`rawRequestBytes`; no tool schema contains path/url/method params (C1, C14).
3. Lock-set failure after G13 increments the breaker by exactly 1 (C2).
4. Two containers with the same name: name-based allow/deny refuses (C3); stale list cache cannot be used for scope (C3).
5. Scope entries `*`, `a*`, ALLOWED overlapping PROTECTED are rejected at config load (C4).
6. State changes between confirmation and mutation (dependent appears, baseSha changes): abort with `conflict`, zero mutation calls (C5).
7. Container/image/file names with newlines, ANSI, markdown, "ignore previous instructions" text: sanitised in prompts, plans, errors and audit; `rpmDescription` never in a prompt (C6).
8. Intent row fsynced before the mutating call (assert order with a recording fs); an unwritable audit file blocks the write; crash simulation yields `recovered-unknown` at startup; tool output has no absolute paths (C7).
9. Register returns multiple sessions including one not ours: fail closed, no heartbeat/unregister of foreign ids; heartbeat failure stops subsequent mutation steps; register never occurs in read-only/dry-run/startup (C8, C9).
10. Abort at max-hold during MUTATING: release only after reconcile read; hold < sum of step timeouts is refused at config load (C10).
11. Lock `itemId` mismatch with image record: tool refuses (C11).
12. `verified-live` entry without evidence record fails `tests/compat.test.ts`; request builder output equals the contract fixture; unverified escape produces `unverified:true` rows and is ignored when SCOUT_ENV is unset (C12).
13. Repo scan test: no password/JWT/PEM/cookie value in fixtures/docs/.agents/src; `.gitignore` contains `*.har` (C13).
14. Body builder deny-list: no key matching sign/cert/pem/trust reaches any request body (C14).
15. Image dependents across a multi-level OU tree (non-recursing `includeSubOus`) are fully counted; truncated or failed enumeration refuses; image update/add/remove obey the edit-dependents cap (C15).
16. `force` input is rejected by the strict schema in the first delete PR (C16).
17. Container delete: signing cert present refuses; read failure = non-empty; emptiness re-read inside the mutex; strict regex in test env; `MCPTEST-foo` (no date/hash) refused for delete (C17).
18. Snapshot stored raw 0600, never present in tool output or audit; banned words ("rollback", "undo", "reversible") absent from tool descriptions and results while `elias-snapshot-roundtrip` is not verified-live; `restorable` is false (C19).
19. `elias_image_update` rejects input containing `[REDACTED]`; export output redacted while `baseSha256` is the raw hash (C20).
20. Upload without `expectedSha256` refused; file modified in place between passes aborts before `complete`; elicitation text contains name, size, our sha256 (C21).
21. `unknown` outcome returns isError with opId; failed readback never produces `not-applied` (C26).
22. Sweeper: refuses names not matching the strict regex, `uc-*`, candidates over 5, missing host pin or SCOUT_LIVE_WRITE_TESTS, non-empty containers (C23).

## 6. Smallest safe first PR (implement FIRST)

**PR 1 = W0 foundation plus exactly one write tool, `elias_container_create`, plus `elias_write_status`.** No lock, no session, no snapshot, no delete, no upload.
Contents:
1. `.gitignore` `*.har` and the secret/fixture scan test (C13) and the fixture scrubber.
2. Config parser (section 9, C4, C25), `elias_scope.ts` with strict test-prefix rule, closed op table with only `POST /containers/import`, static Tier C tests (C14).
3. Pipeline G0-G13 and G16-G18 with MutationToken in `client.ts` (C1, C2), fresh-list scope binding (C3), plan digest (C5), sanitisation (C6), fsynced write-ahead audit and recovery (C7), `unknown` outcome handling (C26). Client extension for empty/201 bodies and per-call timeout only (bytes API and chunk header come with upload).
4. `elias_container_create` only after the Q1 live capture proves `POST /containers/import` in the lab (D0), name-prefix enforced, mock tests for every gate; one live test creating `MCPTEST-<yyyymmdd>-<8hex>`. Cleanup in PR 1 is manual by the human via the UI (no delete tool exists yet).
Why this slice: it is additive (one empty object), needs no lock semantics, exercises every control that all later tools depend on, and its blast radius is a stray empty container.

Suggested order after that (each needs its own Security code review):
- PR 2: `elias_container_delete` (C17, strict regex, empty-only) + sweeper (C23) + `elias_container_rename`. Live W1.
- PR 3: A0 tools (C28) after the diff evidence, still no state change.
- PR 4: Q11 live session findings, then lock/session (C8-C11), then image create/update(patch-only)/add/remove (C15, C19, C20).
- PR 5: image/package/file delete (C15-C18). PR 6: upload (C21, C22). W5 items per C27.

## 7. Residual risks accepted

- Our in-process mutex does not protect against other MCP processes or UI users (Q9); documented.
- `confirmName` and `confirm:true` are not human proof; real stops are env switches, allow-lists and the client's elicitation (design 3.2 states this honestly).
- Unknown outcomes after solver/upload timeouts cannot be resolved by us; reported as `unknown`.
- Audit has no tamper evidence (as in guardrails.ts).
- `dataChange:false` on an unknown outcome may leave the UI cache stale until refreshed; acceptable, reported in the result.

SECURITY: DESIGN APPROVED (conditions: 28)
