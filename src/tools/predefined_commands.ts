/**
 * Private Scout Board endpoints for predefined commands management.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

// ── Logging helpers ───────────────────────────────────────────────────────────

function log(tool: string, method: string, path: string, body?: unknown): void {
  const bodyStr = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
  process.stderr.write(`[scout-mcp/${tool}] ${method} ${path}${bodyStr}\n`);
}

function logOk(tool: string): void {
  process.stderr.write(`[scout-mcp/${tool}] response: 2xx\n`);
}

function logErr(tool: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scout-mcp/${tool}] error: ${msg}\n`);
}

// ── Schemas for command entries ───────────────────────────────────────────────

const addCommandEntrySchema = z.object({
  Name: z.string().describe('Display name for the predefined command'),
  Command: z.string().describe('The command string to execute'),
  RunAsSystem: z.boolean().optional().describe('Run the command as the system account'),
  Active: z.boolean().optional().describe('Whether the command is active'),
  admins: z.array(z.string()).optional().describe('List of admin identifiers that can run this command'),
});

const modifyCommandEntrySchema = z.object({
  PredefinedCommandID: z.number().int().describe('ID of the predefined command to modify (required)'),
  Name: z.string().optional().describe('New display name for the command'),
  Command: z.string().optional().describe('New command string'),
  RunAsSystem: z.boolean().optional().describe('Run the command as the system account'),
  Active: z.boolean().optional().describe('Whether the command is active'),
  admins: z.array(z.string()).optional().describe('List of admin identifiers that can run this command'),
});

const deleteCommandEntrySchema = z.object({
  PredefinedCommandID: z.number().int().describe('ID of the predefined command to delete (required)'),
});

const modifyTemplateEntrySchema = z.object({
  Command: z.string().describe('The command string of the template to modify'),
  useTemplate: z.boolean().describe('Whether to use this template'),
});

// ── predefined_commands schema ────────────────────────────────────────────────

const predefinedCommandsSchema = z.object({
  action: z
    .enum(['list', 'add', 'modify', 'delete', 'auth', 'list_templates', 'modify_templates'])
    .describe(
      'list=list all predefined commands; ' +
        'add=DESTRUCTIVE: add new predefined command entries (requires add_entries); ' +
        'modify=DESTRUCTIVE: modify existing command entries by PredefinedCommandID (requires modify_entries); ' +
        'delete=DESTRUCTIVE: delete commands by PredefinedCommandID (requires delete_entries); ' +
        'auth=authenticate with password to enable command execution (requires password); ' +
        'list_templates=list available command templates; ' +
        'modify_templates=update which templates are in use (requires template_entries)',
    ),

  add_entries: z
    .array(addCommandEntrySchema)
    .optional()
    .describe('Entries to add (required for add action)'),

  modify_entries: z
    .array(modifyCommandEntrySchema)
    .optional()
    .describe('Entries to modify — each must include PredefinedCommandID (required for modify action)'),

  delete_entries: z
    .array(deleteCommandEntrySchema)
    .optional()
    .describe('Entries to delete — each must include PredefinedCommandID (required for delete action)'),

  password: z.string().optional().describe('Password for auth action'),

  template_entries: z
    .array(modifyTemplateEntrySchema)
    .optional()
    .describe('Template modifications (required for modify_templates action)'),
});

type PredefinedCommandsInput = z.infer<typeof predefinedCommandsSchema>;

async function predefinedCommandsExecute(raw: unknown): Promise<McpToolResult> {
  const input = predefinedCommandsSchema.parse(raw) as PredefinedCommandsInput;
  const client = getClient();
  const tool = 'predefined_commands';

  try {
    switch (input.action) {
      case 'list': {
        const path = '/api/v1/predefinedCommands';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'add': {
        if (!input.add_entries || input.add_entries.length === 0)
          return fail('add requires at least one entry in add_entries');
        const body = { requestValues: input.add_entries };
        const path = '/api/v1/predefinedCommands/add';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'modify': {
        if (!input.modify_entries || input.modify_entries.length === 0)
          return fail('modify requires at least one entry in modify_entries');
        const body = { requestValues: input.modify_entries };
        const path = '/api/v1/predefinedCommands/modify';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'delete': {
        if (!input.delete_entries || input.delete_entries.length === 0)
          return fail('delete requires at least one entry in delete_entries');
        const body = { requestValues: input.delete_entries };
        const path = '/api/v1/predefinedCommands/delete';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'auth': {
        if (!input.password) return fail('auth requires password');
        const body = { password: input.password };
        const path = '/api/v1/predefinedCommands/auth';
        log(tool, 'POST', path);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }

      case 'list_templates': {
        const path = '/api/v1/predefinedcommands/template';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'modify_templates': {
        if (!input.template_entries || input.template_entries.length === 0)
          return fail('modify_templates requires at least one entry in template_entries');
        const body = { modifiedTemplates: input.template_entries };
        const path = '/api/v1/predefinedCommands/modifyTemplates';
        log(tool, 'POST', path, body);
        const data = await client.rawRequest<unknown>('POST', path, body);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`predefined_commands failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const predefinedCommandsTool = {
  name: 'predefined_commands',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'Manage Scout Board predefined commands and their templates. ' +
    'Actions: list (all commands), ' +
    'add (DESTRUCTIVE: add new commands via add_entries), ' +
    'modify (DESTRUCTIVE: update commands by PredefinedCommandID via modify_entries), ' +
    'delete (DESTRUCTIVE: remove commands by PredefinedCommandID via delete_entries), ' +
    'auth (authenticate with password to enable execution), ' +
    'list_templates (available command templates), ' +
    'modify_templates (update template usage via template_entries).',
  inputSchema: zodToJsonSchema(predefinedCommandsSchema),
  execute: predefinedCommandsExecute,
};
