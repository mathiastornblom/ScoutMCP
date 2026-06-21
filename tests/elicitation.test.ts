/**
 * Unit tests for src/elicitation.ts — real elicitation capability detection plus the
 * confirm:true fallback for clients that don't declare the `elicitation` capability.
 *
 * No live Scout Board connection and no real MCP transport — `server` is a minimal fake
 * exposing only getClientCapabilities()/elicitInput(), the two methods elicitation.ts calls.
 *
 * Run with: npx tsx tests/elicitation.test.ts
 */

import { supportsElicitation, confirmDestructiveAction } from '../src/elicitation.js';

type TestResult = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e) });
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Minimal fake of the SDK Server surface elicitation.ts actually calls. Cast to `any` /
// the imported Server type at call sites since we only implement the two methods used.
function fakeServer(opts: {
  capabilities?: Record<string, unknown>;
  elicitResult?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
  elicitThrows?: Error;
}) {
  return {
    getClientCapabilities: () => opts.capabilities,
    elicitInput: async () => {
      if (opts.elicitThrows) throw opts.elicitThrows;
      return opts.elicitResult ?? { action: 'decline' };
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/index.js').Server;
}

async function main() {
  console.log('\nsupportsElicitation()');

  await test('returns false when server is undefined', () => {
    assert(supportsElicitation(undefined) === false, 'expected false for undefined server');
  });

  await test('returns false when client capabilities have no elicitation key', () => {
    const server = fakeServer({ capabilities: { tools: {} } });
    assert(supportsElicitation(server) === false, 'expected false');
  });

  await test('returns true when client declared a non-empty elicitation capability object', () => {
    const server = fakeServer({ capabilities: { elicitation: { form: {} } } });
    assert(supportsElicitation(server) === true, 'expected true');
  });

  await test('returns false (not throws) if getClientCapabilities() throws (pre-init)', () => {
    const server = {
      getClientCapabilities: () => {
        throw new Error('not initialized yet');
      },
    } as unknown as import('@modelcontextprotocol/sdk/server/index.js').Server;
    assert(supportsElicitation(server) === false, 'expected false, not a throw');
  });

  console.log('\nconfirmDestructiveAction() — elicitation path (client declares capability)');

  await test('accept + confirmed:true proceeds via elicitation', async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitResult: { action: 'accept', content: { confirmed: true } },
    });
    const outcome = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: undefined },
    );
    assert(outcome.proceed === true, 'expected proceed=true');
    assert(outcome.via === 'elicitation', 'expected via=elicitation');
  });

  await test('accept + confirmed:false is refused via elicitation, even with confirmFlag=true', async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitResult: { action: 'accept', content: { confirmed: false } },
    });
    const outcome = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: true },
    );
    assert(outcome.proceed === false, 'expected proceed=false — the live answer overrides any stale confirm flag');
  });

  await test('decline is refused via elicitation', async () => {
    const server = fakeServer({ capabilities: { elicitation: {} }, elicitResult: { action: 'decline' } });
    const outcome = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: undefined },
    );
    assert(outcome.proceed === false, 'expected proceed=false');
    assert(outcome.reason.includes('decline'), `expected reason to mention decline, got "${outcome.reason}"`);
  });

  await test('cancel is refused via elicitation', async () => {
    const server = fakeServer({ capabilities: { elicitation: {} }, elicitResult: { action: 'cancel' } });
    const outcome = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: undefined },
    );
    assert(outcome.proceed === false, 'expected proceed=false');
  });

  await test('a thrown elicitInput error fails closed (never treated as accept)', async () => {
    const server = fakeServer({
      capabilities: { elicitation: {} },
      elicitThrows: new Error('transport down'),
    });
    const outcome = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: true },
    );
    assert(outcome.proceed === false, 'expected proceed=false on transport error, not silent accept');
  });

  console.log('\nconfirmDestructiveAction() — confirm:true fallback (client does NOT declare capability)');

  await test('confirmFlag=true proceeds via confirm-flag fallback when no server/capability', async () => {
    const outcome = await confirmDestructiveAction(
      { server: undefined },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: true },
    );
    assert(outcome.proceed === true, 'expected proceed=true');
    assert(outcome.via === 'confirm-flag', 'expected via=confirm-flag');
  });

  await test('confirmFlag=false is refused via confirm-flag fallback', async () => {
    const outcome = await confirmDestructiveAction(
      { server: undefined },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: false },
    );
    assert(outcome.proceed === false, 'expected proceed=false');
    assert(outcome.via === 'confirm-flag', 'expected via=confirm-flag');
  });

  await test('confirmFlag=undefined is refused via confirm-flag fallback', async () => {
    const outcome = await confirmDestructiveAction(
      { server: undefined },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: undefined },
    );
    assert(outcome.proceed === false, 'expected proceed=false');
  });

  await test('server present but capability not declared still uses confirm-flag fallback', async () => {
    const server = fakeServer({ capabilities: { tools: {} } });
    const outcomeNoFlag = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: undefined },
    );
    assert(outcomeNoFlag.proceed === false, 'expected proceed=false without confirm=true');
    assert(outcomeNoFlag.via === 'confirm-flag', 'expected fallback path, not elicitation');

    const outcomeWithFlag = await confirmDestructiveAction(
      { server },
      { opName: 'test_op', summary: 'do the thing', confirmFlag: true },
    );
    assert(outcomeWithFlag.proceed === true, 'expected proceed=true with confirm=true');
    assert(outcomeWithFlag.via === 'confirm-flag', 'expected fallback path, not elicitation');
  });

  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passedCount} passed, ${failedCount} failed (${results.length} total)`);

  if (failedCount > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`  ✗ ${r.name}`);
      if (r.error) console.log(`    ${r.error}`);
    }
  }

  process.exit(failedCount > 0 ? 1 : 0);
}

void main();
