/**
 * Guards the Zod 4 migration: every tool's MCP inputSchema must keep the same property names,
 * required list, enums and descriptions as the pre-migration (zod 3 + zod-to-json-schema) output,
 * which is committed as tests/fixtures/tool-schemas.json.
 * Run with: npx tsx tests/schema-snapshot.test.ts   (offline)
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { toInputSchema } from '../src/schema.js';

process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS = 'true';
delete process.env.SCOUT_ELIAS_WRITES;

type Fixture = Record<string, { properties: string[]; required: string[]; enums: Record<string, unknown[]>; described: string[] }>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/tool-schemas.json', import.meta.url), 'utf8')) as Fixture;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: boolean, m: string): void {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}

const MODULES = ['configure', 'context', 'health', 'ou', 'device', 'command', 'application', 'config', 'config_resolve', 'label', 'rule', 'schedule', 'maintenance', 'notification', 'update', 'workflow', 'ou_filtering', 'system_info', 'system_settings', 'predefined_commands', 'predefined_paths', 'predefined_images', 'license', 'admins', 'server_instances', 'db_cleanup', 'elias'];

// Property bags are loosely typed here: this test inspects raw JSON Schema.
type Schema = { type?: unknown; properties?: Record<string, Record<string, unknown>>; required?: string[]; $schema?: unknown; additionalProperties?: unknown };
const tools = new Map<string, Schema>();

async function main(): Promise<void> {
  for (const m of MODULES) {
    const mod = (await import(`../src/tools/${m}.js`)) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      for (const t of Array.isArray(v) ? v : [v]) {
        const o = t as { name?: unknown; inputSchema?: unknown };
        if (o && typeof o === 'object' && typeof o.name === 'string' && o.inputSchema) tools.set(o.name, o.inputSchema as Schema);
      }
    }
  }

  test('every baseline tool is still exposed (and none vanished)', () => {
    const missing = Object.keys(fixture).filter((n) => !tools.has(n));
    assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
  });

  for (const [name, exp] of Object.entries(fixture)) {
    const s = tools.get(name);
    if (!s) continue;
    test(`${name}: object schema, no $schema key`, () => {
      assert(s.type === 'object', `type=${String(s.type)}`);
      assert(!('$schema' in s), '$schema present');
      assert(s.additionalProperties === false, 'additionalProperties should stay false (pre-migration shape)');
    });
    test(`${name}: properties, required, enums, descriptions preserved`, () => {
      const props = s.properties ?? {};
      assert(JSON.stringify(Object.keys(props).sort()) === JSON.stringify(exp.properties), `properties ${Object.keys(props).sort().join(',')} != ${exp.properties.join(',')}`);
      assert(exp.properties.length === 0 || Object.keys(props).length > 0, 'properties empty');
      assert(JSON.stringify([...(s.required ?? [])].sort()) === JSON.stringify(exp.required), `required ${JSON.stringify(s.required)} != ${JSON.stringify(exp.required)}`);
      const described = Object.keys(props).filter((k) => props[k].description).sort();
      assert(JSON.stringify(described) === JSON.stringify(exp.described), `descriptions differ: ${described.join(',')}`);
      for (const [k, vals] of Object.entries(exp.enums)) {
        const p = props[k];
        const got = (p.enum ?? (p.items as Record<string, unknown> | undefined)?.enum) as unknown[] | undefined;
        assert(!!got && JSON.stringify([...got].sort()) === JSON.stringify([...vals].sort()), `enum ${k} lost or changed`);
      }
    });
  }

  test('toInputSchema: defaults are kept and fields with defaults are not required (io=input)', () => {
    const s = toInputSchema(z.object({ n: z.number().int().default(3), a: z.string() })) as Schema;
    assert(JSON.stringify(s.required) === '["a"]', JSON.stringify(s.required));
    assert(s.properties?.n.default === 3, 'default lost');
  });
  test('toInputSchema: z.record keeps free-form additionalProperties', () => {
    const s = toInputSchema(z.object({ b: z.record(z.string(), z.unknown()) })) as Schema;
    assert(s.properties?.b.type === 'object', 'record not an object');
    assert(!('propertyNames' in (s.properties?.b ?? {})), 'propertyNames noise');
  });
  test('z.guid() accepts Scout-style GUIDs of any version/variant (z.uuid() would not)', () => {
    const nonRfc = '01234567-89ab-cdef-0123-456789abcdef';
    assert(z.guid().safeParse(nonRfc).success, 'guid rejected');
    assert(z.guid().safeParse('ABCDEF01-2345-6789-ABCD-EF0123456789').success, 'upper-case guid rejected');
    assert(!z.guid().safeParse('not-a-guid').success, 'garbage accepted');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
