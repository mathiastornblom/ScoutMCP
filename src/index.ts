import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpTransport } from './http.js';
import { resolveTransportMode, InvalidTransportError } from './transport.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { listResources, listResourceTemplates, readResource } from './resources.js';

import { fetch } from 'undici';
import { setProgressReporter, clearProgressReporter, createProgressReporter } from './progress.js';
import type { ToolContext, McpTool } from './types.js';
import { loadSavedConfig, setSessionConfig, clearSessionConfig, resolveConfig } from './session.js';
import { shouldClearCredentialsAfterAuthFailure } from './startup_auth.js';
import { getClient } from './client.js';
import { MCP_SERVER_VERSION } from './version.js';
import { eliasTools } from './tools/elias.js';
import { getEliasWriteTools } from './tools/elias_write.js';
import { recoverUnknownIntents } from './elias/audit.js';
import { configureTool } from './tools/configure.js';
import { contextTool } from './tools/context.js';
import { healthCheckTool } from './tools/health.js';
import { ouGetTool, ouManageTool } from './tools/ou.js';
import { deviceGetTool, deviceManageTool } from './tools/device.js';
import { deviceCommandTool, deviceDiagnosticsTool } from './tools/command.js';
import { appListTool, appManageTool } from './tools/application.js';
import { configGetTool, configUpdateTool, configCompareTool } from './tools/config.js';
import { configResolveTool } from './tools/config_resolve.js';
import { labelManageTool } from './tools/label.js';
import { ruleManageTool } from './tools/rule.js';
import { scheduleManageTool } from './tools/schedule.js';
import { maintenanceWindowManageTool } from './tools/maintenance.js';
import { notificationManageTool } from './tools/notification.js';
import { updateTool } from './tools/update.js';
import { onboardBranchTool, moveDevicesByFilterTool, bulkCommandTool } from './tools/workflow.js';
import { ouFilterManageTool, newDeviceOptionsTool } from './tools/ou_filtering.js';
import { systemInfoTool } from './tools/system_info.js';
import { systemSettingsTool } from './tools/system_settings.js';
import { predefinedCommandsTool } from './tools/predefined_commands.js';
import { predefinedPathsTool } from './tools/predefined_paths.js';
import { predefinedImagesTool } from './tools/predefined_images.js';
import { licenseManageTool } from './tools/license.js';
import { adminManageTool } from './tools/admins.js';
import { serverInstancesTool } from './tools/server_instances.js';
import { dbCleanupTool } from './tools/db_cleanup.js';
import { registerPrompts } from './prompts.js';

// Load persisted credentials from ~/.scout-mcp.json if present
const savedConfig = loadSavedConfig();
if (savedConfig) setSessionConfig(savedConfig);

