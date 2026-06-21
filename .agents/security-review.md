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

---

## Uppföljning — Gate 6 trådad genom device_manage/ou_manage/move_devices_by_filter

Detta stänger det gap som dokumenterades i föregående sektion ("Gate 6 är inte
trådad genom alla OU-skrivande verktyg"). `checkOuWriteAllowed` (samma
chokepoint-funktion i `src/safety/guardrails.ts`, ingen ny gate-logik) är nu
inkopplad i:

- **`device_manage`(action=move):** kontrollerar BÅDA sidor av flytten — den
  upplösta destinationen (`destoupath`/`destouRef`/`destouid`) OCH enhetens
  nuvarande OU (slås upp via `device_get`-motsvarande `/api/v1/device`-anrop på
  enhetens identifierare, sedan `resolveOuRef(OUID)` mot OU-trädet). Motivering:
  att flytta en enhet UT från en skyddad OU ändrar vilken config den ärver precis
  lika mycket som att flytta en IN — ett gate som bara kollade destinationen hade
  låtit en agent tömma en skyddad OU på enheter utan att någon gate reagerade.
  `action=add` kontrollerar destinationen (samma path-upplösning som move, men
  utan källkontroll eftersom add inte har någon källa).
- **`ou_manage`(action=delete):** kontrollerar mål-OU:n (den som raderas).
  **`ou_manage`(action=move):** kontrollerar BÅDA mål-OU:n (den som flyttas,
  med hela sitt subträd) OCH destinations-OU:n. `rename`/`converttobase`/
  `structure_import` kontrolleras INTE av detta gate — rename ändrar inte
  subträdets position/arv, converttobase och structure_import bedömdes ligga
  utanför ramen för "flytta/radera en OU" som uppgiften specificerade; detta är en
  medveten avgränsning, inte ett förbiseende, men noteras explicit ifall en framtida
  runda vill bredda gatet ytterligare.
- **`move_devices_by_filter`:** kontrollerar destinations-OU:n OCH **varje unik
  OU som någon av de faktiskt matchade enheterna befinner sig i** — inte bara den
  sourceOuPath/sourceOuId som anroparen angav som sökrot. Detta är medvetet:
  med `includeSubOus=true` kan sökroten matcha enheter spridda över många olika
  OU:er i subträdet, och en enskild enhet kan sitta i en skyddad ättling-OU även om
  sökroten själv inte är skyddad. Implementationen läser varje matchad enhets
  `OUID`-fält (samma fält `device_get`/`device/search` redan returnerar per enhet,
  inget nytt API-anrop krävs utöver den sökning som redan görs), deduplicerar, och
  kör `checkOuWriteAllowed` för varje unik upplöst path. Skrivningen blockeras om
  NÅGON av dessa källor — eller destinationen — är skyddad. Detta var den punkt
  uppgiften flaggade som möjligen "infeasible utan extra API-anrop" — i praktiken
  krävdes inget extra anrop, eftersom OUID redan finns i samma sökresultat som
  `move_devices_by_filter` redan hämtar för att räkna `matched`/bygga
  flytt-listan. Gapet är alltså helt stängt, inte delvis.

### Vad som INTE är inkopplat (medvetna avgränsningar, inte glömda)
- `ou_manage`(rename/converttobase/structure_import) — se ovan.
- `bulk_command` — skickar kommandon till enheter, flyttar/raderar inga OU:er eller
  enheter mellan OU:er, så protected-OU-gatet (som handlar om var en enhet/OU
  *sitter*, inte vilka kommandon den tar emot) är inte relevant för det verktyget.
  Detta nämndes inte i uppgiftens scope och är heller inte en del av "OU write"-
  ytan detta gate skyddar.

