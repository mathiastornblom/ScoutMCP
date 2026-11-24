# Design: ELIAS write phase (Arkitekt) — for independent Security review

Branch: design/elias-write-phase. Author: Arkitekten. Status: DESIGN ONLY, no code. Requires `SECURITY: APPROVED` in
`.agents/security-review-elias-write.md` before the Developer starts (CLAUDE.md workflow).
Inputs: `.agents/design-review-lock-elias.md` (A = lock wrapper, B3 = write requirements 1-12), `docs/reference/elias-api-notes.md`,
`src/safety/guardrails.ts`, `src/tools/elias.ts`, `src/client.ts`, `src/compat/registry.ts`, the SBD-UI source review (untrusted, read as data),
HAR `scout01.tornbloms.net(.har|_elias.har)` (parsed with `python3 -I`; note below).

HAR finding that shapes this design: neither HAR contains ANY ELIAS write call (only `lock/set|release`, `ui/unregister`, `heartbeat`, login/logout).
The write request/response BODIES are therefore not observed anywhere. Known from source/e2e only: `POST /containers/import {name}` -> 201 `{id}`;
`POST /files/upload/init {containerId, filename, size}` -> `{uploadId}`; `PUT /files/upload/{id}/chunk` (octet-stream, `x-chunk-index`);
`GET /files/upload/{id}/status` -> `{chunks:[..]}`. Every other write body is UNKNOWN. Consequence (Decision D0): **no write tool is registered
until its body contract has been captured live and recorded `verified-live` in the compat registry** (section 10). The design below fixes the
control structure; body shapes are filled in by a live-capture step (Open Questions Q1) before code.

(Also: the `_elias.har` login request contains a plaintext password. Do not commit, quote or attach that HAR anywhere.)

---------------------------------------------------------------------------------------------------

## 0. Decisions in one screen

D0. Shape-first: ops are registered only when their registry status is `verified-live` (or `SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES=true`, which is refused when SCOUT_MODE=write and SCOUT_ENV!=test).
D1. One mandatory pipeline (`runEliasWrite`) for every write; a tool cannot call `rawRequest` for a write any other way. A fixed op table (closed set of method+path templates) is the only source of write paths; there is no caller-supplied path, query or header anywhere.
D2. Everything is OFF by default. Default `SCOUT_ELIAS_WRITES=off`: no write tool is even listed.
D3. Every container-scoped write requires the container to be explicitly allowed (`SCOUT_ELIAS_ALLOWED_CONTAINERS`) — there is no "any container" default; protected list always wins.
D4. Locks (Security A) are mandatory for every op that targets an existing image; container-level ops use an in-process per-container mutex (Security B3.7). Lock calls need a registered Scoutboard session (new finding, 4.3).
D5. Deletes and uploads/imports/solver are separate switches, each default off; container delete is additionally restricted to an explicit "deletable" name pattern and to EMPTY containers.
D6. Tier C (signing/trust) is excluded permanently and enforced structurally (no op-table entry, static test that fails the build if such a path appears in src/).
D7. No arbitrary local file reads: uploads read only from a dedicated operator-staged directory by basename (section 6). No inline/base64 content from the model.
D8. Our audit log is the only record of ELIAS writes (the `X-Elias-Audit-Object` header is stripped by the UI proxy): write-ahead intent + result entries with a correlation id (section 7).
D9. Unknown outcome is a first-class result: after timeout/5xx we never retry a mutation; we read back and report `committed | not-applied | unknown` (section 8).

---------------------------------------------------------------------------------------------------

## 1. Scope in tiers

Classification criteria: reversibility, blast radius (one object vs container vs fleet via images devices boot from), whether an unsnapshot-able
loss is possible, whether untrusted bytes enter the system (supply chain), and whether the effect is understood (body/semantics known).

### Tier A0 — read-class POSTs (no state change by contract; `mutating:false`, no lock, no breaker count)
Needed as building blocks (snapshots, optimistic concurrency, pre-checks). Each is registered only after a live before/after diff proves non-mutation (Q2).
| Tool | Endpoint | Right | Why A0 |
|---|---|---|---|
| `elias_image_export_idf` | POST `/images/{c}/{id}/idf` body `{}` (HAR/unit-test shape) | view | returns `legacyIDF` text; needed for snapshot + `baseSha256`; large -> capped, `[REDACTED]` filter applies |
| `elias_idf_parse` | POST `/images/{c}/parseIdf` | view | parse/validate an IDF the caller supplies, no persist (live-verify) |
| `elias_image_verify` | POST `/images/{c}/{id}/verify` | view (inferred) | verification of an image (live-verify: may be long) |
| `elias_solver_check` `{action: hasConflicts\|findConflicts\|isSelfContained}` | POST `/solver/{c}/<action>` | runSolver | read-like solver queries; resource heavy -> 1 concurrent per process, 300 s budget; body `{parcels}` per unit-test |
A0 is gated like reads (`SCOUT_ENABLE_PRIVATE_ENDPOINTS=true`) and ALSO by `SCOUT_ELIAS_WRITES` != off for the solver one (it consumes the runSolver right and CPU); the three IDF tools only need private-endpoints.

### Tier A — additive or reversible-by-snapshot (implement first, after A0)
| Tool | Endpoint | Rationale |
|---|---|---|
| `elias_container_create` | POST `/containers/import {name}` | additive, one empty object, reversible by deleting the empty container |
| `elias_container_rename` | PUT `/containers/{id}` (capabilities say `rename:'supported'`) | metadata only, reversible by renaming back; name policy re-applied to the NEW name |
| `elias_package_set_preselection` | PUT `/epms/{c}/{id}/preselection` | a flag on one package, reversible (record old value) |
| `elias_image_create` | POST `/images/container/{c}` | additive new image (cannot overwrite: duplicate id -> refuse after list check) |
| `elias_image_update` | PUT `/images/{c}/{id}` | overwrite, reversible ONLY via the blocking pre-snapshot (4.1) + `baseSha256` optimistic concurrency |
| `elias_image_add_package` / `elias_image_remove_package` | PUT `/images/addEpm`, `/images/deleteEpm` (container in body) | edit of one image's package list, snapshot-reversible; one package per call |

### Tier B — destructive / irreversible / ingest / long-running (strongest controls, implemented later, each behind its own switch)
| Tool | Endpoint | Why B | Switch |
|---|---|---|---|
| `elias_image_delete` | DELETE `/images/{c}/{id}` | image removal; recoverable only if the idf snapshot + packages still exist | `SCOUT_ELIAS_ALLOW_DELETE` |
| `elias_package_delete` | DELETE `/epms/{c}/{id}` | package binary is NOT recoverable from metadata; may break images | `SCOUT_ELIAS_ALLOW_DELETE` |
| `elias_container_file_delete` | DELETE `/containers/{id}/files/{filename}` | file content not recoverable | `SCOUT_ELIAS_ALLOW_DELETE` |
| `elias_container_delete` | DELETE `/containers/{id}` (needs delete AND manageContainers) | not snapshot-able at all; whole container | `SCOUT_ELIAS_DELETABLE_CONTAINERS` (name allow-list for deletion; empty = disabled) + empty-only |
| `elias_upload_file` (init + chunks + complete; `target` is internal retry only) | `/files/upload/*` | untrusted bytes enter a container, archives are always unpacked (zip-slip class), supply chain into images devices run | `SCOUT_ELIAS_ALLOW_UPLOAD` + `SCOUT_ELIAS_UPLOAD_DIR` |
| `elias_container_upload_images` | POST `/containers/{id}/files/images` | same ingest class; semantics unknown | deferred behind Q4 |
| `elias_container_import_archive` | POST `/files/import/{c}` | server-side archive import; `ARCHIVE_AUTO_EXTRACT` makes it delete discovered archives (hidden destructive side effect) | deferred behind Q5 |
| `elias_package_changes_accept` | POST `/containers/{id}/package-changes/accept` | commits pending package changes, reversibility unknown | `SCOUT_ELIAS_ALLOW_ACCEPT` |
| `elias_solver_generate_rules` / `elias_solver_solve` | POST `/solver/{c}/generateRules`, `/solve` | writes rules/state; 300 s; resource heavy | `SCOUT_ELIAS_ALLOW_SOLVER` |
| `elias_image_generate` | POST `/images/generate?containerName=` | addressed by container NAME (aliasing risk), effect unverified | deferred behind Q6 |

Phasing: W0 prerequisites (lock helper, pipeline, client extensions, audit schema, config parser) -> W1 = A0 + container create/rename + preselection
-> W2 = image create/update/add/remove package -> W3 = deletes (image, package, file, container) -> W4 = upload -> W5 = solver, accept, import, generate.
Each phase needs live evidence and Security code review before the next switch is documented as usable.

