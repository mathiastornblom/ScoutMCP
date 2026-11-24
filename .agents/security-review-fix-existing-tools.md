# Security review: feature/fix-existing-tools (git diff origin/main..HEAD, commit 386b653)

Checks: `npx tsc --noEmit` clean; `npm run test:unit` all pass (guardrails 38/38, fix-existing-tools 36/36). src/devices.ts and src/resolver.ts untouched.

## Findings
F1 (Medium) src/tools/admins.ts update_admin summary (~l.250): confirmation shows only counts ("menu rights: N entries", "root OU: changed"), not RootOu values or Id=Value pairs; audit entry omits the body. Rights widening is not human-visible. Fix: list root_ou ids and capped Id=Value pairs in summary and audit detail.
F2 (Low) src/tools/db_cleanup.ts parseCleanupFilter: "bounded range" is presence-only (from:"0",to:"99999999999" passes). Not a gate bypass. Validate ISO dates and from<=to.
F3 (Low) admin_manage prompts (confirmDestructiveAction) before the production/mode gates, so UX only, no bypass. `username` alias and `duplicate_from` have no max length. Missing confirm_audit_purge is not audit-logged.

## Checklist
1 admin_manage: add/update/delete need confirm/elicitation + prod gate + mode gate; fullAccess shown in add summary; delete uses encodeURIComponent, min1/max256. PASS (F1).
2 db_cleanup id 1: id must be integer number in table map; '1', ' 1', '01', arrays, names rejected; 1.0/1e0 parse to 1 and are caught; duplicates/nested scanned with .some; body rebuilt from {id,from,to}. Needs SCOUT_ALLOW_AUDIT_PURGE (refusal audited) + confirm_audit_purge + confirm; env does not override read-only/dry-run; empty filter refused. PASS (F2).
3 guardrails.ts: additive only; gate order, kill switch, breaker, audit untouched. PASS.
4 client.ts 401: max one re-login per call, no replay on rights-denial body or fresh token, no loop, server text sanitised and capped (300; msgId 100), no credentials in messages. PASS.
5 device_result/device.ts: post-hoc annotation after existing gates, no new data, no bypass. PASS.
6 recoverySettings: only the path changed; all gates intact. PASS.
7 health_check: read-only classification, echoes truncated. PASS.
8 tests: only the old username/admin_id assertions replaced by name/admin_name equivalents; new ADMIN_LOGS tests added; nothing weakened. PASS.

No blocking issues. F1 recommended.

SECURITY: APPROVED
