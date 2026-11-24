# Security Review: ELIAS write foundation slice

Branch `feature/elias-write-foundation` (942fa89). Reviewer: Security (veto). Binding: `design-review-elias-write-phase.md` C1-C28.
Reviewed: `git diff origin/main...HEAD` (three-dot, 25 files). NOTE: the two-dot diff `origin/main..HEAD` shows reverts of the OU-gate work (ou_path.ts, ou_tree.ts, resolver, tests); that is only because the branch base (f2a666c) is behind origin/main (62fc134), not a branch defect (see F6).
Method: adversarial read of client.ts, token.ts, optable.ts, config.ts, scope.ts, registration.ts, pipeline.ts, audit.ts, sanitize.ts, fixture-scrub.ts, tools/elias_write.ts, registry; runtime probes (path-variant classifier, token forgery, registration matrix, config matrix). Probe scripts were temporary and removed.
Verification: `npx tsc --noEmit` clean. `npm run test:unit` all green (elias-write suites 25/23/22/34/11 passed).

## Rulings on the Developer's flagged deviations

- (a) C4 `prefix >= 4` vs C24 `uc-*`: AMEND C4. Observed: `SCOUT_ELIAS_PROTECTED_CONTAINERS=uc-*` -> scope error -> scope invalid -> every write refused (fail closed and safe, but the C24 live config becomes impossible). The 4-char floor exists to stop dangerously broad ALLOW entries; a broad PROTECTED entry only shrinks the writable set. Ruling: floor of 4 stays for ALLOWED and DELETABLE; PROTECTED accepts prefixes of >= 2 chars. Bare `*` stays rejected everywhere. Needed before the C24 live run, not before merge.
- (b) dry-run skips G12 confirmation: ACCEPTED. Dry-run mints no token (checkMutationAllowed returns proceed:false), consume() re-checks mode==='write', nothing is sent; the plan digest is returned.
- (c) planDigest optional on input: ACCEPTED for this slice only (Tier A additive, one empty container, name-scoped). In the elicitation path the human sees the digest and the same-call recheck (G14) binds to it. In the `confirm:true` fallback the model is its own confirmer when it supplies no digest. Condition: planDigest becomes REQUIRED (plan, then confirm) on the confirm-flag path before any edit or Tier B op.

## Findings (no Critical or High)