Plus two non-writing helpers: `elias_write_status` (effective tier/switches, allowed/protected lists, held/leaked locks, pending uploads, breaker state; never secrets) and
`elias_upload_staged_list` (name + size of files in the staging dir, no content).

### Tier C — EXCLUDED PERMANENTLY from the MCP
Signing certificate management (POST `certificates/signing`, signing PFX upload), `POST certificates/sign/{c}/{idfId}`, `POST certificates/{c}/signing-upload-key`,
trust certificate import (both forms), `POST certificates/{c}/defaults` (restore trust) and `DELETE certificates/{c}/{id}`.
Argument:
1. Fleet-wide trust and attestation, not data: trust anchors and signatures decide what thin clients accept to run. A wrong/malicious anchor or signature is a supply-chain compromise whose blast radius is every device that boots from the container, and it is not snapshot-reversible (no known way to prove the old trust set; `defaults` resets it wholesale).
2. The server deliberately forbids plain-credential transit (`signingUploadNotSealed`; credentials must be sealed to a ticketed key). To support it we would have to receive PFX bytes/passwords from the model or local disk and implement the client-side sealing. That makes the MCP a custodian of signing material, which contradicts D7 and Security B1 (no key material ever returned or handled).
3. `sign` is the one ELIAS write logged at every monitoring level: it is the single most audit-sensitive action; letting an LLM trigger it (signature laundering of whatever image it just edited) removes the human from the exact step the product treats as most trusted.
4. Low value for the model: signing is a rare, deliberate admin ritual with a UI that already does it correctly (sealing included).
5. Counter-argument considered ("automate release pipelines"): that is a CI use case with a dedicated secrets path and approver, not an interactive LLM tool; revisit only as a separate project with its own threat model.
Structural enforcement (not just "we did not write it"): the op table has no such entry; a static test greps `src/` for `certificates/(signing|sign|import|.*defaults|.*signing-upload-key)` write paths and fails; tool-list test asserts no name matches `/sign|trust|certificate_(import|delete|restore)/`; `elias_certificate_*` stay read-only metadata (existing B1 rules).
Note: DELETE of a plain `CRT` certificate is also in Tier C (it removes trust anchors; same class).

---------------------------------------------------------------------------------------------------

## 2. Per-tool specification

### 2.0 Common elements

Identifier validation (extends existing `EliasGuid`/`EliasName`/`seg`/`cseg`): `containerId` = GUID, upper-cased by `cseg`, then CANONICALISED against `GET /containers`
(the list's own spelling; Source review 2.3 / D14), refused if not in the list (the list is already filtered by the caller's View right). `imageId`/`packageId`/
`filename` use `EliasName` (no `..`, charset `A-Za-z0-9._+~-`, <=200). New: `ContainerName` = `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` (conservative; Q7 checks real limits),
`Sha256` = `^[0-9a-f]{64}$`. All Zod objects are `.strict()` (unknown keys rejected, no pass-through of extra body fields). Bodies are BUILT by us from validated fields; the model never supplies a raw body, path, query or header.

Common input fields on every write tool: `confirm: boolean` (required true, via `confirmDestructiveAction`/elicitation where the client supports it, else the flag),
`dryRun` is not an input (mode governs; SCOUT_MODE=dry-run returns the plan). Deletes add `confirmName` (below).

Rights table (right names = `elias_my_roles` fields). `D` = documented (Scout source/OpenAPI note: a denied preflight is trusted to refuse), `I` = inferred (advisory only: a false is reported as a warning, not a refusal; the server decides):
| Op | Required rights |
|---|---|
| container create / rename | manageContainers (I) |
| container delete | delete (D) AND manageContainers (D) |
| container file delete | delete (I) |
| image create / update / add / remove package | upload (D: image lock needs Upload on the container) |
| image delete | delete (I) AND upload (D, because of the lock) |
| package delete | delete (I) |
| preselection | upload (I) |
| upload / import archive / upload images | upload (D) |
| solver (solve, generateRules, checks) | runSolver (D) |
| package-changes accept | manageContainers (I) |
| A0 IDF reads | view (D) |
For container create there is no container yet: preflight uses `GET /containers/rights` (global booleans, shape unknown -> soft-pass, Q8).

### 2.1 The gate chain (applies to every write tool, in this exact order)

Notation: "refuse" = tool returns `fail(message)` AND writes an audit `result:'refused'` with the gate name; no later step runs; no lock/snapshot/mutation happens.
```
 G0  registration   tool exists only if SCOUT_ENABLE_PRIVATE_ENDPOINTS=true AND SCOUT_ELIAS_WRITES covers its tier AND its feature switch is on AND
                    its registry entry is verified-live (D0). Re-checked at call time. Failure: refuse (gate 'mode'-class message naming the switch).
 G1  parse          Zod strict parse + canonical forms (pure, no I/O). Failure: refuse gate 'validation' (audit written, no network).
 G2  kill switch    checkKillSwitch(opName) (existsSync). Engaged: refuse gate 'kill-switch'.
 G3  mode peek      getScoutMode(): read-only -> refuse gate 'mode' (NO network read at all). dry-run and write continue (dry-run still resolves/plans).
 G4  private-write  checkPrivateWriteAllowedInProduction(opName): when SCOUT_MODE=write, needs SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true
     in production      (applies to ALL ELIAS writes, A and B; A0 reads exempt). Failure: refuse gate 'private-write-production'.
 G5  breaker peek   isCircuitBreakerTripped() -> refuse gate 'circuit-breaker' (no network).
 --- first network I/O below this line (reads only) ---
 G6  resolve        GET /containers (fresh for deletes, <=15 s cache otherwise) -> canonical id, server-side NAME. Unknown container: refuse 'validation'.
                    (create: no container yet; the NEW NAME is the subject.)
 G7  scope          protected/allowed container policy (3.1): SCOUT_ELIAS_PROTECTED_CONTAINERS (wins), SCOUT_ELIAS_ALLOWED_CONTAINERS (required, non-empty,
                    fail closed), SCOUT_ENV=test prefix rule. Deletable-list for container delete. Refuse gate 'elias-scope'. Audit includes id AND server name.
 G8  semantic       op-specific checks from reads (duplicate name on create/rename, image id exists / does not exist, extension/size/staged-file for upload,
     validation     package is part of the image, etc.). Refuse gate 'validation'.
 G9  delete switch  deletes only: SCOUT_ELIAS_ALLOW_DELETE (image/package/file) or container deletable-list; per-process delete budget
                    (SCOUT_ELIAS_MAX_DELETES_PER_HOUR, default 5, ceiling 20). Refuse gate 'elias-delete'.
 G10 dependents     (3.3) deletes only; > SCOUT_ELIAS_MAX_DELETE_DEPENDENTS (default 0, ceiling 5) -> refuse gate 'blast-radius'. Unreadable/uncountable -> refuse (fail closed).
 G11 rights         preflight (3.4): POST /elias/my-container-roles (read). Documented right === false -> refuse gate 'preflight'. Inferred false -> warning in
     preflight       result only. Missing/erroring/odd shape -> soft-pass with a stderr note (UX aid, never a boundary, never relaxes a gate).
 G12 confirm        Tier A: confirm:true (or elicitation accept). Tier B: elicitation if the client supports it, else confirm:true. DELETES additionally need
                    confirmName === server-resolved name (container: container name; image: image id; package: package id; file: filename), exact, no wildcard,
                    ONE object per call. Mismatch: refuse gate 'confirm' and say what was expected is NOT echoed beyond "must equal the displayed name"
                    (the name is shown in the plan/dry-run, not leaked in the error; avoids a model that guesses by retrying with the error text).
 G13 mutation gate  checkMutationAllowed(opName): authoritative kill switch + breaker + mode; the ONE breaker count for the whole logical op.
                    dry-run -> returns proceed:false: tool returns the PLAN (resolved target, rights result, dependents, what would be snapshotted/locked/sent;
                    body hash only), audit 'refused/mode/dry-run skip'. No lock, no snapshot, no write. read-only cannot reach here (G3).
 G14 lock           withLock(client, target, opName, check, fn) per section 4 (image ops) or container mutex (container-level ops). Lock failure: abort, audit.
 G15 snapshot       per section 5. Inside the lock, before the mutation. BLOCKING for every Tier A overwrite and every Tier B delete (unlike config writes).
 G16 intent audit   write-ahead entry {phase:'intent', opId, bodySha256, bodyBytes} BEFORE the mutating call.
 G17 mutate         client.rawRequest(method, templated path, built body, {mutating:false, timeoutMs}) via the pipeline helper only (see 2.2 note); per step re-check
                    checkKillSwitch; no auto-retry (except chunk PUT, 6.5).
 G18 result audit   {phase:'result', outcome: committed|failed|unknown, httpStatus, msgId, createdId, elapsedMs}; then reconcile read if unknown (8).
 G19 release        lock release in finally (always allowed under kill switch / read-only); container mutex release.
```
Breaker interplay: only ops that pass G1-G12 count (the count is taken at G13), so refusals never burn the budget; a multi-step op (upload) counts once.

