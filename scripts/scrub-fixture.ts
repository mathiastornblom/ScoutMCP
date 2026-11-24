/**
 * CLI: scrub a captured exchange file into a committable contract fixture (Security C13).
 *
 *   npx tsx scripts/scrub-fixture.ts <capture.json> [out.json]
 *
 * The input may be a HAR (log.entries[]) or an array of {method,url,requestBody,status,responseBody}.
 * Only method, path template, body key names/types and status are written. Never commit the input.
 * Prints the fixture sha256 (use it as the evidence record in src/compat/registry.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scrubCapture } from '../src/elias/fixture-scrub.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath) {
  process.stderr.write('usage: tsx scripts/scrub-fixture.ts <capture.json> [out.json]\n');
  process.exit(2);
}
const result = scrubCapture(JSON.parse(readFileSync(inPath, 'utf-8')));
if (outPath) writeFileSync(outPath, result.json + '\n', { mode: 0o644 });
else process.stdout.write(result.json + '\n');
process.stderr.write(
  `contracts=${result.contracts.length} skipped(auth=${result.skipped.auth}, tierC=${result.skipped.tierC}, unparseable=${result.skipped.unparseable}) ` +
    `omittedKeys=${result.omittedKeys} fixtureSha256=${result.fixtureSha256}\n`,
);