| # | Sev | Where | Finding / repro | Required |
|---|---|---|---|---|
| F1 | Medium | `src/elias/optable.ts` classifyRequest/isTierCPath; `src/client.ts` enforceRawWritePolicy | The closed-world claim is not met. Probe (POST and DELETE): `/api/v1/containers/import/`, `/API/V1/Containers/Import`, `/api/v1/containers/import?x=1`, `/api/v1//containers/import`, `/containers/%69mport` classify as `unknown`; Tier C variants `/api/v1/certificates;a/x`, `certificates%2Fx`, `certificates./x`, `/containers/c/signing-keys`, `/api/v1/trust-certificates`, `/containers/c/trustCertificates`, `/containers/c/sign;x` classify as `unknown`, not `tier-c`. `unknown` + `mutating:true` is allowed (legacy rule), so any caller passing `mutating:true` reaches an ELIAS or Tier C endpoint with no token. Not exploitable today: every legacy non-GET path is a constant or encodeURIComponent'd and ids are zod-uuid/enum. Server routing is likely case-insensitive, so the case variants are the realistic ones. | Before merge: (1) for any non-GET, normalise (decode, lowercase, strip query/trailing slash) and treat as Tier C when the path CONTAINS `certificate`, `signing`, `/sign`, `trust`; (2) refuse any non-GET whose raw path has `..`, `%2e`, `%2f`, `%5c`, `;`, `//`, backslash or control chars before the legacy `mutating:true` allowance; (3) refuse `mutating:true` when the normalised path matches an op-table pattern or sits under `/api/v1/(containers|images|epms|files|solver|certificates|lock|heartbeat|ui/unregister)`. Add the probe list as tests. |
| F2 | Medium | `src/elias/token.ts:35-41` | `MutationToken` constructor is public and does `MINTED.add(this)`. Probe: `new MutationToken(binding, 1000)` -> `isMutationToken === true`: a valid token without a proceeding `MutationCheckResult`. The static test only greps for `mintMutationToken`. (QA found the same: untracked `tests/_qa_probe2.ts`.) | Before merge: register in MINTED only inside `mintMutationToken`, make the constructor unreachable from other modules, and extend the static test to forbid `new MutationToken` outside token.ts. |
| F3 | Medium | `src/client.ts:302` `request()` | `request()` has no write-policy backstop. `new URL('https://h/rest/../api/v1/containers/import').pathname` is `/api/v1/containers/import`, so a non-GET through `request()` with a traversal segment and `mutating:true` reaches a non-/rest ELIAS endpoint with no token and no Tier C check. Not reachable today (ids are uuid/enum/encoded) but it is the one door the new enforcement does not cover. | Before merge: apply the F1(2) traversal/encoding refusal to non-GET in `request()`. |
| F4 | Low | `token.ts` consume; `client.ts` enforce | Token binds opId/opName/method/path TEMPLATE, not the concrete path or body hash. Harmless for `containers/import`; for templated ops a token for one id works for another. | Before the first templated op: bind the concrete path and body sha256 in consume(). |
| F5 | Low | `pipeline.ts` (G17 catch), `elias_write.ts` formatWriteResult | Server error text (sanitizeServerText, 200 chars) is placed in the `fail(...)` string and audit `detail` without the untrusted-data wrapper that success results carry (C6). Control chars are stripped; plain-word injection survives. It never reaches an elicitation prompt. safeDisplay likewise keeps plain words from server names (charset-clean, capped, quoted). | Quote the server message and prefix the untrusted-data note; not blocking. |
| F6 | Process | branch | Base behind origin/main; `git merge-tree` shows 1 conflict (likely the GuardrailError union in guardrails.ts). Untracked `tests/_qa_probe*.ts` sit in the worktree. | Merge/rebase main, re-run tsc and test:unit, verify only the conflict hunk. Do not commit `tests/_qa_probe*.ts`. |
| F7 | Low | `audit.ts` | No directory fsync after file creation; recovery from a second MCP process marks another live process's in-flight intent `recovered-unknown` (its later result row still lands); partial `writeSync` is not looped. All fail toward "unknown", never toward hiding a mutation. | Track for the lock/session slice. |
| F8 | Low | `config.ts`, `optable.ts`, `fixture-scrub.ts` | `SCOUT_ENV=test` has no host pin, so the unverified escape hatch can be enabled in a production environment by whoever controls env; it stays limited to strict `MCPTEST-<8 digits>-<8 hex>` names + scope list + `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true`. Body deny-list `/sign|cert|pem|trust|.../` over-matches (`design`, `assign`) and fails closed on legitimate future keys. Scrubber keeps lowercase single-word path segments and dictionary-style response keys verbatim (GUID/name keys are not caught by the strict scan). | Accepted for C12 literal. Add a host pin with the live-test PR (C23/C24); document the deny-list over-match. |

## Adversarial results by area

