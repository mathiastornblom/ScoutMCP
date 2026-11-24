# Review - fix/single-device-envelope (7f85640, 417eb43, ee96f8e) - Security + QA
Build: `npx tsc --noEmit` clean. `npm run test:unit` exit 0, about 522 assertions passed / 0 failed over all suites (single-device-envelope 20/20). No src edits, no repo test edits. Probe script: scratchpad/probe.ts (parseSingleDevice on 25 shapes).

## 1. Refuse-on-unexpected (parseSingleDevice, src/devices.ts:143-155; parseSearchDevices :89-137)
REFUSED+audited (via gateSingleDeviceSource ou_gate.ts:311-318): zero rows, 2 rows, hidden/pending/denied count >0, negative, float, string "0", null, list-vs-int mix with rows, msg null, nested response.response, response null/string, top-level array/null, non-object row.
Accepted (all benign, fail later or correct): live shape; msg as 1-element array; empty hidden list [].
- F1 LOW residual: unknown extra count keys inside msg (e.g. `unmanagedDevices:5`) are ignored (probe unknownCountKey -> OK). Only the three known keys are policed. Suggest: refuse any other numeric/array sibling of visibleDevices (allow lastDeviceId explicitly).
- F2 LOW residual: "flat" branch (devices.ts:150) accepts ANY object lacking a `response` key (`{}`, `{status:{msg:{visibleDevices:[a,b]}}}`). Downstream readDeviceOuId requires top-level OUID/GroupID so these refuse in gateSingleDeviceSource (verified by reading readDeviceOuId); a flat object carrying a top-level GroupID plus a nested multi-device list would pass, but needs a server shape never seen. config_resolve: same (then OUPath/readDeviceOuId). Accept; tighten by refusing flat objects that contain visibleDevices/status/msg keys.
No lenient parse left on gate paths: move_devices_by_filter / bulk_command both use extractDevicesOrThrow (strict, now unlisted>0 refuses), per-OU.

## 2. Single-device lookup ambiguity
- F3 MEDIUM residual (pre-existing, not worsened here; NON-BLOCKING): name/mac/id/clientid are all optional and forwarded identically to GET (gate) and PUT/DELETE/command (write) (device.ts:324-370, command.ts:102, notification.ts:69). Exactly one row is required, but the returned row is never compared to the identifiers supplied. If the server's GET and write endpoints resolve disagreeing identifiers differently (AND vs priority; LIKE vs exact for `name` with `%`/`_`), gate may judge device A while write hits B. Recommend: refuse when more than one identifier is supplied, or verify row.Name/Mac_Address/DeviceID/ClientIdentifier equals each supplied identifier (exact, case-insensitive for name/mac), and refuse `%`/`_`/`*` in `name`. Not live-testable here.
- F4 MEDIUM residual (pre-existing): bulk tools write by `name` from search rows (workflow.ts move ~L395, bulk ~L645). Two merged rows with the same Name, or a same-named device outside the searched OUs (protected), are both "gated" by their own rows yet the write resolves by name only. No duplicate-Name guard in the merged list. Recommend refuse when merged Names (case-insensitive) are not unique, ideally with a per-device GET exactly-one check before write.

## 3. Bulk fan-out (searchDevicesAcrossOus, workflow.ts:~115-146)
- Written set == gated set == merged de-duplicated list: verified (same `devices` array to gate, preview, prompt, blast radius, loop). Devices missed by the per-OU `limit` (default 100) are neither gated nor written: safe direction.
- F5 LOW QA: when an OU returns exactly `limit` rows the result is silently truncated (no `truncated` flag); `matched` understated. Suggest warn when rows.length === limit.
- Dedup key DeviceID ?? ClientIdentifier ?? JSON: collapse only drops a row from BOTH gate and write (safe); a device cannot evade the gate by dedup. Object-valued DeviceID collapses all such rows to "[object Object]" (safe, odd).
- 500 cap: refuses (audited) after merge; limit schema max 500 so single OU cannot exceed. OK.
- Fan-out uses a fresh tree (collectOuSubtree/fetchOuTree); bulk_command additionally runs gateOuSubtree first (second tree read: tiny TOCTOU, then per-device GroupID gate covers it).
- F6 LOW residual (pre-existing): TOCTOU after the gate: assertOuPathUnchanged covers only the dest (move) / source ROOT (bulk) path, not each device's current OU; no re-check of a device's OU before its mutating call. Accept (previously approved model); recommend noting in README.
- includeSubOus: still normalised by subOusRequested (undefined/false only = off) and now never forwarded to the server; no recursion by the server assumed.

