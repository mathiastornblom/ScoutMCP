# Dev report: zod 3 -> zod 4 (branch chore/zod-4)

Result: build clean (`tsc`), `npm run test:unit` exit 0 (incl. new schema-snapshot, 106 checks), `npm audit` 0 vulnerabilities. Live integration suite not run.

## Files
- package.json / package-lock.json: zod ^4.6.7; zod-to-json-schema removed (the SDK keeps its own nested copy, irrelevant to us); schema-snapshot test added to test:unit.
- src/schema.ts (new): `toInputSchema()` = `z.toJSONSchema(schema,{target:'draft-7',io:'input'})`, strips `$schema`, then normalises (additionalProperties:false on closed objects, drops implicit +-MAX_SAFE_INTEGER bounds and `propertyNames:{type:string}`). Throws if the root is not an object.
- 27 files in src/tools: 53 `zodToJsonSchema(` sites -> `toInputSchema(`; `z.record(z.unknown())` -> `z.record(z.string(), z.unknown())`; `z.string().uuid()` -> `z.guid()` (label.ts, rule.ts).
- tests/schema-snapshot.test.ts + tests/fixtures/tool-schemas.json (fixture generated from the pre-migration output; no old zod imported).
- CHANGELOG.md (Unreleased), .agents/DEVELOPER.md stack line.
- Nothing needed for: ZodError (`.issues` already used in elias.ts / pipeline.ts; `instanceof z.ZodError` works), `.default()` / `.refine()` / `.strict()`, `message:` options.

## Schema diff (51 tools, private endpoints on, ELIAS writes off; baseline taken before any change)
No tool lost a property, required entry, enum or description. Remaining differences:
- `$schema` top-level key removed (requested).
- admin_manage `menu_rights[].Value`: `type:[number,string]+enum:[0,1,'0','1']` -> `anyOf` of four `const`s (equivalent, more verbose).
- admin_manage `base_rights.items`: old output was a `$ref` to `#/properties/menu_rights/items`; now inlined (equivalent).
- elias_certificate_get `certificateId`: old output was a wrong `$ref` to `containerId` (zod-to-json-schema dedupe quirk); now a proper string with GUID pattern (improvement).
- label_manage / rule_manage id fields gain a permissive 8-4-4-4-12 hex `pattern`; `format:"uuid"` kept.

## Behaviour changes
- uuid: `z.guid()` accepts any 8-4-4-4-12 hex GUID (what zod 3 `.uuid()` effectively did). `z.uuid()` would reject GUIDs with non-RFC version/variant nibbles. Not verified against live Scout ids (no live run); permissive is the safe choice.
- Error text reaching MCP clients: a ZodError `message` is a JSON issue list; wording is now Zod 4's (e.g. "Invalid input: expected string, received undefined" instead of "Required"). ELIAS tools build their text from `.issues`, unchanged in form.
- additionalProperties:false is still advertised although Zod strips (not rejects) unknown keys at parse time, same as before.
