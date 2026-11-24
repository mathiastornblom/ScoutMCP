# ELIAS API notes (Scout 26.11, from the ELIAS OpenAPI)

Source: the ELIAS OpenAPI shipped with Scout 26.11 (DBLayer 15.2611+). Response schemas for several
endpoints are unknown; the MCP treats them generically (redact, size-cap, paginate).

## Versioning
Scout releases are `YY.MM.patch` (`26.11.0` = `2611`). The public `openapi.json` `info.version`
`25.11.0` is the release that spec was taken from, not a server version.

## Container ids
DBLayer storage only accepts ids spelled as `GET /containers` lists them: **UPPER CASE, no braces**.
Any other spelling returns `404` with msgId `containerNotFound`. The MCP validates a GUID (braces
rejected) and upper-cases it before building the path.

## Per-container grant
Container-scoped calls need a grant header (`x-elias-container-rights`) that only Scout Board's UI
proxy can mint. The MCP never creates, forges or computes it.
- Missing/invalid grant: `403`. A missing one has the message `Insufficient permissions: the request carries no per-container grant`. The proxy mints grants for any authenticated caller (cookie or Bearer), so this usually means the container id spelling (must be the UPPER CASE GUID as listed), a stale grant (retry), or a genuinely denied right.
- Grant under an old key: `403` msgId `grantKeyChanged`. GET tools retry once, then report.
- Any other `403`: a rights bit is denied.

## Rights (a set bit = denied)
| Bit | Right |
|-----|-------|
| 414 | parent |
| 415 | view |
| 416 | upload |
| 417 | delete |
| 418 | manage containers |
| 419 | run solver |
| 420 | sign |

Read tools report `view (415)` as the likely missing right.

## Authentication limits for private (non-/rest) calls
- CCAUTH (Citrix Cloud) installs: Bearer-only calls outside `/rest` get a JSON `401` (catch-all in `config/ccauth.ts:603-617` of the Scout Board source, which only looks at cookies).
- OIDC installs: the `oidcToken` cookie is also required, so a Bearer-only client gets `401`.
- On such installs ELIAS and other private tools may not work. A `401` right after a successful login now carries a hint saying so; there is no extra login retry beyond the existing single one.

## Other
- `elias_my_roles` uses `POST /api/v1/elias/my-container-roles {containerIds}` (a read behind a POST, body only, no mutation, needs only `authorize`). Per-container roles: view, upload, delete, manageContainers, runSolver, sign. A mis-spelled id answers all-false.
- `415` on an odd `Content-Encoding`; request bodies are limited to 10 MB.

## Write phase (foundation slice; everything off by default)
Design: `.agents/design-elias-write-phase.md`; Security conditions: `.agents/design-review-elias-write-phase.md`.

**Tier C, permanently excluded** (structurally unreachable: no op-table entry, refused by `client.ts`,
body deny-list): signing certificate management, `sign`, `signing-upload-key`, trust-certificate import and
restore (`defaults`), and certificate delete. They decide what thin clients accept to run (fleet-wide trust).

**Closed op table** (`src/elias/optable.ts`): every known ELIAS non-GET endpoint is classified A0 / A / B /
internal. Only `POST /containers/import` (Tier A) is enabled in this build, and its tool
(`elias_container_create`) is registered only with a `verified-live` body plus evidence (see
`docs/compatibility.md`). `client.ts` refuses any non-GET without a single-use mutation token unless it is on the
closed read-class POST list (`my-container-roles`, `treefilter`).

**Switches** (all optional, all off by default; booleans accept only the literal `true`; invalid values fall to the
safe side and are listed by `elias_write_status`): `SCOUT_ELIAS_WRITES` (`off`|`a`|`b`),
`SCOUT_ELIAS_ALLOWED_CONTAINERS`, `SCOUT_ELIAS_PROTECTED_CONTAINERS` (entries: GUID, exact name, or `prefix*`; the prefix needs at least 4
characters in ALLOWED/DELETABLE and at least 2 in PROTECTED (so `uc-*` works; Security ruling on C4); bare `*` rejected; an allowed entry overlapping a protected one is rejected and invalidates the
whole scope), `SCOUT_ENV=test` with `SCOUT_TEST_CONTAINER_PREFIX` (default `MCPTEST-`),
`SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES` (test env only). Parsed but not yet active: `..._ALLOW_DELETE`,
`..._DELETABLE_CONTAINERS`, `..._ALLOW_UPLOAD`, `..._ALLOW_SOLVER`, `..._ALLOW_ACCEPT`, `..._MAX_DELETE_DEPENDENTS`
(ceiling 5), `..._MAX_EDIT_DEPENDENTS` (ceiling 5), `..._MAX_DELETES_PER_HOUR` (ceiling 20). `SCOUT_ELIAS_ALLOW_FORCE`
is intentionally not read.

**Audit**: a write-ahead intent row is appended and fsynced before the mutating call and blocks the mutation if it
cannot be written; an intent without a result is reported as `recovered-unknown` at startup. The audit file is 0600.
Snapshots are NOT implemented yet: no tool or document may claim that a change can be reverted automatically.

**Path policy**: every non-GET path is normalised before classification (percent-decoding once, double encoding,
`//`, `.`/`..`, `;`, backslash, encoded separators and control characters rejected, case-folded). Tier C detection is a broad
match on the decoded path. An unknown non-GET is refused even with `mutating:true` unless its exact normalised path is on the
legacy private-write allow-list (`LEGACY_MUTATING` in `src/elias/optable.ts`). `client.request()` applies the same
traversal/Tier C backstop. Mutation tokens are bound to method, template, concrete normalised path and body hash.

**Confirm path**: `planDigest` is optional in this slice (Tier A, one empty container). It becomes REQUIRED (plan, then
confirm) on the `confirm:true` path before any edit or Tier B op. The `SCOUT_ENV=test` host pin for the unverified escape
hatch comes with the live-test PR (C23/C24).

## Not implemented yet
Locks and sessions, snapshots, delete, upload, solver, accept, import/generate, and the A0 read-class POST tools
(IDF export/parse/verify, solver checks) are deferred to later reviewed PRs.