2.2 Deviation for Security's attention: B3.2 says write calls go via `rawRequest(..., {mutating:true,opName})`. We call `checkMutationAllowed` explicitly at G13 (before the lock, as Security's A.3 requires)
and then issue the call with `mutating:false` through the pipeline helper, because `mutating:true` would run `checkMutationAllowed` a second time (double breaker count, second 'allowed' audit row, and for multi-step ops one count per step).
Equivalent guarantee: the pipeline helper requires the `MutationCheckResult` (`proceed === true`) object created at G13 (throws otherwise) and calls `checkKillSwitch` before every step. `rawRequest` is not importable by the write tools; the helper is the only caller. Security to rule on this.

### 2.3 Tool specs (Zod-level inputs; all `.strict()`; `confirm` omitted below for brevity but present on every write)

Naming convention: `elias_<object>_<verb>`. Annotations: `readOnlyHint:false`, `destructiveHint:true` for Tier B, `false` for Tier A, `idempotentHint:false`.

**elias_container_create** (A)
- Input: `{ name: ContainerName }`.
- Call: POST `/api/v1/containers/import`, body `{ "name": <name> }` (verified shape from e2e; response 201 `{id}`). Timeout 60 s.
- Rights: manageContainers (I). Gates: all of 2.1. G7: new name must match ALLOWED (a `prefix*` entry or exact name) and not match PROTECTED; in SCOUT_ENV=test must start with `SCOUT_TEST_CONTAINER_PREFIX`. G8: case-insensitive duplicate name in the list -> refuse. G12: confirm. No lock (no itemType); in-process mutex key `container-name:<lower name>`. No snapshot (nothing existed); record the list of container ids in the audit detail. Failure: 4xx -> failed, msg mapped; 5xx/timeout -> reconcile: list containers, name present -> `committed (created id=...)`, else `not-applied`/`unknown`.

**elias_container_rename** (A)
- Input: `{ containerId: GUID, newName: ContainerName }`.
- Call: PUT `/api/v1/containers/{id}` body `{ "name": <newName> }` (body UNVERIFIED -> Q1; D0 blocks registration until captured).
- Gates: G7 on BOTH the current server name and the new name (rename cannot move a container out of protection or into an allow-list it should not enter; protected -> refused). Container mutex. Snapshot: container record `{id,name,created,rowid}` (always possible, small) blocking. Reconcile: re-read list.

**elias_package_set_preselection** (A)
- Input: `{ containerId, packageId: EliasName, preselected: boolean }`.
- Call: PUT `/epms/{c}/{id}/preselection`, body UNVERIFIED (Q1). Container mutex (no image lock: package-level). Snapshot: the package record from `GET /epms/{c}/{id}` incl. current preselection value (blocking). Reconcile by re-reading the record.

**elias_image_create** (A)
- Input: `{ containerId, imageId: EliasName (new id), definition: {...allow-listed fields discovered in Q1} }`. No free-form body; if the body is an IDF text, input is `{ idf: string<=1MB }` run through `elias_idf_parse` (A0) first and must parse cleanly; secret filter applies to the supplied IDF (reject if it contains PEM private key markers).
- Call: POST `/images/container/{c}`. G8: imageId must not already exist (list). Container mutex. Snapshot: none needed (new object) but the container's image list is recorded. Reconcile: GET image.

**elias_image_update** (A, overwrite)
- Input: `{ containerId, imageId, baseSha256: Sha256, patch|idf: ... }`; `baseSha256` = sha256 of the idf the caller obtained from `elias_image_export_idf` (optimistic concurrency; REQUIRED).
- Call: PUT `/images/{c}/{id}` (body Q1).
- After the lock is held (G14) and before snapshot: fetch current idf (A0 call) and compare hash; mismatch -> abort `conflict` (someone changed it). Then snapshot (blocking), then mutate with `lock dataChange:true` on success only. Rights: upload.
- Needs the image row id for the lock (Q3). If the image detail has no numeric id -> this tool is not registered (fail closed).

**elias_image_add_package / elias_image_remove_package** (A)
- Input: `{ containerId, imageId, packageId }`. Calls: PUT `/images/addEpm` / `/images/deleteEpm`, body `{containerId, ...}` (container travels in the BODY, which is where the proxy reads it for the grant; Q1 captures the exact keys). G8: package exists in container (add) / is currently in the image (remove). Lock + blocking snapshot (idf). One package per call. Reconcile: export idf, check membership.

**elias_image_delete** (B)
- Input: `{ containerId, imageId, confirmName: string (== imageId), force?: false }`. DELETE `/images/{c}/{id}`.
- Gates add G9, G10 (dependents = devices currently assigned to the image: device search on `DistributionImageFileName` matching the image name/id, cap default 0; if the column cannot be queried -> refuse unless `force:true` AND env `SCOUT_ELIAS_ALLOW_FORCE=true`; `force` never skips confirmName, scope or snapshot). Lock (needs delete + upload). Blocking snapshot = metadata + idf. After success: `dataChange:true`. Reconcile: GET image -> 404 = committed.

**elias_package_delete** (B)
- Input: `{ containerId, packageId, confirmName: string (== packageId) }`. DELETE `/epms/{c}/{id}`.
- G10 dependents = images of the container that reference the package (scan `images/getAll` then per-image detail, limited to 200 images; more -> refuse, uncountable). Default 0, hard ceiling 5. Container mutex (package-level; no known lock type). Blocking snapshot: package record + fpm list + referencing image ids (metadata only). The tool result and the confirm text state: "package binary is NOT restorable from this snapshot". Reconcile: GET -> 404.

**elias_container_file_delete** (B)
- Input: `{ containerId, filename: EliasName, confirmName: string (== filename) }`. DELETE `/containers/{id}/files/{filename}` (filename segment `encodeURIComponent` after validation). G8: filename must be present in `GET /containers/{id}/files` (exact). Dependents: if the file is an archive that backs a package/image import -> unknown -> counted as 1 dependent when name matches a package source (best effort) else 0; mention. Container mutex. Blocking snapshot = file list entry (name,size,time); content not recoverable (stated).

**elias_container_delete** (B, strictest)
- Input: `{ containerId, confirmName: string (== server name), confirmId: GUID (== containerId) }`.
- Call: DELETE `/containers/{id}`. Needs delete AND manageContainers (D).
- Extra gates: (a) container name must match `SCOUT_ELIAS_DELETABLE_CONTAINERS` (name/`prefix*`; empty = tool not registered); (b) container must be EMPTY: 0 images (`images/getAll`), 0 packages (`epms/getAll`), 0 files (`containers/{id}/files`); checked twice, once at G10 and again inside the container mutex right before sending (TOCTOU window narrowed, not closed: another admin/MCP could add content in between, accepted, see Q9); (c) not in PROTECTED, and in SCOUT_ENV=test must start with the test prefix; (d) "not snapshot-able": the snapshot records only container metadata (blocking) and the audit says `restorable:false`. Because (b) leaves nothing to lose beyond the name/GUID, devices cannot reference images in it; this replaces the "referenced by devices" check which we cannot prove.
- Reconcile: list -> id absent = committed.

**elias_upload_file** (B) — see section 6 for the full design. Input `{ containerId, stagedFile: EliasName (basename in the staging dir), expectedSha256?: Sha256, contents?: 'packages' (enum, HAR value), transfer?: 'direct' }`.

**elias_package_changes_accept** (B): input `{ containerId }`; POST `/containers/{id}/package-changes/accept` (body Q1). Snapshot: package list + (if readable) the pending-changes view, blocking; if there is no way to read pending changes (Q10) the tool requires `confirmName` = container name and refuses in SCOUT_MODE=write unless `SCOUT_ELIAS_ALLOW_ACCEPT=true`. Container mutex.

**elias_solver_generate_rules / elias_solver_solve** (B): input `{ containerId, parcels?: bounded list of package ids (<=200, EliasName each) }` (body shape Q1). Container mutex + global solver semaphore (1). Timeout `SCOUT_ELIAS_SOLVER_TIMEOUT_SECONDS` (default 300, clamp 30..600) with AbortController (our client aborts; the server may keep running, see 8). Snapshot: container rules via the existing read (`elias_container_rules` endpoint) before, blocking. Output treated as data, capped. Input size cap 10 MB (server limit). Never run solve while an upload/lock-bearing op on the same container is active (mutex).

