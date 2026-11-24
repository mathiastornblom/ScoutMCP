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

import { types } from 'node:util';
import { GuardrailError, checkKillSwitch, getScoutMode, type MutationCheckResult } from '../safety/guardrails.js';
import { sha256Hex } from './sanitize.js';

export interface TokenBinding {
  opId: string;
  opName: string;
  method: string;
  /** Op-table template, e.g. `/api/v1/containers/import`. */
  pathTemplate: string;
  /** Concrete NORMALISED path (lower-cased, see normalizeWritePath) the request will be sent to (F4). */
  concretePath: string;
  /** sha256 of the request body as sent (see bodyHashOf) (F4). */
  bodySha256: string;
}

/** Hash of a request body exactly as client.ts serialises it ('' when there is no body). */
export function bodyHashOf(body: unknown): string {
  return sha256Hex(body === undefined ? '' : JSON.stringify(body));
}

/** Minted tokens only: a structurally identical forged object is rejected. */
const MINTED = new WeakSet<object>();
/** Only mintMutationToken knows this key; the class itself is not exported. */
const MINT_KEY = Symbol('mint-mutation-token');

/** Default lifetime of a token (single request ops). */
const DEFAULT_TTL_MS = 120_000;

class MutationToken {
  readonly binding: Readonly<TokenBinding>;
  /** Read-only: a getter over a private field (N4). */
  readonly #expiresAt: number;
  #used = false;

  constructor(key: symbol, binding: TokenBinding, ttlMs: number) {
    // `new token.constructor(...)` from outside cannot supply the module-private key.
    if (key !== MINT_KEY) throw new GuardrailError('MutationToken cannot be constructed directly.', 'mutation-token');
    this.binding = Object.freeze({ ...binding });
    this.#expiresAt = Date.now() + ttlMs;
    MINTED.add(this);
    Object.freeze(this); // no property can be added, changed or redefined afterwards (N4)
  }

  get expiresAt(): number {
    return this.#expiresAt;
  }

  get used(): boolean {
    return this.#used;
  }

  /**
   * Called by client.ts for each request. Marks the token used (whatever the outcome), then checks
   * binding (method, template, concrete path, body hash), expiry, kill switch and mode.
   */
  consume(method: string, pathTemplate: string, concretePath: string, bodySha256: string): void {
    if (!MINTED.has(this)) throw new GuardrailError('Invalid mutation token.', 'mutation-token');
    if (this.#used) {
      throw new GuardrailError('Mutation token was already used (single-use).', 'mutation-token');
    }
    this.#used = true;
    if (
      method.toUpperCase() !== this.binding.method.toUpperCase() ||
      pathTemplate !== this.binding.pathTemplate ||
      concretePath !== this.binding.concretePath ||
      bodySha256 !== this.binding.bodySha256
    ) {
      throw new GuardrailError(
        'Mutation token is bound to a different request (method/path/body mismatch).',
        'mutation-token',
      );
    }
    if (Date.now() > this.#expiresAt) {
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

export type { MutationToken };

export function isMutationToken(x: unknown): x is MutationToken {
  return typeof x === 'object' && x !== null && MINTED.has(x);
}

const CHECK_KEYS = new Set(['proceed', 'dryRunNotice']);

/** True only for a plain data object shaped exactly like a MutationCheckResult with proceed === true (N4). */
function isProceedingCheck(check: unknown): check is MutationCheckResult {
  if (check === null || typeof check !== 'object' || types.isProxy(check)) return false;
  const proto = Object.getPrototypeOf(check);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(check);
  if (keys.some((k) => typeof k !== 'string' || !CHECK_KEYS.has(k))) return false;
  const d = Object.getOwnPropertyDescriptor(check, 'proceed');
  return !!d && 'value' in d && d.value === true; // data property only: no getter that flips
}

/** Mints a token from the gate-13 result. Refuses unless `check` is a plain `{proceed: true}` result. */
export function mintMutationToken(check: MutationCheckResult, binding: TokenBinding, ttlMs = DEFAULT_TTL_MS): MutationToken {
  if (!isProceedingCheck(check)) {
    throw new GuardrailError('Cannot mint a mutation token without a proceeding mutation check.', 'mutation-token');
  }
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs > DEFAULT_TTL_MS) {
    throw new GuardrailError('Invalid mutation token lifetime.', 'mutation-token');
  }
  for (const k of ['opId', 'opName', 'method', 'pathTemplate', 'concretePath', 'bodySha256'] as const) {
    if (typeof binding?.[k] !== 'string') throw new GuardrailError(`Invalid mutation token binding (${k}).`, 'mutation-token');
  }
  return new MutationToken(MINT_KEY, binding, ttlMs);
}
