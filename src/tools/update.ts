import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fetch } from 'undici';
import { type McpToolResult, ok, fail } from '../types.js';

const REPO = 'mathiastornblom/ScoutMCP';
const GHCR_IMAGE = 'ghcr.io/mathiastornblom/scoutmcp:latest';

const inputSchema = z.object({
  action: z
    .enum(['check', 'apply'])
    .describe(
      'check = compare running version against latest GitHub commit; ' +
        'apply = show the docker pull command needed to update',
    ),
});

interface GitHubCommit {
  sha: string;
}

async function fetchLatestSha(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!res.ok) throw new Error(`GitHub API responded with HTTP ${res.status}`);
  const data = (await res.json()) as GitHubCommit;
  if (!data.sha) throw new Error('Unexpected response from GitHub API');
  return data.sha;
}

async function execute(raw: unknown): Promise<McpToolResult> {
  const { action } = inputSchema.parse(raw);

  const currentVersion = process.env.SCOUT_VERSION ?? 'dev';

  if (action === 'check') {
    if (currentVersion === 'dev') {
      return ok({
        upToDate: null,
        message: 'Running in development mode — version tracking is disabled.',
      });
    }

    let latestSha: string;
    try {
      latestSha = await fetchLatestSha();
    } catch (err) {
      return fail(
        `Could not reach GitHub API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const shortCurrent = currentVersion.slice(0, 7);
    const shortLatest = latestSha.slice(0, 7);
    const upToDate = latestSha.startsWith(currentVersion) || currentVersion === latestSha;

    if (upToDate) {
      return ok({
        upToDate: true,
        currentVersion: shortCurrent,
        latestVersion: shortLatest,
        message: `You are running the latest version (${shortCurrent}).`,
      });
    }

    return ok({
      upToDate: false,
      currentVersion: shortCurrent,
      latestVersion: shortLatest,
      message:
        `Update available: ${shortCurrent} → ${shortLatest}. ` +
        'Call scout_update with action=apply to get update instructions.',
    });
  }

  // action === 'apply'
  return ok({
    image: GHCR_IMAGE,
    instructions: [
      `1. Pull the latest image:`,
      `     docker pull ${GHCR_IMAGE}`,
      `2. Restart the Scout MCP server in Docker Desktop`,
      `   (stop and re-run the container — Docker Desktop will use the new image).`,
      `   Or via CLI:`,
      `     docker stop <container-name> && docker rm <container-name>`,
      `     docker run ... (same flags as before, using ${GHCR_IMAGE})`,
    ],
    note: 'Your credentials in ~/.scout-mcp.json persist across image updates.',
  });
}

export const updateTool = {
  name: 'scout_update',
  description:
    'Check whether a newer version of the Scout MCP server is available on GitHub, ' +
    'and get instructions for applying the update. ' +
    'Use action=check to compare the running image version against the latest commit on main. ' +
    'Use action=apply to get the exact docker pull command needed to update.',
  inputSchema: zodToJsonSchema(inputSchema),
  execute,
};