### Verifiering
- `npx tsc --noEmit`: rent, inga typfel.
- `npm run test:unit`: **110/110 gröna** (100 tidigare + 10 nya i
  `tests/protected-ou-wiring.test.ts`). De 10 nya testerna körs mot en riktig
  in-process HTTPS-stand-in för Scout Board (self-signed cert genererad via
  `openssl` vid testkörning, `ignoreTls: true` i testsessionen) — inte mot
  handvikta stubbar av gatet självt. Varje test verifierar BÅDE att tool-anropet
  returnerar ett fel som nämner "protected", OCH att den muterande HTTP-anropet
  (`PUT /device/move`, `DELETE /ou`, etc.) aldrig nådde den fejkade servern —
  dvs. gatet kastar INNAN något skrivande HTTP-anrop görs, inte efter.
- Sidoeffekt upptäckt under testskrivning, inte en del av detta gates ändring:
  `device.ts`s `extractSearchDevices` och `workflow.ts`s `extractDevices` förväntar
  sig olika svarskuvert-format för samma `/api/v1/device/search`-endpoint
  (`{response:{status:{msg:[...]}}}` respektive `{Devices:[...]}` m.fl. nycklar).
  Detta är en pre-existing inkonsekvens i kodbasen, inte introducerad av denna
  ändring — flaggas här för synlighet men ligger utanför detta gates scope att
  fixa.

## Status: SECURITY: APPROVED — Gate 6-luckan från föregående runda är nu stängt

Samtliga tre verktyg uppgiften namngav (`device_manage` move, `ou_manage`
delete/move, `move_devices_by_filter`) är nu trådade genom samma
`checkOuWriteAllowed`-chokepoint som `config_update` redan använde, med
källa-OCH-destination-kontroll där relevant. Inget nytt gap kvarstår inom det scope
uppgiften definierade. De avgränsningar som finns (rename/converttobase/
structure_import i ou_manage, bulk_command) är dokumenterade ovan som medvetna,
inte glömda.

---

## 2026-06-22 — Independent Security re-review of feature/safety-full (WS-D round 2 + protected-OU wiring)

Reviewed `git diff feature/rsop-engine..feature/safety-full`, `src/safety/guardrails.ts`, `src/tools/device.ts`,
`src/tools/workflow.ts`, `src/tools/ou.ts`, and the two prior self-review entries. This is independent
verification, not a rubber-stamp of the implementer's own conclusions.

### Confirmed correct
1. **Gate order in `checkMutationAllowed`**: kill switch (`checkKillSwitch`) and circuit breaker
   (`checkCircuitBreaker`) run first, unconditionally, before the mode-tier check — confirmed by reading
   the function body directly (guardrails.ts:113-146). Neither can be bypassed by an otherwise-valid write.
2. **Circuit breaker re-arm**: `resetCircuitBreaker()` is not called anywhere in `src/` outside its own
   definition and the test-only `__resetCircuitBreakerStateForTests()`. No auto-cooldown, no exploitable
   reset path. Confirmed via grep across `src/`.
3. **Audit log on refusal**: every throwing gate (mode, kill-switch, circuit-breaker, protected-ou,
   private-write-production) calls `auditLog({ result: 'refused', ... })` before throwing. Confirmed by
   reading each gate function body — not just trusting the comments.
4. **device_manage(move) and move_devices_by_filter wiring**: `checkOuWriteAllowed` is called before the
   mutating `client.request(...)` in both tools (device.ts:342-371 before the PUT at line 443;
   workflow.ts:296-311 before the PUT loop at line 340). Order is correct in both.

### BLOCKING FINDING — fail-open gap in move_devices_by_filter source-OU resolution

The two prior self-review entries acknowledge but mischaracterize a severity-relevant bug as a cosmetic
"pre-existing inconsistency, out of scope." It is not cosmetic — it defeats the very gate this branch
claims to have closed:

- `src/tools/device.ts`'s `extractSearchDevices()` reads devices from the envelope
  `{response:{status:{msg:[...]}}}`.
- `src/tools/workflow.ts`'s `extractDevices()` (used by `move_devices_by_filter`) reads from a flat array
  or one of `{Devices,devices,Items,items,Results,results,data}` — a different shape entirely.
