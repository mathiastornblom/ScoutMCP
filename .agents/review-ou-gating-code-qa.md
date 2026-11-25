# QA review: feat/ou-gating-followup (uncommitted diff + tests/ou-gating-followup.test.ts)

## Verified
- `npx tsc --noEmit`: clean. `npm run test:unit`: exit 0, every suite 0 failed (ou-gate-coverage 36/36, device-ou-groupid 27/27, single-device-envelope 20/20, new suite 29/29). New test registered last in package.json test:unit.
- Mutation testing (copy in scratchpad/mut, repo untouched): 12 mutations. Caught: ddg refusal removed (command and notification separately), gateSourceOus removed, command recheck removed, claimed-path comparison removed, schedule refusal removed, ClientIdentifier-equality removed, destinationOU gate removed, 100-cap removed, OU-key refusal removed.
  SURVIVED: removing `listGate.recheck()` in notification.ts (no test covers notification recheck).
- No-gate behaviour: tests assert zero lookups/structure fetches/extra GETs and unchanged body for command devicelist/ddg, notification devicelist/ddg, schedule update/delete.
- Gate ordering: mode check first, gates before dry-run return and before confirm prompt, recheck after prompt and right before POST (command, notification). Lookups run in dry-run.
- Design cases + condition 12 extras present: GUID variants, 100/101 cap, mixed protected member, notification set/delete for all types, devicerelocation destination, ddg for all three gate kinds, enriched matching row passes, path/name/own-property/mixed-result cases.
- ddgid deviation: handled safely. Since ddg is refused wholesale whenever a gate is active, the id transport (query `id` vs body) is irrelevant; with gates off nothing changes. devicelist bodies strip `ddgid` and refuse generic `id`/path keys.
- README: known-gaps entries for devicelist/ddg and schedule removed correctly (they are now refused, not ungated); `ou_filter_manage set_settings` and base/global gaps remain. New paragraph matches code (100 cap, GUID, ddg refused, schedule refused, enriched path check).

## Findings (non-blocking)
1. Test gap: notification_manage `recheck()` is not asserted (mutation survives). Add a renamed-OU test for notification devicelist.
2. Weak tests: "mixed row shapes" case in the lookup-failure test swallows the result (`.catch`, expectAudit=false); the generic `id` key notification case uses `.catch` and only checks isError. Cosmetic but vacuous-ish.
3. Usability: refusal text for ddg and devicelist never says how to proceed. Suggest appending "use target=devicelist with explicit clientIds, or target=ou" to the ddg message, and including the offending clientIds index/value hint (GUID format) for the bad-id refusals. Schedule message is good (UI or unset gates).
4. `docs/compatibility.md` / `src/compat/registry.ts` not touched; acceptable since no Scout-version-dependent field is newly relied on (enriched keys are optional), but state that in the PR.
5. Residual (documented design acceptance): single fresh read TOCTOU between lookup and POST; notification recheck is the only guard there.

None of these block merge.

QA: APPROVED
