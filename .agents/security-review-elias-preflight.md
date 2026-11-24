# Security Implementation Review: ELIAS read-only + ourights preflight + compat probes

Branch feature/elias-preflight, `git diff dcca95d..HEAD`. Reviewer: Säkerhet. Method: code read plus executed probes (tsx) against `EliasGuid`/`EliasName`/`redactSecrets`.

## Design conditions verified

| Condition | Result | Evidence |
|---|---|---|
| B1 GET-only | PASS | `elias.ts:149` is the only HTTP call, hardcoded `'GET'`. `health.ts:81` GET. `detect.ts:223` GET. Registry type is `method: 'GET'` (`registry.ts:20`), all probes GET. `preflight.ts:89` GET. No `mutating` option anywhere in the new code. |
| B1 ID validation + encode | PASS | Every segment goes through `seg(schema, v)` = Zod parse then `encodeURIComponent`. |
| B1 private gate, registration | PASS | `index.ts:~161` spreads `eliasTools` inside the `privateEndpointsEnabled` branch. |
| B1 private gate, per call | PASS | `elias.ts:128` re-checks `SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true'` in `wrap()` before any work. |
| B1 output cap | PASS | `capOutput` runs after `redactSecrets` (`elias.ts:133`). Page `limit` is at most 500 and projections are whitelisted. Objects with no `items` array are dropped, not truncated. |
| B1 cert metadata only | PASS | `certSummary` is a whitelist. `signing=true` never reaches the PEM path (`:385-388`). `includePem` needs `certType==='CRT'` plus a string `pem`, and the output still goes through the redactor. |
| B2 deny only on explicit false | PASS | `preflight.ts:131`. 404/405/5xx/timeout/non-object/absent key all go through `softFail`. Failures are never cached. |
| B2 never relaxes a gate | PASS | `granted` is informational. Callers ignore the return value. The calls sit after mode/OU-write gates (`config.ts`, `command.ts`, `ou.ts` after the dry-run short-circuit). `confirm` and blast radius are untouched. |
| B2 audit refusal, no secrets | PASS | Only `auditLog` call is `preflight.ts:132`; it logs op, target, right name. `config.ts` skips its duplicate audit for `gate==='preflight'`. Soft-fail stderr line contains only the server message text. |
| B2 read-only, no breaker count | PASS | Plain `rawRequest` without `mutating`. ouId is an integer check, sent through `URLSearchParams`. |
| Lock NOT exposed | PASS | `grep` of `src/` finds no `lock/set`, `lock/release`, `lock_*` tool or helper. The only mentions are comments. No mutating ELIAS call exists. |
| RSoP advanced entries | PASS | `rsop.ts parseAdvancedFileEntries`. Warnings include level, index and key name only, never `Value`. No `auditLog` or stderr line carries a value. Values appear only in the tool result (see F6). |

## Path-injection bypass attempts (executed)

Rejected before any HTTP call: trailing `\n` (JS `$` has no `m` flag), trailing space, fullwidth-digit GUID (NFKC lookalike), array, object, `%2e`, `%2e%2e`, `a..b`, `a/b`, `.`, `..`, and a 201-char name. Accepted: only plain ASCII charset values. Unicode normalisation, `%`-encoded dots, whitespace, long ids and non-string ids give no bypass. `name="a."` is accepted and becomes `a..epm`. It is a single path segment, so it is not traversal (cosmetic).

## Findings

**F1 (MEDIUM, hardening, non-blocking): redaction key matching is exact-name only.** `elias.ts:58` `SECRET_KEY_RE` is `^(privateKey|private_key|key|...)$`. Repro (executed): keys `privateKeyPem`, `pkcs12`, `keyPem`, `apiKey`, `token`, `private-key`, `clientSecret` were NOT redacted. A base64 PKCS#12 blob in a field named `data` is also unredacted, because there is no marker to match (`d3:"MIIJ..."`). `"-----BEGIN  PRIVATE KEY"` is caught, but `PRIVATE  KEY` with a double space or a line wrap is not. Exposure today is limited, since nearly all tools project through whitelists. The unprojected paths are `elias_health` (raw body), `elias_rights` (raw body) and `elias_upload_status.parse` (raw nested object). It meets the literal B1(b) key list, but the list is too narrow. Fix: substring or token match on `/(priv(ate)?[-_]?key|pass(word|wd|phrase)?|secret|token|pfx|p12|pkcs ?12|api[-_]?key|credential)/i`, tolerate `\s+` in the PEM marker, and project `elias_health`, `elias_rights` and `parse` to known fields.

**F2 (LOW): `.env.example` corruption.** `SCOUT_ENABLE_PRIVATE_ENDPOINTS=false# ELIAS ...` is joined onto one line (missing newline). dotenv treats `#` as a comment only after whitespace, so the value becomes `false# ELIAS...`. This fails closed, because it is never `=== 'true'`. But if an operator edits it to `true# ELIAS...`, the private gate stays silently OFF. Fix: restore the newline.

**F3 (LOW): server-controlled version string reflected.** `detect.ts:173-190` accepts any string for which `parseScoutVersion` finds a 4-digit YYMM token, with no length or charset limit. It is echoed unchanged in `requireCapability` messages (`:343`), in the `health_check` `scoutVersion` field, and in `disagreements`. A malicious or compromised server can inject long free text (prompt injection) into tool output. Fix: require `/^[0-9A-Za-z.\-_+>= ]{1,40}$/` on the version before accepting it.

**F4 (LOW): preflight cache not keyed by identity.** `preflight.ts:76` keys on ouId only, TTL 30 s, and is not cleared on `scout_configure` or a credential change. After a re-auth as a different user, the previous user's rights can be served for up to 30 s. A stale `false` over-refuses (safe). A stale `true` changes nothing, since it relaxes no gate. This is not a security boundary issue. Fix: key on the token/user and call `resetPreflightCache()` on reconfigure.

**F5 (LOW, info): probe cost and cache.** `health_check` triggers about 5 GETs on a cold cache (version sources plus 4 probes), cached 5 min per client (WeakMap, so a new client means a new cache). Probe paths are static registry constants. No attacker-influenced path or credential reaches a probe, and the 5 s timeout does not abort the underlying fetch (the client has its own timeout). Poisoning is bounded: only `unavailable` changes any behaviour, and it only changes an error message after a real 404, never blocking a call.

**F6 (INFO): advanced file-entry values are returned to the model unredacted.** `config_resolve` returns INI `Value` strings as-is (same trust level as `config_get`). Not logged or audited. Consider running them through the F1 redactor for keys that look like secrets.

**F7 (INFO): output cap counts UTF-16 chars, not bytes.** The 100k cap can be up to about 3x in bytes. Acceptable.

## Errors and logs

`ScoutError` messages carry only the server-supplied `message` or `HTTP <status>`. Login errors do not echo credentials. The token is never logged: `elias.ts` logs the method and path only (validated ids), and `preflight.ts` and `health.ts` log only the error message. Server-supplied error text is untrusted and is shown to the model verbatim (same as the pre-existing behaviour).

## Verdict

No blocker found. B1 and B2 conditions are met in code. Lock is not exposed and no mutating ELIAS call exists. F1 and F2 must be fixed before ELIAS gets any write phase or unprojected endpoints. F3 and F4 are recommended.

SECURITY: APPROVED
