# QA review: startup-auth cleanup (fix/startup-auth-cleanup, uncommitted)

- tsc --noEmit: clean.
- npm run test:unit: exit 0, every suite 0 failed (new startup-auth: 9/9). Log: scratchpad/unit.log.
- Timeouts really exercised: in-process HTTPS server, SCOUT_REQUEST_TIMEOUT_MS=200, responses delayed 600ms; no mocking of fetch/timers.
- Mutation testing (copy in scratchpad/m), all caught:
  - remove exchange headroom -> 2 fail
  - remove direct-login headroom -> 2 fail
  - drop unchanged-config condition -> 2 fail (replaced, cleared)
  - drop 403 -> 1 fail; clear on 500 -> 1 fail
  - add headroom to mint step -> 1 fail (mint must still time out)
- Behaviour: valid creds path unchanged (Authenticated log); no-credentials branch untouched; only change in catch is the clear decision (400/401/403 AND config value-equal to startup config), else "kept" warning. Late rejection after scout_configure or already-cleared config no longer wipes state.
- Gap (minor, non-blocking): index.ts wiring itself not covered by a test; verified by reading the diff.

QA: APPROVED