**elias_image_generate / elias_container_import_archive / elias_container_upload_images**: specified only after Q4-Q6; same pipeline, Tier B switches, no registration until verified.

### 3. Supporting policies

3.1 Container scope policy (new, `src/safety/elias_scope.ts`, pure functions, unit-testable like Gate 6)
- Entry syntax (comma list or JSON array, same parser as `SCOUT_PROTECTED_OUS`): a GUID (case-insensitive, braces rejected), an exact name, or `prefix*`. Names compare case-insensitively after trim. The match is evaluated against the SERVER's id AND name for the container (never against caller text).
- PROTECTED always wins. ALLOWED must be non-empty for any write (D3), else refuse "no ELIAS containers are allowed: set SCOUT_ELIAS_ALLOWED_CONTAINERS". Rename and create apply the policy to the new name too.
- SCOUT_ENV=test additionally requires the name to start with `SCOUT_TEST_CONTAINER_PREFIX` (default `MCPTEST-`) — this is code in the product path, not test-only, so a misconfigured test run cannot hit `uc-elux7-*`.
- Mapping to Security B3.4/B3.5: `SCOUT_PROTECTED_CONTAINERS` is renamed `SCOUT_ELIAS_PROTECTED_CONTAINERS` (same semantics, ids or names).

3.2 Confirm (Security B3.3): implemented through `confirmDestructiveAction` (elicitation when negotiated, `confirm:true` fallback). `confirmName` is an additional typed check that the target the caller means is the target the server resolved. We state plainly it is a speed bump against mistakes, not a human proof (a model can copy the name from a read); the human gate is the client's tool-approval / elicitation, and the real hard stops are the env switches and the allow-lists.

3.3 Dependents (blast-radius analogue, B3.4). Computed from read endpoints at plan time (so dry-run shows them): image -> devices assigned (device search on the image column), package -> images referencing it, container -> must be empty, file -> dependent package best-effort. Cap `SCOUT_ELIAS_MAX_DELETE_DEPENDENTS` default 0, hard ceiling 5 (a code constant, like `HARD_BLAST_RADIUS_CEILING`). Counting failure or truncation = refuse.

3.4 Rights preflight (B3.11 = B2 rules): `elias_my_roles` call (POST my-container-roles, `mutating:false`, cache <=15 s keyed by container id, never across a failure). Only after the id is canonicalised (a mis-spelled id answers all-false: this is why G6 precedes G11). Explicit `false` on a documented right refuses; everything else soft-passes. A `true` never skips any gate.

---------------------------------------------------------------------------------------------------

## 4. Lock wrapper (Security A) applied to ELIAS

### 4.1 Interface (internal, `src/safety/lock.ts`, no tool, test asserts no tool matches /lock/i)
`withLock(client, target, opName, check: MutationCheckResult, fn, opts)`; `target = {itemType:'eliasImage', itemId:int>=0, containerId: GUID}` (only `application` and `eliasImage` exist in the closed enum; ELIAS ops only ever use `eliasImage`).

### 4.2 State machine
```
IDLE --(check.proceed!==true? THROW)--> 
IDLE -> ACQUIRING: checkKillSwitch; cap check (<=3 held, SCOUT_LOCK_MAX_HELD); per-key mutex; ensure session (4.3); POST /lock/set (1 attempt)
ACQUIRING -fail(4xx/5xx/timeout/404/405)-> IDLE   (abort op, audit lock-acquire refused/error, registry empty, no unlocked fallback)
ACQUIRING -ok-> HELD: registry.add(key), write logs/scout-locks.json (0600), audit lock-acquire allowed, start heartbeat, start max-hold timer (default 120 s)
HELD -> MUTATING: snapshot (G15), intent audit (G16), mutate (G17) [all inside fn]; AbortController aborts fn at max hold
MUTATING -ok-> RELEASING (dataChange:true)   MUTATING -error|timeout|GuardrailError|kill switch-> RELEASING (dataChange:false)
RELEASING: POST /lock/release (<=2 attempts, server tolerates double release); finally-block, never masks the original error
RELEASING -ok-> IDLE: registry.remove, file entry removed, audit lock-release
RELEASING -fail x2-> LEAKED: registry entry KEPT, file entry kept, audit lock-leaked, surfaced in elias_write_status; return the original result/error
```
Rules carried over unchanged from Security: release only keys in the registry; gates before lock; kill switch/read-only never block release; lock calls never counted by the breaker; no skip-lock flag; `dataChange:true` only after a successful mutation; startup reports stale entries and releases them only with `SCOUT_RELEASE_STALE_LOCKS=true`; SIGINT/SIGTERM handler releases registry entries best effort (and unregisters the session, 4.3); max hold `SCOUT_LOCK_MAX_HOLD_SECONDS` clamp 5..600 default 120; cap 3.
ELIAS-specific additions:
- Max hold vs op duration: only image-targeted ops take a lock, and none of them is long-running (solver and upload use the container mutex, not a lock), so the 120 s default holds. If a lock-bearing op is observed to exceed it live, we raise the per-op hold (never remove the cap).
- Where a lock is not possible (create, package-level, container-level, solver, upload): in-process per-container mutex (Map of promises keyed by canonical container id; FIFO; same-key re-entry refused; wait max 30 s then refuse). This does NOT protect against another MCP process or a human in the UI; documented limitation (Q9).
- Lock conflict from the server (UI lock route answers 400 with DBLayer text starting `Database Lock error`; /rest 409): map to typed `LockedByOtherError`, no wait loop.

### 4.3 New finding that changes the lock design (needs Security's ruling)
Source review section 5: `lock/set|release` are refused (409 `scoutBoardId <id> does not exist for this user`) unless `scoutBoardId` is a Scoutboard SESSION registered BY THE CALLER. The HAR's constant `27` is the browser's own session; the MCP must NOT reuse a UI session id. Therefore `withLock` needs, outside any tool surface:
1. lazy `GET /api/v1/ui/register` (returns rows with `EntityID`; pick the row created for this call — exact semantics Q11) on first lock;
2. `POST /api/v1/heartbeat {scoutBoardId}` every 30 s while any lock is held (the session dies when heartbeats stop; the timeout is DBLayer-internal, assumed unknown);
3. `POST /api/v1/ui/unregister {EntityID}` on process exit/SIGTERM and after the registry becomes empty after `SCOUT_LOCK_SESSION_IDLE_SECONDS` (default 60): unregister drops all of that session's locks, which is a stronger leak cleanup than per-lock release and is server-enforced as owner-only (no stealing possible by construction).
These three calls are `mutating:false` for the breaker (they are session plumbing, like login), are callable only from inside `lock.ts`, and are audited (`session-register|heartbeat-fail|session-unregister`). `scoutBoardId` therefore comes from our own registered session (Security A.3 already says "from config/session, never from the model"). If register fails -> lock-set cannot be attempted -> all image write tools fail closed.
Prerequisite client changes for locks (also needed for upload): `rawRequest` must tolerate empty 200/202/204 bodies (lock/set and release answer `200` with an empty body; today `res.json()` would throw), and expose status + a per-call timeout (4.4).

### 4.4 Client extensions required (W0; Security to review the diff in client.ts)
- `rawRequest(..., {timeoutMs, expect: 'json'|'empty'|'any'})`: empty-body tolerance, per-call timeout up to 330 s (solver, uploads) instead of the single `timeoutMs`.
- `rawRequestBytes(method, path, {body: Buffer|Uint8Array, contentType:'application/octet-stream', headers:{'x-chunk-index': n}})` for chunk PUT; headers are a closed allow-list (`x-chunk-index` only); never lets callers set `Authorization`, `Cookie`, `x-elias-*`. The `x-elias-container-rights` header is never set by us (the proxy mints it).
- Re-login on 401 must not replay a streamed/one-shot body: bytes calls re-send from the in-memory chunk (<=8 MiB) only once, as today; `grantKeyChanged` retry applies ONLY to idempotent reads and A0, never to a mutation (a mutation 403/503 is reported, not retried; the server itself answers 503 for non-replayable streamed bodies).
- Mutations are never retried by the client layer except the single post-401 re-login replay that exists today (safe because a 401 means the request was not processed).

---------------------------------------------------------------------------------------------------

## 5. Snapshot-before-mutate feasibility (`writeSnapshot`, `wx` flag, dir from `SCOUT_SNAPSHOT_DIR`)

