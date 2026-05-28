## Review: design-decisions.md
Datum: 2026-05-19
Resultat: SECURITY: APPROVED

---

### Godkänt

- **JWT in-memory only** — Token lagras enbart som en privat klassvariabel i ScoutClient-singelton. Inget disk-skriv, ingen serialisering, ingen exponering via miljövariabler. Korrekt.
- **TLS bypass är scoped** — Designen använder `undici.Agent({ connect: { rejectUnauthorized: false } })` och skickar den som `dispatcher` per request. Det globala `NODE_TLS_REJECT_UNAUTHORIZED` sätts aldrig. Uppfyller det kritiska kravet.
- **Inga hårdkodade credentials eller URLs** — Alla känsliga värden hämtas från miljövariabler. `.env.example` planeras utan riktiga värden. Korrekt.
- **Zod-validering på alla tool-inputs** — `z.any()` förbjudet utan motiverande kommentar. Enum-params, OU-sökvägar och MAC-adresser valideras explicit. Tillräcklig yttre skyddsgräns.
- **Destruktiva operationer har guard-mekanism** — `SCOUT_TEST_OU_PATH`-kontroll i testläge hindrar oavsiktliga operationer utanför testträdet. `SCOUT_ENV`-flaggan separerar test- och produktionsläge.
- **Retry-logik är minimal** — Retry sker bara vid 401 (re-auth), aldrig generellt. Eliminerar risken för thundering herd och upprepade skrivoperationer.
- **Timeout satt** — 30 s default med override via `SCOUT_REQUEST_TIMEOUT_MS`. Förhindrar hängande connections.
- **Test-säkerhetsinvariant** — Tester avbryts om `SCOUT_TEST_OU_PATH` saknas. Skrivtester städar upp i `finally`-block. Korrekt.
- **TypeScript strict mode** — `tsconfig.json` bekräftar `"strict": true`. Minskar risken för typfel som leder till säkerhetsproblem.

---

### Krav för godkännande (om BLOCKED)

Inga blockerare identifierade. Design godkänns med kommentarer nedan.

---

### Svar på öppna frågor (sektion 10)

1. **Cookie vs Bearer:** Implementera cookie-mekanismen som primär (`Cookie: ScoutBoardAuthJWT=<JWT>`), vilket stämmer med OpenAPI-spec (`in: cookie`). Testa **inte** Bearer-header som alternativ utan explicit bevis från API-ägaren — att skicka token i två kanaler ökar attackytan i onödan. Om API:et i framtiden stöder Bearer kan det läggas till som ett konfigurerat alternativ.

2. **TLS bypass scope:** Det är acceptabelt i nuläget, givet att scopingen är korrekt (per-dispatcher, ej global). I produktionsmiljö med ett korrekt signerat certifikat SKA `SCOUT_IGNORE_TLS` vara `false` eller helt frånvarade. Dokumentera tydligt i README att `SCOUT_IGNORE_TLS=true` inte ska sättas i prod utan att man vet vad man gör. Inget hinder för godkännande.

3. **Token logging:** Ingen del av JWT-strängen ska loggas, inte ens trunkerad. JWT-headern och -payloaden är base64-kodade men inte krypterade — en delvis token kan i kombination med signaturen vara exploaterbar. Sätt regeln: logga aldrig `this.token` i någon form. I debug-läge är det tillåtet att logga `[JWT present: true/false]` som boolean.

4. **Factory reset / halt guards:** `SCOUT_TEST_OU_PATH`-kontrollen i testläge är tillräcklig för att skydda mot felaktiga tester. I produktionsläge är det ett medvetet val att låta MCP-anroparen bära ansvaret. Det är acceptabelt förutsatt att: (a) varje destruktivt verktyg har en explicit varningstext i sin `description`-sträng, (b) verktygets inputschema kräver ett bekräftelsefält för de mest farliga operationerna (`factoryreset`, `halt`) — exempelvis `confirm: z.literal(true)`. Detta är ett implementationskrav, inte ett designblocker.

5. **Advanced Configuration endpoints:** Att utesluta dem från v1 är ett positivt säkerhetsbeslut — det reducerar attackytan. Avancerade konfigurationsendpoints kan ha sidoeffekter som är svåra att förutse. Godkänt att hålla dem utanför scope tills de behövs, med en tydlig kommentar i koden att sektionen är medvetet utelämnad.

---

### Kommentarer (icke-blockerande)

