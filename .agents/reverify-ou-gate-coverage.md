# Re-verification - fix/ou-gate-coverage @48a44cf (Security + QA)
Build: tsc clean. npm run test:unit exit 0, 120 passed / 0 failed summed over suites (ou-gate-coverage 35/35). Throwaway adversarial test (8 scenarios) run and removed; no src or test edits left.

## Previous findings
- F1 CLOSED. ou_manage rename/delete/move/converttobase + structure_import now call gateOuSubtree on a FRESH /ou/structure read (collectOuSubtree -> fetchOuTree, uncached). Verified refused: multiple + nested protected entries, deep nested (Google-CEP under Browser), top-level delete (with ALLOW_BASE_WRITES), name ref, id/path disagreement, move child OUT of protected, move INTO protected (dst gate) and into a protected-ancestor subtree, add under protected, import with payload parentOuId, allow-list ancestor. Subtree enumeration failure (HTTP 500 or garbage tree on 2nd fetch) refuses and audits (fail closed). Tree is re-read every call (no stale cache).
- F2 CLOSED for the boolean/true-ish values: subOusRequested = only absent/boolean false mean "no"; applied identically at command.ts, notification.ts, workflow.ts bulk_command (zod boolean there). 'false' string, null, 0, [] all count as requested (stricter, consistent, documented). Server receives real boolean true/false. Other includeSubOus sites are reads or zod-typed booleans (move_devices_by_filter gates per matched-device source OU).
- F3 CLOSED: config_update target=ou now via gateOuWrite (test scope + audit). F4 CLOSED (source OU test scope). F5: app_manage now sends `id` (spec name), command ou sends ?id; still needs live check (unchanged advice, non-blocking).
- Gate order unchanged; no read-only/dry-run mutation; refusals audited; no existing safety assertion altered (diff only adds).

## New findings
### F6 MEDIUM (blocking) - key-case variants in forwarded bodies
device_command / notification_manage forward the caller body raw except for exact keys ouId, ouPath, includeSubOus. Repros (protected=/NorthCreek/Customers/CLALIT):
- body {IncludeSubOus:true} (also includesubous, INCLUDESUBOUS) with ouRef=8 -> SENT, subtree gate skipped; body sent {"IncludeSubOus":true,"ouId":8}.
- body {ouid:9} / {OUID:9} / {ouPATH:"/NorthCreek/Customers/CLALIT"} with ouRef=17 -> SENT as {"OUID":9,"ouId":17}: a duplicate OU key differing only in case rides along. If the server deserialiser is case-insensitive (typical for .NET/Newtonsoft), the gate and the write diverge (protected OU 9 targeted or sub-OUs fanned out). Server behaviour unverified; the gate must not depend on it.
Fix: for target=ou, delete every body key whose lowercase (strip _ and -) is in {ouid, oupath, ou, id, path, includesubous}, then add the canonical ouId and, only if requested, boolean includeSubOus (or whitelist body keys). Add tests for the casing variants above.

### F7 MEDIUM (blocking, per ruling) - config_update on ancestor
Repro: protected=CLALIT, config_update {target:'ou', ouId:8, section:'network', body:{}, confirm:true} -> POST /api/v1/configuration/ou/network?id=8 SENT.

## RULING: config_update on an ancestor of a protected OU
Must be gated. Inheritance (UseParent=1 on Customers/CLALIT in the fixture) makes this a write to the protected OU's effective config, i.e. the same class as F1; the README now says "writes to protected OUs are refused" while this path writes to them. Recommendation: in config_update target=ou, call gateOuSubtree('config_update', resolved) after gateOuWrite (skipProtectedCheck stays or is dropped; the subtree call covers the OU itself). Refuse when any descendant is protected or outside SCOUT_ALLOWED_OUS. Optional follow-up (not required): refuse only when the descendant actually inherits (UseParent) - not needed for v1, fail closed is acceptable. Update README paragraph (currently documents the residual) and add tests (ancestor id 8 and grandparent by path refused; sibling allowed). Marked blocking.

## Other notes (non-blocking)
- F5 live check of `id` vs `ouId` for app_manage on Scout 26.11.0 still pending.
- notification/command ou: openapi lists both path and id; only id sent (fails closed if enforced).

SECURITY: BLOCKED (F6 case-variant includeSubOus/ouid keys in forwarded bodies bypass subtree gate / duplicate OU key; F7 config_update on ancestor of protected OU not gated, ruling: must gate via gateOuSubtree)
QA: FAIL (2)
