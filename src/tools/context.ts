import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { ok, fail, type McpToolResult } from '../types.js';
import { resolveWriteTarget } from '../resolver.js';
import { getWorkingOu, setWorkingOu, clearWorkingOu } from '../context.js';

// ── scout_context ─────────────────────────────────────────────────────────────

const contextSchema = z.object({
  action: z
    .enum(['set_ou', 'get_ou', 'clear_ou'])
    .describe(
      'set_ou=set working OU (path or id required, validated against Scout Board); ' +
        'get_ou=show current working OU; clear_ou=unset working OU',
    ),
  path: z.string().optional().describe('OU path to set as working OU (set_ou)'),
  id: z.number().int().optional().describe('OU numeric ID to set as working OU (set_ou)'),
});

type ContextInput = z.infer<typeof contextSchema>;

async function contextExecute(raw: unknown): Promise<McpToolResult> {
  const input = contextSchema.parse(raw) as ContextInput;

  switch (input.action) {
    case 'set_ou': {
      if (!input.path && input.id === undefined) {
        return fail('set_ou requires either path or id');
      }
      try {
        // Name and path come from the parsed OU tree (real rows carry OUID/Name, not OUPath/OUName;
        // see src/ou_tree.ts), looked up by id. If the OU cannot be resolved there is NO working OU
        // (fail soft, nothing stored) - never a numeric string used as a name.
        const match = await resolveWriteTarget([input.path, input.id], 'working OU');
        if (!match) return fail('set_ou requires either path or id');
        setWorkingOu(match.path, match.name);
        return ok({
          workingOu: { path: match.path, name: match.name },
          message: `Working OU set to "${match.name}" (${match.path}). Tools that accept ouPath or destoupath will now use this as their default.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`set_ou failed: ${msg}. No working OU was set.`);
      }
    }

    case 'get_ou': {
      const current = getWorkingOu();
      if (!current) {
        return ok({
          workingOu: null,
          message:
            'No working OU is currently set. ' +
            'Use scout_context action=set_ou with a path or id to set one.',
        });
      }
      return ok({
        workingOu: current,
        message: `Current working OU: "${current.name}" (${current.path})`,
      });
    }

    case 'clear_ou': {
      const prev = getWorkingOu();
      clearWorkingOu();
      return ok({
        workingOu: null,
        message: prev
          ? `Working OU cleared (was "${prev.name}" at ${prev.path}).`
          : 'No working OU was set.',
      });
    }
  }
}

export const contextTool = {
  name: 'scout_context',
  description:
    'Manage the session-level working OU. ' +
    'action=set_ou validates the OU exists and stores it as the default for tools that accept ouPath or destoupath — ' +
    'device_get mode=search, ou_get mode=subordinate/device_status, and device_manage action=add/move will all use ' +
    'the working OU when no explicit path is given. ' +
    'action=get_ou shows what is currently set. action=clear_ou unsets it. ' +
    'The working OU is session-scoped and cleared on server restart.',
  inputSchema: toInputSchema(contextSchema),
  execute: contextExecute,
};
