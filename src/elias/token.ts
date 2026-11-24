/**
 * Single-use mutation token (Security C1).
 *
 * A token is minted from a `MutationCheckResult` with `proceed === true` (the ONE gate-13 check of
 * a logical op) and is bound to opId + opName + method + path template. client.ts consumes it per
 * request: wrong binding, reuse, expiry, kill switch, or a mode other than `write` refuse BEFORE any
 * network traffic. Only src/elias/pipeline.ts may call `mintMutationToken` (static test).
 *
 * This module must not import client.ts.
 */

import { GuardrailError, checkKillSwitch, getScoutMode, type MutationCheckResult } from '../safety/guardrails.js';

export interface TokenBinding {
  opId: string;
  opName: string;
  method: string;
  /** Op-table template, e.g. `/api/v1/containers/import`. */
  pathTemplate: string;
}

/** Minted tokens only: a structurally identical forged object is rejected. */
const MINTED = new WeakSet<object>();

/** Default lifetime of a token (single request ops). Upload-style ops would pass their own bound later. */
const DEFAULT_TTL_MS = 120_000;

export class MutationToken {
  readonly binding: Readonly<TokenBinding>;
  readonly expiresAt: number;
  #used = false;

  /** @internal use mintMutationToken(). */
  constructor(binding: TokenBinding, ttlMs: number) {
    this.binding = Object.freeze({ ...binding });
    this.expiresAt = Date.now() + ttlMs;
    MINTED.add(this);
  }

  get used(): boolean {
    return this.#used;
  }

  /**
   * Called by client.ts for each request. Marks the token used (whatever the outcome), then checks
   * binding, expiry, kill switch and mode. Throws GuardrailError(gate 'mutation-token' | 'kill-switch').
   */
  consume(method: string, pathTemplate: string): void {
    if (this.#used) {
      throw new GuardrailError('Mutation token was already used (single-use).', 'mutation-token');
    }
    this.#used = true;
    if (method.toUpperCase() !== this.binding.method.toUpperCase() || pathTemplate !== this.binding.pathTemplate) {
      throw new GuardrailError(
        'Mutation token is bound to a different request (method/path template mismatch).',
        'mutation-token',
      );
    }
    if (Date.now() > this.expiresAt) {
      throw new GuardrailError('Mutation token expired.', 'mutation-token');
    }
    // Authoritative re-checks right before the request leaves (kill switch + mode).
    checkKillSwitch(this.binding.opName);
    if (getScoutMode() !== 'write') {
      throw new GuardrailError(
        `Mutation token refused: SCOUT_MODE is not "write" (op ${this.binding.opName}).`,
        'mutation-token',
      );
    }
  }
}

export function isMutationToken(x: unknown): x is MutationToken {
  return typeof x === 'object' && x !== null && MINTED.has(x);
}

/** Mints a token from the gate-13 result. Refuses unless `check.proceed === true`. */
export function mintMutationToken(check: MutationCheckResult, binding: TokenBinding, ttlMs = DEFAULT_TTL_MS): MutationToken {
  if (!check || check.proceed !== true) {
    throw new GuardrailError('Cannot mint a mutation token without a proceeding mutation check.', 'mutation-token');
  }
  return new MutationToken(binding, ttlMs);
}
