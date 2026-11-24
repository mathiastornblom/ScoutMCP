/**
 * Gate G0 / rule D0 / Security C12: when may an ELIAS write tool be registered (and re-checked per call)?
 *
 *  - SCOUT_ENABLE_PRIVATE_ENDPOINTS=true, and SCOUT_ELIAS_WRITES covers the op's tier;
 *  - the tool's body contract is `verified-live` with a valid evidence record in the compat registry;
 *  - OR (escape hatch) SCOUT_ELIAS_ALLOW_UNVERIFIED_WRITES=true with SCOUT_ENV=test. Such calls are
 *    additionally restricted to strict MCPTEST names by the pipeline and audited with `unverified:true`.
 */

import { getBodyContract, isBodyVerifiedLive, type WriteBodyContract, WRITE_BODY_CONTRACTS } from '../compat/registry.js';
import { type EliasWriteConfig, tierCovers } from './config.js';

export type Registration =
  | { registered: true; unverified: boolean }
  | { registered: false; reason: string };

export function evaluateRegistration(
  toolName: string,
  opTier: 'A0' | 'A' | 'B',
  cfg: EliasWriteConfig,
  contracts: readonly WriteBodyContract[] | undefined = WRITE_BODY_CONTRACTS,
): Registration {
  if (!cfg.privateEndpoints) return { registered: false, reason: 'SCOUT_ENABLE_PRIVATE_ENDPOINTS is not true' };
  if (!tierCovers(cfg, opTier)) return { registered: false, reason: `SCOUT_ELIAS_WRITES does not cover tier ${opTier}` };
  if (!getBodyContract(toolName, contracts)) return { registered: false, reason: 'no body contract in the compat registry' };
  if (isBodyVerifiedLive(toolName, contracts)) return { registered: true, unverified: false };
  if (cfg.allowUnverifiedWrites && cfg.testEnv) return { registered: true, unverified: true };
  return {
    registered: false,
    reason: 'request body is not verified-live with an evidence record (rule D0); no live capture exists yet',
  };
}
