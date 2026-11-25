# Security review: PR #43 (fix/integration-suite-1.6), tests/integration.ts only

Scope: `git diff origin/main...HEAD` touches only tests/integration.ts. No src changes.

## Findings
1. Loosened refusals ('No OU matching', 'high-risk'): ACCEPTABLE.
   - 'No OU matching' is thrown by resolveOuRef (src/resolver.ts:118), a read-only OU-tree lookup. ou.ts resolves the target before gateOuWrite and before any mutating call, so this refusal occurs before any write.
   - 'high-risk' comes from checkPrivateWriteAllowedInProduction (guardrails.ts Gate 7); in admins.ts the gates run before the confirm prompt and before any request. Genuine pre-write refusal.
   - LOW / non-blocking: the 'outside TEST_OU_PATH' tests now also pass when /Enterprise does not exist (forest layout), so on such servers they no longer exercise the scope-guard text itself. Scope guards are unchanged in src; coverage of that branch is better done in a unit test with a fixture tree. Suggest follow-up, not a blocker.
2. __resetCircuitBreakerStateForTests: ACCEPTABLE. Test-only export already exists (guardrails.ts:420), only resets in-memory flag/window, imported solely from tests/integration.ts, no production call site added. It does not weaken what is asserted: the onboard out-of-scope test is meant to check the scope guard rather than a tripped breaker; the reset is what makes that check meaningful.
3. Added ou_id to ou_filter_manage entries, resolved from TEST_OU_PATH via resolveOuRef: writes are now explicitly targeted at the test OU (improves scoping). Entries remain active:false.
4. Skip paths ('no root OU', 'No device found', HTTP 400): benign, read/dry-run only, log a NOTE; no write bypass.
5. Credentials/secrets: none in the diff (grep for password/secret/token: no hits).

No scope guard (SCOUT_ENV=test, TEST_OU_PATH, protected OUs) was weakened in src, and no test assertion on a destructive path was removed.

SECURITY: APPROVED
