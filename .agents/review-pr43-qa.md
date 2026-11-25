# QA review PR #43 (fix/integration-suite-1.6) - tests/integration.ts only

Checks: `npx tsc --noEmit` clean; `npm run test:unit` 20 passed / 0 failed. Integration suite not run (per instructions). Diff is +43/-7, test file only, no src changes.

## Per-assertion
- rename missing newname: now accepts "newname" OR "No OU matching". Gate resolves OU before arg validation, so the nonexistent path legitimately hits the resolver first. Intent (isError, refusal) kept; the newname-validation branch is no longer exercised by this test. Minor weakening, acceptable. Suggest (non-blocking) using an existing test OU path to restore the original intent.
- delete outside scope (/Enterprise): accepts "No OU matching" for forest layout. Still isError; no write occurs. Scope-guard semantics are covered by tests/ou-gate-coverage.test.ts (line ~309 expects /outside SCOUT_TEST_OU_PATH/), so no coverage hole overall. Integration test is weaker on forest servers only.
- onboard_branch outside scope: same pattern plus breaker reset; scope guard covered by unit tests. OK. Breaker reset uses __resetCircuitBreakerStateForTests (exists, guardrails.ts:420, test-only name) - appropriate so scope guard, not circuit breaker, is what is checked.
- admin_manage delete_admin no-confirm: accepts "high-risk" gate refusal. Still isError. Slightly loosened; confirm-prompt itself not asserted when gate fires first. Acceptable (gate 7 in guardrails.ts is a stricter refusal).
- dryRun on empty OU (move_devices_by_filter, bulk_command): early-return skip with NOTE when "No device found". Only skips on that specific message; other errors still throw. Silent-pass risk is limited to empty OU. Acceptable.
- ou_filter_manage ou_id: adds resolved test OU id to entries - strengthens scoping (writes pinned to TEST_OU_PATH). Good. Breaker resets are test-hygiene only.
- resolver root test: skips only on "No root OU defined"; others still throw. OK.
- device_get enrichment: skips on HTTP 400 / "not OK" - broadest of the skips (could mask a real 400 regression); recommend narrowing in a follow-up. Non-blocking.
- db_cleanup `includes(confirm)` assertion: NOT in the diff; untouched. The only confirm-related change is admin_manage delete_admin (intended).

## Verdict
No assertion was converted into a tautology; all still require isError or a specific message, and safety scope behavior remains covered by unit tests. Note the author's live 129/0/1 run was not independently reproduced.

QA: APPROVED
