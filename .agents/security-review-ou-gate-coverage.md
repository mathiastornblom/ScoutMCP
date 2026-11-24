# Security review - fix/ou-gate-coverage (commit 6733096, `git diff origin/main..HEAD`)

Build: `npx tsc --noEmit` clean. `npm run test:unit`: all suites pass (ou-gate-coverage 29/29 etc.).
Test diffs (fix-existing-tools, preflight, protected-ou-wiring) only add OU-tree fixtures / the resolved-path search param; no assertion weakened.
Repros below were run with a throwaway script in the scratchpad (client instance-patched, no network, no src edits).

## Verified OK
- gateOuWrite: all refs resolved from a fresh tree, disagreement refused, canonical resolved path gated, refusals audited (incl. unresolvable/unreadable tree), requiredMessage fails closed on "no OU given".
- Only resolved ids are sent: ou_manage (add/rename/delete/move/converttobase/import), device_manage add/move, onboard_branch, move_devices_by_filter, bulk_command (search by canonical path), device_command (body.ouId/ouPath replaced, ouRef/ouId/ouPath must agree), notification (id only), app_manage, ou_filter OUID, new_device_options DefaultOU, admin root_ou.
- Gate order: mode check (read-only throws) -> resolve/gate -> dry-run return -> preflight -> confirm -> assertOuPathUnchanged -> write. No new mutating path in read-only/dry-run. Kill switch / breaker / audit accounting untouched (resolution GETs are non-mutating). Confirm prompts name resolved path+id (OU names are control-char/"/"-validated by ou_tree.ts, so injection surface is minimal).
- topLevel = `parentId === undefined` on the parsed forest: every forest root is top-level; a limited-view admin can only over-flag (fails closed). No slip found.
- Test scope: canonicalizeOuPath (NFC, trim, case-fold, empty-segment collapse, `..` rejected) + segment-prefix; compared on server-derived paths, so attacker-chosen unicode only reaches the resolver. `/MCP-Test2` correctly outside. Invalid SCOUT_TEST_OU_PATH fails closed.
- ou_filter_manage: z.object strips unknown keys; OUID overwritten with resolved id; modify/delete lookup via GET /oufilter fails closed (non-array, string EntryId/OUID, missing row => audited refusal) whenever a list or SCOUT_ENV=test is active. With no list and not test mode nothing is protected, so skipping the lookup loses nothing.
- structure_import: allow-listed keys only, `dryRun` taken from tool input (not payload), parentOuId must agree with path/id/ouId/ouRef, requires SCOUT_ALLOW_BASE_WRITES before any dry-run return, re-asserts path.
- App request-shape changes (copy/move now need appId + source OU + integer body.targetOu; set_inheritance needs boolean; notification ou sends `id`; ou_filter add needs ou_id): a wrong/missing shape is refused before any call. Residual: see F5.

## Findings

### F1 HIGH (bypass, pre-existing but now claimed closed) - ancestor of a protected OU is never gated
`ou_manage rename|delete|move|converttobase` gate only the target path (same-or-descendant of a protected entry). A non-top-level ancestor of a protected OU passes, and the operation affects the protected subtree (delete removes it; rename/move changes its path so the SCOUT_PROTECTED_OUS entry stops matching).
Repro (SCOUT_MODE=write, SCOUT_PROTECTED_OUS=/NorthCreek/Customers/CLALIT, tree fixture):
`ou_manage {action:'rename', id:8, newname:'Renamed'}` -> `PUT /api/v1/ou?id=8&newname=Renamed` WROTE; `{action:'delete', id:8}` -> `DELETE /api/v1/ou?id=8` WROTE.
Same class: `structure_import` with a non-protected parent that has a protected descendant (arming flag set, payload can overwrite it); `device_manage`/`bulk` are covered per-device.
Fix: after gateOuWrite for rename/delete/move/converttobase (target) and structure_import (parent), call `gateOuSubtree(opName, tgt)` (already exists; also covers SCOUT_ENV=test and ALLOWED lists for sub-OUs). Add tests for all four actions + import.

### F2 MEDIUM - `includeSubOus` honoured only for the literal boolean `true`
command.ts / notification.ts: `body.includeSubOus === true`. `body` is `z.record(z.unknown())` and is forwarded as-is. `includeSubOus: 1` or `"true"` skips gateOuSubtree and is forwarded.
Repro: `device_command {target:'ou', command:'restart', ouRef:'/NorthCreek/Customers', body:{includeSubOus:'true'}}` -> POST sent with `{"includeSubOus":"true","ouId":8}` (also `1`).
Whether the server coerces is unverified; the gate must not depend on it. Fix: gate the subtree whenever `body.includeSubOus !== undefined && !== false`, or normalise to a strict boolean in the forwarded body (and reject non-boolean). Consider also whitelisting body keys (extra OU-ish keys like `ouid`/`OUID` are forwarded for command/notification bodies).

### F3 MEDIUM - config_update target=ou bypasses the shared gate (README claims otherwise)
`src/tools/config.ts:176-186` still uses resolveWriteTarget + checkOuWriteAllowed only: no SCOUT_ENV=test scope, no gateOuWrite audit of resolution failures. README line 149 lists `config_update (target=ou)` under the shared gate and says the test scope is applied, which is false.
Repro: SCOUT_ENV=test, SCOUT_TEST_OU_PATH=/MCP-Test, `config_update {target:'ou', ouPath:'/NorthCreek/Customers', section:'general', body:{}, confirm:true}` -> `POST /api/v1/configuration/ou/general?id=8` WROTE.
Fix: use gateOuWrite there (keep the later assertOuPathUnchanged), or correct the README.

### F4 LOW - device_manage move: SCOUT_ENV=test scope not applied to the SOURCE OU
`device.ts` source path goes through checkOuWriteAllowed only, so in test mode a device can be moved out of a non-test OU into the test OU. Pre-existing; fix with testScopeViolation on sourcePath.

### F5 LOW/INFO - request-shape regression risk (availability, one safety unknown)
- app_manage uses `ouId` (and `appId`) query names; openapi `OuQuery` documents `path`/`id`, and copy/move `copyMove` is undocumented in detail. If the server ignores `ouId` it could default to another scope instead of erroring. Recommend verifying live on 26.11.0 (a negative test that a missing OU param is rejected) and sending the spec name `id`.
- notification/command `ou` operations list both `path` and `id` as required query params in openapi; only `id` is sent. Expect 400 (fails closed) if enforced.
- copy/move from base (no source OU) is now refused: safe, but a functional regression.
- Known, documented residuals (README 156-158): device-level targets (device_command/notification device|devicelist|ddg, device_manage rename/delete), scope=base apps and other global tools are not OU-gated.

## Verdict
F1 is a protected-OU bypass on the core `ou_manage` write path that the new "every OU-scoped write is gated" claim now covers, and F3 contradicts the README gate-coverage statement. Fix F1-F3 (small: gateOuSubtree + strict includeSubOus + gateOuWrite in config.ts), add tests, re-submit.

SECURITY: BLOCKED (F1 ancestor-of-protected-OU rename/delete/move/import bypass; F2 non-boolean includeSubOus skips subtree gate; F3 config_update target=ou lacks SCOUT_ENV=test scope despite README claim)