Snapshot content never includes PEM/keys/tokens (run `redactSecrets` over everything written; fail snapshot if redaction would alter an IDF-body field that is needed? -> store as-is only after the redaction filter, and say so). Files 0600 in a 0700 dir. A snapshot is a manual restore reference, not auto-rollback.
| Op | What can be exported | Restorable? | Snapshot failure |
|---|---|---|---|
| container create | nothing (new) ; list of ids | n/a (undo = delete empty container) | n/a |
| container rename | container record | yes (rename back) | BLOCK |
| preselection | package record incl. flag | yes | BLOCK |
| image create | image list ids | n/a (undo = image delete) | n/a |
| image update / add/remove package | image metadata (`GET /images/{c}/{id}`) + `legacyIDF` (`POST .../idf`) | yes IF restore via PUT/POST works (Q12: live round-trip test must show idf equality) | BLOCK |
| image delete | same as update | yes only if all packages still exist (checked and stated) | BLOCK |
| package delete | package record + fpm list + referencing images | NO for the binary (metadata only) | BLOCK, and the confirm text says irreversible |
| container file delete | file list entry | NO (content) | BLOCK |
| container delete | container record only | NO (not snapshot-able); mitigated by empty-only + deletable-list + confirmName+confirmId | BLOCK (record), plus the stronger gates; if the operator wants it disabled entirely, leave `SCOUT_ELIAS_DELETABLE_CONTAINERS` empty (default) |
| upload | container file list before | undo = file delete (Tier B) | non-blocking (additive) |
| import archive | file list + package list before | NO if ARCHIVE_AUTO_EXTRACT deletes archives | BLOCK |
| solver solve / generateRules | container rules (read) + package list | partial (rules readable; internal state unknown) | BLOCK |
| package-changes accept | package list, pending changes if readable | unknown | BLOCK |
Snapshot is taken after the lock (A.3: consistent with what will change) and recorded in the audit with path + sha256.

---------------------------------------------------------------------------------------------------

## 6. Upload design (Tier B, W4)

### 6.1 The local-file problem and the decision
A tool that takes a path is a local file-read primitive (`~/.ssh`, `.env`, `logs/`, the credentials store) whose bytes are then sent to a server the model can read back from. A tool that takes base64 content lets the model forge packages that devices will run. Decision: **the model chooses only a basename inside one operator-owned staging directory; it never supplies a path, directory, URL or bytes.**
- `SCOUT_ELIAS_UPLOAD_DIR` (absolute; unset = upload tool not registered). At startup: `realpath`; must be a directory owned by the current uid, mode without group/other write (`mode & 0o022 == 0`), not equal to or an ancestor of `/`, `$HOME`, `process.cwd()`, the audit/snapshot/lock dirs, `~/.ssh`, `~/.claude`, `.env` location; refuse otherwise. Flat directory only (no recursion).
- `stagedFile`: `EliasName`, additionally must not start with `.`; resolved as `join(realDir, name)`; then: `lstat` is a regular file (symlink -> refuse), `open(O_RDONLY|O_NOFOLLOW)`, `fstat` on the descriptor: regular file, `nlink==1` (hard-link trick), size in `1..cap`, realpath of the descriptor path starts with `realDir + sep`. Streaming reads come from that open descriptor (no TOCTOU between check and use).
- The model cannot write to that directory: no tool in this server writes there; the operator places files (human-in-the-loop supply chain control). Residual risk (another MCP server with FS write access can stage files) is documented.
- `expectedSha256` optional input; if present it must equal the streamed hash BEFORE `init` is sent (hash pass 1 over the descriptor, upload pass 2 compares again; mismatch aborts, covers a file swapped mid-way). sha256 is always logged.
- No downloads exist in this phase, so no round trip "read container file -> upload elsewhere" for the model.

### 6.2 Policy
| Item | Default | Env | Hard ceiling (code) |
|---|---|---|---|
| Extensions | `epm,fpm,idf` | `SCOUT_ELIAS_UPLOAD_EXTENSIONS` (subset check against a code allow-list `epm,fpm,idf`; `zip` is NOT in the code allow-list in W4: archives are always unpacked server-side and we do not yet validate central-directory paths (zip-slip) locally; adding it needs a code change + local zip validation + review) | code list |
| Max size | 256 MB | `SCOUT_ELIAS_MAX_UPLOAD_MB` | 1024 MB |
| Chunk size | 4 MiB (server body limit 10 MB; headroom for the proxy) | none | fixed |
| Max duration | 900 s | `SCOUT_ELIAS_UPLOAD_MAX_SECONDS` (60..3600) | 3600 |
| Per-chunk timeout / retries | 60 s / 3 with 1-2-4 s backoff, same index (idempotent by index; Q13) | none | fixed |
| Status polling | <=30 polls x 2 s after `complete` | none | fixed |
Content sniff before init: `idf` must be valid UTF-8 text, no NUL, <=10 MB and pass `elias_idf_parse` offline-structure check if available; `epm/fpm`: magic check if the format is determined (Q14), otherwise size/extension only (stated limitation). `contents` enum = `packages`, `transfer` enum = `direct` (HAR values). `signaturePEM`: no input exists; no tool accepts or returns signing material (B3.8).

### 6.3 Sequence (ONE logical op, one breaker count; every step re-checks the kill switch)
1. gates G1-G13 (G8: staged-file checks, name collision with `containers/{id}/files` unless... collision = refuse (no overwrite semantics assumed, Q15)).
2. container mutex.
3. `POST /files/upload/init {containerId, filename, size}` -> `{uploadId}` (validate uuid shape; store in `logs/scout-uploads.json` 0600 as pending).
4. `PUT /files/upload/{id}/chunk` for index 0..n-1 sequential (octet-stream, `x-chunk-index`); after each 16 chunks and before complete `GET /files/upload/{id}/status` must list all indexes.
5. `POST /files/upload/{id}/complete` (archives would be unpacked: not enabled in W4).
6. poll status (bounded), then `GET /containers/{id}/files` must show the filename with `size == local size`; else outcome `unknown/failed`.
7. audit result with uploadId, filename, bytes, sha256, chunks, duration; remove pending entry.
Kill switch trips between steps: stop sending chunks, do NOT call `complete`, audit `kill-switch`, leave the pending record (an incomplete upload is inert; there is no known abort endpoint, Q16). A 401/`grantKeyChanged` mid-sequence: a streamed chunk cannot be replayed by the proxy (503), our client re-sends the chunk from memory once after re-login; otherwise abort and report the resumable `uploadId` + received indexes (we never auto-resume across tool calls in W4).
`POST /files/upload/{id}/target` (renew direct-to-storage link): internal, used only when a chunk fails with the documented expired-link signature (Q17); never a tool.
Dry-run: validates staged file, size, extension, sha256 (local read only, no network write, no init) and reports the plan.
The uploaded bytes are never executed, unpacked, or interpreted locally.

---------------------------------------------------------------------------------------------------

## 7. Audit-log schema additions (extends `AuditLogEntry`, backward compatible; all new fields optional)

