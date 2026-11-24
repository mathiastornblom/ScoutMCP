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
- Missing/invalid grant: `403`. A missing one has the message `Insufficient permissions: the request carries no per-container grant`. It may not be issued for Bearer/API authentication; cookie / UI-session auth may be required.
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

## Other
- `415` on an odd `Content-Encoding`; request bodies are limited to 10 MB.

## Deliberately NOT exposed (pending the write-phase design)
Signing / sign / signing-upload-key, trust-certificate import and restore, uploads, deletes, and
solver solve/generate. Only GET endpoints are implemented.
