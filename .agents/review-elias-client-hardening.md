# Review: ELIAS client hardening (fix/elias-client-hardening, 96f84bf) - Security + QA

Build: `npx tsc --noEmit` clean. `npm run test:unit` all suites pass (client-hardening suite 23/23, elias-write-hardening 14/14, others 11-34 each, 0 failures).
My own fuzz scripts (scratch, removed afterwards): ~1,000 combinations, details below.

## BLOCKING
None.

## N1 validated == sent: HOLDS
Fuzzed rawRequest and request(), methods POST/PUT/PATCH/DELETE/OPTIONS (+lower/mixed case), mutating true/false, baseUrl with/without port and trailing slash, ~27 spellings:
no leading '/', '//evil/x', 'https://evil/...', 'http:evil', '@evil/x', '/@evil', /API/V1, trailing '/', '%69mport', '%2e%2e', '%2F', ';', '?', '#', backslash, space, NUL, fullwidth, './', '../', 100 KB path, query with '/../', '#', CRLF.
Invariant checked on every request that reached fetch: sent === baseUrl(+/rest)+path byte for byte, same origin, pathname under /api/v1/ (raw) or /rest/ (request). 116 sends, 0 violations. The no-leading-slash/port-less host rewrite is closed (refused before send); host can never change because every non-GET path must start with a single '/'.
Residuals (accept): (a) query part is not canonicalised (a '#' in a legacy allowQuery query is dropped by fetch; harmless); (b) for token ops, {id} segments may contain percent-encoded benign characters sent as-is while the token binds the decoded lower-case path (semantically identical, no host/route change); (c) GET is deliberately unvalidated (unchanged); OPTIONS via request() is ungated (pre-existing).
Callers: all 27 non-elias rawRequest non-GET sites and every request() POST site read; paths are constants/validated and are on the allow-list with the pinned verb (license PUT, admins POST/POST/DELETE?adminName, dbCleanUp POST, ui/instances PUT/DELETE, oufilter/*, recoverySettings POST, predefined*, *options/set, devicePassword/set). No caller broken. Note: the callers-scan test calls isLegacyMutating without a method, so it does not itself prove verb pinning; I verified verbs by hand (INFO: pass the method in that test).

## N2 body deny-list: HOLDS with Unicode residual
Denied: signkey, pemfile, certfile, mycert, cacert, x509, signer, signerName, keystore, privateKey, private_key, privKey, thumbprint, Sign-Key, SIGNKEY, 'sign key', trustStore, design_signkey, assign_cert, designsignkey, resignpem, certPem, keyPem, mypem, nested objects/arrays, `__proto__` key. Allow-words not denied: design, assign, assignedTo, resign, consign, pempty, name, description.
Wrapper abuse ('design_signkey', 'assign_cert') is NOT a bypass: allowed words are stripped, but the always-list and the 'sign'/'cert' check on the remainder still catch the real token.
LOW residual (accept, latent): zero-width space and fullwidth/homoglyph spellings ('sig​nkey', 'tru​st', 'ｓｉｇｎ', Cyrillic 'sіgn') are not denied. Not exploitable today (builders emit fixed keys only); fix before any op takes caller-supplied keys: strip \p{Cf} and NFKC-normalise the key first.

## N3 method pinning: HOLDS (method pinned per entry, tests present; PATCH/OPTIONS refused).

## N4 token: HOLDS
Instance frozen; setting expiresAt/used/binding/prototype throws; expiresAt is a getter over a #private field; mint refuses Proxy, getter-proceed, extra keys, class instance, symbol keys, proceed:1; ttl > 120 s and non-string binding rejected. Accepts null-prototype and `{proceed:true,dryRunNotice}` (intended).
INFO: the MutationToken.prototype itself is not frozen (Object.defineProperty on it succeeds). Needs in-process code execution, which already bypasses everything; accept.

## N5 audit: HOLDS
Half-written row ('{"half":') then two appends -> bad line stays isolated, next rows valid on their own lines (a+ open, 1-byte tail read, newline prepended in the same single write, no extra blank line). 200 same-process appends: 200 valid rows (sync writes, no interleave). Residual (accept): cross-process check-then-write race can at worst add a stray blank line; unreadable tail assumes newline needed (fail-safe).

## N6 request() mode gating: HOLDS
PUT/PATCH/DELETE now gated even without mutating:true (read-only refuses, dry-run returns skip, write sends). Bare POST stays ungated: the only two bare-POST request() callers are src/tools/ou.ts:440 (structure/export, read) and src/tools/rule.ts:72 (rules/validate, read); every mutating POST caller (schedule, label, rule, ou, application, config, device, command, maintenance, workflow) passes mutating:true. No mutation bypasses the mode gate. Acceptable.

## N7 scrubber / rules / capOutput
- GUID keys -> {guid}, numeric -> {int}, >=20-key dictionaries and non-identifier keys -> {key}: works.
- RESIDUAL (Low/Info, accept, but track): small maps (<20 keys) keyed by plain-identifier names pass through, e.g. `{"ContainerA":{...},"HostPC01":1,"container_a":1}` appear verbatim in the fixture (confirmed). Key names that look like identifiers are indistinguishable from field names. Mitigation before the first real HAR is committed: keep keys only if in a vocabulary allow-list (as already done for path segments), or manual review gate.
- elias_container_rules: 5,000 rules with PEM + prompt-injection text + secretKey -> output 10.9 KB (limit 100 KB), valid JSON, total/summary/pagination correct, no PEM/secret leaked, text capped at 300 chars (max 5000 by caller), note labels server text untrusted. {response:[..]}, [] and non-array shapes handled (non-array throws a clean error). Nested arrays capped (depth/array limits).
- capOutput on 3,000x900-char objects + 500 KB string: 31 KB, valid JSON, truncated:true, no secret.
- Order note: redaction runs BEFORE capOutput (`capOutput(redactSecrets(..))`), i.e. on the full values; shrinking cannot reintroduce anything. shapeRules shortens before redaction, so a PEM header cut by the 300-char limit leaves no key body (header always precedes body). Judged safe, arguably better than redact-after.
- INFO (pre-existing): redactSecrets recursion overflows on 100,000-deep JSON ("Maximum call stack size exceeded"); caught by wrap(), no leak.

## Altered tests
1. F4 '/API/V1/Containers/Import/' now expected REFUSED (was "same request"): LEGITIMATE and stricter; canonical spelling still asserted as sent.
2. import-path variants list: '//containers/import' moved from "normalises to op" to a new "must be rejected" list, plus 'api/v1/...' and '//api/v1/...' added: STRENGTHENING (restores the earlier-flagged weakened assertion). optable test additionally adds the '//' case: strengthening.
3. rights-denial 401 test sets SCOUT_MODE=write around an undeclared DELETE and restores it: LEGITIMATE adaptation (N6 made the call mode-gated; test is about 401 handling, env restored in finally).
Fixtures: new tests use runtime-random user/secret (randomBytes); only literal is the short fake 'k-live' apiKey value in a redaction test (INFO, not credential-shaped for scanners; could be randomised).

## Summary
0 blocking. Residual-accept: Unicode key evasion (N2, latent), small identifier-keyed maps in scrubber output (N7), unfrozen token prototype (in-process only), cross-process audit race (cosmetic), pre-existing deep-recursion in redactSecrets. Suggested follow-ups: NFKC/strip-format-chars in BODY_KEY_DENY; pass method in callers-scan test; vocabulary allow-list for scrubber keys before any real HAR is committed.

SECURITY: APPROVED
QA: APPROVED
