# QA review PR #44 (feat/health-mcp-version)

Reviewed `origin/main...HEAD`: 2 commits (73ac363, 6397122 which moves mcpServerVersion after the Scout spread).

## Checks
- `npx tsc --noEmit`: clean (exit 0). `npm run build`: OK.
- `npm run test:unit`: all suites pass, 0 failed (includes fix-existing-tools with the new mcpServerVersion assertion).
- Version resolution: `tsx src/version.ts` -> 1.6.0; `node dist/version.js` -> 1.6.0 (matches package.json).
- Docker: runtime stage does `COPY package*.json ./` into /app, so dist/version.js -> ../package.json = /app/package.json. .dockerignore does not exclude package.json. src/ under tsx resolves ../package.json at repo root. Fallback is 'unknown' (no throw) if unreadable.
- Hard-coded '1.6.0': only README example update-check log lines (unrelated, illustrative); no test/doc asserts exact health_check output. docs/compatibility.md only mentions healthState/scoutVersion, unaffected. No compat registry entry needed (not Scout-version-dependent).
- CHANGELOG: Added entry accurate. Fixed entry (PR #42: non-blocking startup login, 90s LOGIN_TIMEOUT_MS confirmed in src/client.ts) and Changed entry (PR #43) match git history on main.
- Ordering: after 6397122 mcpServerVersion is set after `...data`, so Scout cannot override it. Note the CHANGELOG/commit 1 wording "first in the output object" no longer applies; the changelog does not claim ordering, so fine. Test checks value only, consistent.

## Minor, non-blocking
- Import in health.ts is placed above `zod` import (style only).
- README does not mention `mcpServerVersion` in health_check description (optional).
- Test does not cover the failure-message version suffix (optional).

QA: APPROVED