```
opId:        uuid per logical op (shared by intent/result/lock/snapshot/step rows)
phase:       'intent' | 'step' | 'result' | 'plan'           (write-ahead: intent row exists before the HTTP call)
tier:        'A0' | 'A' | 'B'
container:   canonical id            containerName: server name (not caller text)
objectType:  'container'|'image'|'package'|'file'|'upload'|'solver'
objectId:    image/package/file id or new name
step:        'init'|'chunk'|'complete'|'poll'|'readback'|... (multi-step ops)
httpStatus:  number                  msgId: sanitised server msgId
bodySha256 / bodyBytes: of the request body we built (never the body itself for uploads/IDF)
fileSha256 / bytes / chunks: uploads
lockKey / snapshotPath / snapshotSha256
outcome:     'committed' | 'failed' | 'unknown' | 'not-applied'   (result row only)
restorable:  boolean         dependents: number         rights: 'allowed'|'denied'|'unknown'
elapsedMs:   number          dryRun: boolean
```
`result` union gains `'unknown'`; `gate` union gains: `'validation'`, `'confirm'`, `'lock'`, `'elias-scope'`, `'elias-delete'`, `'upload-policy'`, `'snapshot'` (plus Security's `'lock'`). Existing `'preflight'` is reused for G11, `'blast-radius'` for G10.
Never logged: JWT, grant header, PEM/key material, file contents, IDF text, filenames beyond the validated charset. Container and object names are logged (server-resolved). Because the server-side audit header is stripped, the intent/result pair plus `opId` is the authoritative trail; an intent without result = crashed/unknown op and `elias_write_status` lists such opIds from the last N hours. Tamper-evidence (hash chain) stays out of scope as in guardrails.ts; flagged as a known limitation.

---------------------------------------------------------------------------------------------------

## 8. Failure and partial-failure handling

General rule: a mutation is sent at most once. The client re-login replay on 401 is the only automatic re-send (401 = not processed). All other failures end in a reconcile read and an explicit outcome.
| Situation | Handling |
|---|---|
| 4xx on mutation (400/403/404/405/409) | `failed`, mapped message (reuse `describeError`, 403 -> id spelling/rights wording); `dataChange:false`; no retry |
| `403 grantKeyChanged` | NOT retried for mutations: report "retry the whole tool call" (state unchanged, server refuses before acting); GETs keep the existing single retry |
| Timeout / abort on a mutation, or 5xx / 502 / 503 after sending | outcome `unknown`; run the op's `reconcile()` read(s) (create: list; update/addEpm/deleteEpm: idf hash vs intended; delete: 404 = committed; preselection: record). Result is `committed (verified by readback)`, `not-applied (verified)` or `unknown` with the opId and an instruction not to blindly repeat. Never auto-retry. Lock released with `dataChange` = true only if readback proved commit, else false |
| Upload: timeout mid chunk | retry the same index up to 3x; still failing -> stop, no `complete`, outcome `failed`, resumable uploadId reported, pending record kept |
| Upload: `complete` timed out/5xx | outcome `unknown`; verify via container file list (size match) -> committed/not-applied |
| Upload: server rejects as archive/bad content | `failed`; nothing local to undo; audit |
| Solver exceeds our timeout (300 s default) | our fetch aborts; the server may keep running and may commit rules after we gave up: outcome `unknown`, status "solver may still be running"; the container mutex is held for an extra `SCOUT_ELIAS_SOLVER_COOLDOWN_SECONDS` (default 60) and a post-hoc readback of rules is attempted (snapshot diff). A second solve on that container within the cooldown is refused |
| Kill switch trips after the mutating request left | cannot recall: let it complete, release lock, audit `kill-switch observed`, report outcome |
| Process killed (SIGKILL) | intent row without result; lock file entry; session dies by heartbeat loss; startup reports stale locks/uploads/intents; no auto-release unless `SCOUT_RELEASE_STALE_LOCKS=true` |
| Lock set fails / session register fails | abort before any snapshot or mutation; audit `lock-acquire error` |
| Snapshot write fails | BLOCK (Tier A overwrite and all Tier B); lock released; audit |
| Rights preflight endpoint down | soft-pass (UX aid only) |
| Breaker trips mid multi-step op | the op already counted once, finishes its current step sequence only if the breaker is not tripped by ANOTHER op; the kill switch is the only mid-op stop |
Concurrency: all ELIAS writes in this process serialize per container; solver is globally single; max 1 upload at a time per process.

---------------------------------------------------------------------------------------------------

## 9. Configuration (all safe by default)

| Variable | Default | Meaning |
|---|---|---|
| `SCOUT_ENABLE_PRIVATE_ENDPOINTS` | unset | existing; required for any ELIAS tool |
| `SCOUT_MODE` | `read-only` | existing; read-only => no write tool can mutate (and no ELIAS read before refusal) |
| `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION` | unset | existing G7; REQUIRED for every ELIAS write when `SCOUT_MODE=write` (A and B). Interplay: tier switch alone is not enough in write mode; dry-run needs neither |
| `SCOUT_ELIAS_WRITES` | `off` | `off` \| `a` (A0+A) \| `b` (A0+A+B subject to the per-feature switches below). Tools above the tier are not registered |
| `SCOUT_ELIAS_ALLOWED_CONTAINERS` | empty = all ELIAS writes refused | ids / names / `prefix*` |
| `SCOUT_ELIAS_PROTECTED_CONTAINERS` | empty | ids / names / `prefix*`, always wins |
| `SCOUT_ELIAS_ALLOW_DELETE` | false | image, package, file delete |
| `SCOUT_ELIAS_DELETABLE_CONTAINERS` | empty = container delete not registered | names / `prefix*` of containers that may be deleted (and only when empty) |
| `SCOUT_ELIAS_MAX_DELETE_DEPENDENTS` | 0 (ceiling 5) | dependents cap |
| `SCOUT_ELIAS_MAX_DELETES_PER_HOUR` | 5 (ceiling 20) | per-process delete budget, all kinds |
| `SCOUT_ELIAS_ALLOW_FORCE` | false | permits `force:true` on image delete when dependents are uncountable |
| `SCOUT_ELIAS_ALLOW_UPLOAD` / `SCOUT_ELIAS_UPLOAD_DIR` / `..._EXTENSIONS` / `..._MAX_UPLOAD_MB` / `..._UPLOAD_MAX_SECONDS` | false / unset / `epm,fpm,idf` / 256 / 900 | upload policy (6.2); ceilings in code |
| `SCOUT_ELIAS_ALLOW_SOLVER` / `SCOUT_ELIAS_SOLVER_TIMEOUT_SECONDS` / `..._COOLDOWN_SECONDS` | false / 300 (30..600) / 60 | solver switch and timing |
| `SCOUT_ELIAS_ALLOW_ACCEPT` | false | package-changes accept |
| `SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES` | false | D0 escape for test envs only; ignored if SCOUT_MODE=write and SCOUT_ENV!=test |
| `SCOUT_ENV` / `SCOUT_TEST_CONTAINER_PREFIX` | unset / `MCPTEST-` | test mode prefix enforcement in product code |
| `SCOUT_LOCK_MAX_HOLD_SECONDS` / `SCOUT_LOCK_MAX_HELD` / `SCOUT_RELEASE_STALE_LOCKS` / `SCOUT_LOCK_SESSION_IDLE_SECONDS` | 120 / 3 / false / 60 | Security A + 4.3 |
Invalid/unparseable values fall back to the SAFE side (off, smaller). Config is read fresh per call (like `getScoutMode`). `elias_write_status` prints the effective values.
Effective matrix: read-only = nothing writes; dry-run = plans only (reads + audit), needs `SCOUT_ELIAS_WRITES!=off` only to list the tools; write = needs tier + feature switch + allowed container + `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION`.

---------------------------------------------------------------------------------------------------

## 10. Compat registry and docs (same PR, `tests/compat.test.ts` enforces agreement)

- `src/compat/registry.ts`: keep `elias` (reads) unchanged; split `ELIAS_TOOLS` into read list; add capabilities (probe `null`, `minScoutVersion:'2611'`, status `untested` until live evidence is recorded per phase):
  `elias-image-lock` (lock/set|release + session register/heartbeat/unregister; dependentTools = image write tools), `elias-write-containers` (create, rename, delete, file delete),
  `elias-write-images` (create, update, add/remove package, delete, export idf, parse, verify), `elias-write-packages` (preselection, delete, accept), `elias-upload`, `elias-solver`.
  A0 read-class POSTs become `verified-live` only after the before/after diff test. Registration (D0) reads these statuses.
- `docs/compatibility.md`: one row per new capability (min version, status, "live-verified date"), a "Live verification log" entry per executed live test (what was created/deleted in the MCPTEST container), and the line "Not yet exercised live: every ELIAS write tool" removed only as evidence arrives.
- `docs/reference/elias-api-notes.md`: replace the "Deliberately NOT exposed" paragraph with: Tier C permanent exclusion + reasons; list of write ops, their rights, observed bodies/responses from the live capture (without secrets), lock/session findings, id spelling rules, timeouts.
- `README.md`: ELIAS write section (switches table from section 9, "everything off by default", the UX-only status of rights preflight, upload staging directory procedure, kill switch usage).
- `.agents/design-decisions.md`: add ELIAS write phase summary + link to this file.

---------------------------------------------------------------------------------------------------

## 11. Test strategy (how to test without hurting production)

### 11.1 Environments
- Mock tier (default `npm test`, no network): fake client implementing `rawRequest/rawRequestBytes` with scripted responses, call recorder, injectable latency and faults. Everything destructive is mock-only by default.
- Live tier (explicit, opt-in; never part of default `npm test`): `SCOUT_ENV=test`, `SCOUT_MODE=write`, `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION=true` (test-only), `SCOUT_ELIAS_ALLOWED_CONTAINERS=MCPTEST-*`, `SCOUT_ELIAS_DELETABLE_CONTAINERS=MCPTEST-*`, `SCOUT_ELIAS_PROTECTED_CONTAINERS=uc-*`. The live server's real containers are `uc-elux7-2507...2612` and `uc-rp6-x64`; the prefix rule is enforced in product code so a test bug cannot touch them.
- The live tests create their own container `MCPTEST-<yyyymmdd>-<8 hex>` via `elias_container_create`, run all object-level tests inside it, and delete it in `finally` via `elias_container_delete` (empty-only: tests delete their objects first). A sweeper at test start lists `MCPTEST-*` containers older than 24 h and deletes the empty ones; non-empty leftovers are reported, never force-deleted. A test refuses to run if the target container name does not start with the prefix (belt and braces on top of the product rule) or if `uc-*` appear in its resolved target set.
- Needs operator fixtures in a dedicated test staging dir (`tests/fixtures/elias/`, gitignored if proprietary): one tiny valid `.epm`/`.fpm` and one `.idf` (Q14). Image tests are skipped (reported `SKIPPED: no fixture`) when absent.

### 11.2 Mock-only (must never run live)
Container delete of anything non-test, package delete of real packages, solver on non-test containers, kill switch mid-upload, 5xx-after-commit, timeouts, `grantKeyChanged` on a mutation, lock conflicts, stale locks/SIGTERM, circuit breaker, symlink/hardlink/TOCTOU upload attacks, protected/allowed policy permutations, every Tier C absence check.
### 11.3 Live (test container only)
create -> list -> rename -> rename back; lock register/set/release/double-release/unregister and observe conflict + TTL behaviour (Security A.4 #17, results appended to `.agents/` notes and the registry); upload a fixture, verify listing, delete file; image create/update/add/remove, snapshot round-trip equality (Q12); A0 before/after non-mutation diffs (idf export/parse/verify, solver checks) on the test container; empty container delete; delete refusal when non-empty (server-side behaviour recorded).

---------------------------------------------------------------------------------------------------

## 12. Acceptance tests (full list; unit = mock, L = live/test container)

Registration and config
1. With defaults (no env) the tool list contains zero ELIAS write tools; `SCOUT_ELIAS_WRITES=a` lists only A0+A; `b` still hides delete tools until `ALLOW_DELETE`, container delete until `DELETABLE` set, upload until `ALLOW_UPLOAD`+dir, solver/accept until their switches.
2. Tool list contains no name/description matching /lock|session|sign|trust|certificate_(import|delete|restore)/i; no resource/prompt exposes lock or write paths.
3. Op table is closed: a static test enumerates the table and asserts every path template appears in the allowed list; static grep test fails if `src/` contains a write to `certificates/(sign|signing|import|defaults|.*signing-upload-key)` or `DELETE certificates/`.
4. An op whose registry status is not `verified-live` is not registered; `ALLOW_UNVERIFIED_WRITES` is ignored in SCOUT_MODE=write with SCOUT_ENV unset.
5. Invalid config values (negative, NaN, over-ceiling) fall to the safe side; ceilings cannot be exceeded by env.
Gate order and zero-I/O refusals (each: assert the exact HTTP call list on the fake client)
6. read-only: zero HTTP calls (not even `GET /containers`) for every write tool.
7. dry-run: only read calls; returns plan incl. resolved name, rights result, dependents, snapshot/lock plan, `bodySha256`; zero lock/session/snapshot/mutation calls; breaker count unchanged.
8. kill switch engaged before the op: zero calls; engaged between lock set and mutation: mutation not sent, release sent; engaged between upload chunks: no further chunk, no `complete`, pending record kept.
9. breaker tripped: zero calls; one logical op (incl. 40-chunk upload) increments the count by exactly 1; a refused op (validation/confirm/scope) increments by 0.
10. SCOUT_MODE=write without `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION`: refused for A and B tools with gate `private-write-production`; A0 reads unaffected.
11. Missing confirm, wrong `confirmName`, wrong `confirmId`: refused, zero lock calls; the error does not echo the expected name.
12. Elicitation-capable client: accept -> proceed; decline/cancel -> refused; non-capable -> `confirm:true` path.
13. Order test: calls occur in the sequence resolve -> rights -> (checkMutationAllowed) -> session/lock set -> snapshot -> intent audit -> mutate -> readback -> lock release.
Scope
14. Allowed list empty -> every write refused; protected wins over allowed; protected id OR name (server name, case-insensitive); `prefix*` semantics; descendant-style confusion (`MCPTEST-x` vs `MCPTEST2`) correct.
15. Rename into a protected/not-allowed name refused; rename of protected refused; create with protected name refused.
16. SCOUT_ENV=test: any container without the test prefix refused even if in ALLOWED.
17. A container id spelled lower-case/with braces is canonicalised or refused (never sent as typed); id not in the list refused before any write; a name passed where an id is expected rejected.
Validation / injection
18. Corpus for every id/name/filename field: `../`, `%2f`, `%2e%2e`, `?x=`, `#`, backslash, NUL, newline, 10k chars, unicode, `.`, `..` rejected before any HTTP; extra keys rejected (`.strict()`); no tool accepts path/query/header/raw body; model-supplied `x-elias-container-rights` impossible.
19. Body built by us: snapshot test of the exact method/path/body per op against the live-captured contract.
Rights
20. Documented right false -> refused `preflight` (zero lock calls); inferred false -> warning only; endpoint 404/5xx/odd shape -> proceeds; all-true never bypasses read-only/confirm/scope; mis-spelled-id all-false case cannot occur because ids are canonicalised first.
Lock/session
21. Security A.4 tests 1-16 (adapted to eliasImage): incl. no tool exposure, cap 3, per-key mutex, release only own keys, release under kill switch/read-only, stale file 0600 without secrets, SIGTERM release, max hold abort, `dataChange` only on success, leak path.
22. Session: register failure -> image ops fail closed with zero snapshot/mutation; heartbeat while held; unregister at exit and idle; never uses a `scoutBoardId` not from our own register; `scoutBoardId` never from tool input.
23. Container-level ops use the mutex, take no `/lock/*` calls; same container twice concurrently serialises; different containers parallel.
24. `LockedByOtherError` mapping (400 `Database Lock error` and 409) with no wait loop.
Snapshots
25. Snapshot written before the mutation for every op in the table of section 5; blocking cases abort when the dir is unwritable (zero mutation calls, lock released); content passes `redactSecrets`; file mode 0600; sha recorded in audit.
26. `baseSha256` mismatch on `elias_image_update` aborts after lock and before snapshot/mutation; match proceeds.
Deletes
27. Each delete tool refused without `ALLOW_DELETE`; container delete refused without a matching `DELETABLE` entry; container delete refused for a non-empty container (each of images/packages/files non-zero), and re-checked inside the mutex (race test: content appears between checks -> refused).
28. Dependents > cap (default 0) refused; uncountable (read fails, >200 images, column missing) refused; `force` requires `ALLOW_FORCE` and never bypasses scope/confirm/snapshot; ceiling 5 unraisable by env.
29. Delete budget per hour enforced; 6th delete refused.
30. One object per call: arrays/wildcards/`*` in ids rejected.
Upload
31. No stagedFile without `UPLOAD_DIR`; dir validation (world-writable, wrong owner, `/`, `$HOME`, cwd, ancestors of audit/snapshot dirs) refused at startup; basename-only: `a/b`, `..`, absolute, leading dot, symlink, hardlink (nlink>1), FIFO/device, directory refused; symlink swapped after lstat (TOCTOU) read from the descriptor or refused.
32. Extension allow-list (zip refused in W4), size cap and ceiling, empty file, idf with NUL/invalid UTF-8, `expectedSha256` mismatch and file changed mid-way abort before `complete`.
33. Sequence: init -> N chunks in order with correct `x-chunk-index` -> status check -> complete -> readback; wrong order/duplicate/short status aborts; chunk retry limited to 3 on same index; 4 MiB chunking boundaries (size = k*4MiB, k*4MiB±1, 1 byte).
34. Failure matrix: timeout mid-chunk, status missing indexes, `complete` 5xx (readback decides), kill switch mid-sequence, `grantKeyChanged` on chunk, 401 mid-sequence, max duration exceeded; pending record present and reported in `elias_write_status`; uploaded bytes never executed locally (no child_process import in module, static test).
35. Dry-run upload: local validation only, zero network writes.
Solver/accept/generate
36. Switch off -> unregistered; on: global single-flight; second concurrent call refused; timeout -> outcome `unknown`, cooldown refuses next solve; input >10 MB refused; output capped and treated as data.
Failure handling
37. For each op: 5xx-after-commit and timeout produce readback and outcome `committed|not-applied|unknown`; no second mutation request is ever sent (assert call count 1); 401 after login replays exactly once.
38. 403 `grantKeyChanged` on a mutation is reported, not retried; on GET retried once.
Audit
39. Every write attempt produces intent+result rows sharing `opId`; refusals produce one refused row with the gate; no JWT/PEM/IDF text/file content in any row (secret-corpus test across log, snapshots, lock file, stderr); `unknown` result representable; crash simulation (intent without result) is surfaced by `elias_write_status`.
Tier C
40. Static + runtime assertions from tests 2-3; plus a unit test that the op-table lookup for any signing/trust path throws `NotInOpTable`.
Output handling
41. All write results pass `redactSecrets` + `capOutput`; server text is wrapped as untrusted data.
Live (L, test container only)
42. L: create container; duplicate create refused; rename + back; list shows both states.
43. L: register/lock/release/double release/unregister; conflict behaviour with a second session recorded; TTL observation recorded.
44. L: upload fixture, listing size match, file delete; upload dir attacks are mock-only.
45. L: image create/update/add/remove package round trip with snapshot equality (needs fixtures).
46. L: A0 non-mutation diffs (idf export/parse/verify, solver checks).
47. L: delete empty container; non-empty delete refused by our gate; record whether the SERVER also refuses (informational).
48. L: cleanup sweeper leaves zero `MCPTEST-*` containers; run aborts if any non-prefix container would be touched.

---------------------------------------------------------------------------------------------------

## 13. Traceability to Security's B3 requirements and the lock design

| B3 | Where satisfied |
|---|---|
| 1 env gating + mode write + private-writes-in-production, delete/import/upload/solve hard off | G0, G4, section 9 (applied to ALL ELIAS writes, stricter than the minimum) |
| 2 mode tiers; dry-run plan only; mutating via rawRequest with kill/breaker/audit; multi-step = one op | G3, G13, 2.2 (deviation noted), 6.3 |
| 3 confirm tiers, confirmName for container/image, one object per call | G12, tools 2.3, test 30 |
| 4 dependents pre-count, cap default 0, no delete of referenced, protected list | 3.3, G7/G10, container-delete empty-only + deletable list |
| 5 test-scope prefix in SCOUT_ENV=test, scratch containers created in test | 3.1, 11.1 |
| 6 snapshots; BLOCK for deletes; refuse deleting non-empty containers | section 5, container delete (b) |
| 7 locks for eliasImage ops; no invented itemType; per-container mutex for container ops | section 4 |
| 8 upload controls (filename regex, ext allow-list, size cap, contents/transfer enums, operator dir + realpath, checksum logged, bounded polls, never executed, no signing material) | section 6 |
| 9 solver single-flight, timeout, cancel path, input cap | tool spec + section 8 (cancel = abort + cooldown; no server cancel endpoint known, Q18) |
| 10 audit every step, no PEM/token/content | section 7 |
| 11 rights UX only | 3.4 |
| 12 own design review before code | this file |
Security A (lock): honoured, with the new session-registration requirement flagged in 4.3.

## 14. Points explicitly requested for Security's ruling
1. 4.3: `ui/register` + heartbeat + `ui/unregister` plumbing inside `lock.ts` (not tools, `mutating:false`).
2. 2.2: breaker counted at G13 and the actual call sent `mutating:false` through the pipeline helper.
3. Container delete: deletable-list + empty-only + confirmName + confirmId instead of dependents-on-devices.
4. D0: registration only for `verified-live` bodies, with the test-env escape hatch.
5. Upload: operator staging directory design (6.1) instead of refusing uploads outright; `zip` excluded in W4.
6. Tier C permanent exclusion incl. DELETE of CRT certificates.
7. Client extensions (4.4): bytes upload, empty-body tolerance, per-call timeout.

## 15. Open questions (user or live test must answer; each blocks the named op)

Q1. Request/response bodies of every write except import/upload-init/chunk (rename, preselection, image create/update/addEpm/deleteEpm, generateRules, solve, accept, files/images, files/import). Needs a HAR capture of the UI doing each action ON A TEST CONTAINER (user: please record `MCPTEST-...` actions; redact password before sharing). Blocks all those tools (D0).
Q2. Do `parseIdf`, `verify`, `hasConflicts`, `findConflicts`, `isSelfContained`, `POST .../idf` really not mutate? Live before/after diff on a test container. Blocks A0 registration.
Q3. Does image detail carry the numeric row id needed as lock `itemId` (HAR lock ids 1 and 73 for eliasImage)? Without it image writes are not lockable -> fail closed.
Q4. What does `POST /containers/{id}/files/images` take and do?
Q5. `POST /files/import/{c}`: body, and does it delete archives (ARCHIVE_AUTO_EXTRACT)? Is that configurable per call?
Q6. `POST /images/generate?containerName=`: body, effect, name aliasing (are container names unique?).
Q7. Real container name constraints (length, charset, spaces; existing names like `uc-elux7-2507`).
Q8. Shape of `GET /containers/rights` (global) for the create preflight.
Q9. Does the server refuse DELETE of a non-empty container itself? Do other MCP processes / UI users share a container concurrently (our mutex cannot protect against that)? Is that acceptable?
Q10. Is there a readable "pending package changes" endpoint for the accept snapshot?
Q11. Exact `ui/register` semantics (GET creates a session? returns all of the caller's sessions or the new one? is `EntityID` of ours distinct from the browser's?), heartbeat cadence and server-side expiry, and whether `unregister` drops locks as the source implies. Also whether a Bearer-only `/rest` login token may register a Scoutboard session at all (kind `api` vs `browser`).
Q12. Is restoring an image from a snapshot (PUT/POST with the exported idf) lossless? Live round trip required before we claim "reversible".
Q13. Is chunk PUT idempotent per `x-chunk-index` (re-sending the same index)? Does the server reject out-of-order?
Q14. Which magic/format do `.epm`/`.fpm` have (to sniff), and which tiny valid fixture can the user provide for live tests?
Q15. Overwrite semantics when a file with the same name exists in the container.
Q16. Is there any abort/cleanup for a pending upload and what is its server-side expiry?
Q17. What error indicates an expired direct-to-storage link (`target` renewal)?
Q18. Can a running solve be cancelled server-side? What happens to state when our client aborts?
Q19. Which exact ELIAS right gates each inferred (I) operation (rename, preselection, file delete, accept, package delete)? Live test with a restricted test account would settle it; we have only the all-rights account today.
Q20. Is the test lab (`scout01.tornbloms.net`) acceptable for live write tests inside `MCPTEST-*` only? (User decision; also whether a second, restricted admin account may be created for Q19.)
Q21. CCAUTH/OIDC installs: Bearer-only private calls get 401 (already documented); confirm writes are simply unsupported there (tools fail with the existing hint) — no cookie-forging workaround will be built.

---------------------------------------------------------------------------------------------------

## Summary (15 lines)
1. Scope: Tier A0 read-class POSTs (idf export/parse/verify, solver checks) + Tier A additive/reversible (container create/rename, preselection, image create/update/add/remove package).
2. Tier B (each behind its own off-by-default switch): image/package/file delete, container delete (deletable-list + empty-only), upload, solver, accept; import/generate/images-upload deferred until bodies are known.
3. Tier C excluded permanently and enforced structurally: signing certs, sign, signing-upload-key, trust import/restore, certificate delete (fleet trust = supply chain, sealed-credential protocol, not snapshot-reversible).
4. Everything off by default: `SCOUT_ELIAS_WRITES=off`, allow-list required (no "any container"), protected wins, test-prefix enforced in product code under SCOUT_ENV=test.
5. One mandatory 19-step gate pipeline; refusals before any network read for read-only/kill/breaker/private-write-production; breaker counted once per logical op at G13.
6. Locks via internal `withLock` for image ops; container-level ops use an in-process mutex; no lock tool exists.
7. NEW: server requires a self-registered Scoutboard session for lock/set (register + heartbeat + unregister); never reuse the UI's id 27 (needs Security ruling).
8. Snapshots blocking for every overwrite/delete; container delete and package/file content are NOT restorable and the design says so (hence empty-only, deletable-list, confirmName+confirmId).
9. Uploads: operator-staged directory, basename only, O_NOFOLLOW/fstat/realpath containment, ext allow-list `epm,fpm,idf` (zip excluded), 256 MB cap, 4 MiB chunks, sha256 verified and logged; no model-supplied paths or bytes.
10. Audit: write-ahead intent + result with opId, body hash, outcome `committed|failed|unknown|not-applied` (server audit header is stripped, our log is the only trail).
11. A mutation is sent at most once; timeouts/5xx end in a readback, never a retry.
12. Tests: mock-only for everything destructive; live only in self-created `MCPTEST-*` containers with cleanup sweeper; 48 acceptance tests.
13. Top risk 1: write bodies are unobserved (no ELIAS write in either HAR) -> D0 blocks registration until a live capture exists.
14. Top risk 2: lock semantics/row id/session expiry unknown, and cross-process or human concurrent edits cannot be prevented by our mutex; unknown-outcome after solver/upload timeouts.
15. Top risk 3: supply chain via uploaded packages and the single all-rights account on the test server; mitigated by allow-lists, staging dir, off-by-default switches, and a restricted test account (Q19/Q20).
