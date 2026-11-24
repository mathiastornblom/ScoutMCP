/**
 * Offline tests for src/compat (registry, version parsing, probe interpretation, caching,
 * requireCapability) and registry <-> docs/compatibility.md consistency.
 * No network: all clients are fakes.
 *
 * Run with: npx tsx tests/compat.test.ts
 */

import { readFileSync } from 'node:fs';
import { ScoutError } from '../src/client.js';
import { CAPABILITIES, getCapability } from '../src/compat/registry.js';
import {
  parseScoutVersion,
  versionAtLeast,
  interpretProbe,
  detectCapabilities,
  detectScoutVersion,
  requireCapability,
  findVersionField,
  type ProbeClient,
} from '../src/compat/detect.js';
import { eliasTools } from '../src/tools/elias.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: boolean, m: string): asserts c {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}

type Handler = (kind: 'public' | 'private', method: string, path: string) => unknown;
interface FakeClient extends ProbeClient {
  calls: Array<{ kind: string; method: string; path: string }>;
}
function fake(h: Handler): FakeClient {
  const calls: FakeClient['calls'] = [];
  const mk = (kind: 'public' | 'private') => async (method: string, path: string): Promise<never> => {
    calls.push({ kind, method, path });
    return h(kind, method, path) as never;
  };
  return { calls, request: mk('public'), rawRequest: mk('private') };
}
const err = (code: number) => new ScoutError(`HTTP ${code}`, code);
const elias = getCapability('elias')!;
const ourights = getCapability('ourights-preflight')!;

