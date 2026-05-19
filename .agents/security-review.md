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
