/**
 * Op spec for `elias_container_create`: POST /api/v1/containers/import {name} (Tier A, additive).
 * Fed to runEliasWrite() (src/elias/pipeline.ts). No lock (no itemType), no snapshot (nothing existed).
 */

import { z } from 'zod';
import { buildContainerCreateRequest } from './optable.js';
import { isGuid, type PipelineClient, type WriteOpSpec } from './pipeline.js';
import { safeDisplay } from './sanitize.js';
import type { ContainerRef } from './scope.js';

/** Conservative container name (design 2.0; real server limits are Open Question Q7). */
export const ContainerName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'must be 1-63 chars: letters, digits, . _ - (first char alphanumeric)');

export const containerCreateInput = z
  .object({
    name: ContainerName,
    confirm: z.boolean().optional(),
    planDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type ContainerCreateInput = z.infer<typeof containerCreateInput>;

const lower = (s: string): string => s.toLowerCase();

export const containerCreateSpec: WriteOpSpec<ContainerCreateInput> = {
  toolName: 'elias_container_create',
  tier: 'A',
  parse: (raw) => containerCreateInput.parse(raw ?? {}),
  scopeSubject: (p) => ({ newName: p.name }),
  names: (p) => [p.name],
  semantic: (p, fresh) => {
    const dup = fresh.find((c) => lower(c.name) === lower(p.name));
    return dup ? `a container named "${safeDisplay(p.name)}" already exists (names are compared case-insensitively)` : null;
  },
  build: (p) => buildContainerCreateRequest(p.name),
  target: (p) => `new:${safeDisplay(p.name)}`,
  planFields: (p, fresh) => ({
    newName: lower(p.name),
    sameNameIds: fresh
      .filter((c) => lower(c.name) === lower(p.name))
      .map((c) => c.id)
      .sort(),
    snapshot: 'none',
    lock: 'none',
  }),
  confirmSummary: (p, digest) =>
    `Create one empty ELIAS container named "${safeDisplay(p.name)}" (plan ${digest.slice(0, 12)}). ` +
    'No delete tool exists yet; a stray container has to be removed manually in the ELIAS UI.',
  mutexKey: (p) => `container-name:${lower(p.name)}`,
  rights: async (_p, client: PipelineClient) => {
    // GET /containers/rights has an unknown shape (Q8): advisory only, never a boundary.
    const r = await client.rawRequest<unknown>('GET', '/api/v1/containers/rights');
    if (r !== null && typeof r === 'object' && (r as Record<string, unknown>).manageContainers === false) {
      return { rights: 'denied', warning: 'the ELIAS manageContainers right appears to be denied (advisory; the server decides)' };
    }
    if (r !== null && typeof r === 'object' && (r as Record<string, unknown>).manageContainers === true) return { rights: 'allowed' };
    return { rights: 'unknown' };
  },
  interpretResponse: (resp) => {
    const id = resp !== null && typeof resp === 'object' ? (resp as { id?: unknown }).id : undefined;
    return isGuid(id) ? { createdId: id.toUpperCase() } : {};
  },
  reconcile: (p, before, after) => {
    const beforeIds = new Set(before.map((c) => c.id));
    const found: ContainerRef | undefined = after.find((c) => lower(c.name) === lower(p.name) && !beforeIds.has(c.id));
    return found ? { outcome: 'committed', createdId: found.id } : { outcome: 'not-applied' };
  },
};