async function main(): Promise<void> {
  console.log('registry');
  await test('ids are unique, probes GET-only, versions parse', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    assert(new Set(ids).size === ids.length, 'duplicate ids');
    for (const c of CAPABILITIES) {
      if (c.probe) assert(c.probe.method === 'GET', `${c.id} probe is not GET`);
      if (c.minScoutVersion !== null) assert(parseScoutVersion(c.minScoutVersion) !== null, `${c.id} bad min`);
    }
  });
  await test('elias dependentTools are real registered tool names', () => {
    const names = new Set(eliasTools.map((t) => t.name));
    for (const t of elias.dependentTools) assert(names.has(t), `unknown tool ${t}`);
  });

  console.log('docs consistency');
  await test('registry ids, min versions and statuses match docs/compatibility.md rows', () => {
    const md = readFileSync(new URL('../docs/compatibility.md', import.meta.url), 'utf-8');
    const rows = new Map<string, { min: string; status: string }>();
    for (const line of md.split('\n')) {
      const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (m) rows.set(m[1], { min: m[2], status: m[3] });
    }
    const regIds = CAPABILITIES.map((c) => c.id).sort();
    const docIds = [...rows.keys()].sort();
    assert(JSON.stringify(regIds) === JSON.stringify(docIds), `registry ${regIds} != docs ${docIds}`);
    for (const c of CAPABILITIES) {
      const r = rows.get(c.id)!;
      assert(r.min === (c.minScoutVersion ?? '-'), `${c.id}: min ${r.min} != ${c.minScoutVersion}`);
      assert(r.status === c.status, `${c.id}: status ${r.status} != ${c.status}`);
    }
  });

  console.log('version parsing');
  await test('parses known formats', () => {
    assert(parseScoutVersion('7.2611.0-13') === 2611, '7.2611.0-13');
    assert(parseScoutVersion('7.2611.x') === 2611, '7.2611.x');
    assert(parseScoutVersion('2611') === 2611, '2611');
    assert(parseScoutVersion(2605) === 2605, 'number');
    assert(parseScoutVersion('25.11.0') === 2511, '25.11.0');
  });
  await test('rejects garbage', () => {
    for (const v of ['', 'abc', '1.2.3', '2613', '7.9999.0', null, undefined, {}]) {
      assert(parseScoutVersion(v) === null, `should reject ${String(v)}`);
    }
  });
  await test('versionAtLeast', () => {
    assert(versionAtLeast(2611, '2611') === true, 'eq');
    assert(versionAtLeast(2605, '2611') === false, 'lt');
    assert(versionAtLeast(null, '2611') === null, 'unknown detected');
    assert(versionAtLeast(2611, null) === null, 'unknown required');
  });
  await test('findVersionField finds nested version, ignores unparseable', () => {
    assert(findVersionField({ a: [{ b: { Version: '7.2611.1' } }] }) === '7.2611.1', 'nested');
    assert(findVersionField({ version: 'banana' }) === null, 'unparseable');
    assert(findVersionField('x') === null, 'scalar');
  });

  console.log('probe interpretation');
  await test('success -> available', () => {
    assert(interpretProbe(elias, { ok: true }).state === 'available', '200');
  });
  await test('404 -> unavailable', () => {
    assert(interpretProbe(elias, { ok: false, error: err(404) }).state === 'unavailable', '404');
  });
  await test('401/403 -> unknown (forbidden)', () => {
    for (const c of [401, 403]) {
      const r = interpretProbe(elias, { ok: false, error: err(c) });
      assert(r.state === 'unknown' && r.reason.includes('forbidden'), `${c}`);
    }
  });
  await test('5xx and network error -> unknown', () => {
    assert(interpretProbe(elias, { ok: false, error: err(503) }).state === 'unknown', '503');
    assert(interpretProbe(elias, { ok: false, error: new Error('ECONNRESET') }).state === 'unknown', 'net');
    assert(interpretProbe(elias, { ok: false, error: 'weird' }).state === 'unknown', 'non-error');
  });
  await test('400 -> available only where badRequestMeansAvailable', () => {
    assert(interpretProbe(ourights, { ok: false, error: err(400) }).state === 'available', 'ourights 400');
    assert(interpretProbe(elias, { ok: false, error: err(400) }).state === 'unknown', 'elias 400');
  });

  console.log('detectCapabilities');
  await test('probes are GET-only and use the right client method', async () => {
    const c = fake(() => ({}));
    await detectCapabilities(c, { privateEnabled: true });
    assert(c.calls.length > 0, 'no calls');
    assert(c.calls.every((x) => x.method === 'GET'), 'non-GET call issued');
    const e = c.calls.find((x) => x.path === '/api/v1/systemcheck/elias');
    assert(e?.kind === 'private', 'elias must use rawRequest');
    const h = c.calls.find((x) => x.path === '/api/v1/healthcheck');
    assert(h?.kind === 'public', 'healthcheck must use request');
  });
  await test('private probes skipped when private endpoints disabled', async () => {
    const c = fake(() => ({}));
    const r = await detectCapabilities(c, { privateEnabled: false });
    assert(!c.calls.some((x) => x.kind === 'private'), 'private call issued');
    assert(r.capabilities['elias'].state === 'unknown', 'elias should be unknown');
  });
  await test('mixed outcomes map per capability and never throw', async () => {
    const c = fake((_k, _m, path) => {
      if (path.includes('systemcheck/elias')) throw err(404);
      if (path.includes('ourights')) throw err(403);
      if (path.includes('fileEntries')) throw new Error('ECONNREFUSED');
      return {};
    });
    const r = await detectCapabilities(c, { privateEnabled: true });
    assert(r.capabilities['elias'].state === 'unavailable', 'elias');
    assert(r.capabilities['ourights-preflight'].state === 'unknown', 'ourights');
    assert(r.capabilities['advanced-file-entries'].state === 'unknown', 'fileEntries');
    assert(r.capabilities['ou-filter-and-or'].state === 'unknown', 'not probeable');
    assert(r.capabilities['elias'].status === 'har-only', 'status carried');
  });
  await test('timeout -> unknown', async () => {
    const c: ProbeClient = {
      request: () => new Promise(() => undefined),
      rawRequest: () => new Promise(() => undefined),
    };
    const r = await detectCapabilities(c, { privateEnabled: true, timeoutMs: 20 });
    assert(r.capabilities['healthcheck'].state === 'unknown', 'timeout');
  });
  await test('cache: second call within TTL does not re-probe; after TTL it does; force bypasses', async () => {
    const c = fake(() => ({}));
    let t = 1_000;
    const o = { privateEnabled: true, ttlMs: 100, now: () => t };
    await detectCapabilities(c, o);
    const n = c.calls.length;
    await detectCapabilities(c, o);
    assert(c.calls.length === n, 'cache miss within TTL');
    t += 101;
    await detectCapabilities(c, o);
    assert(c.calls.length === 2 * n, 'no re-probe after TTL');
    await detectCapabilities(c, { ...o, force: true });
    assert(c.calls.length === 3 * n, 'force ignored');
  });
  await test('version from healthcheck field; disagreement reported, probe wins', async () => {
    const c = fake((_k, _m, path) => {
      if (path.startsWith('/api/v1/healthcheck')) return { response: { scoutServer: { version: '7.2605.0' } } };
      return {}; // elias probe succeeds although 2605 < 2611
    });
    const r = await detectCapabilities(c, { privateEnabled: true });
    assert(r.scoutVersion === '7.2605.0' && r.versionSource === 'healthcheck', `${r.scoutVersion}/${r.versionSource}`);
    assert(r.versionConfidence === 'low', 'confidence');
    assert(r.capabilities['elias'].state === 'available', 'probe wins');
    assert(r.disagreements.some((d) => d.startsWith('elias:')), 'disagreement not reported');
  });
  await test('no version field: ELIAS available -> inferred lower bound', async () => {
    const c = fake(() => ({}));
    const r = await detectCapabilities(c, { privateEnabled: true });
    assert(r.versionSource === 'capability-inference' && r.scoutVersion === '>=2611', `${r.versionSource}`);
    assert(r.disagreements.length === 0, 'no disagreement expected');
  });
  await test('no version and nothing available -> source none', async () => {
    const c = fake(() => {
      throw err(500);
    });
    const r = await detectScoutVersion(c, { privateEnabled: true });
    assert(r.source === 'none' && r.version === null && r.confidence === 'none', 'none expected');
  });

  console.log('requireCapability');
  await test('unavailable with known min -> clear message with detected version', async () => {
    const c = fake((_k, _m, path) => {
      if (path.startsWith('/api/v1/healthcheck')) return { version: '2605' };
      if (path.includes('systemcheck/elias')) throw err(404);
      return {};
    });
    const msg = await requireCapability('elias', c, { privateEnabled: true });
    assert(msg !== null && msg.includes('requires Scout >=2611') && msg.includes('detected 2605'), String(msg));
  });
  await test('unavailable, version unknown -> says detected unknown', async () => {
    const c = fake((_k, _m, path) => {
      if (path.includes('systemcheck/elias')) throw err(404);
      return {};
    });
    const msg = await requireCapability('elias', c, { privateEnabled: true });
    assert(msg !== null && msg.includes('detected unknown'), String(msg));
  });
  await test('unavailable with null min -> no invented version', async () => {
    const c = fake((_k, _m, path) => {
      if (path.includes('ourights')) throw err(404);
      return {};
    });
    const msg = await requireCapability('ourights-preflight', c, { privateEnabled: true });
    assert(msg !== null && !msg.includes('requires Scout') && msg.includes('not established'), String(msg));
  });
  await test('available / unknown / unprobeable / unregistered -> proceed (null)', async () => {
    assert((await requireCapability('elias', fake(() => ({})), { privateEnabled: true })) === null, 'available');
    const forbidden = fake(() => {
      throw err(403);
    });
    assert((await requireCapability('elias', forbidden, { privateEnabled: true })) === null, 'forbidden');
    assert((await requireCapability('ou-filter-and-or', fake(() => ({})))) === null, 'unprobeable');
    assert((await requireCapability('nope', fake(() => ({})))) === null, 'unregistered');
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
