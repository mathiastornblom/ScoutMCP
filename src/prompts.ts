/**
 * MCP Prompts — pre-built workflow templates for common Scout Board tasks.
 *
 * Each prompt returns a user message that instructs the AI to execute a
 * specific multi-step workflow using the available tools. Arguments are
 * interpolated into the message text so the AI has all context up front.
 *
 * Prompts are discovered via prompts/list and retrieved via prompts/get.
 */

import { type Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Prompt definitions ────────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'scout_connect',
    description:
      'Connect to a Scout Board server and prepare the session — configure credentials, verify connectivity, and optionally set a working OU.',
    arguments: [
      { name: 'base_url', description: 'Scout Board URL (https://host:22160)', required: true },
      { name: 'username', description: 'Login username (email)', required: true },
      { name: 'ou_path', description: 'OU path to set as working OU after connecting (optional)', required: false },
    ],
  },
  {
    name: 'onboard_device',
    description:
      'Add a new device to Scout Board: register it in the target OU, verify it appears, and confirm readiness.',
    arguments: [
      { name: 'device_name', description: 'Name for the new device', required: true },
      { name: 'mac_address', description: 'MAC address of the new device (e.g. AA:BB:CC:DD:EE:FF)', required: true },
      { name: 'ou_path', description: 'OU to register the device in (uses working OU if not provided)', required: false },
    ],
  },
  {
    name: 'audit_ou',
    description:
      'Audit all devices in an OU: list them, check activation and connection status, and summarise findings.',
    arguments: [
      { name: 'ou_path', description: 'OU to audit (uses working OU if not provided)', required: false },
      { name: 'include_sub_ous', description: 'Include devices in child OUs (true/false, default false)', required: false },
    ],
  },
  {
    name: 'mass_command',
    description:
      'Send a command (restart, update, factory reset, etc.) to all devices in an OU — with a preview step before executing.',
    arguments: [
      { name: 'command', description: 'Command to send: restart | update | factoryreset | halt | activate | deactivate', required: true },
      { name: 'ou_path', description: 'Target OU (uses working OU if not provided)', required: false },
      { name: 'confirm', description: 'Set to "true" to execute immediately; omit to preview first', required: false },
    ],
  },
  {
    name: 'move_devices',
    description:
      'Find devices matching a search term in one OU and move them to another OU — with a preview before any move.',
    arguments: [
      { name: 'search_term', description: 'Device name pattern to search for', required: true },
      { name: 'source_ou', description: 'OU to search in (uses working OU if not provided)', required: false },
      { name: 'target_ou', description: 'Destination OU path', required: true },
    ],
  },
] as const;

// ── Message builders ──────────────────────────────────────────────────────────

