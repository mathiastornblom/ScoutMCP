import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { type McpToolResult, ok, fail } from '../types.js';
import {
  setSessionConfig,
  clearSessionConfig,
  resolveConfig,
  saveConfig,
  deleteSavedConfig,
  loadSavedConfig,
  missingCcFields,
  type ScoutConfig,
} from '../session.js';
import { ScoutClient, getClient } from '../client.js';

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
  authMethod: z
    .enum(['password', 'citrix-cloud'])
    .optional()
    .describe(
      'Auth method to Scout Board: password (default, username/password) or citrix-cloud (Citrix Cloud service principal)',
    ),
  username: z
    .string()
    .optional()
    .describe('Username, e.g. admin@example.com (required for set with password auth)'),
  password: z.string().optional().describe('Password (required for set with password auth)'),
  ccClientId: z
    .string()
    .optional()
    .describe('Citrix Cloud service-principal client ID (required for citrix-cloud auth)'),
  ccClientSecret: z
    .string()
    .optional()
    .describe('Citrix Cloud service-principal client secret (required for citrix-cloud auth)'),
  ccCustomerId: z
    .string()
    .optional()
    .describe('Citrix Cloud customer ID (required for citrix-cloud auth unless region=staging or ccTokenUrl is set)'),
  ccRegion: z
    .enum(['us', 'eu', 'ap-s', 'jp', 'staging'])
    .optional()
    .describe('Citrix Cloud region for the token endpoint (staging uses /root/ instead of the customer id)'),
  ccTokenUrl: z
    .string()
    .optional()
    .describe('Full Citrix Cloud token endpoint URL override — takes precedence over ccRegion/ccCustomerId'),
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
    const authMethod = input.authMethod ?? 'password';
    let config: ScoutConfig;

    if (authMethod === 'citrix-cloud') {
      const candidate: ScoutConfig = {
        baseUrl: input.baseUrl ?? '',
        authMethod: 'citrix-cloud',
        ignoreTls: input.ignoreTls ?? false,
        ccClientId: input.ccClientId,
        ccClientSecret: input.ccClientSecret,
        ccCustomerId: input.ccCustomerId,
        ccRegion: input.ccRegion,
        ccTokenUrl: input.ccTokenUrl,
      };
      const missing = missingCcFields(candidate);
      if (missing.length > 0) {
        return fail(
          `action=set with authMethod=citrix-cloud is missing: ${missing.join('; ')}`,
        );
      }
      config = candidate;
    } else {
      if (!input.baseUrl || !input.username || !input.password) {
        return fail('action=set requires baseUrl, username, and password.');
      }
      config = {
        baseUrl: input.baseUrl,
        username: input.username,
        password: input.password,
        domain: input.domain ?? '',
        ignoreTls: input.ignoreTls ?? false,
      };
    }

    if (!config.baseUrl.startsWith('https://')) {
      return fail('baseUrl must use https://');
    }

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
        authMethod: config.authMethod ?? 'password',
        identity: config.authMethod === 'citrix-cloud' ? config.ccClientId : config.username,
      });
    }

    return ok({
      status: 'configured',
      saved: false,
      message: 'Credentials active for this session only. Pass save=true to persist.',
      baseUrl: config.baseUrl,
      authMethod: config.authMethod ?? 'password',
      identity: config.authMethod === 'citrix-cloud' ? config.ccClientId : config.username,
    });
  }

  if (input.action === 'status') {
    const config = resolveConfig();
    if (!config) {
      return ok({
        status: 'not_configured',
        message:
          'No credentials configured. Call scout_configure with action=set, ' +
          'providing baseUrl, username, and password.',
      });
    }
    const client = getClient();
    const expiry = client.tokenExpiry();
    const expiresAt = expiry ? new Date(expiry).toISOString() : null;
    const secondsLeft = expiry ? Math.round((expiry - Date.now()) / 1000) : null;
    return ok({
      status: 'configured',
      authenticated: client.isAuthenticated(),
      baseUrl: config.baseUrl,
      authMethod: config.authMethod ?? 'password',
      username: config.authMethod === 'citrix-cloud' ? undefined : config.username,
      ccClientId: config.authMethod === 'citrix-cloud' ? config.ccClientId : undefined,
      ccRegion: config.authMethod === 'citrix-cloud' ? config.ccRegion : undefined,
      domain: config.domain || '(none)',
      ignoreTls: config.ignoreTls ?? false,
      hasSavedFile: loadSavedConfig() !== null,
      tokenExpiresAt: expiresAt,
      tokenSecondsRemaining: secondsLeft,
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
    'Use action=set with baseUrl, username, and password to connect (or ' +
    'authMethod=citrix-cloud with ccClientId, ccClientSecret, ccCustomerId, ccRegion for ' +
    'Citrix Cloud service-principal auth). ' +
    'Pass save=true to persist to ~/.scout-mcp.json for future sessions. ' +
    'Use action=status to inspect current config, action=clear to remove credentials.',
  inputSchema: toInputSchema(inputSchema),
  execute,
};