- C1/C2 enforcement. HEAD/GET pass; all other methods are upper-cased before classification; headers are fixed in doRawRequest so no method-override header is possible. A non-GET to a known write op without a token is refused; `mutating:true` on a write op is refused (no double count); `mutating:false` POST is allowed only for the closed, enabled read-post list (`my-container-roles`, `treefilter`); internal lock/session paths are refused outright. Token: single use (marked used before checks, also on mismatch), bound to method+template, 120 s expiry, kill switch and `SCOUT_MODE==='write'` re-checked at use, forged plain objects rejected (WeakSet), reuse refused, wrong op refused. The 401 replay does not re-consume (single replay of an unprocessed request). The wider rule (non-GET needs `mutating:true`) breaks no existing caller (all legacy writes pass it; `system_info` treefilter is whitelisted). Gaps: F1-F4.
- C3/C4. Protected wins; fresh `GET /containers` at G6 and again inside the mutex; duplicate names refuse name-based entries for existing containers and `semantic` refuses a duplicate new name; matching is case-insensitive over ASCII-only entries, so non-ASCII server names never match an allow entry (fail closed). Bare `*`, braces, short prefixes and ALLOWED-overlaps-PROTECTED all invalidate the whole scope.
- C5/C6. Confirmation text is validated name + digest[0:12] only; names pass safeDisplay (ANSI stripped, charset `[A-Za-z0-9._+~ -]`, cap 80). Digest covers op, method, template, body sha256, same-name ids; recomputed after the mutex, any change aborts with `conflict` before a token exists.
- C7. Intent row: O_APPEND, 0600, fchmod, write, fsync, written after the recheck and before mint/send; any failure -> `refused(audit-write)` and no request. Startup recovery appends `recovered-unknown`. Rows are one JSON line each (newlines escaped), details sanitised, tool output shows the basename only.
- C12. Probe: default -> no tools; all switches + unverified but no `SCOUT_ENV` -> status tool only; `SCOUT_ENV=TEST|production` and `ALLOW_UNVERIFIED=1|True` -> status tool only; only `SCOUT_ENV=test` + `ALLOW_UNVERIFIED=true` registers `elias_container_create` (then strict MCPTEST regex and `unverified:true` on every row). `WRITE_BODY_CONTRACTS` holds no evidence, so verified-live is unreachable. The builder-vs-fixture test must exist before the first verified-live flip.
- C13. `.gitignore` has `*.har` and `*.har.json`; scrubber is allow-list extraction (no header, cookie, token, value or host copied; credential-like keys omitted; auth and Tier C exchanges skipped; strict scan refuses to emit); repo scan covers tests/fixtures, docs, .agents, src, scripts. Residual in F8. Rotation of the lab account password stays a user action.
- C14/C16/C25. Builder emits only `{name}`; `assertBodyAllowed` runs in the client on token-bearing writes; zod `.strict()` rejects `force` and any path/url/method parameter; `SCOUT_ELIAS_ALLOW_FORCE` is never read; booleans accept literal `true` only; ceilings are code constants; tier must be exactly `off|a|b`.
- Breaker and modes. One `checkMutationAllowed` per logical op at G13 (the token path never calls it again); refusals before G13 count 0; refusals after G13 (conflict, audit-write, mutex timeout) count 1 (fail-safe, matches C2 intent). read-only: refused at G3 with zero network. dry-run: two reads, no token, no mutation. write without `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true` is refused at G4 in the pipeline (the pipeline is the only minter, so this is sufficient).
- Race and outcomes. The `before` list is read inside the mutex immediately before sending; a concurrent human-created same-name container could be misreported as `committed` (harmless). `unknown` is isError with opId and "do not repeat blindly"; `not-applied` only after a successful readback.

## Condition status C1-C28

| C | Status |
|---|---|
| C1 | PARTIAL: enforced and tested; F1/F2/F3 before merge, F4 before the first templated op |
| C2 | DONE for accounting; the A.3 supersession is not yet documented (no lock.ts): document with the lock slice |
| C3 | DONE |
| C4 | DONE literal; AMENDED for PROTECTED (ruling a) |
| C5 | DONE in-call; digest-required on the confirm-flag path deferred to the next op (ruling c) |
| C6 | DONE (F5 low) |
| C7 | DONE (F7 low) |
| C8-C11 | DEFERRED (lock/session slice) |
| C12 | DONE (registration and escape hatch); evidence-vs-fixture test due with the first live capture |
| C13 | DONE |
| C14 | DONE for this slice (F8 note) |
| C15 | DEFERRED (no edit/delete op enabled; all other ops `enabled:false`) |
| C16 | DONE |
| C17-C18 | DEFERRED (no delete) |
| C19-C22 | DEFERRED (no snapshots/upload; output says `restorable:false`, no banned wording) |
| C23-C24 | DEFERRED; needs the (a) amendment and a host pin |
| C25 | DONE |
| C26 | DONE |
| C27-C28 | DEFERRED (all A0 POSTs `enabled:false`) |

## Required to lift the block (diff-only re-check, not a full re-review)

1. F1, F2, F3 fixed with tests (the probe lists above are the repro set).
2. Merge/rebase origin/main; tsc and test:unit green (F6); `tests/_qa_probe*.ts` not committed.
Before the second write op: F4, planDigest required on the confirm-flag path, C4 amendment for PROTECTED, builder-vs-fixture evidence test.

SECURITY: BLOCKED (F1-F3: unknown/variant paths and request() traversal bypass the closed op table and Tier C via mutating:true; MutationToken constructor is publicly forgeable; fix + rebase onto main, then diff-only re-check)
