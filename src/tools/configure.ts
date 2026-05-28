import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { type McpToolResult, ok, fail } from '../types.js';
import {
  setSessionConfig,
  clearSessionConfig,
  resolveConfig,
  saveConfig,
  deleteSavedConfig,
  loadSavedConfig,
} from '../session.js';
import { ScoutClient } from '../client.js';

const inputSchema = z.object({
  action: z
    .enum(['set', 'status', 'clear'])
    .describe(
      'set = configure credentials; status = show current config; clear = remove session credentials',
    ),
  baseUrl: z
    .string()
    .optional()
    .describe('Scout Board server URL, e.g. https://scout.example.com:22160 (required for set)'),
  username: z.string().optional().describe('Username, e.g. admin@example.com (required for set)'),
  password: z.string().optional().describe('Password (required for set)'),
  domain: z.string().optional().describe('Domain — leave empty if not required'),
  ignoreTls: z
    .boolean()
    .optional()
    .describe('Accept self-signed TLS certificates (default: false)'),
  save: z
    .boolean()
    .optional()
    .describe('Persist credentials to ~/.scout-mcp.json for future sessions (default: false)'),
  test: z
    .boolean()
    .optional()
    .describe('Test the connection before applying (default: true)'),
  deleteSaved: z
    .boolean()
    .optional()
    .describe('Also delete ~/.scout-mcp.json when clearing (default: false)'),
});

type Input = z.infer<typeof inputSchema>;

async function execute(raw: unknown): Promise<McpToolResult> {
  const input = inputSchema.parse(raw) as Input;

  if (input.action === 'set') {
    if (!input.baseUrl || !input.username || !input.password) {
      return fail('action=set requires baseUrl, username, and password.');
    }
    if (!input.baseUrl.startsWith('https://')) {
      return fail('baseUrl must use https://');
    }

    const config = {
      baseUrl: input.baseUrl,
      username: input.username,
      password: input.password,
      domain: input.domain ?? '',
      ignoreTls: input.ignoreTls ?? false,
    };

    if (input.test !== false) {
      try {
        const testClient = new ScoutClient(config);
        await testClient.login();
      } catch (err) {
        return fail(
          `Connection test failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    setSessionConfig(config);

    if (input.save) {
      saveConfig(config);
      return ok({
        status: 'configured',
        saved: true,
        message: 'Credentials saved to ~/.scout-mcp.json and active for this session.',
        baseUrl: config.baseUrl,
        username: config.username,
      });
    }

    return ok({
      status: 'configured',
      saved: false,
      message: 'Credentials active for this session only. Pass save=true to persist.',
      baseUrl: config.baseUrl,
      username: config.username,
    });
  }

  if (input.action === 'status') {
    const config = resolveConfig();
    if (!config) {
      return ok({
        status: 'not_configured',
        message: 'Call scout_configure with action=set to configure credentials.',
      });
    }
    return ok({
      status: 'configured',
      baseUrl: config.baseUrl,
      username: config.username,
      domain: config.domain || '(none)',
      ignoreTls: config.ignoreTls ?? false,
      hasSavedFile: loadSavedConfig() !== null,
    });
  }

  if (input.action === 'clear') {
    clearSessionConfig();
    if (input.deleteSaved) {
      deleteSavedConfig();
      return ok({ status: 'cleared', savedFileDeleted: true });
    }
    return ok({
      status: 'cleared',
      savedFileDeleted: false,
      message: 'Session cleared. Saved file (if any) was kept. Pass deleteSaved=true to remove it.',
    });
  }

  return fail('Unknown action');
}

export const configureTool = {
  name: 'scout_configure',
  description:
    'Configure Scout Board credentials at runtime — no static config files needed. ' +
    'Use action=set with baseUrl, username, and password to connect. ' +
    'Pass save=true to persist to ~/.scout-mcp.json for future sessions. ' +
    'Use action=status to inspect current config, action=clear to remove credentials.',
  inputSchema: zodToJsonSchema(inputSchema),
  execute,
};