// Verify auth in the BACKGROUND. The MCP handshake must not wait on the Scout login:
// a cold Scout server can take >30s for the first login, which exceeds the client's
// connect timeout and makes the whole server show as "failed". Tool calls log in lazily
// (ensureAuth), so nothing depends on this finishing first. Credentials are cleared only
// when the server explicitly REJECTS them (HTTP 400/401/403); a timeout or network error
// is transient and must not wipe a working configuration.
const startupConfig = resolveConfig();
if (startupConfig) {
  void (async () => {
    try {
      await getClient().login();
      process.stderr.write(
        `[scout-mcp] Authenticated — connected to ${startupConfig.baseUrl} as ${startupConfig.authMethod === 'citrix-cloud' ? `service principal ${startupConfig.ccClientId}` : startupConfig.username}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // resolveConfig() can throw (e.g. session cleared + invalid env config); that must never crash the
      // detached task, so treat it as "config unknown" and keep credentials.
      let currentConfig: ReturnType<typeof resolveConfig> = null;
      try {
        currentConfig = resolveConfig();
      } catch {
        currentConfig = null;
      }
      if (shouldClearCredentialsAfterAuthFailure(err, startupConfig, currentConfig)) {
        process.stderr.write(
          `[scout-mcp] WARNING: Startup auth failed (${msg}). ` +
            'Credentials cleared — use scout_configure to reconnect.\n',
        );
        clearSessionConfig();
      } else {
        process.stderr.write(
          `[scout-mcp] WARNING: Startup auth did not complete (${msg}). ` +
            'Credentials kept; the next tool call will retry the login.\n',
        );
      }
    }
  })();
} else {
  process.stderr.write(
    '[scout-mcp] No credentials configured. ' +
      'Use the scout_configure tool with action=set, baseUrl, username, and password to connect.\n',
  );
}

// Non-blocking release check — compares SCOUT_VERSION (semver) against the latest GitHub release tag.
// Runs every time the MCP server starts, i.e. on every client reconnect.
void (async () => {
  const currentVersion = process.env.SCOUT_VERSION;
  if (!currentVersion || currentVersion === 'dev') return;

  function parseVer(v: string): [number, number, number] {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  function isNewer(latest: string, current: string): boolean {
    const [lMaj, lMin, lPatch] = parseVer(latest);
    const [cMaj, cMin, cPatch] = parseVer(current);
    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPatch > cPatch;
  }

  try {
    const res = await fetch('https://api.github.com/repos/mathiastornblom/ScoutMCP/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { tag_name?: string };
    const latestTag = data.tag_name;
    if (!latestTag) return;
    if (isNewer(latestTag, currentVersion)) {
      process.stderr.write(
        `[scout-mcp] Update available: v${currentVersion} → ${latestTag}. ` +
          'Rebuild the Docker image to get the latest version.\n',
      );
    } else {
      process.stderr.write(`[scout-mcp] Version v${currentVersion} is up to date.\n`);
    }
  } catch {
    // Network errors are non-fatal — skip silently
  }
})();

const privateEndpointsEnabled = process.env.SCOUT_ENABLE_PRIVATE_ENDPOINTS === 'true';
if (privateEndpointsEnabled) {
  process.stderr.write('[scout-mcp] Private endpoints enabled (SCOUT_ENABLE_PRIVATE_ENDPOINTS=true)\n');
}

// ELIAS write foundation: tools only with SCOUT_ELIAS_WRITES=a|b; startup surfaces intents that never got a result.
const eliasWriteTools = privateEndpointsEnabled ? getEliasWriteTools() : [];
if (eliasWriteTools.length > 0) {
  try {
    const recovered = recoverUnknownIntents();
    if (recovered.length > 0) {
      process.stderr.write(`[scout-mcp] ${recovered.length} ELIAS write intent(s) without a result were marked recovered-unknown\n`);
    }
  } catch {
    /* best effort */
  }
}

const tools: McpTool[] = [
  configureTool,
  contextTool,
  healthCheckTool,
  ouGetTool,
  ouManageTool,
  deviceGetTool,
  deviceManageTool,
  deviceCommandTool,
  deviceDiagnosticsTool,
  appListTool,
  appManageTool,
  configGetTool,
  configUpdateTool,
  configCompareTool,
  configResolveTool,
  labelManageTool,
  ruleManageTool,
  scheduleManageTool,
  maintenanceWindowManageTool,
  notificationManageTool,
  updateTool,
  onboardBranchTool,
  moveDevicesByFilterTool,
  bulkCommandTool,
  ...(privateEndpointsEnabled
    ? [
        ouFilterManageTool,
        newDeviceOptionsTool,
        systemInfoTool,
        systemSettingsTool,
        predefinedCommandsTool,
        predefinedPathsTool,
        predefinedImagesTool,
        licenseManageTool,
        adminManageTool,
        serverInstancesTool,
        dbCleanupTool,
        ...eliasTools, // read-only ELIAS (Scout 2611+)
        ...eliasWriteTools, // [] unless SCOUT_ELIAS_WRITES=a|b (and body evidence / test escape hatch)
      ]
    : []),
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'scout-mcp-server', version: MCP_SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

registerPrompts(server);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // notifications/progress requires a progressToken from the originating request's _meta
  // (per the MCP spec). If the caller didn't supply one, progressToken is undefined and
  // sendProgress below is never invoked — createProgressReporter()'s report() degrades to a
  // silent no-op in that case (see src/progress.ts).
  const progressToken = request.params._meta?.progressToken;

  setProgressReporter(
    createProgressReporter({
      log: async (level, message) => {
        await server.sendLoggingMessage({ level, data: message });
      },
      sendProgress:
        progressToken !== undefined
          ? async (progress, total, message) => {
              await server.notification({
                method: 'notifications/progress',
                params: { progressToken, progress, total, message },
              });
            }
          : undefined,
    }),
  );

  const ctx: ToolContext = {
    server,
    progressToken,
    sendProgress:
      progressToken !== undefined
        ? async (progress, total, message) => {
            try {
              await server.notification({
                method: 'notifications/progress',
                params: { progressToken, progress, total, message },
              });
            } catch {
              // Best-effort: progress notifications must never fail the underlying operation.
            }
          }
        : undefined,
  };

  try {
    const result = await tool.execute(args ?? {}, ctx);
    return result as CallToolResult;
  } catch (err) {
    // Never forward stack traces or internal paths to the MCP client
    const message = err instanceof Error ? err.message : 'An unexpected error occurred';
    return { content: [{ type: 'text', text: message }], isError: true };
  } finally {
    clearProgressReporter();
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await listResources(),
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
  resourceTemplates: listResourceTemplates(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const content = await readResource(uri);
  return { contents: [content] };
});

// Transport selection — defaults to stdio, completely unchanged for existing users who
// don't set SCOUT_TRANSPORT. SCOUT_TRANSPORT=http switches to the Streamable-HTTP
// transport (src/http.ts), which adds its own OIDC bearer-auth gate and manages its own
// per-session transport instances; it calls server.connect() itself per session, so we
// must NOT call server.connect() with a StdioServerTransport in that branch.
try {
  const transportMode = resolveTransportMode(process.env.SCOUT_TRANSPORT);
  if (transportMode === 'http') {
    await startHttpTransport(server);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
} catch (err) {
  if (err instanceof InvalidTransportError) {
    process.stderr.write(`[scout-mcp] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
