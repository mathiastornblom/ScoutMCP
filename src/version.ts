import { readFileSync } from 'node:fs';

/**
 * Version of THIS MCP server, read from package.json so serverInfo and health_check can
 * never drift from the released version. package.json sits one level above both src/
 * (tsx / tests) and dist/ (built output, and /app in the Docker image).
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const MCP_SERVER_VERSION: string = readVersion();

export interface McpBuild {
  version: string;
  gitSha: string;
  builtAt: string;
  /** `<version>+<gitSha>` — valid semver build metadata. */
  build: string;
}

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SHA_WORDS = new Set(['dev', 'local', 'unknown']);

/**
 * Pure: derive the build identifier from env-like input. Env text is never reflected;
 * only strictly validated shapes pass through, everything else becomes 'unknown'.
 */
export function computeBuild(
  env: Record<string, string | undefined>,
  version: string,
): McpBuild {
  const rawSha = (env['SCOUT_GIT_SHA'] ?? '').trim();
  let gitSha = 'unknown';
  if (SHA_RE.test(rawSha)) gitSha = rawSha.slice(0, 7).toLowerCase();
  else if (SHA_WORDS.has(rawSha)) gitSha = rawSha;

  const rawDate = (env['SCOUT_BUILD_DATE'] ?? '').trim();
  const builtAt = ISO_UTC_RE.test(rawDate) && !Number.isNaN(Date.parse(rawDate)) ? rawDate : 'unknown';

  return { version, gitSha, builtAt, build: `${version}+${gitSha}` };
}

export const MCP_BUILD: McpBuild = computeBuild(process.env, MCP_SERVER_VERSION);