- **Bekräftelsefält för kritiska kommandon (implementationskrav):** `device_command` med `command=factoryreset` och `command=halt` BOR kräva ett explicit `confirm: z.literal(true)` i inputschemat. Detta skyddar mot oavsiktliga anrop från en AI-klient som tolkar ett verktygsnamn utan att förstå konsekvenserna. Implementera detta i `tools/command.ts`.

- **Credential-hantering vid login:** `loginData64` skickas som base64-kodad JSON, inte krypterad. Det är API:ets val och inget vi kan påverka — men det understryker vikten av att HTTPS alltid används (vilket det gör via `SCOUT_BASE_URL` med https-scheme). Lägg till en startup-kontroll som kastar om `SCOUT_BASE_URL` inte börjar med `https://`.

- **Error-responses till klienten:** Designen nämner att `McpError` kastas med serverns `{ code, message }`. Säkerställ att interna stacktraces, filsökvägar och systemdetaljer aldrig vidarebefordras till MCP-klienten. Wrap-a fel i ett generiskt meddelande om det rör sig om oväntade fel (inte API-svar).

- **Singleton-livscykel:** ScoutClient som singleton innebär att ett komprometterat token lever tills processen startas om. Acceptabelt för ett MCP-serverscenario, men dokumentera att processen bör startas om vid misstänkt kompromettering.

- **SCOUT_ENV default = production:** Klokt val — produktionsläge är standardläget, vilket innebär att man måste aktivt välja testläge. Behåll detta.

- **Avsaknad av rate limiting:** MCP-servern exponerar inga egna rate limits mot servern. Om en AI-klient anropar i hög frekvens kan det påverka Scout Board-servern. Kan lösas i v2 med enkel token-bucket i ScoutClient. Inte ett blocker.

- **`dotenv` enbart i dev:** Konfigurera `dotenv.config()` så att det enbart körs i icke-produktionsmiljöer, eller dokumentera att produktionsinstanser ska tillhandahålla miljövariabler via systemet (inte `.env`-fil).

---

## Code Review: src/client.ts
Datum: 2026-05-19
Granskare: Arkitekt (Säkerhetsperspektiv)

### Resultat: SECURITY: APPROVED (med ett implementationskrav)

---

### Godkänt — designkrav uppfyllda i koden

- **HTTPS-kontroll vid uppstart** ✅ — `constructor` kastar `ScoutError` om `SCOUT_BASE_URL` inte börjar med `https://` (rad 39–41). Uppfyller det icke-blockerande kravet från designgranskningen.
- **TLS bypass scoped till dispatcher** ✅ — `undici.Agent({ connect: { rejectUnauthorized: false } })` skapas endast om `SCOUT_IGNORE_TLS === 'true'` och skickas per request. `NODE_TLS_REJECT_UNAUTHORIZED` sätts aldrig globalt.
- **JWT enbart i minnet** ✅ — `private token: string | null = null` — aldrig serialiserad, aldrig loggad. Ingen `console.log` förekommer i filen.
- **Retry begränsad till 401** ✅ — `isRetry`-flaggan (rad 103/126) förhindrar oändlig loop. Inga generella retries.
- **Timeout implementerad** ✅ — `AbortController`-baserad timeout (rad 142–149), 30 s default med override via `SCOUT_REQUEST_TIMEOUT_MS`.
- **Fel exponerar inte interna detaljer** ✅ — `ScoutError` innehåller bara `message` och `statusCode`. `tryParseError` returnerar `ApiError` (code + message) — inga stacktraces eller filsökvägar vidarebefordras.
- **Credentials från env-vars** ✅ — Inga hårdkodade värden. Startup kastar tydliga fel vid saknade variabler.
- **`loginData64` skickas alltid via HTTPS** ✅ — HTTPS-kontrollen sker i konstruktorn, innan `login()` kan anropas. Base64-kodning av credentials är API-spec och inte ett val vi kan påverka.

---

### Implementationskrav (icke-blockerande men måste åtgärdas)

**1. `parseInt` av `SCOUT_REQUEST_TIMEOUT_MS` saknar validering (rad 47)**

```ts
this.timeoutMs = parseInt(process.env.SCOUT_REQUEST_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
```

Om env-variabeln sätts till ett icke-numeriskt värde returnerar `parseInt` `NaN`. `setTimeout(fn, NaN)` behandlas av V8 som `setTimeout(fn, 0)` — dvs. timeout avfyras omedelbart, varje request aborteras direkt. Ingen varning ges.

**Fix:** Lägg till en fallback:

```ts
const parsedTimeout = parseInt(process.env.SCOUT_REQUEST_TIMEOUT_MS ?? '', 10);
this.timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_TIMEOUT_MS;
```

---

### Observationer (icke-blockerande, inga åtgärder krävs)