function buildMessage(name: string, args: Record<string, string>): string {
  const get = (key: string, fallback = '') => args[key] ?? fallback;

  switch (name) {
    case 'scout_connect': {
      const baseUrl = get('base_url');
      const username = get('username');
      const ouPath = get('ou_path');
      return [
        `Connect to the Scout Board server at **${baseUrl}** as **${username}**.`,
        '',
        'Steps:',
        `1. Call \`scout_configure\` with \`action=set\`, \`baseUrl=${baseUrl}\`, \`username=${username}\`, and ask the user for their password (do NOT store it in plaintext).`,
        '2. Call `health_check` with `mode=healthcheck` to verify the connection and retrieve server version info.',
        '3. If the health check fails, report the error and stop.',
        ouPath
          ? `4. Call \`scout_context\` with \`action=set_ou\` and \`path=${ouPath}\` to set the working OU.`
          : '4. Ask the user if they want to set a working OU (scout_context action=set_ou) for this session.',
        '5. Report the connected server name, version, and working OU status.',
      ].join('\n');
    }

    case 'onboard_device': {
      const deviceName = get('device_name');
      const mac = get('mac_address');
      const ouPath = get('ou_path');
      const ouNote = ouPath
        ? `Use OU path \`${ouPath}\`.`
        : 'Use the working OU (scout_context action=get_ou); if none is set, ask the user for the target OU path.';
      return [
        `Onboard a new device named **${deviceName}** (MAC: \`${mac}\`) into Scout Board.`,
        '',
        'Steps:',
        `1. Determine the target OU. ${ouNote}`,
        `2. Call \`device_manage\` with \`action=add\`, \`newDeviceName=${deviceName}\`, \`newDeviceMac=${mac}\`, and the resolved \`destoupath\`.`,
        `3. Verify the device was registered: call \`device_get\` with \`mode=get\` and \`name=${deviceName}\`.`,
        '4. Report the device details (ID, OU, status) on success, or the error if the add failed.',
        '5. If successful, ask the user if they want to send an initial command (e.g. activate).',
      ].join('\n');
    }

    case 'audit_ou': {
      const ouPath = get('ou_path');
      const includeSub = get('include_sub_ous', 'false');
      const ouNote = ouPath
        ? `Audit OU: \`${ouPath}\`.`
        : 'Use the working OU (scout_context action=get_ou); if none is set, ask the user for the OU path.';
      return [
        `Audit all devices in an OU and report their health status.`,
        '',
        `${ouNote}`,
        '',
        'Steps:',
        `1. Resolve the OU path as described above.`,
        `2. Call \`ou_get\` with \`mode=device_status\`, the resolved \`ouPath\`, and \`includeSubOus=${includeSub}\` to get device statuses.`,
        '3. Summarise the results:',
        '   - Total device count',
        '   - Active vs inactive vs unknown',
        '   - Any devices with errors or warnings',
        '4. List devices that are inactive or have issues (name, status, last seen).',
        '5. If there are inactive devices, ask the user if they want to send a restart command.',
      ].join('\n');
    }

    case 'mass_command': {
      const command = get('command');
      const ouPath = get('ou_path');
      const confirm = get('confirm', 'false');
      const ouNote = ouPath
        ? `Target OU: \`${ouPath}\`.`
        : 'Use the working OU (scout_context action=get_ou); if none is set, ask the user for the OU path.';
      const safetyNote =
        command === 'factoryreset' || command === 'halt'
          ? `\n⚠️  **${command.toUpperCase()}** is a destructive command. Always confirm with the user before executing.`
          : '';
      return [
        `Send the **${command}** command to all devices in an OU.${safetyNote}`,
        '',
        `${ouNote}`,
        '',
        'Steps:',
        '1. Resolve the OU path as described above.',
        `2. Call \`device_get\` with \`mode=search\`, the resolved \`ouPath\`, and \`searchTerm=*\` (or a broad term) to list all devices.`,
        '3. Show the device list as a preview (names and current status).',
        confirm === 'true'
          ? `4. Proceed: call \`device_command\` with \`command=${command}\`, \`ouPath=<resolved>\`, and \`confirm=true\`.`
          : `4. Ask the user to confirm before executing. Once confirmed, call \`device_command\` with \`command=${command}\`, \`ouPath=<resolved>\`, and \`confirm=true\`.`,
        `5. After execution, report success or any per-device errors.`,
      ].join('\n');
    }

    case 'move_devices': {
      const searchTerm = get('search_term');
      const sourceOu = get('source_ou');
      const targetOu = get('target_ou');
      const sourceNote = sourceOu
        ? `Search in OU: \`${sourceOu}\`.`
        : 'Use the working OU as source (scout_context action=get_ou); if none is set, ask the user.';
      return [
        `Find devices matching **"${searchTerm}"** and move them to \`${targetOu}\`.`,
        '',
        `${sourceNote}`,
        '',
        'Steps:',
        '1. Resolve the source OU path as described above.',
        `2. Call \`device_get\` with \`mode=search\`, the resolved \`ouPath\`, and \`searchTerm=${searchTerm}\`.`,
        '3. Show the matching devices as a preview (names, IDs, current OU).',
        '4. Ask the user to confirm the move before proceeding.',
        `5. For each device, call \`device_manage\` with \`action=move\`, the device identifier, and \`destoupath=${targetOu}\`.`,
        '6. Report how many devices were moved successfully and list any failures.',
      ].join('\n');
    }

    default:
      return `Unknown prompt: ${name}`;
  }
}

// ── Handler registration ──────────────────────────────────────────────────────

/**
 * Registers the prompts/list and prompts/get handlers on the given MCP server.
 * Call this before connecting the transport.
 */
export function registerPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({
      name,
      description,
      arguments: args.map((a) => ({ name: a.name, description: a.description, required: a.required })),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    const found = PROMPTS.find((p) => p.name === name);
    if (!found) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    const resolvedArgs = (args ?? {}) as Record<string, string>;
    return {
      description: found.description,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: buildMessage(name, resolvedArgs),
          },
        },
      ],
    };
  });
}
