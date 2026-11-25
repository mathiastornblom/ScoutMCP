# Security code review: OU-gating follow-up (uncommitted, branch feat/ou-gating-followup)

Scope: git diff HEAD (devices.ts, safety/ou_gate.ts, tools/command.ts, notification.ts, schedule.ts, README, package.json) + tests/ou-gating-followup.test.ts, against .agents/design-ou-gating-followup.md and the 12 conditions in design-review-ou-gating-followup.md. Static review; no live access, no repo edits.
Build: `npx tsc --noEmit` clean. `npm run test:unit` all suites pass (followup suite 29 passed, 0 failed).

## Attack results (all held)
- devicelist id normalisation: trim + one brace pair + lowercase + strict ASCII GUID regex. Embedded whitespace/NUL/unicode/double braces/unbalanced braces rejected (regex fails after strip). Duplicates collapse on normalised form. Lookup uses the trimmed caller string, but the result is accepted only if normalised server ClientIdentifier equals the normalised request, exactly one visible row (parseSingleDevice rejects hidden/pending/denied/multi). Cap 100 applies before de-dup (stricter, fine).
- Body re-forwarding: every top-level key with normKey in {clientids, ddgid} is stripped (any case/separator/NFKC variant); >1 clientIds variant refuses; clientIds is rebuilt ONLY from server-returned ClientIdentifier values. OU-ish keys (id, path, ouId, destinationOU variants, includeSubOus, any depth) refuse via sanitizeOuBody(generic).
- notification_manage: set/delete both gated; devicelist lookup runs before mode-dry-run return; destinationOU (any variant) removed, gated through gateOuWrite, replaced by the resolved numeric id; non-relocation types carrying destinationOU refuse via ouRefs; multiple variants refuse; ddg refused (incl. ddgid in body or query since no path reaches the server).
- command: ddg refused after the mode check and before the dry-run return and any prompt; devicelist gate covers every command (schedule key, update, updateuefi, custom). Only routes to devices are device_command, notification_manage, workflow/bulk_command (per-device gated, per earlier reviews). No other /command/ or /notification/ callers in src (grep).
- Lookup failure: every GET error/shape/mismatch/ambiguity -> audited refuse, no POST. resolveOuIdsFresh failure refuses. No fail-open found. Mixed row shapes refused by readDeviceOuIds.
- recheck: runs after any confirm prompt and immediately before the POST; compares id->path from a fresh tree; mismatch/error refuses.
- schedule_manage option B: update and delete both refuse while sourceOuChecksActive(), after the mode check, before the dry-run return, audited, no extra GETs. Tool has no add action; no other tool calls /schedule/* or /config/advanced/*/eluxcommandscheduler (grep), so no alternate path. Gate-inactive path unchanged.
- _GroupIDPath: own-property + undefined-as-absent; path without id key, name without path, non-string/empty/invalid path, disagreeing claims, name != last segment all refuse; comparison against the FRESH tree path after canonicalisation (case/trailing slash); never falls back to the claimed path (id always from the integer key). Mixed rows with/without path fine; one bad row refuses all.
- No gate active: devicelist/ddg/schedule branches are guarded by sourceOuChecksActive(); no extra requests. F1-F14 paths untouched.

## Findings (none blocking)

1. MEDIUM (pre-existing, not a regression) - src/tools/notification.ts:~53-77 (target=device) and src/tools/command.ts target=device.
   notification_manage target=device type=devicerelocation forwards `input.body` unsanitised, so `body.destinationOU` is never passed to gateOuWrite. With SCOUT_PROTECTED_OU/ALLOWED lists active, a device from an allowed OU can be relocated INTO a protected (or non-allowed) OU. Repro: gates active, target=device, type=devicerelocation, body {destinationOU:"/Protected"} -> POST sent, only source OU gated. The new code correctly gates destination for devicelist, which makes the device-target omission inconsistent. Fix: apply the same destinationOU extraction + gateOuWrite + replace-with-id block to target=device (same helper), and sanitise other OU keys (generic) in the device body.

2. LOW - src/tools/notification.ts:~83-99. For devicelist devicerelocation the API moves devices to the DEFAULT OU when destinationOU is omitted (RelocationInformation spec). With SCOUT_ALLOWED_OUS active this lands devices outside the allow-list, ungated. Fix: when gates are active and type=devicerelocation, require destinationOU (refuse if absent) for devicelist (and device, per finding 1).

3. LOW - src/safety/ou_gate.ts:~416-421. Only TOP-LEVEL clientIds/ddgid keys are stripped; the rest of the caller body is forwarded after OU-key sanitising. A nested `schedule.clientIds` or other device-selector-like top-level keys (e.g. `devices`, `ids`, `macs`) would pass through. Not exploitable per openapi (DeviceList schema = clientIds only; Schedule has no selectors), but it relies on the server ignoring unknown keys. Fix: for devicelist forward only an allowlist of spec-known keys per command/notification type, or recursively strip normKey in {clientids, ddgid, deviceids, macs, names, ids}.

4. LOW (documented residual) - recheck() verifies the source OU id->path mapping, not that each device is still in that OU. A device moved between lookup and POST (or a prompt delay) is not re-detected. Bounded TOCTOU, consistent with condition 6 as written; for factoryreset/halt a second per-id lookup pass right before the POST would close it. Document in README/design.

5. INFO - README updated and package.json test chain includes the new suite; docs/compatibility.md and src/compat/registry.ts were not touched. Per CLAUDE.md Definition of Done, confirm no new Scout-version-dependent function was added (none seen: gates use existing endpoints).

## Verdict
No bypass of the stated conditions 1-12 found; all earlier blocks (F1-F14, ou-gate-coverage reverifies) remain closed. Findings 1-2 are real destination-gate gaps adjacent to the new code and should be fixed in this or an immediately following PR; they are not regressions and do not defeat the devicelist/ddg/schedule gating that this change delivers.

SECURITY: APPROVED
