# Design: OU-gating follow-up (schedule_manage, devicelist/ddg commands, _GroupIDPath cross-check)

Branch feat/ou-gating-followup (base main 78f0703). DESIGN ONLY, no src changes. Awaiting SECURITY review before DEVELOPER starts.

Common rules (unchanged, reused): gates run only through `gateOuWrite` / `gateOuSubtree` / `gateSingleDeviceSource` / `resolveDeviceSourceOus` + `gateSourceOus` (src/safety/ou_gate.ts). Source-OU checks run when `sourceOuChecksActive()` (lists configured or SCOUT_ENV=test, ou_gate.ts:~300), exactly like target=device today; with none active nothing can fire and behaviour is unchanged. Mode tier (`checkMutationAllowed`) stays first; gates run BEFORE the dry-run return and before any confirm prompt; `assertOuPathUnchanged` right before the write; every refusal audited with an existing gate name (`unresolvable-source-ou`, `protected-ou`, `test-scope`). Previously blocked bypasses that must NOT return (security-review-ou-gate-coverage F1-F3, reverify 1-3 F8/F9): ancestor-of-protected OU (use `gateOuSubtree`), non-boolean includeSubOus (use `subOusRequested`, send the normalised boolean), disagreeing refs (all refs through one `gateOuWrite` call), caller body re-targeting (`sanitizeOuBody`, send only resolved id), gate-on-stale-tree (always fresh tree).

---

## 1. schedule_manage (update / delete)

