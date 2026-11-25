# QA review: zod 3 -> zod 4 migration (branch chore/zod-4)

Verified myself (not trusting dev report): `npx tsc --noEmit` clean, `npm run build` clean, `npm run test:unit` all pass
(schema-snapshot: 106/106). Old behaviour was obtained by checking out origin/main in a temp worktree (zod 3.25.76 +
zod-to-json-schema), now removed.

## 1. Schemas (old vs new, full dump of all 53 tools, deep diff)
- Tool set identical (53 / 53). Every property name, required list, enum, description, type, default, min/max is identical.
- tests/fixtures/tool-schemas.json re-derived from OLD output: 0 mismatches. It contains 51 tools; elias_write_status and
  elias_container_create are NOT in it (see defect 1).
- Only differences, all benign:
  - `labelId`/`ruleId` (label_manage, rule_manage): new output adds `pattern` (z.guid regex) next to existing `format: uuid`.
  - `elias_certificate_get.certificateId`: old emitted a `$ref` to containerId, new inlines `type:string` + pattern (same regex).
  - `admin_manage.*_rights[].Value`: old `type:[number,string], enum:[0,1,"0","1"]`; new `anyOf` of four `const`s. Semantically equal,
    but a less common shape for simple MCP clients.
  - `admin_manage.base_rights.items`: old `$ref`, new inlined (same content).
  - `additionalProperties:false`, no `$schema`, no propertyNames/safe-int noise: normalise() reproduces the old shape.

## 2. Runtime validation (differential fuzz, 5518 inputs across all 53 tools, old vs new execute())
Per property: valid/null/number/string/numeric-string/float/1e21/negative/zero/5000-char/empty/array/object/bool/GUID variants, plus
empty/null/extra-key inputs. Also direct containerCreateInput (.strict + refine) on 14 inputs.
- Accept/reject decisions identical except: unsafe integers (1e21) are now rejected by `.int()` in zod 4 (previously accepted and
  forwarded). Stricter, arguably better; note in CHANGELOG (defect 3).
- Error text changed: "Required" -> "Invalid input: expected string, received undefined", "Expected X" -> "Invalid input: expected X",
  "Unrecognized key(s) in object: 'x'" -> `Unrecognized key: "x"`. Custom refine messages unchanged. Affects elias_* tool and ELIAS-write
  `invalid input:` strings only; no test asserts the old wording. Some failures now list the same path twice
  (e.g. `limit` unsafe int, `deviceIds`, `admin_manage.name` array) because v4 emits two issues; cosmetic.
- Grep of v4-changed features in src/: no `nativeEnum`, `.merge`, `.extend` on refined, `invalid_type_error`, `required_error`, `errorMap`,
  `.email/.url`, `.ip`, `.datetime`, `z.coerce`, `.flatten/.format`, `.errors` on ZodError (code uses `.issues`). `.default()` only on
  elias Limit/Offset (non-optional wrappers) - behaviour verified. All 26 `z.record(z.unknown())` converted to 2-arg form. `.strict()`
  and `.refine()` behave identically. eluxConfig.ts schema still loads (659 entries).

## 3. z.guid / ids
`z.string().uuid()` (zod 3, accepts any hex GUID) -> `z.guid()` (same laxness). zod 4 `z.uuid()` would have rejected non-RFC variants;
verified 01234567-89ab-cdef-0123-456789abcdef and v4 GUIDs accepted, truncated GUID rejected, identical to old. label_manage and
rule_manage (labelId, ruleId) behave the same as before. Note: published JSON Schema still says `format: uuid`, same as before.

## 4. tests/schema-snapshot.test.ts quality
Would catch an empty schema for any tool in the fixture (property-name list is compared, and `required`/descriptions would also diverge).
Weaknesses:
- Covers only top-level properties: nested object/array item properties, types, min/max, defaults, `pattern`, `additionalProperties`
  of nested objects, and nested enums (41 in the old output) are not checked. A regression inside `menu_rights.items` would pass.
- elias_write module not in MODULES; the 2 write tools are absent from fixture and test.
- A brand-new tool with no fixture entry is not flagged ("none vanished" only checks one direction).
- Fixture is a hand-generated artifact with no regeneration script committed.

## Defects
1. tests/schema-snapshot.test.ts:33 - MODULES omits `elias_write`; tests/fixtures/tool-schemas.json lacks `elias_write_status` and
   `elias_container_create` (src/tools/elias_write.ts:91,155 use toInputSchema); those schemas are unguarded. (low)
2. tests/schema-snapshot.test.ts:66-77 - only top-level properties/required/enums/descriptions asserted; nested schemas, types, bounds,
   defaults unguarded; no check for tools present now but missing from fixture. (low)
3. CHANGELOG.md - behaviour changes not documented: `.int()` now rejects values beyond +/-2^53-1; ZodError message wording changed
   (visible in elias `invalid input:` messages); possible duplicate issue entries. (low)
4. src/tools/admins.ts:43-46 - Value union emits `anyOf` of consts instead of `enum`; harmless but a visible schema-shape change
   contrary to the "no churn" goal of src/schema.ts. Optional: use `z.enum(['0','1']).or(z.union([z.literal(0), z.literal(1)]))` is no better;
   acceptable as is. (info)
5. src/schema.ts vs src/schema/ directory - a file `schema.ts` now sits beside the existing `schema/` directory (eluxConfig.ts);
   imports resolve correctly (`../schema.js`) but the naming is confusing. (info)

No blocking defects: items 1-3 are low-severity hardening, 4-5 informational.

QA: APPROVED
