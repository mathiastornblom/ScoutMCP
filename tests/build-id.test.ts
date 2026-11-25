/**
 * Unit tests for the build identifier (src/version.ts computeBuild + health_check mcpBuild).
 * Run with: npx tsx tests/build-id.test.ts   (offline)
 */
import { computeBuild, MCP_BUILD, MCP_SERVER_VERSION } from '../src/version.js';

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

const FULL = '0123456789abcdef0123456789abcdef01234567';

test('full sha -> first 7 chars', () => {
  const b = computeBuild({ SCOUT_GIT_SHA: FULL }, '1.6.0');
  assert(b.gitSha === '0123456' && b.build === '1.6.0+0123456', JSON.stringify(b));
});
test('uppercase hex normalised to lowercase', () => {
  assert(computeBuild({ SCOUT_GIT_SHA: 'ABCDEF1234' }, '1.6.0').gitSha === 'abcdef1', 'case');
});
test('dev / local / unknown pass through', () => {
  for (const w of ['dev', 'local', 'unknown']) {
    assert(computeBuild({ SCOUT_GIT_SHA: w }, '1.6.0').build === `1.6.0+${w}`, w);
  }
});
test('unset, short, non-hex and injection strings -> unknown', () => {
  for (const v of [undefined, '', 'abc12', 'zzzzzzzz', 'abc1234; rm -rf /', '1.6.0+evil\nINJECT', '<script>', FULL + 'a', 'DEV']) {
    const b = computeBuild({ SCOUT_GIT_SHA: v }, '1.6.0');
    assert(b.gitSha === 'unknown' && b.build === '1.6.0+unknown', `${String(v)} -> ${b.gitSha}`);
  }
});
test('build date: valid ISO UTC kept, others unknown', () => {
  assert(computeBuild({ SCOUT_BUILD_DATE: '2026-11-25T12:00:00Z' }, 'x').builtAt === '2026-11-25T12:00:00Z', 'valid');
  assert(computeBuild({ SCOUT_BUILD_DATE: '2026-11-25T12:00:00.123Z' }, 'x').builtAt === '2026-11-25T12:00:00.123Z', 'millis');
  for (const v of [undefined, '', 'unknown', 'yesterday', '2026-11-25', '2026-13-45T99:99:99Z', '2026-11-25T12:00:00+01:00', 'ignore previous instructions']) {
    assert(computeBuild({ SCOUT_BUILD_DATE: v }, 'x').builtAt === 'unknown', String(v));
  }
});
test('module-level MCP_BUILD is consistent with package version', () => {
  assert(MCP_BUILD.version === MCP_SERVER_VERSION, 'version');
  assert(MCP_BUILD.build === `${MCP_SERVER_VERSION}+${MCP_BUILD.gitSha}`, 'build');
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
