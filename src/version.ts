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