## 4. searchFields / searchTerm
- searchFields regex `^[A-Za-z_][A-Za-z0-9_,]*$`, passed through buildQuery (encodeURIComponent on key and value): `&`, `=`, newline, `#`, spaces cannot inject params (also true for searchTerm, ouPath). Zod rejects before any call. Trailing/double commas allowed (server 400, harmless). F7 INFO: any column may be searched (Mac_Address, GroupID); harmless (read).
- `*`->`%` replaces all occurrences; caller-supplied `%` or `_` pass through as LIKE wildcards, so `%` matches everything. Acceptable: gate runs on every matched row, blast-radius cap and confirm still apply.

## 5. Gate order
move_devices_by_filter: read-only mode throw -> gateOuWrite(dest, protected) -> gateOuWrite(src, skipProtectedCheck, test-scope on canonical path) -> search -> gateSourceOus(resolveDeviceSourceOus) -> dry-run preview -> confirm/elicitation -> blast radius -> mode dry-run notice -> assertOuPathUnchanged(dest) -> PUT. Correct.
bulk_command: mode -> sanitise body -> gateOuWrite(src incl. protected) -> gateOuSubtree (includeSubOus) -> search -> per-device gate (only if sourceOuChecksActive) -> preview -> confirm -> blast -> assertOuPathUnchanged(src root) -> POST. Correct; SCOUT_MODE=dry-run reaches the gate before the dry-run notice (test asserts refusal). 
Judgement on not blanket-gating the move subtree: ACCEPTABLE. Matched device in a protected descendant -> its GroupID resolves against fresh tree -> checkOuWriteAllowed (protected incl. descendants) refuses the whole call (test "fan-out protected descendant"). A protected OU with no matched rows writes nothing, so ignoring it is safe; a row whose GroupID differs from the searched OU is still gated by its own GroupID. Missing/invalid GroupID refuses (resolveDeviceSourceOus unconditional, even with no lists: stricter than before for move; fail-closed).
SCOUT_ENV=test scope now applies to move sources via gateSourceOus (testScopeViolation): stricter, no regression found (existing suites green).
Tests really assert the ordering: refused-source tests check isError + /protected/ message, prompts.length===0 (mock elicitInput records prompts), writes empty; allowed source still previews/prompts. Adequate. F8 INFO: resolveDistinctSourceOuPathsOrThrow (workflow.ts) is now unused dead code.

## 6. config_resolve device branch
parseSingleDevice then OUPath/readDeviceOuId + resolveOuRef: live envelope row (GroupID) resolves; flat record with OUPath still works; ambiguity (0/2 rows, counts) now throws a clear error. No regression for normal devices. No dedicated config_resolve test in the new file (comment only): F9 LOW QA gap.

## 7. Tests
Diff of tests is additions only (new test file + synthetic fixture tests/fixtures/device-get-live.json, documentation IPs/MACs, zero GUID). No assertion weakened; test:unit script appended only.

## Verdict
No BLOCKING findings. Residual: F3, F4 (MEDIUM, pre-existing identifier-to-write ambiguity; recommend follow-up), F1, F2, F5, F6, F9 (LOW), F7, F8 (INFO).

SECURITY: APPROVED
QA: APPROVED
