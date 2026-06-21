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

---

## Review: WS-D Phase 1 — Safety mode tiers, Base/root protection, blast-radius cap
Datum: 2026-06-21
Granskare: Säkerhet (självgranskning av eget arbete — branch `feature/safety-mode-tiers`)
Resultat: SECURITY: APPROVED (med kvarstående gap dokumenterade nedan)

### Scope för denna runda

Tre tidiga skyddsgrindar, landade INNAN RSoP/validation-arbetet börjar, så att framtida
write-kod föds bakom dem:

1. **SCOUT_MODE** (`read-only` default | `dry-run` | `write`) — global mutationsspärr.
2. **SCOUT_ALLOW_BASE_WRITES** — separat armeringsflagga för Base-scope/root-OU-skrivningar,
   oberoende av SCOUT_MODE.
3. **SCOUT_MAX_BLAST_RADIUS** — enhetstak per bulkoperation (default 25, hård cap 500).

Implementerat i `src/safety/guardrails.ts` som enda källa för all gate-logik, anropat från
`src/client.ts` (Gate 1, central funnel via `mutating`-flaggan på `request()`/`rawRequest()`)
samt direkt från verktygslagret (`config.ts`, `ou.ts`, `device.ts`, `workflow.ts`) för Gate 2
och Gate 3, eftersom endast verktygslagret känner till semantiskt scope (base/ou/device) och
det upplösta enhetsantalet.

### Godkänt

- **Gate 1 är en hård spärr, inte bara en varning** — `checkMutationAllowed` kastar
  `GuardrailError` i `read-only` (inklusive när `SCOUT_MODE` är ounset eller ogiltigt — fail
  closed, inte fail open). `dry-run` returnerar `proceed=false` utan att kasta, vilket låter
  verktyget köra sin read/plan-del och rapportera vad som SKULLE hända.
- **Gate 2 är explicit oberoende av Gate 1** — `checkBaseWriteAllowed` läser enbart
  `SCOUT_ALLOW_BASE_WRITES`, aldrig `SCOUT_MODE`. Verifierat med enhetstest
  ("Gate 2 is independent of SCOUT_MODE — write mode alone does not arm base writes").
  `SCOUT_MODE=write` ensamt kan alltså INTE skriva till Base/root.
- **Gate 3 har en hård cap som inte kan höjas via konfiguration** — `HARD_BLAST_RADIUS_CEILING`
  är en kodkonstant (500), `getBlastRadiusCap()` clampar alltid `SCOUT_MAX_BLAST_RADIUS` till
  detta tak. `overrideBlastRadius: true` kan höja över den konfigurerade cap men aldrig över
  hårdtaket — verifierat med enhetstest.
- **Root-OU-detektion är konservativ** — `isRootOuTarget` jämför mot en live `GET /api/v1/ou/root`-
  lookup (inte cachead vid anropstillfället i `ou_manage`) samt behandlar bar `"/"` som root
  oavsett vad root-lookupen returnerar — minskar risken att ett tomt/felaktigt root-svar tolkas
  som "inte root".
- **Fail-closed vid ogiltiga env-värden** — ogiltigt `SCOUT_MODE` faller tillbaka till
  `read-only` (säkraste läget), ogiltigt/negativt `SCOUT_MAX_BLAST_RADIUS` faller tillbaka till
  default (25), inte till hårdtaket. Verifierat med enhetstest.
- **27/27 enhetstester gröna**, körs utan live-server (`npm run test:unit`), och hela
  integrationstestsviten (`tsc --noEmit`) bygger utan fel efter ändringarna.

### Kvarstående gap — INTE blockerande för denna runda, men måste lösas innan
write-funktionalitet (RSoP-motorn, pre-write validation) bygger vidare på dessa grindar

