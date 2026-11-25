# QA review: build identifier (feat/build-identifier, uncommitted)
- tsc --noEmit: clean (exit 0).
- npm run test:unit: every suite reports 0 failed; build-id 6/6, fix-existing-tools incl. mcpBuild assertion passes, startup-auth 9/9. (Stderr noise from audit/snapshot/401 lines is expected negative-path output.)
- Mutation (copy under scratchpad/mut): hex check loosened -> 5/6 FAIL; slice(0,8) -> 4/6 FAIL; date regex check removed -> 5/6 FAIL; date regex widened to accept offsets -> 5/6 FAIL. Tests are non-vacuous. (First "loosen date" sed was a no-op; redone properly.)
- Docker with args (GIT_SHA=fedcba98..., BUILD_DATE): stdin initialize -> serverInfo.version "1.6.0+fedcba9". No args: "1.6.0+dev" (no crash). No credentials used; images removed.
- README: gh api ... --jq '.sha[0:7]' works (returned 52da398). docker:build script is valid POSIX env-prefix syntax (verified the prefix part with sh -c; short sha + UTC date produced). docker compose passes GIT_SHA/BUILD_DATE via args; workflow computes date step and passes both build args.
- CHANGELOG entry accurate (mcpBuild fields, serverInfo, build args, npm script).
- SCOUT_VERSION update-check unchanged: Dockerfile VERSION arg/ENV untouched, src/index.ts update check and src/tools/update.ts not modified.
- Minor/non-blocking: plain `docker compose build` gives gitSha "local" (documented); docker:build does not pass VERSION (pre-existing, so SCOUT_VERSION=local there).

QA: APPROVED