- The new test fixture (`tests/protected-ou-wiring.test.ts` lines 161-171) admits this directly in a code
  comment and serves **two different fake response shapes from the same fake endpoint** so that both
  callers' parsers "succeed" in the test. This proves the test never exercises the real failure mode.

Trace the actual consequence in `workflow.ts`:
- `moveDevicesByFilterExecute` calls `extractDevices(searchResp)` → `devices`.
- `resolveDistinctSourceOuPaths(devices)` reads `deviceOuId(d)` per device, filters out devices where it's
  `undefined`, resolves the rest, and returns the resulting path list.
- The protected-OU loop (`for (const sourcePath of sourcePaths) checkOuWriteAllowed(...)`) only runs for
  paths that were resolved. If `extractDevices` returns the wrong shape against the real API (i.e. if the
  real `/api/v1/device/search` actually wraps responses in `response.status.msg` the way `device.ts`
  assumes), `devices` is `[]`, the early-return on line 280-282 fires ("No devices matched"), and the
  bulk move silently no-ops — relatively safe, but masks a real result as "no matches" without surfacing
  that the parser is broken.
- The more dangerous case: if the real envelope is something in between, or `extractDevices` matches a
  non-empty array via one of its many guessed keys but those records lack the literal `OUID`/`ouId`/`OuId`
  fields `deviceOuId()` checks for, `devices.length > 0` (so blast-radius and the main loop proceed), but
  `resolveDistinctSourceOuPaths` returns `[]` — **zero source-OU protected checks run, and the bulk move
  proceeds to actually move devices** with only the destination OU checked. This is a fail-open path, not
  fail-closed: nothing throws, nothing logs a refusal, the move just goes through as if no source devices
  were ever in a protected OU. Given `device_manage`(move)'s analogous single-device source lookup
  (`resolveCurrentDeviceOuPath` in device.ts) uses a single-device GET endpoint and a different code path,
  it is not affected — this finding is specific to `move_devices_by_filter`'s bulk source-resolution path.

This must be fixed before merge:
1. Determine the actual `/api/v1/device/search` response envelope against a real Scout Board instance (or
   from existing passing integration evidence elsewhere in the codebase) and make `extractDevices` in
   workflow.ts and `extractSearchDevices` in device.ts agree — one parser, one source of truth, shared
   helper if both files need it.
   the live shape, the protected-OU check for `move_devices_by_filter` must fail closed (refuse the bulk
   move) rather than silently proceeding with zero source-OU checks. A bulk move with unresolvable source
   OUs is exactly the case this gate exists to catch — it must not be the case that silently bypasses it.
3. Remove or rewrite the test fixture in `tests/protected-ou-wiring.test.ts` that serves two different
   envelope shapes for the same endpoint — it currently guarantees the test suite can never catch this
   class of bug, which is worse than not testing it at all (false confidence).

## Status: SECURITY: BLOCKED

Kill switch, circuit breaker, audit-on-refusal, and the device_manage(move)/ou_manage gate ordering are
all correctly implemented and independently verified. However, the `move_devices_by_filter` protected-OU
check has a fail-open gap rooted in the unresolved device-search envelope-format inconsistency between
device.ts and workflow.ts — confirmed by the test fixture's own admission that it fakes two shapes to make
both pass. This is the bulk/multi-device write path, i.e. the highest blast-radius tool covered by this
gate, so the gap is not acceptable to ship. Must be fixed (real envelope confirmed + fail-closed fallback
+ test fixture corrected) before this branch proceeds.

---

## 2026-06-22 (later same day) — Fix for the BLOCKED finding: unified device-search parser + fail-closed protected-OU gate

Addresses the independent re-review's BLOCKING FINDING above. All three required fixes plus
both QA follow-ups (one fixed, one explicitly deferred) are described below with exact file
references so this can be re-verified without re-deriving the reasoning.

### 1. Real `/api/v1/device/search` envelope shape — confirmed from openapi.json

Searched openapi.json directly for the `/api/v1/device/search` path's documented response
example (the spec's own ground truth, not either existing parser's assumption):