### Current behaviour
- src/tools/schedule.ts:43-70: `update` (POST /api/v1/schedule/update?scheduleId=) and `delete` (DELETE /api/v1/schedule/delete?scheduleId=) call only `checkMutationAllowed`. No OU lookup of any kind. `get_ou` / `get_device` (lines 33-42) are reads, ungated by design.
- The tool has no "add"; schedules are CREATED via command endpoints (`schedule` key in the command body, all of device/devicelist/ou/ddg) which are gated (or the known gap, item 2). The eLux command scheduler (/api/v1/config/advanced/*/eluxcommandscheduler) is config_update territory and already gated there (config.ts), out of scope.

### What openapi.json says about the binding
- `/schedule/update` and `/schedule/delete` take ONLY `scheduleId` (query) (+ body `Schedule` = {schedule:{type,date,daysOfWeek,daysOfMonth}} for update). There is no OU, device or group in the request: the server derives the owner from the job id.
- There is NO get-schedule-by-id endpoint. Jobs are discoverable only through `GET /schedule/ou` (path|ouid, includeSubOus) and `GET /schedule/device` (name|mac|id|clientid). Example rows: `{ScheduleJobID, Receiver (client GUID), TypeString:"Device", RootOU:0, Cmd, schedule:{...}, ...}`. `TypeString` / `RootOU` semantics for OU and DDG jobs are NOT documented (UNVERIFIED; needs one read-only live probe on a dev instance before implementation: list a real OU's schedules and record TypeString/Receiver/RootOU for OU-, devicelist- and ddg-created jobs).
- Consequence: a bare scheduleId cannot be mapped to an OU/device by any documented call. Precise gating from scheduleId alone is IMPOSSIBLE.

### Threat
A schedule job created earlier (a restart/factoryreset/custom command at a future time) targets devices in a protected OU. `update` can re-time or change what runs; `delete` cancels it (e.g. cancelling a security update/maintenance job). With SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS / SCOUT_ENV=test set, an agent restricted to /MCP-Test can still mutate any job on the server by guessing ids (ids are small sequential ints, see example 57).

### Proposed rule (fail closed; only when `sourceOuChecksActive()`)
Require an OWNER SCOPE that the tool can PROVE contains the job, then gate that scope:
1. New optional inputs on update/delete: `ouRef` (name/path/id) with optional `includeSubOus`, OR device identifiers `name|mac|id|clientid`. Exactly one scope kind; both or neither -> refuse ("owner scope required while OU gates are active; schedule ids cannot be mapped to an OU by the API").
2. Scope=OU: `gateOuWrite(opName,[ouRef],'schedule OU',{requiredMessage})`, then ALWAYS `gateOuSubtree(opName, ou)` (conservative: an OU job's reach into sub-OUs is undocumented, so any protected/out-of-scope sub-OU blocks). Read `GET /schedule/ou?ouid=<resolved id>&includeSubOus=false` (send resolved id only, strict boolean).
3. Scope=device: `gateSingleDeviceSource(client, opName, ids)` (returns the device's OU, gated); read `GET /schedule/device` with the same identifiers.
4. Ownership proof: parse `response.status.msg` strictly (must be an array of objects; anything else refuses). Require EXACTLY ONE row whose `ScheduleJobID` equals `scheduleId` under strict integer comparison (string "57", 57.5, negative, NaN, duplicate rows -> refuse). Not listed in the gated scope -> refuse "job not found in the gated scope; cannot prove ownership" (this also blocks devicelist/ddg-created jobs that only other scopes can list).
5. Scope=device additionally: row `Receiver` must equal the resolved device's `ClientIdentifier` (case-insensitive, braces stripped), else refuse (guards a server that returns a broader list).
6. `assertOuPathUnchanged(ou.ouid, ou.path)` before the write (OU scope); send only `scheduleId` (+ body). Body: pass `sanitizeOuBody(body)`; any `ouRefs` -> refuse (a Schedule body carries no OU; openapi `Schedule` schema), drop OU keys otherwise.
7. Gate order: mode -> scope validation -> scope gate -> ownership read -> dry-run return -> assertOuPathUnchanged -> write. The ownership read is a GET, so it is allowed in dry-run (as the other gates' lookups are).

### Alternatives and trade-offs
- A (proposed): owner-scope proof. Precise for jobs created per OU or per device; jobs created via devicelist/ddg are not listable per OU and so are NOT editable while gates are active (safe, slightly restrictive; the user can unset the gates or delete in the Scout UI).
- B (simplest, strictest): refuse update/delete whenever `sourceOuChecksActive()`; `get_*` still work. Zero bypass surface, zero functionality while gates are on.
- C (reject): gate on any device found by walking all schedules. Unbounded reads, still cannot attribute DDG jobs. Rejected.
Recommendation: A, with B as the explicit fallback if the live probe shows `get_ou` rows do not reliably contain jobs created via `command/ou/*` (then ownership cannot be proven and A degrades to B for OU scope). DEVELOPER must not guess TypeString semantics.
- Residual (documented, accept): a job whose row appears in the gated scope list but also fans out to devices outside it (a mixed devicelist job split per receiver) is judged by the scope in which it was listed. Mitigation: for scope=device, only `Receiver === device` rows qualify.

### Test plan (new tests/schedule-gate.test.ts, client instance-patched like ou-gate-coverage.test.ts; fixtures ou-structure-live.json, device-get-live.json (GroupID 10 = /NorthCreek/AD), device-search-live.json, plus a new synthetic tests/fixtures/schedule-live-shape.json built from the openapi example)
No gates active: update/delete behave as before (no extra GETs). Gates active:
1. update, no scope -> refused, audited `protected-ou`, no POST.
2. update scope=OU /MCP-Test, job listed there -> POST sent with scheduleId only; ouId forwarded is the resolved id.
3. SCOUT_ENV=test, SCOUT_TEST_OU_PATH=/MCP-Test, scope=/NorthCreek -> refused `test-scope`, no GET of schedules, no POST.
4. SCOUT_PROTECTED_OUS=/NorthCreek/AD: scope=/NorthCreek (ancestor) -> refused via gateOuSubtree (F1 regression); scope=/NorthCreek/AD -> refused; sibling /NorthCreek/Boot2VDI allowed.
5. includeSubOus bypass: "1", "true", [] , {} (strings/arrays) -> treated as true (subtree gated); we always send includeSubOus=false.
6. scheduleId not in the scope's list -> refused ("cannot prove ownership"), no POST.
7. scheduleId "57", 57.5, -1, NaN, 0/ "" ; duplicate ScheduleJobID rows ; msg not an array ; msg missing ; GET throws/500 -> all refused.
8. scope=device (name from device-get-live, OU 10) with PROTECTED=/NorthCreek/AD -> refused `unresolvable-source-ou`/`protected-ou`; Receiver mismatch -> refused.
9. Both ouRef and device given; ouRef and body.ouId naming another OU (`sanitizeOuBody` ouRefs) -> refused.
10. Unreadable OU tree / unresolved ouRef -> refused + audit line present (assert audit log content).
11. read-only mode -> blocked before any lookup; dry-run -> `{status:'dry_run'}` and no mutating request issued.

---

## 2. command target=devicelist and target=ddg

### Current behaviour
- src/tools/command.ts:79-105: only `target=ou` (gateOuWrite + subtree) and `target=device` (gateSingleDeviceSource) are gated. `devicelist` and `ddg` pass straight to `POST /api/v1/command/{devicelist|ddg}/<cmd>` (line 155) with the caller's raw `body`. Comments at 79/100 call it a known gap. Same gap in notification_manage (notification.ts:53,67): the helper below should be reused there in the same PR (one-line call), listed under scope-creep guard below.

### What openapi.json says
- devicelist: body `DeviceList` = `{clientIds: string[]}` (required) + InformUser/Schedule/command fields; example ids are `"{C30918AE-...}"` (brace-wrapped GUIDs = `ClientIdentifier`). No OU in the request; the server resolves each id to a device wherever it lives. Query: cookie only.
- ddg: query `id` (integer, the dynamic-device-group id) and body InformUser/Schedule/MultiDeviceDelay/command fields. NO member list anywhere in the request. The openapi has NO endpoint to read DDG definitions or members (`grep` of all paths for ddg/dynamic/devicegroup outside /command and /notification: none).
- Device rows expose their direct OU: `GroupID` (integer id), enriched `_GroupIDName`/`_GroupIDPath` (enricher.ts:81-87), single-device `OUID`.

### Threat
- devicelist: any protected/out-of-scope device can be commanded by listing its clientId (restart/halt/factoryreset/custom command = arbitrary command execution). Also: id-format tricks ("{GUID}" vs "guid", case) to make the server match a device the gate did not look up; extra OU-ish body keys.
- ddg: a DDG is a server-side filter; its members can be anywhere, including protected OUs. The tool cannot enumerate them.

### Proposed change
**devicelist** (new `gateDeviceListSources(client, opName, clientIds)` in ou_gate.ts, built from existing pieces; only when `sourceOuChecksActive()`):
1. `body.clientIds` must be a non-empty array of non-empty strings, max N=100 (else refuse; blast-radius also bounded by existing `blast` helper when present). Normalise each id (trim, strip surrounding braces, lower-case); reject ids that do not match a GUID pattern; de-duplicate.
2. For each id, `GET /api/v1/device?clientid=<id>`, `parseSingleDevice` (exactly one row, zero hidden/pending/denied), and REQUIRE the returned row's `ClientIdentifier` to equal the requested id after the same normalisation (defends against server fuzzy matching returning a different device). Concurrency 5. Any miss/failure/mismatch refuses the WHOLE command (no partial send, audit `unresolvable-source-ou`).
3. Collect each row's OU id with `readDeviceOuId` (so item 3 cross-check applies), then ONE `resolveOuIdsFresh(allIds)` and `gateSourceOus` (each distinct source OU: test-scope + protected/allowed). Blast radius = number of distinct devices and distinct OUs, included in the audit detail.
4. Send a canonical body: `clientIds` = the server-returned `ClientIdentifier` values of the verified rows (original brace style preserved from the server row); other keys via `sanitizeOuBody(raw,{generic:true})`: any collected `ouRefs` -> refuse (devicelist has no OU), OU keys dropped. (Generic id/path strip may false-refuse nested legit ids; accepted, fail closed, see reverify-3 F12.)
5. The lookup is read-only so it runs in dry-run too; the actual POST only after `assertOuPathUnchanged` is NOT applicable (no single OU); instead re-run step 3's `resolveOuIdsFresh` is not needed twice: the lookup occurs after any confirm prompt would be wrong, so order is: gates -> confirm (names "N devices in OUs ...") -> POST. TOCTOU window (device moved between lookup and POST) is bounded by the single fresh read; documented residual, same as target=device.

**ddg**: cannot be resolved -> FAIL CLOSED. When `sourceOuChecksActive()`, `target=ddg` is refused (audit gate `unresolvable-source-ou`, detail "dynamic device group membership cannot be enumerated via the API"), no override flag. When no gate is active, behaviour is unchanged. Also validate `ddgId`/query when inactive? Out of scope (unchanged). Trade-off: users with gates on lose ddg commands; they can send per-OU or devicelist instead. An opt-in `SCOUT_ALLOW_UNGATED_DDG=true` is deliberately NOT proposed; SECURITY may veto or add.
New input for ddg is not needed (current schema has no ddg id field; the id travels in `body`/qs as today, so also confirm: today `qs` for ddg is ''; the ddg id must be in `body.id` - ungated and, per the sanitizer, `id` is OU-ish; check live whether ddg calls work at all, UNVERIFIED, noted for DEVELOPER, the refusal makes this moot while gates are active).

### Test plan (extend tests/ou-gate-coverage.test.ts or new tests/devicelist-gate.test.ts; fixtures device-search-live.json (ids ...0001 GroupID 10 /NorthCreek/AD, ...0002 GroupID 11, ...0003 GroupID 16), device-get-live.json, ou-structure-live.json)
1. Gates inactive: devicelist/ddg unchanged, no lookups.
2. PROTECTED=/NorthCreek/AD, clientIds=[...0002] (OU 11) -> allowed; [...0002,...0001] -> refused (one protected member), NO POST, no partial send.
3. SCOUT_ENV=test, TEST_OU=/NorthCreek/AD: [...0001] ok; [...0001,...0003] refused `test-scope`.
4. Id format: "{...0001}" vs "...0001" vs UPPERCASE all normalise to the same device and are gated identically (protected OU still refused); body forwarded carries the server's ClientIdentifier, not the caller string.
5. Unknown clientId (lookup 404 / zero rows); two rows; hidden/pending>0; row whose ClientIdentifier differs from the requested id; row without GroupID/OUID; GroupID "10" (string), 10.5, -1; GroupID not in fresh tree; lookup throws -> all refused with audit line.
6. Empty clientIds, missing, non-array, array of numbers/objects/empty strings, 101 ids, non-GUID strings -> refused.
7. Duplicate ids de-duplicated (one lookup each, one POST).
8. Body smuggling: `ouId:9`, `OU_Path:"/NorthCreek/AD"`, nested `{x:{ouid:11}}`, `groupId` in a devicelist body -> refused (ouRefs non-empty); `includeSubOus:true` dropped/ignored.
9. ddg with gates on (each of lists-only, test-only) -> refused, no POST; gates off -> passes as before.
10. read-only blocked before lookups; dry-run: lookups done, returns dry_run, no POST.
11. Blast: 100 ids in 100 OUs all allowed -> 100 lookups (mock counter) and one `resolveOuIdsFresh`.

---

## 3. Defense in depth: `_GroupIDPath` vs fresh tree

### Current behaviour
- src/devices.ts `readDeviceOuId` (~l.147) / `readDeviceOuIds` (~l.171) validate only the VALUE of OUID/ouId/OuId/GroupID (non-negative integer, agreeing keys); `resolveDeviceSourceOus` (ou_gate.ts:~253) then maps ids through `resolveOuIdsFresh` (fresh tree). Enriched fields `_GroupIDName` / `_GroupIDPath` (and `_OUIDName/_OUIDPath`, enricher.ts:81-97) are ignored. Today gate paths consume RAW rows (client.request in gateSingleDeviceSource; workflow.ts:103/383/593), so enriched rows never reach them. config_resolve.ts:217 also calls `readDeviceOuId`.
- Threat/value: if a row ever arrives enriched (future refactor passing tool output into a gate, a replayed/hand-built record, or a server that echoes path keys), a record whose `GroupID` says a harmless OU but whose `_GroupIDPath` names a protected one (or vice versa after an out-of-band move: enrichment uses a <=5 min cache) is an inconsistent record and must not be trusted. Absent keys are normal (all current servers).

### Proposed change
- devices.ts (pure, no resolver import, avoids the ou_gate<->devices cycle): `readDeviceOuId` returns `{ok:true, id, claimedPath?: string}` additionally. New logic: for each of `_GroupIDPath` (pairs with GroupID) and `_OUIDPath` / `_ouIdPath` / `_OuIdPath` (pair with the same-named id key) that is PRESENT (own property, not undefined): must be a non-empty string, `canonicalizeOuPath` (from src/ou_path.ts) must succeed, and if several claimed paths are present they must canonicalize identically; otherwise `{ok:false, reason}`. A path key present without its id key refuses. `_GroupIDName` / `_OUIDName`, if present, must equal (case-insensitive) the last segment of the claimed path, else refuse. `readDeviceOuIds` propagates `claimedPaths: (string|undefined)[]` (same order); the row-shape signature (`ouIdShape`) is NOT extended (absent allowed; no new mixed-shape refusals).
- ou_gate.ts `resolveDeviceSourceOus` (the ONLY place the fresh-tree comparison lives, since it already calls `resolveOuIdsFresh(ids)` and holds the matches): after resolving, for every row with a `claimedPath`, require `canonicalizeOuPath(match.path) === claimedPath`; mismatch -> `refuse('row N: _GroupIDPath "<claimed>" disagrees with the fresh OU tree path "<match.path>" for id <id>')` (existing `refuse` => audit `unresolvable-source-ou`, GuardrailError). No other call site changes. `config_resolve.ts:217` benefits implicitly only for the value check; it must not need the tree (no behaviour change besides refusing malformed path keys).
- Consequence accepted: a legitimately enriched row right after an OU rename/move (stale enrichment cache) is refused with a retry hint; fail closed is the point.

### Test plan (tests/devices-ou-claims.test.ts, pure unit + one gate-level case; fixtures device-search-live.json rows, ou-structure-live.json)
1. Row GroupID 10 with `_GroupIDPath:"/NorthCreek/AD"` -> accepted; case/space/slash variants ("/northcreek/ad/", " /NORTHCREEK//AD") -> accepted (canonical equal).
2. `_GroupIDPath:"/NorthCreek/Browser"` for GroupID 10 -> refused at resolveDeviceSourceOus (fresh-tree mismatch), audit line present; mirrored: GroupID 13 with path of 10 -> refused.
3. `_GroupIDPath` present but GroupID absent / OUID only -> refused.
4. `_GroupIDPath` non-string (number, array, null, ""), containing "..", ".", control chars -> refused.
5. `_GroupIDName` "Browser" with path ".../AD" -> refused; matching name -> ok.
6. Enriched single-device record (OUID + `_OUIDPath`) matching/mismatching.
7. Absent path keys (all existing fixtures) -> behaviour identical; existing suites (ou-gate-coverage 36/36, others) unchanged.
8. Mixed result: some rows with path, some without -> no shape refusal; the row with a wrong path is refused for the whole result (workflow bulk path via `resolveDeviceSourceOus`).
9. Prototype/own-property: path set via inherited prototype ignored; `_GroupIDPath: undefined` treated as absent.
10. Path says protected OU but id is unprotected (and vice versa) -> refused in both directions.

---

## Out of scope (explicit)
- Resolving DDG membership (no API); ddg stays refuse-when-gated, not gated precisely.
- Editing/creating eLux command scheduler jobs (config_update, already gated) and "schedule add" (tool has none).
- Whitelisting forwarded body keys per command type (reverify-3 F11 residual; separate hardening).
- Fixing the pre-existing single-read TOCTOU between lookup and mutate beyond `assertOuPathUnchanged` / one fresh read.
- Gating `get_*` reads, enrichment/caching behaviour, ELIAS writes, locks, signing, Citrix Cloud auth.
- notification_manage devicelist/ddg: same helper reused ONLY if SECURITY agrees; otherwise tracked as a separate item (README known-gap text updated either way).
- Any live-server access during design; the two UNVERIFIED facts (schedule row TypeString/RootOU semantics, ddg id transport) need a read-only dev-instance probe before DEVELOPER starts item 1.

## Process / definition of done
README gate-coverage + known-gaps text and `docs/compatibility.md` row updated in the same PR; `src/compat/registry.ts` entry only if a Scout-version-dependent field (`_GroupIDPath`, ScheduleJobID shape) is relied on. Reviews: SECURITY on this design first, QA PR file `.agents/pr-*.md`, SECURITY final.