1. **Inte alla skrivvägar är instrumenterade ännu.** Denna runda kopplade in gates i
   `config_update`, `ou_manage`, `device_manage`, `move_devices_by_filter`, `bulk_command`,
   och `onboard_branch`. Följande write-capable verktyg har INTE fått Gate 1 ännu:
   `ou_filter_manage` (`tools/ou_filtering.ts`), `application.ts`, `label.ts`, `rule.ts`,
   `schedule.ts`, `maintenance.ts`, `notification.ts`, `admins.ts`, `license.ts`,
   `server_instances.ts`, `db_cleanup.ts`, `update.ts`, `command.ts` (single-device
   `device_command`), `predefined_*.ts`, `system_settings.ts`. Dessa måste instrumenteras
   innan SCOUT_MODE kan beskrivas som en universell garanti — just nu är det en garanti för
   en delmängd av write-verktygen. Rekommendation: nästa PR ska grep:a `'POST'|'PUT'|'DELETE'|'PATCH'`
   i samtliga `tools/*.ts`-filer och lägga `mutating: true` på varje faktisk write-anrop
   (notera: vissa POST-anrop är read/search, t.ex. `search_with_config`, och ska INTE flaggas).
2. **`client.ts`s `mutating`-flagga är opt-in, inte enforced.** Eftersom flaggan måste skickas
   explicit av varje anropsställe finns ingen mekanism som upptäcker om en framtida write-kod
   glömmer `mutating: true`. En statisk lint-regel eller ett runtime-varningsläge
   ("denna POST/PUT/DELETE/PATCH saknar mutating-flagga") vore värt att lägga till i en
   senare fas.