```
{
  "code": 200,
  "message": "OK",
  "response": {
    "status": {
      "result": 0,
      "msg": {
        "visibleDevices": [
          { "ClientIdentifier": "...", "Name": "DEVICE-00001" },
          { "ClientIdentifier": "...", "Name": "DEVICE-00002" }
        ],
        "hiddenDevices": 0
      }
    }
  }
}
```

Key correction versus BOTH prior parsers: `response.status.msg` is an OBJECT carrying
`visibleDevices` (the array) and `hiddenDevices` (a count) — it is neither an array itself
(device.ts's old `extractSearchDevices` assumption) nor one of the flat/`{Devices,...}` shapes
workflow.ts's old `extractDevices` guessed. Neither prior parser matched the documented schema
at all.

Also confirmed: the documented example does **not** show any OU-id field (e.g. OUID) on
individual device records returned by search — the example only has `ClientIdentifier`/`Name`.
This is why the fix below treats "no per-device OU id" as an expected, schema-legal case that
must fail closed, not as evidence of a bug to special-case away.

### 2. Unified parser — `src/devices.ts` (new file)

Created `src/devices.ts` as the single source of truth for parsing this response, replacing
THREE independent copies that existed across the codebase (the two the prior review found,
plus a third in `src/resolver.ts` that had the same bug and wasn't part of the original
finding):

- `parseSearchDevices(raw)` — returns `{ok:true, devices, hiddenDevices}` on a schema-matching
  response, or `{ok:false, reason}` (never throws, never silently coerces) when the shape
  doesn't match.
- `extractSearchDevices(raw)` — convenience wrapper returning `devices` on success or `[]` on
  parse failure, for callers where "couldn't parse" and "zero matches" are both safe to treat
  as "nothing to do" (e.g. `device_get(search)`, `bulk_command`, `countDevicesUnderOu`'s
  per-OU device count where the *aggregate* function now fails closed around it instead — see
  point 3b).
- `deviceName(d)` / `deviceOuId(d)` — field accessors, same names/semantics as before.

Call sites updated:
- `src/tools/device.ts` — local `extractSearchDevices` deleted, now imports from `devices.ts`.
- `src/resolver.ts` — local `extractSearchDevices` deleted (this was the third, previously
  unflagged copy), now imports `parseSearchDevices` from `devices.ts` for `countDevicesUnderOu`.
- `src/tools/workflow.ts` — local `extractDevices`/`deviceOuId` deleted, now imports
  `parseSearchDevices`/`deviceOuId`/`extractSearchDevices` from `devices.ts`. `bulk_command`
  (no protected-OU dependency) uses the non-throwing `extractSearchDevices`; `move_devices_by_filter`
  uses new throwing wrappers (point 3).

### 3. Fail-closed protected-OU gate in `move_devices_by_filter` (src/tools/workflow.ts)

Two new throwing helpers replace the old best-effort `extractDevices`/`resolveDistinctSourceOuPaths`
for this tool specifically (bulk_command keeps best-effort parsing — it has no source-OU gate,
so degrading to "no devices matched" on a bad response can't bypass anything):

- `extractDevicesOrThrow(raw)` — throws `GuardrailError('unresolvable-source-ou')` if the
  response doesn't match the documented envelope at all (parse failure), instead of returning
  `[]`. A parse failure must never look like "no devices matched."
- `resolveDistinctSourceOuPathsOrThrow(devices)` — throws `GuardrailError('unresolvable-source-ou')`
  if ANY matched device has no resolvable OU id (not just "all of them" — a partial resolution
  is treated as a failure too, since an unresolved device's source OU is exactly the gap the
  gate exists to catch), or if an OU id present on a device can't be resolved against the live
  OU tree. Both throw sites also call `auditLog({..., result: 'refused', gate: 'unresolvable-source-ou'})`
  before throwing, so the refusal is recorded the same way every other gate's refusal is.

Added `'unresolvable-source-ou'` to `GuardrailError`'s `gate` union in `src/safety/guardrails.ts`
so this is a typed gate like the other seven, not a generic Error.

`moveDevicesByFilterExecute`'s existing outer try/catch (already present, unchanged) catches
`GuardrailError` and returns `fail('move_devices_by_filter blocked: ...')` — same path every
other gate refusal in this tool already used, so no new error-handling plumbing was needed
there.

Net effect: the previously fail-open case (devices matched, but the gate can't determine any
of their source OUs) now refuses the entire move with a clear message and an audit-logged
refusal, instead of proceeding with zero source-OU checks.

### 4. Test fixture fixed — `tests/protected-ou-wiring.test.ts`

The `/device/search` handler in the fake server now serves exactly ONE envelope shape — the
real, schema-accurate `response.status.msg.{visibleDevices,hiddenDevices}` shape — to every
caller, instead of the previous two-different-shapes-for-two-different-callers setup that the
prior review correctly identified as guaranteeing this bug class could never be caught.

Added a new test: **"FAIL CLOSED: malformed/unparseable device-search response refuses the
move (no source-OU bypass)"**. It flips a new `malformedSearchResponse` flag so `/device/search`
returns a response with no `response/status/msg` wrapper at all, then calls
`move_devices_by_filter` with an otherwise completely unprotected source and destination (the
case that would look totally safe if the old fail-open bug were still present). Asserts:
  - the tool call returns `isError: true` with a "could not parse/determine" message, and
  - the `/device/move` HTTP endpoint is NEVER called.

This is exactly the trace the independent review walked through by hand (devices matched, but
the gate's source-OU resolution silently returns `[]`) — now it's a thrown refusal instead.

### QA follow-up 1 — `countDevicesUnderOu` fail-open (src/resolver.ts) — FIXED

Previously: per-sub-OU search errors were caught and treated as 0 devices for that OU (logged
to stderr), so a transient failure could silently undercount and let a blast-radius-capped
write through that should have been blocked.

Now: both an HTTP error AND a parse failure (via the same `parseSearchDevices` used above) on
any sub-OU's search call throw immediately, aborting the whole count with a clear error
message naming the failing OU. `countDevicesUnderOu`'s only caller (`config.ts`'s
`configUpdateExecute`, inside its own try/catch) already propagates a thrown error to a
`fail()` result, so no caller-side change was needed — confirmed by reading `src/tools/config.ts`
lines ~204-211 and its outer catch at line 329.

### QA follow-up 2 — generic chokepoint audit logs `target: 'unknown'` — NOT FIXED, deferred

`checkMutationAllowed(opName)` is called from 54 sites across `src/tools/*.ts` with only an
`opName` string; the function itself has no `target`/blast-radius parameter to thread through,
which is why its own `auditLog()` calls (guardrails.ts lines ~122, 131, 143) always log
`target: 'unknown'` for Gates 1/4/5 refusals. Making this informative would require either (a)
adding a second parameter to `checkMutationAllowed` and updating call sites that have a
meaningful target/count available to pass it (most do, by the time they call it), or (b)
moving the call later in each tool after target resolution — neither is a one-line change, and
with 54 call sites touching nearly every tool file, this is a genuine refactor, not the "quick
fix" the review explicitly gated this follow-up on. Left as-is per the review's own
instruction ("if a quick fix, do it; if it requires a larger refactor, leave it and say so
explicitly"). Not blocking — Gates 2/3/6/7's own dedicated `checkOuWriteAllowed`/
`checkBlastRadius` audit calls already carry real target/count context; only the generic
Gate 1/4/5 chokepoint is affected.

### Verification

```
npx tsc --noEmit                 → exit 0, no errors
npm run test:unit                → 111 passed, 0 failed across all 6 suites:
  tests/guardrails.test.ts          38 passed
  tests/rsop.test.ts                 7 passed
  tests/validation.test.ts          14 passed
  tests/rsop-readonly.test.ts        5 passed
  tests/safety-round2.test.ts       36 passed
  tests/protected-ou-wiring.test.ts 11 passed (incl. the new fail-closed test)
```

## Status: Awaiting re-review (fixes complete, branch not merged)

All three required fixes from the BLOCKED finding are implemented (real envelope confirmed,
single unified parser across all three previously-divergent call sites, fail-closed gate with
audit logging, test fixture corrected + new regression test added). QA follow-up 1
(`countDevicesUnderOu` fail-open) is fixed. QA follow-up 2 (generic chokepoint target context)
is explicitly deferred as a larger refactor, not attempted. Not pushed, not merged — awaiting
Security re-verification.

---

## 2026-06-22 (re-review) — SECURITY: APPROVED

Independently re-verified commit ef791c5 on `feature/safety-full` against my own BLOCKED finding. Did not trust the report — re-derived each claim from source.

1. **Schema match confirmed.** Grepped openapi.json's `/api/v1/device/search` 200 example directly (line ~31190): `response.status.msg.{visibleDevices,hiddenDevices}`. `src/devices.ts`'s `parseSearchDevices` checks exactly this nested shape (object, not array, at each level) before returning devices — matches the real schema, not just "changed from before."

2. **Single shared parser confirmed.** `device.ts`, `resolver.ts`, and `workflow.ts` all import `extractSearchDevices`/`parseSearchDevices`/`deviceOuId` from `devices.ts`. Grepped for the old divergent parser names (`extractDevices`, ad-hoc `resolveDistinctSourceOuPaths`) — none remain as live code; only a comment in devices.ts referencing the old name for history. `workflow.ts` line 501 (`bulk_command`) still uses the non-throwing `extractSearchDevices`, but I traced that path: `bulk_command` has no source-OU protected-OU gate, so degrading to "no devices matched" there cannot bypass a safety check. Correctly scoped.

3. **Fail-closed path traced by hand.** `extractDevicesOrThrow` and `resolveDistinctSourceOuPathsOrThrow` in `workflow.ts` both throw `GuardrailError('unresolvable-source-ou')` with `auditLog(... result:'refused')` calls before throwing, for: unparseable envelope, any device missing a resolvable OUID, and any OUID that fails to resolve against the OU tree. These run *before* the `/device/move` mutating call (line 395) in `moveDevicesByFilterExecute`. The new test "FAIL CLOSED: malformed/unparseable device-search response..." asserts both `isError === true` AND `!mutatingCallsReceived.some(c => c.path.includes('/device/move'))` — confirmed it checks the mutate call was never issued, not just that an error was thrown.

4. **countDevicesUnderOu confirmed fail-closed.** Both HTTP error and parse failure on any sub-OU search now throw (no more "treat as 0 devices"). Its only caller, `config.ts`'s `configUpdateExecute`, has an outer try/catch (~line 329) that converts any thrown error to a `fail()` result — verified by reading the catch block; no swallowing.

5. **Fixture fixed, ran tests myself.** `tests/protected-ou-wiring.test.ts` now serves one schema-accurate envelope to all callers. `npx tsc --noEmit` → clean. `npm run test:unit` → 38+7+14+5+36+11 = **111 passed, 0 failed**, matching the report exactly.

**Deferred item (target:'unknown' in generic chokepoint audit logs):** Acceptable to leave. It's a logging-fidelity gap, not a fail-open defect — Gates 2/3/6/7 (the gates that actually prevent the bypass class I blocked on) have their own dedicated audit calls with real target/count context. The generic Gate 1/4/5 chokepoint's `target:'unknown'` only degrades forensic audit-trail readability for those specific gates, it does not allow any mutation to proceed that should be blocked. Genuinely a 54-call-site refactor, correctly not bundled into a fail-open fix. Not blocking.

**Verdict: SECURITY: APPROVED.** The fail-open gap is closed at its root (unified, schema-correct parser) and defended in depth (fail-closed gate + audit log + regression test that asserts the mutate call never fires). Branch may proceed to merge per QA sign-off; not pushed/merged by me.
