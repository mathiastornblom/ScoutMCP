# Re-verification 2 - fix/ou-gate-coverage @95dfdad (Security + QA)
Build: tsc --noEmit clean. npm run test:unit exit 0, all suites 0 failed (ou-gate-coverage 36 passed / 0 failed; others 7-46 each). No existing assertion changed (tests diff is additions only; README one paragraph edited). Throwaway key-variant script run in scratchpad (not in repo).

## F6 - body-key stripping: CLOSED for case/space/_/- variants
stripOuBodyKeys/bodyValuesFor/bodySubOusRequested (ou_gate.ts:159-180) used in device_command(target=ou), notification_manage(target=ou), bulk_command commandBody. Verified: ouId/OUID/OU_ID/' ouId'/'ouId '/'ou id'/ID/Id/OU/Path/includeSubOUs stripped; any case/_/-/space variant of includeSubOus counts as requested (subtree gate runs; tested refused); disagreeing ouid/ouPath key vs ouRef refused; nested {ou:{id:9}} removed (key 'ou'); sent body = stripped + canonical ouId + normalised boolean. JSON-string values and non-string coercions are never interpreted (ids typeof-checked, includeSubOus strict).
Survivors (denylist gaps, not matched by case-insensitive server binders; LOW, F9): '\touId', zero-width/NBSP/fullwidth lookalikes, 'ou.id', 'ou[id]', 'ouIds', 'ous', 'parentOuId', 'sourceOuId', 'targetOUId', 'organizationalUnit', 'ou_guid', 'includeSubOus​'. Only exploitable if the server fuzzy-matches those names. Recommended hardening: whitelist forwarded body keys, or also strip /\s|[​-‏﻿]/ and NFKC-normalise, and drop keys matching /ou/i-ish names. __proto__ is own-key safe (JSON.parse own property; Object.fromEntries keeps it as own data prop, harmless).

## F8 MEDIUM (blocking for consistency with F6) - app_manage create scope=ou forwards raw body next to gated OU
src/tools/application.ts ~80-83: POST /api/v1/applications/ou/<type>?id=<gated> with `input.body` unsanitised. Repro: app_manage {action:'create', scope:'ou', ouId:17 (allowed), applicationType:'citrix', body:{ouId:9, OU:9, includeSubOus:true}} -> body sent verbatim; if the server honours a body OU key, a protected OU (9) is written while gate checked 17. Same class as F6. Fix: body = stripOuBodyKeys(input.body) for scope=ou (and scope=base: harmless). copy/move/set_inheritance already send only {targetOu}/{useParentApps}. Add a test.
Other tools checked: config_update body (config payload, id from query; LOW/F10, optional strip), schedule/maintenance/label/rule/predefined bodies are not OU-gated writes (no gated OU alongside, pre-existing scope), ou_filtering/new_device_options/admin_manage build typed bodies from gated ids (rule_blocks lives inside the CustomFilter envelope, not a wire OU key) - no retarget path found.

## F7 - config_update target=ou subtree gate: CLOSED
Ancestor by id (8), grandparent by path (/northcreek), allowed-list ancestor refused; sibling (17) and unrelated OU (5) allowed; tree failure -> refuseOuWrite (fail closed, fresh uncached read via collectOuSubtree). Order: mode -> validation -> OU resolve/gate -> subtree gate -> preflight -> confirm -> blast radius -> assertOuPathUnchanged -> mutating call. Subtree gate precedes preflight/confirm, i.e. a gate before any prompt/mutation; consistent with documented order (all refusal gates before confirm; validation stays before OU resolution as before). Runs in dry-run too (read-only tree fetch), acceptable.

## Verdict
F6 closed (residual LOW denylist gaps F9), F7 closed, new F8 (app_manage create body) blocking by the F6 standard, one-line fix + test.

SECURITY: BLOCKED (F8 app_manage create scope=ou forwards raw caller body next to the gated OU; same class as F6)
QA: FAIL (1)