3. **Blast-radius räknas bara där enhetsantalet redan upplöstes innan denna runda.**
   `move_devices_by_filter` och `bulk_command` hade redan en `device/search`-upplösning
   före mutationen, så Gate 3 kunde hakas på utan ny logik. `config_update` med `deviceIds`
   räknas direkt på array-längden. Men `config_update target=ou` och `device_manage` move/add
   räknar INTE antalet enheter som indirekt påverkas av en OU-flytt (en OU kan innehålla
   hundratals enheter; att flytta OU:n i sig är en enhetsoperation men en framtida RSoP-motor
   som expanderar config-inheritance till alla enheter i OU:n måste själv anropa
   `checkBlastRadius` med det upplösta antalet — denna gate skyddar inte automatiskt mot det.
4. **`overrideBlastRadius` är en blankocheck, som avsiktligt dokumenterat.** Ingen TTL, ingen
   bindning till den specifika upplösta enhetsmängden, inget replay-skydd. Markerat med TODO
   i `guardrails.ts` för WS-D-bekräftelsetoken-fasen. Får INTE användas av oövervakade/
   automatiserade anropare i nuvarande form.
5. **Root-OU-lookupen i `ou_manage` gör ett extra nätverksanrop per muterande anrop**
   (`GET /api/v1/ou/root`) för att avgöra om målet är root. Detta är korrekt ur säkerhets-
   synpunkt (ingen cache-baserad race mellan "är detta root" och den faktiska mutationen),
   men adderar latens. Acceptabelt för denna fas; om det blir ett prestandaproblem bör en
   kort TTL-cache (analog med `resolver.ts`s 5-minuters OU-cache) övervägas — med samma
   invalidering-efter-mutation-mönster som redan finns för `invalidateOuCache()`.
6. **Inget audit-spår av vem som satte `SCOUT_MODE=write` eller `SCOUT_ALLOW_BASE_WRITES=true`,
   eller när.** Detta är avsiktligt utanför scope för denna runda (audit log är en senare
   WS-D-fas) men flaggas explicit här så att Reviewer inte förväxlar "grindarna finns" med
   "grindarna är spårbara".

### Slutsats

Grindarna är korrekta för det de gör och är väl testade isolerat. De är INTE en fullständig
write-säkerhetslösning än — se gap 1–6 ovan. Godkänner denna runda som avsedd: tidig
scaffolding som framtida write-path-PR:er (RSoP-motor, pre-write validation) ska byggas
ovanpå och granskas mot. Kräver uppföljande PR(s) för full instrumentering av återstående
write-verktyg innan SCOUT_MODE kan kommuniceras som en universell garanti till slutanvändare.

---

## Review: Gate 1 gap closure — resterande write-verktyg instrumenterade
Datum: 2026-06-21
Granskare: Säkerhet (självgranskning, branch `feature/safety-mode-tiers`)
Resultat: SECURITY: APPROVED — gap 1 från föregående runda är nu stängt

### Scope för denna runda

Stänger gap 1 ovan: alla write-capable verktyg som saknade Gate 1 har nu fått
`checkMutationAllowed()` instrumenterat på exakt samma mönster som `config_update`,
`ou_manage`, `device_manage`, `move_devices_by_filter`, `bulk_command`, `onboard_branch`
(explicit anrop före HTTP-anropet, kortslutning med `status:'dry_run'` i dry-run,
`GuardrailError` fångas i catch och returneras som `fail('<tool> blocked: ' + msg)`,
samt `{ mutating: true, opName }` skickas in i `client.request()`/`rawRequest()` som
defence-in-depth).

### Filer/funktioner som fick Gate 1

- **`src/tools/ou_filtering.ts`** — `ou_filter_manage`: `set_settings`, `add`, `modify`,
  `delete` gated. `new_device_options`: `set` gated. (`get_settings`, `list`, `get` lämnas
  ogated — rena läsningar.)
- **`src/tools/application.ts`** — `app_manage`: `create`, `delete`, `copy`, `move`,
  `set_inheritance` gated. (`app_list`, `get_inheritance` lämnas ogated.)
- **`src/tools/label.ts`** — `label_manage`: `create`, `update`, `delete` gated.
  (`list`, `get` lämnas ogated.)
- **`src/tools/rule.ts`** — `rule_manage`: `create`, `update`, `delete`, `link_label`,
  `update_label_priority`, `unlink_label` gated. `validate` lämnas ogated — den anropar
  ett syntax-check-endpoint och muterar ingen regel.
- **`src/tools/schedule.ts`** — `schedule_manage`: `update`, `delete` gated.
  (`get_ou`, `get_device` lämnas ogated.)
- **`src/tools/maintenance.ts`** — `maintenance_window_manage`: `create`, `update`,
  `delete` gated. (`list` lämnas ogated.)
- **`src/tools/notification.ts`** — `notification_manage`: BÅDA `set` och `delete` gated
  (verktyget har inget rent läsläge — varje anrop muterar notifikationstillstånd).
- **`src/tools/admins.ts`** (HÖGRISK) — `admin_manage`: `add_admin`, `update_admin`,
  `delete_admin` gated. `update_rights` gated av försiktighet (triggar en server-side
  rättighetsuppdatering — oklara sidoeffekter, behandlad som muterande). (`list`,
  `permissions`, `advanced_rights`, `configuration_rights` lämnas ogated.)
- **`src/tools/license.ts`** — `license_manage`: `reconfigure` gated.
  (`get`, `check_availability` lämnas ogated.)
- **`src/tools/server_instances.ts`** — `server_instances`: `delete`, `modify` gated.
  (`list` lämnas ogated.)
- **`src/tools/db_cleanup.ts`** (HÖGRISK, privat/destruktiv endpoint) — `db_cleanup`:
  `delete` gated. (`list` lämnas ogated.)
- **`src/tools/command.ts`** — `device_command` (target=device/devicelist/ou/ddg):
  HELA verktyget gated på en gemensam plats (varje kommando muterar enhetstillstånd,
  oavsett target). `device_diagnostics` lämnas helt ogated — `trigger`/`poll`/
  `download_url`/`run` är alla läs-/pollnings-operationer mot ett asynkront
  insamlingsjobb, ingen av dem skriver enhetskonfiguration.
- **`src/tools/predefined_commands.ts`** — `predefined_commands`: `add`, `modify`,
  `delete`, `modify_templates` gated. `auth` gated av försiktighet (aktiverar
  kommandoexekvering server-side — oklar sidoeffekt). (`list`, `list_templates`
  lämnas ogated.)
- **`src/tools/predefined_paths.ts`** — `predefined_paths`: `add`, `delete` gated.
  (`list` lämnas ogated.)
- **`src/tools/system_settings.ts`** (HÖGRISK) — `system_settings`: `set_logging`,
  `set_discover`, `set_retain_local_config`, `set_device_name_options`,
  `set_recovery_settings`, `set_device_password` — ALLA `set_*`-actions gated, inga
  undantag. (`get_logging`, `get_discover`, `get_retain_local_config`,
  `get_device_name_options`, `get_recovery_settings` lämnas ogated.)

### Verktyg bekräftat som rena läsningar — medvetet INTE instrumenterade

- **`src/tools/predefined_images.ts`** — `predefined_images`: `list_images`, `list_uefi`.
  Endast GET mot kataloglistor, inga write-endpoints existerar i filen.
- **`src/tools/update.ts`** (`scout_update`) — `check` läser GitHub API (offentlig,
  inte Scout Board), `apply` returnerar enbart instruktionstext (docker-pull-kommando)
  utan att anropa Scout Board eller någon mutation. Ingen `getClient()`/`ScoutClient`-
  interaktion alls i denna fil.

### Verifiering

- `npx tsc --noEmit`: rent, inga typfel.
- `npm run test:unit`: 38/38 gröna (27 ursprungliga Gate 1–3-tester + 11 nya
  verktygsnivå-tester för `db_cleanup`, `admin_manage`, `system_settings`,
  `device_command` — read-only blockerar, dry-run kortsluter utan att nå
  `client.request()`/`rawRequest()`).
- Manuell granskning: varje ändrad fil grep:ad för kvarvarande `client.request(` /
  `client.rawRequest(` utan `{ mutating: true, ... }` på write-grenar — inga kvar
  inom scope för denna runda.

### Medvetna avgränsningsbeslut

- `rule_manage(validate)` behandlas som läsning trots POST — endpointen är ett
  syntax-check, ingen regel skapas eller ändras.
- `admin_manage(update_rights)` och `predefined_commands(auth)` behandlas som
  muterande trots oklar effekt på faktisk datalagring, eftersom uppgiften
  uttryckligen bad om strikt tolkning för `admins.ts` och eftersom båda har
  server-side sidoeffekter (rättighetscache-refresh respektive
  exekveringsbehörighet) som är svåra att klassificera som rena läsningar.
- `notification_manage` gated i sin helhet (en gemensam kodväg för `set`/`delete`,
  inget separat read-läge existerar att undanta).
- `device_command` gated i sin enda execute-funktion (en kodväg som hanterar alla
  fyra targets) snarare än duplicerad per-target, eftersom `target=device` är den
  enda parametriseringen som nämns explicit i uppgiften men resten av targets delar
  exakt samma muterande POST-anrop och därför rimligen ska omfattas av samma gate.

### Kvarstående gap (oförändrat sedan föregående runda, ej i scope här)

Gap 2–6 från föregående runda (lint-regel för glömd `mutating`-flagga, blast-radius
för indirekt OU-påverkan, `overrideBlastRadius` utan TTL/bindning, extra
nätverksanrop för root-OU-detektion, avsaknad av audit-spår) kvarstår oförändrade
och är inte adresserade av denna runda — de tillhör senare WS-D-faser.

### Slutsats

Gap 1 är stängt: samtliga write-capable verktyg i kodbasen har nu Gate 1. SCOUT_MODE
kan nu kommuniceras som en universell garanti för mutationsspärrning över hela
verktygsytan (med de kvarstående, redan dokumenterade begränsningarna i gap 2–6).

---

# Security Review — 2026-06-22

## Fas: Kod (feature/rsop-engine — config_update §3-validering + fleet-wide confirm, config_resolve, validation.ts)

## Status: SECURITY: APPROVED

## Granskat
- `src/tools/config.ts` (config_update): gate-ordning verifierad som
  checkMutationAllowed → checkBaseWriteAllowed → §3-validering (validateConfigWrite) →
  fleet-wide confirm-check → checkBlastRadius (endast bulk-path) → mutating request.
  `confirm=true` kan inte hoppa över validering eller mode/base-gates — de körs strikt
  före confirm-kontrollen i kodflödet. `skipValidation=true` påverkar enbart §3
  (schema-validering), inte Gate 1/2/3 i guardrails.ts.
- `overrideBlastRadius` är fortsatt korrekt begränsad av HARD_BLAST_RADIUS_CEILING
  (500) och påverkar bara bulk-deviceIds-grenen, oförändrat från tidigare granskning.
- `src/validation.ts`: ren modul, inga nätverksanrop i kärnlogiken, ingen secret-
  hantering. `apiSectionToSchemaSection` returnerar `null` (no-op, `valid: true`) för
  sektioner utan schema-mappning — dokumenterat med kommentar, inte en tyst bugg.
- `lookupRunningEluxVersion` är best-effort, fail-open till `undefined` (varning
  hoppas över, gissas aldrig) — korrekt och ofarligt eftersom sinceVersion-resultatet
  bara är en varning, inte en blockerande kontroll.
- `config_resolve.ts` / `config_compare` inheritance-aware modes: read-only (GET-anrop
  endast), ingen `mutating: true`, inget veto-behov.

## Nytt fynd — INTE blockerande, men dokumenteras
**OU-scope-writes (`target=ou`) saknar en faktisk blast-radius-beräkning.** Gate 3
(`checkBlastRadius`) anropas bara i bulk-deviceIds-grenen. Single-target-grenen har
kommentaren "count = 1, never exceeds the default cap" — det är korrekt för
target=device/base, men felaktigt för target=ou: en enda OU-skrivning ärvs av alla
underliggande enheter och kan i praktiken vara den största blast-radius som finns i
API:et. Det enda skyddet för OU-scope idag är `confirm: true`, vilket är en boolean
utan koppling till faktiskt antal påverkade enheter (ingen "X enheter påverkas,
bekräfta" — modellen kan sätta confirm=true blint).

Detta är **samma gap som redan är noterat och accepterat i föregående rundas
"Kvarstående gap"-lista** ("blast-radius för indirekt OU-påverkan") och tillhör
uttryckligen en senare WS-D-fas. Jag bekräftar att den här branchen inte gör gapet
värre och inte introducerar något sätt att kringgå confirm-gaten — den lägger bara
till confirm ovanpå ett redan känt och accepterat hål. Blockerar inte denna PR.

## Bedömning av rapporterade "feature gaps"
- **Sektioner utan schemamappning (Browser<n>, Store<n>, !NETDRIVE!#) hoppar §3-
  validering**: detta är en täckningslucka, inte en bypass av säkerhetsgates.
  Dessa skrivningar passerar fortfarande Gate 1 (mode), Gate 2 (base-write) och
  fleet-wide confirm-gaten precis som alla andra sektioner — de saknar bara
  typ/intervall-validering av värdet. Accepteras som feature-completeness-gap,
  inte ett säkerhetsproblem.
- **lookupRunningEluxVersion gissar properties utan att verifieras mot en
  enhet**: fail-open till "hoppa varningen", aldrig fail-open till "skriv ett
  ogiltigt värde". Inte ett säkerhetsproblem.

## Rekommendationer (icke-blockerande)
- Nästa WS-D-fas bör beräkna faktiskt antal enheter under en OU (t.ex. via
  device_get/sub-OU-walk) innan `target=ou`-skrivningar tillåts, och köra det
  resultatet genom `checkBlastRadius` precis som bulk-deviceIds-grenen — annars är
  confirm-gaten för OU-scope kosmetisk jämfört med den kvantitativa cap som
  device-bulk får.

---

# Security Review — 2026-06-22 (runda 2)

## Fas: Kod (feature/safety-full, baserad på feature/rsop-engine — WS-D runda 2: kill
switch, circuit breaker, protected/allowed OU-listor, private-writes-i-produktion,
audit log, snapshot-before-mutate, samt stängning av OU-blast-radius-gapet ovan)

## Status: SECURITY: APPROVED

## Stängt gap (från föregående runda)
**OU-scope blast-radius.** `src/tools/config.ts` (`config_update`, `target=ou`) löser
nu OU:n tidigt (`resolveOuRef`), kör `checkOuWriteAllowed` mot den faktiska path:en,
och anropar den nya `countDevicesUnderOu(resolvedOuId)` (i `src/resolver.ts`) — som
går igenom hela OU-subträdet (via samma cachade OU-strukturanrop som `getOuChain`)
och summerar `/api/v1/device/search`-resultat per OU med wildcard `%`
(per projektminnet: `includeSubOus` rekurserar inte tillförlitligt, så fan-out görs
manuellt) — och kör resultatet genom samma `checkBlastRadius()` som bulk-grenen
använder, **innan** skrivningen tillåts. `confirm: true` är därmed inte längre den
enda spärren för OU-scope; den kvantitativa cap:en (default 25, hård cap 500,
`overrideBlastRadius` för att höja upp till cap:en) gäller nu lika för target=ou som
för bulk deviceIds. Verifierat via statisk testning
(`tests/rsop-readonly.test.ts`: `checkOuWriteAllowed` körs före confirm-gaten;
`countDevicesUnderOu` följs av `checkBlastRadius`) — ingen live-anslutning krävs.

**Känd kvarstående svaghet i denna fix:** `countDevicesUnderOu` är "best effort" —
en OU i subträdet vars `/device/search`-anrop kastar fel räknas som 0 enheter för
den OU:n (loggas till stderr, avbryter inte hela räkningen). Detta är medvetet
dokumenterat i koden som en avvägning i FEL riktning för en säkerhetsgate (en
underskattning kan släppa igenom en skrivning som borde ha stoppats av cap:en).
Jag bedömer detta som en acceptabel, dokumenterad brist för denna runda — alternativet
(abort hela skrivningen vid en enskild flckig sub-OU) skulle göra en ofarlig
nätverksglitch till en hård blockering av en annars legitim skrivning — men det är
inte en perfekt garanti och bör noteras för framtida granskning om Scout Board-API:et
visar sig vara flakey i produktion.

## Granskat — nya gates (alla i src/safety/guardrails.ts, samma chokepoint-modul)

- **Gate 4 (kill switch, `SCOUT_KILL_SWITCH_FILE`):** `isKillSwitchEngaged()` gör en
  färsk `existsSync` per anrop (ingen cache), och fail-closed vid filsystemfel
  (behandlas som engaged om `existsSync` självt kastar). `checkKillSwitch` körs allra
  först i `checkMutationAllowed`, före mode-gaten — så kill switch slår igenom även
  om `SCOUT_MODE=write`. Verifierat med test som explicit sätter `SCOUT_MODE=write`
  och bekräftar att kill switch fortfarande blockerar.
- **Gate 5 (circuit breaker, `SCOUT_CIRCUIT_BREAKER_MAX_OPS` /
  `_WINDOW_SECONDS`):** in-memory sliding window, trippas vid `> max` (inte `>=`)
  inom fönstret. Re-arm är **inte** tidsbaserat automatiskt — kräver explicit
  `resetCircuitBreaker()` (eller processomstart). Detta är ett medvetet
  designval (dokumenterat i kodkommentar och README): ett rent tidsbaserat
  cooldown skulle låta en agent i en oändlig loop bara vänta ut fönstret och
  återuppta mutationer utan mänsklig inblandning — explicit re-arm tvingar ett
  beslut. Avvägningen är operationell friktion: om ingen anropar
  `resetCircuitBreaker()` förblir servern skriv-blockerad till nästa
  processomstart. Detta är dokumenterat ärligt, inte dolt.
- **Gate 6 (protected/allowed OU, `SCOUT_PROTECTED_OUS` / `SCOUT_ALLOWED_OUS`):**
  matchning är path-segment-baserad (`isSameOrDescendant`), inte rå strängprefix —
  `/Enterprise/Production2` matchar INTE mot skydd av `/Enterprise/Production`.
  Domslut: en protected OU skyddar **hela sitt subträd**, inte bara exakt den noden
  — dokumenterat i kod och README med motivering (annars vore skydd av en OU men
  inte dess barn nästan meningslöst för det vanliga fallet). Känd begränsning:
  det finns inget sätt att skydda enbart en nods egen config men lämna barnen
  skrivbara i denna runda. Deny-listan vinner alltid över allow-listan vid overlap.
  Rotskydd (`SCOUT_PROTECTED_OUS=/`) blockerar allt, verifierat med test.
  **Detta gate är for närvarande endast inkopplat i `config_update` (target=ou)** —
  det är inte ännu trådat genom `device_manage`(move), `move_devices_by_filter`,
  eller `ou_manage`(delete/move), som också kan skriva mot en OU-scope. Detta är en
  täckningslucka för denna runda, inte en bugg i gaten själv — se "Kvarstående gap"
  nedan.
- **Gate 7 (private writes i produktion,
  `SCOUT_ALLOW_PRIVATE_WRITES_IN_PRODUCTION`):** no-op när `SCOUT_MODE` är
  `read-only`/`dry-run` (Gate 1 täcker redan dessa lägen) — gaten är specifikt
  riktad mot `SCOUT_MODE=write`. Inkopplad i `db_cleanup`(delete),
  `system_settings`(alla `set_*`-actions, inte bara `set_device_password` — tolkat
  brett enligt uppgiftens formulering "system_settings writes"), och
  `admin_manage`(delete_admin). Verifierat att `false`/unset behandlas lika
  (båda blockerar).
- **Gate 8 (audit log, `SCOUT_AUDIT_LOG_PATH`):** `appendFileSync` med `flag: 'a'`
  — aldrig `'w'`, aldrig trunkerar. Katalogen skapas vid första skrivningen om den
  saknas. Skrivfel till loggen sväljs (loggas till stderr) snarare än kastas — en
  trasig audit-logg får aldrig bli ett nytt sätt att blockera en i övrigt korrekt
  gate-bedömning. `actor`-fältet rapporterar ärligt `"unknown"` om
  `SCOUT_AUDIT_ACTOR` inte är satt — ingen gissning, eftersom denna kodbas (stdio,
  en session per process) inte har någon per-anrop MCP-klientidentitet att luta sig
  mot. Verifierat med riktiga filskrivningar i temp-katalog, läst tillbaka och
  parsead som JSON i testerna.
- **Gate 8b (snapshot-before-mutate, `SCOUT_SNAPSHOT_DIR`):** skriver med
  `flag: 'wx'` (failar om filen redan finns — kollision är extremt osannolik given
  timestamp+target i filnamnet, men hellre fail-loud än att tyst skriva över en
  tidigare snapshot). Inkopplad i `config_update` för fleet-wide writes
  (`target=ou` eller multi-device `deviceIds`), tas innan den muterande anropet
  körs (eller hoppas över i dry-run, vilket är ofarligt). Push till git är
  explicit INTE implementerad denna runda (per uppgiftens scope) — dokumenterat
  som framtida möjlighet i kodkommentar.

## Nytt fynd — INTE blockerande, men dokumenteras

**Gate 6 (protected/allowed OU) är inte trådad genom alla OU-skrivande verktyg.**
Som nämnt ovan är `checkOuWriteAllowed` bara inkopplad i `config_update`. Verktyg som
`device_manage`(action=move, destination=OU), `ou_manage`(action=delete/move), och
`move_devices_by_filter` kan också flytta enheter till eller radera en OU, och
passerar idag INTE genom protected/allowed-OU-kontrollen. Detta är ett nytt,
namngivet gap (inte samma som den stängda OU-blast-radius-luckan ovan) och bör
adresseras i en kommande runda — annars är `SCOUT_PROTECTED_OUS` en partiell garanti
("skyddar OU-config-skrivningar men inte OU/device-flytt/radering"), vilket bör
kommuniceras tydligt om denna server driftsätts med en deny-list som operatören
litar på fullt ut. Blockerar inte denna PR eftersom uppgiften för denna runda
explicit avgränsade scope till `config_update`-flödet och guardrails-modulen; men
det är en verklig lucka, inte en hypotetisk.

## Bedömning av cirkelbrytarens re-arm-design
Tidsbaserad-only re-arm avvisades medvetet till förmån för explicit re-arm. Detta är
korrekt ur ett "stoppa en agent i en oändlig loop"-perspektiv, men introducerar en
operationell risk i motsatt riktning: om servern körs obevakat och ingen extern
mekanism anropar `resetCircuitBreaker()`, förblir den permanent skriv-blockerad efter
en enda trippning tills processen startas om. Detta är ett medvetet, dokumenterat
val — inte ett förbiseende — men noteras här explicit eftersom det är den typen av
avvägning som bör vara synlig för en driftsättande operatör, inte bara begravd i en
kodkommentar.

## Verifiering
- `npx tsc --noEmit`: rent, inga typfel.
- `npm run test:unit`: 100/100 gröna totalt (38 Gate 1–3 + tool-wiring från tidigare
  rundor, 7 RSoP, 14 validation, 5 read-only/gate-wiring inkl. 2 nya för
  OU-blast-radius-stängningen, 36 nya för runda 2-gates: kill switch, circuit
  breaker, protected/allowed OU, private-writes-i-produktion, audit log, snapshot).
- Manuell granskning: samtliga nya gate-funktioner i guardrails.ts grep:ade för att
  bekräfta de anropar `auditLog` vid refusal, och att inget nytt ad-hoc env-var-check
  smugit sig in utanför guardrails.ts (per uppgiftens chokepoint-krav).

## Slutsats
Det tidigare dokumenterade OU-blast-radius-gapet är stängt. Sex nya gates (4–7 plus
8/8b) är inkopplade genom samma chokepoint-modul. Ett nytt, mindre gap identifieras
och dokumenteras ärligt ovan (Gate 6 inte trådad genom device/ou-manage-verktygen) —
detta blockerar inte denna runda eftersom det låg utanför explicit scope, men ska
inte glömmas bort. APPROVED med detta gap som öppet, namngivet uppföljningsobjekt.
