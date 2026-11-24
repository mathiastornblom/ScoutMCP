# Security review: OU tree parser rewrite (fix/ou-tree-parser)

Result: `SECURITY: BLOCKED` (F1, F2). tsc clean, unit suite green (ou-tree 29/29) at review time.

## What holds up
- src/ou_tree.ts fails closed: throws on missing envelope level, empty forest, non-integer/duplicate OUID, blank Name, '/' in Name, non-array children, depth > 64, > 100k nodes. Nested JSON cannot cycle; Map avoids prototype-pollution keys.
- Resolver fails closed: getOuChain / collectOuSubtree / countDevicesUnderOu throw (no one-element chain, no empty list). Same-name OUs at different depths and siblings differing only by case throw an ambiguity error. Unicode lookalikes do not match.
- countDevicesUnderOu reads a fresh uncached tree; throws on missing node/count; caller config.ts:209 does not catch, so the write is refused.
- Cache invalidated after non-export ou_manage (ou.ts:427).
- Tests not weakened: protected-ou-wiring / preflight-wiring only changed fixtures to the real envelope; new "tree unreadable: refused, no write" test is an improvement.

## Findings
F1 HIGH (verified): protected-OU path match is case/whitespace/slash sensitive and raw user paths reach it. guardrails.ts:433-447 (normalizeOuPath / isSameOrDescendant) uses === / startsWith. Gates fed by the resolver (canonical path) are safe, but these get raw strings: ou.ts:217 (input.path), ou.ts:226 (destoupath), device.ts:337-340 (destoupath), workflow.ts:372 (input.destOuPath). Repro with SCOUT_PROTECTED_OUS=/NorthCreek/Customers: '/northcreek/customers', '/NorthCreek/Customers ' and '/NorthCreek//Customers' all ALLOWED. A case typo in the env var protects nothing. Fix: compare a canonical form (trim, collapse '//', strip trailing '/', case-fold, reject '.'/'..') and/or resolve every raw path through resolveOuRef and gate on the canonical result.

F2 HIGH (on main, not introduced by diff): device_manage(move) source-OU check fails open. device.ts:35-52 resolveCurrentDeviceOuPath returns undefined when data['OUID'] is not a number (data is the raw envelope, so basically always) and wraps everything in catch { return undefined }; caller device.ts:379 only runs checkOuWriteAllowed when it got a path. Same "unparseable means not protected" pattern as the earlier BLOCKED round. Fix: throw GuardrailError on missing OUID / parse failure / resolve failure.

F2b LOW: bulk move_devices_by_filter does fail closed (workflow.ts:94-103 throws unresolvable-source-ou when rows lack OUID/ouId/OuId); live rows carry GroupID, so tool is safe but unusable. Do not map GroupID to OUID without live proof they are the same value.

F3 MEDIUM: gated path can come from the 5-minute resolver cache. Out-of-band rename/move, or ou_manage throwing before invalidateOuCache() (success path only), lets the gate judge a stale path; config.ts:209 counts from a fresh tree by id without checking the fresh path equals the gated path. Fix: resolve against an uncached tree for write gates, invalidate in finally, compare fresh path to gated path.

F4 MEDIUM: blast radius can undercount; count and write are not atomic. Cumulative DeviceCount confirmed on one fixture only; unknown whether it includes hidden/pending devices (device search reports hiddenDevices separately). Parser falls back to `count` when DeviceCount is absent (ou_tree.ts:100), undocumented. Document as residual risk; validate against a live manual search.

F5 LOW: server strings not sanitised: control chars/newlines/ANSI pass parseOuTree; leading/trailing whitespace allowed ("Customers " != protected "/.../Customers"). Paths are interpolated into confirmation prompts/errors (spoofed prompt). Fix: reject control chars and leading/trailing whitespace in parseOuTree.

F6 LOW (on main): resolveOuRef coerces with Number(): "0x10", "1e1", "010" resolve to OUIDs 16, 10, 10. Use /^\d+$/.

F7 INFO: resources.ts swallowing tree errors is acceptable (read-only listing); catch at ou.ts:325 is the ourights UX aid after all gates; parser does not assert status.result === 0 (consider adding).
