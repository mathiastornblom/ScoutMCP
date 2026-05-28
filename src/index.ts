import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadSavedConfig, setSessionConfig } from './session.js';
import { configureTool } from './tools/configure.js';
import { healthCheckTool } from './tools/health.js';
import { ouGetTool, ouManageTool } from './tools/ou.js';
import { deviceGetTool, deviceManageTool } from './tools/device.js';
import { deviceCommandTool, deviceDiagnosticsTool } from './tools/command.js';
import { appListTool, appManageTool } from './tools/application.js';
import { configGetTool, configUpdateTool } from './tools/config.js';
import { labelManageTool } from './tools/label.js';
import { ruleManageTool } from './tools/rule.js';
import { scheduleManageTool } from './tools/schedule.js';
import { maintenanceWindowManageTool } from './tools/maintenance.js';
import { notificationManageTool } from './tools/notification.js';

// Load persisted credentials from ~/.scout-mcp.json if present
const savedConfig = loadSavedConfig();
if (savedConfig) setSessionConfig(savedConfig);

const tools = [
  configureTool,
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
  labelManageTool,
  ruleManageTool,
  scheduleManageTool,
  maintenanceWindowManageTool,
  notificationManageTool,
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'scout-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.execute(args ?? {});
    return result as CallToolResult;
  } catch (err) {
    // Never forward stack traces or internal paths to the MCP client
    const message = err instanceof Error ? err.message : 'An unexpected error occurred';
    return { content: [{ type: 'text', text: message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
