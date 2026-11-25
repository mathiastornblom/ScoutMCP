# Security re-verification 2: clientid lookup/forward format delta

Scope: gateDeviceListSources in src/safety/ou_gate.ts (lookup + forwarded clientIds), tests/ou-gating-followup.test.ts.

- Injection: lookup value is norm.toUpperCase() where norm passed GUID_RE (^[0-9a-f-]{8-4-4-4-12}$, ASCII only, anchored) after trim and ONE brace-pair strip. Goes through buildQuery -> encodeURIComponent. No way to carry & = # % / or extra params. OK.
- Compare: returned ClientIdentifier is normalised (case, braces) and compared to the requested normalised id; mismatch refuses. Holds for bare, braced and lowercase server forms. parseSingleDevice still enforces exactly one visible row. OK.
- De-dup: requested Map is keyed on the normalised lowercase id, so bare/braced/upper/lower/whitespace forms collapse to one lookup. OK.
- Forwarded ids: rebuilt only from rows[], each of which was proven equal (normalised) to a gated, requested id; format {UPPER-GUID} is a pure re-encoding of the same GUID. Caller strings never forwarded; forwarded set == gated set (one entry per distinct id, in order). Other body keys remain allowlisted. OK.
- notification_manage and command both call the same helper (notification.ts:101, command.ts:125); no separate path. OK.
- Residual (unchanged, accepted earlier): TOCTOU between lookup and write, covered by recheck().

Checks: npx tsc --noEmit clean; npm run test:unit 34 passed, 0 failed (follow-up suite).

No new findings.

SECURITY: APPROVED
