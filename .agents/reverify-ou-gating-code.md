# Security re-verification: OU-gating follow-up (uncommitted, feat/ou-gating-followup)

Build: `npx tsc --noEmit` clean. `npm run test:unit`: every suite 0 failed (incl. ou-gating-followup 33/33).

## Finding 1 (target=ou relocation destination dropped into OU refs) - CLOSED
- gateRelocationDestination runs first (before the target=ou sanitize, before dry-run return). It strips every normKey variant of destinationOU (case, separators, NFKC, dots), refuses 0 variants, >1 variants, non-scalar (array/object/empty string). Destination goes through gateOuWrite (fresh tree, protected/allowed/test scope; destination equal to a protected OU or inside one is refused; an ancestor of a protected OU is not a write into it, so allowed).
- Only `destination.ouid` (resolved integer) is sent, re-added after sanitising, for device, devicelist and ou. Numeric id vs path agree because resolution is by fresh tree, not caller text.
- Dry-run: the gate runs before the dry-run return, so a protected destination is refused in dry-run too.
- Tests cover id/path/variant/two variants/non-scalar/unknown/test-scope for device, ou, devicelist.

## Finding 2 (omitted destination) - CLOSED
Refused with "requires destinationOU" while gates active (device/devicelist/ou, set only); delete unaffected; no gate: unchanged (test at line 327-328). ddg relocation refused entirely when gated.

## Finding 3 (devicelist body keys, ddgid) - CLOSED
Allowlists compared to openapi.json (allOf-resolved): command DEVICELIST_KEYS match exactly for all 10 commands; notification DEVICELIST_SET_KEYS match exactly (destinationOU handled separately); DELETE bodies = clientIds only, matching spec. Unknown keys (ddgid, nested OU keys via sanitizeOuBody generic id/path) are refused when gated; clientIds variants collapse to exactly one, rebuilt from server-returned ClientIdentifier. Legit `schedule` object keys (Command, WeekDay, TimeScheduled, ...) do not collide with the OU key regexes.

## Residual / notes (non-blocking)
- Allowlist is exact-case; a caller sending `InformUser` is refused when gated (fail-closed, usability only).
- target=device relocation passes the remaining caller body unfiltered (no OU-ish stripping other than destinationOU); the server schema has no other OU field for that endpoint, so no bypass found.
- Other relocators: device_manage move and workflow move_devices_by_filter are pre-existing and gated (not changed by this diff); command/rule/label/update tools have no relocation parameter.
- schedule_manage update/delete now refused while gated (fail-closed, as designed).

SECURITY: APPROVED