- **`method`-parametern valideras inte** — `request(method, path, body)` skickar `method` direkt till `fetch`. Det är en intern API-yta som enbart anropas av verktygsmoduler med hårdkodade strängar (`'GET'`, `'POST'`, etc.), så risken är låg. Ingen åtgärd behövs om mönstret hålls.
- **Cookie-header interpolation** — `Cookie: ScoutBoardAuthJWT=${this.token}` är säkert eftersom JWT är base64url-kodat (alfanumeriskt + `.`, `-`, `_`) och inte kan innehålla tecken som bryter cookie-syntaxen.
- **Singleton-livscykel** — `_instance` rensas aldrig. Vid misstänkt kompromettering av token måste processen startas om. Acceptabelt för MCP-serverscenario, men bör dokumenteras i README.

---

## Final Code Review
Date: 2026-05-19
Resultat: SECURITY: FINAL APPROVED

### Code-level findings

**1. JWT never logged anywhere in src/ — PASS**
- `this.token` in `client.ts` is assigned, compared, and inserted into a Cookie header, but never passed to any logging call. Zero `console.*` calls exist anywhere in `src/`. Confirmed by exhaustive grep across all 13 source files.

**2. `confirm: true` enforced for factoryreset and halt — PASS**
- `command.ts` line 40: `if ((input.command === 'factoryreset' || input.command === 'halt') && input.confirm !== true)` returns a `fail()` response before the HTTP request is made. The check uses strict `!== true`, so `undefined`, `false`, and missing field all block execution. The tool description also contains an explicit `DESTRUCTIVE:` warning. Fully satisfies the design requirement.

**3. `SCOUT_BASE_URL` https:// check in client.ts constructor — PASS**
- `client.ts` lines 39–41: constructor throws `ScoutError('SCOUT_BASE_URL must use https://')` before any field is assigned. No login or request can proceed without a valid https:// base URL. The integration test suite verifies this check fires correctly (Phase 2a).

**4. TLS bypass uses dispatcher scoped to undici.Agent, NOT global NODE_TLS_REJECT_UNAUTHORIZED — PASS**
- `client.ts` lines 52–55: `new Agent({ connect: { rejectUnauthorized: false } })` is only created when `SCOUT_IGNORE_TLS === 'true'` and stored as `this.dispatcher`. The dispatcher is passed per-request via the fetch options object. `NODE_TLS_REJECT_UNAUTHORIZED` is set nowhere in `src/`. The same pattern is correctly replicated in `health.ts` `pingDirect()` (lines 57–61).

**5. `dotenv/config` only imported in index.ts — PASS**
- Only `src/index.ts` line 1 imports `dotenv/config`. No tool file imports dotenv. Confirmed by grep across all files.

**6. No `any` casts without an explaining comment — PASS**
- Three `as any` / `any` occurrences found: `client.ts:73`, `client.ts:122`, `health.ts:57`. All three are immediately preceded by an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment with `client.ts` additionally carrying an inline explanation (`// dispatcher cast: undici fetch accepts dispatcher but @types/node doesn't declare it`). No unexplained `any` casts exist. `z.any()` is not used anywhere.

**7. No hardcoded credentials, URLs, or tokens — PASS**
- All sensitive values (`SCOUT_BASE_URL`, `SCOUT_USERNAME`, `SCOUT_PASSWORD`) are sourced exclusively from `process.env` with mandatory presence checks that throw on startup. No literal credential strings, no hardcoded hostnames. The only URL construction is from `this.baseUrl` or `process.env.SCOUT_BASE_URL` with path suffixes.

**8. Error responses don't leak stack traces to MCP clients — PASS**
- `index.ts` lines 68–72: the top-level `CallToolRequestSchema` handler catches all errors and returns only `err.message` (for `Error` instances) or the string `'An unexpected error occurred'` for non-Error throws. Stack traces, file paths, and internal module names are never forwarded. All individual tool execute functions similarly catch errors and call `fail(err.message)`. No `.stack` property is accessed anywhere in `src/`.

**Previous implementation requirement (parseInt validation) — RESOLVED**
- The `parseInt` / `NaN` issue raised in the interim client review has been fixed in the final code. `client.ts` lines 47–50 now use `Number.isFinite(parsedTimeout) && parsedTimeout > 0` with a fallback to `DEFAULT_TIMEOUT_MS`. Requirement satisfied.

### Non-blocking observations

