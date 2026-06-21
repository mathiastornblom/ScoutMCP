/**
 * Real elicitation-based confirmation for destructive operations, with a
 * confirm:true fallback for clients that don't support elicitation.
 *
 * Mechanics:
 *   - MCP clients declare capabilities during the `initialize` handshake. The SDK's
 *     `Server.getClientCapabilities()` returns the negotiated capabilities after that
 *     handshake completes — see node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
 *     (`getClientCapabilities(): ClientCapabilities | undefined`) and index.js (populated
 *     from the `initialize` request's `params.capabilities` in `_oninitialize`).
 *   - A client that supports elicitation reports `capabilities.elicitation` as a non-empty
 *     object (the SDK's `ClientCapabilitiesSchema` declares `elicitation` as an optional
 *     `ElicitationCapabilitySchema`). We treat *any* truthy `elicitation` capability object
 *     as "this client can be asked yes/no questions" and use the form-mode elicitation flow
 *     (`server.elicitInput({ mode: 'form', message, requestedSchema })`, which the SDK sends
 *     as an `elicitation/create` request — see server/index.js `elicitInput()`).
 *   - When the client has NOT declared the capability, every confirmation gate falls back to
 *     requiring `confirm: true` in the tool's own input — exactly the behavior that shipped
 *     before this module existed. That fallback boundary is the single `supportsElicitation()`
 *     check below; nothing else decides which path a tool takes.
 *
 * Tool files call `confirmDestructiveAction()` instead of inlining `if (!input.confirm) fail(...)`.
 * It never includes secrets/credentials/PII in the elicitation prompt — only a yes/no question
 * about the blast radius of the operation (target, scope, counts).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface ConfirmationContext {
  /** The live MCP Server instance, used to check capabilities and issue elicitation/create. */
  server?: Server;
}

export interface ConfirmationRequest {
  /** Short operation name for logging/messages, e.g. "config_update" or "bulk_command(halt)". */
  opName: string;
  /** Human-readable summary of what will happen — target, scope, counts. No secrets/PII. */
  summary: string;
  /** Whether the caller already passed confirm:true in tool input (fallback path). */
  confirmFlag: boolean | undefined;
}

export type ConfirmationOutcome =
  | { proceed: true; via: 'elicitation' | 'confirm-flag' }
  | { proceed: false; via: 'elicitation' | 'confirm-flag'; reason: string };

/**
 * Returns true if the connected client declared the `elicitation` capability during the
 * `initialize` handshake. Checks `server.getClientCapabilities()?.elicitation` — a truthy
 * (non-undefined) value means the client opted in; `undefined`/missing means it didn't, and
 * we must fall back to confirm:true.
 */
export function supportsElicitation(server: Server | undefined): boolean {
  if (!server) return false;
  try {
    const caps = server.getClientCapabilities();
    return Boolean(caps?.elicitation);
  } catch {
    // getClientCapabilities() throws only if called before initialization completes — treat
    // that as "no elicitation support" rather than crashing the tool call.
    return false;
  }
}

/**
 * Decides how to gate a destructive action and, if elicitation is supported, actually performs
 * the yes/no round-trip. Returns a structured outcome the caller uses to proceed or fail.
 *
 * Boundary condition (elicitation vs confirm:true): `supportsElicitation(ctx.server)` is the
 * ONLY thing that decides which path runs. If true, we always issue a real elicitation request
 * (ignoring any confirm flag already on the input — the live human answer takes precedence).
 * If false, we require `confirmFlag === true`, exactly as before this module existed.
 */
export async function confirmDestructiveAction(
  ctx: ConfirmationContext,
  req: ConfirmationRequest,
): Promise<ConfirmationOutcome> {
  if (supportsElicitation(ctx.server)) {
    try {
      const result = await ctx.server!.elicitInput({
        mode: 'form',
        message: `${req.opName}: ${req.summary}\n\nProceed with this operation?`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirmed: {
              type: 'boolean',
              title: 'Confirm',
              description: 'Set to true to proceed, false to cancel.',
            },
          },
          required: ['confirmed'],
        },
      });

      if (result.action === 'accept') {
        const confirmed = (result.content as Record<string, unknown> | undefined)?.['confirmed'];
        if (confirmed === true) {
          return { proceed: true, via: 'elicitation' };
        }
        return {
          proceed: false,
          via: 'elicitation',
          reason: `${req.opName} was not confirmed by the user.`,
        };
      }

      // 'decline' or 'cancel'
      return {
        proceed: false,
        via: 'elicitation',
        reason: `${req.opName} was ${result.action} by the user.`,
      };
    } catch (err) {
      // If the elicitation round-trip itself fails (transport error, client misbehaving despite
      // declaring the capability), fail closed rather than silently falling back to confirm:true
      // — a failed confirmation prompt must never be treated as "yes."
      return {
        proceed: false,
        via: 'elicitation',
        reason: `${req.opName} confirmation request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Fallback: client does not support elicitation — require confirm:true in tool input.
  if (req.confirmFlag === true) {
    return { proceed: true, via: 'confirm-flag' };
  }
  return {
    proceed: false,
    via: 'confirm-flag',
    reason: `${req.opName} requires confirm=true to proceed (this client does not support interactive confirmation). ${req.summary}`,
  };
}
