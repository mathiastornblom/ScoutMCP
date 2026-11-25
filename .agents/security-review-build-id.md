# Security review: build identifier (feat/build-identifier)

Checks run: `npx tsc --noEmit` clean; `npm run test:unit` all pass (build-id 6/6).

- Env injection: computeBuild never reflects raw env. SHA must match ^[0-9a-fA-F]{7,40}$ (sliced to 7, lowercased) or be exactly dev/local/unknown; else 'unknown'. Date must match strict ISO-UTC regex plus Date.parse. Regexes are anchored with no /m flag, so embedded newlines, unicode, over-long values and shell metacharacters fall back to 'unknown'. Only trailing whitespace is trimmed. No ReDoS risk (linear patterns).
- serverInfo.version = `1.6.0+<sha7|dev|local|unknown>`: valid semver build metadata (alphanumerics only).
- SCOUT_VERSION update-check semantics untouched (index.ts:106, tools/update.ts:35 unchanged; separate from SCOUT_GIT_SHA).
- health_check: mcpServerVersion kept; mcpBuild added after the Scout response spread, so Scout cannot override it. Error message uses validated build string.
- GitHub Actions: only new `run:` is `date -u` with no `${{ }}` interpolation. `github.sha` (trusted) and `steps.builddate.outputs.date` (self-generated) are used only in `build-args` (not shell). No github.event.head_commit.* use. Permissions unchanged (contents: read, packages: write). No secrets touched.
- package.json docker:build: no eval; command substitutions are fixed commands (git rev-parse, date) with no user input; values are safe charsets.
- Dockerfile/compose: build ARG/ENV only carry non-secret values, with safe defaults.
- Info disclosure: only short SHA and build timestamp; low sensitivity.

Minor, non-blocking: 'unknown' is a shared fallback for both invalid and absent input (fine).

SECURITY: APPROVED
