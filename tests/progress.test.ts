/**
 * Unit tests for src/progress.ts — migration from the logging-based progress shim to real
 * MCP `notifications/progress` messages, tied to a progressToken from the originating
 * request's `_meta.progressToken`.
 *
 * Covers: report() sends when a progressToken-bound sender is supplied; report() is a
 * silent no-op (never throws) when no sender/token was supplied; log() still routes through
 * the logging callback unchanged; both log() and report() swallow errors from their
 * underlying senders (best-effort, must never fail the tool call).
 *
 * Run with: npx tsx tests/progress.test.ts
 */

import { createProgressReporter, getProgressReporter, setProgressReporter, clearProgressReporter } from '../src/progress.js';

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
  } finally {
    clearProgressReporter();
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  console.log('\ncreateProgressReporter() — report() with a progressToken-bound sender');

  await test('report() forwards progress/total/message to the bound sender', async () => {
    const calls: Array<{ progress: number; total?: number; message?: string }> = [];
    const reporter = createProgressReporter({
      log: async () => {},
      sendProgress: async (progress, total, message) => {
        calls.push({ progress, total, message });
      },
    });
    await reporter.report(2, 5, 'halfway-ish');
    assert(calls.length === 1, `expected exactly one send, got ${calls.length}`);
    assert(calls[0]!.progress === 2 && calls[0]!.total === 5 && calls[0]!.message === 'halfway-ish',
      `unexpected call payload: ${JSON.stringify(calls[0])}`);
  });

  await test('report() can be called multiple times, each forwarded independently', async () => {
    const calls: number[] = [];
    const reporter = createProgressReporter({
      log: async () => {},
      sendProgress: async (progress) => {
        calls.push(progress);
      },
    });
    await reporter.report(1, 3);
    await reporter.report(2, 3);
    await reporter.report(3, 3);
    assert(calls.length === 3, `expected 3 sends, got ${calls.length}`);
    assert(JSON.stringify(calls) === JSON.stringify([1, 2, 3]), `unexpected sequence: ${JSON.stringify(calls)}`);
  });

  console.log('\ncreateProgressReporter() — report() without a progressToken (no sender supplied)');

  await test('report() is a silent no-op when sendProgress is undefined (no progressToken case)', async () => {
    const reporter = createProgressReporter({ log: async () => {} });
    // Must resolve, not throw or hang.
    await reporter.report(1, 10, 'should be dropped');
    assert(true, 'reached here without throwing');
  });

  await test('report() never throws even if a sender is wired in later for the same call sequence', async () => {
    const reporter = createProgressReporter({ log: async () => {} });
    await reporter.report(0);
    await reporter.report(50, 100, 'still a no-op');
    assert(true, 'no-op path never throws');
  });

  console.log('\ncreateProgressReporter() — error handling (best-effort, never fails the caller)');

  await test('report() swallows errors thrown by the underlying sender', async () => {
    const reporter = createProgressReporter({
      log: async () => {},
      sendProgress: async () => {
        throw new Error('transport not ready');
      },
    });
    await reporter.report(1, 2); // must not throw
    assert(true, 'report() did not propagate the sender error');
  });

  await test('log() swallows errors thrown by the underlying log sender', async () => {
    const reporter = createProgressReporter({
      log: async () => {
        throw new Error('sendLoggingMessage failed');
      },
    });
    await reporter.log('info', 'hello'); // must not throw
    assert(true, 'log() did not propagate the sender error');
  });

  console.log('\ncreateProgressReporter() — log() still routes through the logging callback');

  await test('log() forwards level and message to the bound log sender', async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const reporter = createProgressReporter({
      log: async (level, message) => {
        calls.push({ level, message });
      },
    });
    await reporter.log('warning', 'careful now');
    assert(calls.length === 1, `expected one log call, got ${calls.length}`);
    assert(calls[0]!.level === 'warning' && calls[0]!.message === 'careful now', 'unexpected log payload');
  });

  console.log('\nmodule-level reporter (setProgressReporter / getProgressReporter / clearProgressReporter)');

  await test('getProgressReporter() returns a safe no-op reporter before any is set', async () => {
    clearProgressReporter();
    const reporter = getProgressReporter();
    await reporter.log('info', 'x'); // must not throw
    await reporter.report(1, 2); // must not throw
    assert(true, 'default no-op reporter is safe to call');
  });

  await test('setProgressReporter() installs a reporter that getProgressReporter() returns', async () => {
    let reported: number | undefined;
    setProgressReporter(
      createProgressReporter({
        log: async () => {},
        sendProgress: async (progress) => {
          reported = progress;
        },
      }),
    );
    await getProgressReporter().report(7, 10);
    assert(reported === 7, `expected the installed reporter to receive the call, got ${reported}`);
  });

  await test('clearProgressReporter() resets to the no-op reporter', async () => {
    setProgressReporter(
      createProgressReporter({
        log: async () => {},
        sendProgress: async () => {
          throw new Error('should never be called after clear');
        },
      }),
    );
    clearProgressReporter();
    await getProgressReporter().report(1, 1); // must not throw, must not call the cleared sender
    assert(true, 'cleared reporter is the safe no-op');
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
