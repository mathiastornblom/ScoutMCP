# Review: fix/device-ou-groupid (e5240bd + 0378cef) - Security + QA

Verification: `npx tsc --noEmit` clean. `npm run test:unit` all suites 0 failed (device-ou-groupid 27/27; ou-gate-hardening 36, ou-gate-coverage 42/other suites all pass). No tests added by reviewer.

## (1) Fail-closed - OK
- readDeviceOuId (src/devices.ts): present keys OUID/ouId/OuId/GroupID must be non-negative integer numbers and agree; string/float/negative/NaN/null/bool refused. readDeviceOuIds refuses mixed row shapes and any bad row (every row checked, not just first).
- resolveDeviceSourceOus (src/safety/ou_gate.ts:~253) audits + throws unresolvable-source-ou on any read failure or id not in a FRESH tree (resolveOuIdsFresh invalidates cache, all-or-nothing). Tree unreadable -> loadCache throws -> refused via the catch (catch refuses, does not swallow).
- parseSearchDevices refuses unknown/mixed shapes; msg object without visibleDevices refused; non-object rows refused. Remaining lenient use: extractSearchDevices only in device_get config fan-out (src/tools/device.ts:136) - a READ path, not a gate. No `|| []` on any gate path.
- gateSingleDeviceSource: array/envelope/no-record -> `{}` -> refused. Duplicate-id rows OK (deduped after reading).

## (2) Many rows / limit - OK
Every row is read; ids deduped then gated. Rows beyond `limit` (default 100, max 500) or hiddenDevices are never listed and so are never written (bulk loops iterate only the gated list) - no gate skip.

## (3) Conditional gating - acceptable (residual R3)
device_command/notification_manage target=device, rename/delete, bulk_command per-device check run only when sourceOuChecksActive() (lists configured or SCOUT_ENV=test). With neither active, checkOuWriteAllowed/testScopeViolation cannot fire, so nothing relevant is skipped; env is read per call so it cannot be bypassed by the caller. move is unconditional (source id must resolve even with no lists) - consistent with prior behaviour. Recommendation: keep conditional (avoids an extra GET and breaking unresolvable-but-harmless writes); revisit if audit-completeness is wanted.
- bulk_command strict parse is unconditional and only changes unparseable responses (refuse instead of "0 matched"); normal OU-targeted use with live list shape unaffected (tested).

## (4) TOCTOU - residual R1 (LOW/MEDIUM, non-blocking)
Source OU is not re-asserted immediately before the write for single-device ops (GET then PUT, short window) nor per batch in move_devices_by_filter/bulk_command (only the destination/root path is re-asserted via assertOuPathUnchanged). A device moved by someone else into a protected OU after the gate (esp. during the confirmation prompt on up to 500 devices) is not caught. Suggest per-batch re-read of source ids or document the gap.

## (6) Identifier fidelity - residual R2 (MEDIUM, non-blocking)
- Single device: GET and PUT/DELETE use the identical identifier set (name/mac/id/clientid) so server resolution is the same; wildcard/ambiguous match returns a list -> refused. Suggest also asserting the returned record's Name/Mac/DeviceID equals the supplied identifier.
- Bulk: gate uses the row's OU but the write addresses by `name` only (workflow.ts move/bulk loops), not DeviceID/ClientIdentifier. If device names are not unique per server, the written device could differ from the gated one. Suggest writing by id/clientid from the gated row.
- Also: move_devices_by_filter applies checkOuWriteAllowed to source OUs only (no testScopeViolation per source, unlike gateSourceOus). Covered in practice because the search root is test-scope gated and sources are within its subtree; consider using gateSourceOus there for consistency (R4, LOW).

## (7) Enricher - OK/low
_GroupIDName/_GroupIDPath only for integer GroupID on rows with DeviceID/ClientIdentifier; strings come from the OU tree exactly like existing _ouName/_ouPath (same trust level, no new class of injection). No length/control-char cap (pre-existing, LOW).

## (8) Changed assertions - legitimate
ou-gate-hardening: the old "GroupID-only => refuse" case is replaced by three refusals (GroupID not in tree, string GroupID, no id field); no safety assertion removed. ou-gate-coverage: n<=4 -> n<=5 accounts for the one new fresh-tree read; the abort-per-batch semantics are still asserted.

## (9) Fixture hygiene - OK
tests/fixtures/device-search-live.json: IPs in 192.0.2.0/24 (TEST-NET-1), locally-administered MACs 02:00:..., all-zero synthetic UUIDs, names synth-*. No real identifiers; grep of the test file found no real MAC/UUID.

## Other QA notes
- Single-device GET /api/v1/device shape (flat record with OUID/GroupID) is not live-verified; if the server wraps the record or omits both keys, move/rename/delete under active lists are refused (safe, but may be functionally dead). Recommend one live check.
- bulk/move return `matched 0` for an empty list `[]`; fine.

## Findings summary
BLOCKING: none.
Residual: R1 TOCTOU on source OU; R2 name-only addressing in bulk writes; R3 conditional gating (accepted); R4 move_devices_by_filter source test-scope.

SECURITY: APPROVED
QA: APPROVED