- **`applicationType` and `section` interpolated directly into URL paths** — In `application.ts` line 70 (`/api/v1/applications/${input.scope}/${input.applicationType}`) and `config.ts` line 55 (`/api/v1/configuration/${input.target}/${input.section}`), user-supplied strings are placed in the URL path without `encodeURIComponent`. Both `scope` and `target` are Zod `z.enum()` values and therefore safe. `applicationType` is a free-form `z.string()` and `section` is a free-form `z.string()`. A caller passing `applicationType: "citrix/../../../other"` could construct unexpected paths. Risk is low in practice because: (a) the server enforces its own routing and auth, (b) MCP callers are trusted AI clients, not anonymous users. Consider wrapping these segments with `encodeURIComponent()` in v2 as a defensive measure.

- **`diagnositics download_url` exposes a raw URL with the note to attach the auth cookie** — `command.ts` lines 112–116 return a downloadUrl string and a note telling the caller to use the `ScoutBoardAuthJWT` cookie. This is correct behaviour (binary download cannot go through MCP), but the returned URL contains no auth material itself. No security issue — just worth documenting in the README that the caller must handle cookie attachment correctly.

- **Test file imports `dotenv/config`** — `tests/integration.ts` line 1 imports `dotenv/config`. This is appropriate for a test runner that reads a local `.env` file in development; it does not affect production behaviour. Not a concern.

---

## Final Review — Full Codebase (Post-QA Pass)
Datum: 2026-05-19
Granskare: Säkerhetsagent
Resultat: **SECURITY: FINAL APPROVED**

### Alla ursprungliga godkännandekrav uppfyllda i levererad kod

| Krav | Status | Verifiering |
|------|--------|-------------|
| JWT in-memory only, aldrig loggad | ✓ | `private token: string | null = null` i `client.ts`; noll `console.*`-anrop i `src/` |
| TLS bypass per-request, ej global | ✓ | `undici.Agent` scoped till instans; `NODE_TLS_REJECT_UNAUTHORIZED` och `setGlobalDispatcher` används aldrig |
| Inga hårdkodade credentials eller URL:er | ✓ | Inga literaler utöver prefix-kontrollen `https://` |
| HTTPS-kontroll vid startup | ✓ | `client.ts:39–41` — kastar innan något fält tilldelas |
| `confirm: true` för `factoryreset` och `halt` | ✓ | `command.ts:40` — `!== true` blockerar `undefined`, `false`, och saknat fält |
| Noll `z.any()` utan motivering | ✓ | Grep bekräftar noll förekomster |
| Inga stack traces till MCP-klient | ✓ | `index.ts:68–72` returnerar bara `err.message`; inget `.stack` används |
| Destruktiva operationer har guard | ✓ | `ou.ts`, `device.ts` har `assertTestScope`; `device delete` blockad helt i testläge |
| `SCOUT_ENV` defaultar till production | ✓ | Testläge kräver explicit `SCOUT_ENV=test` |
| `.env` gitignorerad | ✓ | Bekräftat i `.gitignore` |
| `parseInt`-validering med fallback | ✓ | `client.ts:47–50` — `Number.isFinite` + positiv guard + fallback till `DEFAULT_TIMEOUT_MS` |

### Icke-blockerande fynd att åtgärda före merge

**1. `.env.example` innehåller riktig infrastruktur**
`SCOUT_BASE_URL` och `SCOUT_USERNAME` ska ha platshållarvärden i `.env.example`.
Åtgärd: byt till `https://your-scout-server:22160` och `admin@example.com`.

**2. Odokumenterade miljövariabler i `.env.example`**
`SCOUT_AUTH_MODE=basic` och `SCOUT_DIAGNOSTICS_PATH=./diagnostic` finns i `.env.example` men refereras inte i någon källfil och är inte dokumenterade. Bör tas bort.

### Observationer (inga åtgärder krävs)

- `applicationType` och `section` i URL-path-interpolation saknar `encodeURIComponent` — låg risk eftersom `scope`/`target` är Zod enum och servern har egen routing; rekommenderas i v2.
- `dotenv/config` laddas ovillkorligt även i produktion — no-op om ingen `.env` finns; acceptabelt.
- `as any`-casts i `client.ts:73,122` har förklarande kommentarer; undici-interop-problem känt och dokumenterat.
- Labels/rules/schedules/maintenance/notifications har `delete`-åtgärder utan DESTRUCTIVE-text i description — dessa är konfigurationsobjekt, ej enheter/OU:er, och täcks inte av guard-kravet. Rekommenderas i v2.

### Integrationstestverifiering

QA körde 23/23 tester mot live-server inklusive autentisering, OU-skrivoperationer scoped till `/MCP-Test`, cleanup i `finally`-block, och verifiering att token inte exponeras i felsvar.
