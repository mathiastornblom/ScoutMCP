# Security review: zod 3 -> zod 4 (branch chore/zod-4)

Scope: `git diff origin/main` (32 files, schema-only edits plus new src/schema.ts). Verified by reading the diff, running probes against zod 4.6.7, `tsc --noEmit`, schema-snapshot (106 pass), validation (14 pass), ou-gate-hardening (31 pass), and `npm audit`.

## Findings

1. INFO - src/tools/label.ts:9, src/tools/rule.ts:16-17. `z.string().uuid()` became `z.guid()`. This is looser than zod 4's `z.uuid()` (no version/variant check) but matches the zod 3 behaviour that Scout's non-RFC GUIDs need. The regex is `^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$`. It is anchored, hex and dash only, so no path traversal, `/`, `?`, braces or whitespace can reach the URL path. Probes with `../` suffix and `{...}` braces were rejected. No weakening.
2. INFO - All `z.record(z.unknown())` became `z.record(z.string(), z.unknown())` (src/tools/*.ts bodies, e.g. config.ts, ou.ts:importPayload, workflow.ts commandBody, ou_filtering.ts rule_blocks). The semantics are equivalent. Probe: a `__proto__` key in a parsed record is dropped by zod 4, so the prototype stays `Object.prototype` and there is no own `__proto__` property. This is stricter than before, with no pollution path.
3. INFO - Unknown keys: objects still strip by default, as in zod 3. The `.strict()` uses (src/tools/elias_write.ts:100, src/elias/container-create.ts:28) are unchanged. There is no `.passthrough`, `.catchall`, `.merge`, `z.coerce` or `nativeEnum` use. Refinements (src/types.ts:9 OU path `startsWith('/')`, src/tools/elias.ts:39 path-segment `..` check, src/elias/container-create.ts:16-17) are unchanged. In zod 4 refinements run only after the base string checks pass, which is the same effective ordering. The elias segment validator and pipeline canonicalisation are not touched by the diff.
4. INFO - Error leakage: a ZodError.message is JSON of the issues. Probes show `invalid_type` reports the type only ("received string"), not the value. `invalid_format` includes the regex and `invalid_value` includes the allowed enum values, but never the rejected input. This is not worse than zod 3, and no secrets or ids are echoed.
5. INFO - Advertised schemas: confirm and dryRun fields (command.ts:68, config.ts:113, workflow.ts:301/304/522/525) are `z.boolean().optional()` on main as well, enforced at runtime by the safety layer. The advertised required set is unchanged. src/schema.ts `normalise()` only adds `additionalProperties:false` to closed objects and strips the implicit safe-integer bounds and `propertyNames:{type:string}`. It never removes `required`. `toInputSchema` throws if the root is not an object, so there is no silent empty schema fallback (the main hazard with zod-to-json-schema on zod 4). tests/schema-snapshot.test.ts plus tests/fixtures/tool-schemas.json lock this in.
6. LOW (hardening, non-blocking) - src/schema.ts:19-21 drops the implicit +/-MAX_SAFE_INTEGER bounds from the advertised schema only. Runtime `z.number().int()` in zod 4 still rejects unsafe integers (probe: 2**60 and 1e300 rejected), so no gap. Clients just aren't told the bound.
7. INFO - Supply chain: npm audit reports 0 vulnerabilities. The lockfile diff is only zod 3.25.76 -> 4.6.7 (new integrity hash, registry.npmjs.org) and the removal of zod-to-json-schema. There are no new packages. The MCP SDK peer range `^3.25 || ^4.0` accepts zod 4.

## Verdict
No input validation feeding SCOUT_MODE gates, OU gating, confirm flags, id validation or ELIAS segment checks is weakened or bypassable. No findings need a fix before merge.

SECURITY: APPROVED
