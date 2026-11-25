import { z } from 'zod';
import { toInputSchema } from '../schema.js';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef, invalidateOuCache, resolveWriteTarget, assertOuPathUnchanged, type OuMatch } from '../resolver.js';
import { enrich, invalidateEnrichmentCache } from '../enricher.js';
import { suggestOus, formatOuSuggestions, isNotFound } from '../fuzzy.js';
import { getWorkingOu } from '../context.js';
import { checkMutationAllowed, checkBaseWriteAllowed, isDryRunSkip, GuardrailError, auditLog } from '../safety/guardrails.js';
import { gateOuWrite, gateOuSubtree, refuseOuWrite } from '../safety/ou_gate.js';
import { checkOuRightPreflight, OU_MANAGE_RIGHTS } from '../safety/preflight.js';

// ── ou_get ────────────────────────────────────────────────────────────────────

const ouGetSchema = z.object({
  mode: z.enum(['get', 'root', 'search', 'subordinate', 'structure', 'device_status']).describe(
    'get=single OU by path/id; root=root OU; search=search OUs by term; subordinate=direct children; structure=full tree; device_status=device statuses in OU',
  ),
  // Friendly resolver — accepts name, partial name, full path, or numeric ID.
  ouRef: z.string().optional().describe(
    'OU name, partial name, full path, or numeric ID — resolved automatically. ' +
    'Examples: "Berlin", "03 - LU Berlin", "/Enterprise/Germany/Berlin", "42". ' +
    'Preferred over path/id for natural-language requests.',
  ),
  // get / subordinate / structure — defaults to working OU for subordinate/device_status
  path: z.string().optional().describe(
    'OU path (e.g. /Enterprise/SubOU); for subordinate/device_status defaults to working OU if not provided',
  ),
  id: z.number().int().optional().describe('OU numeric ID — use ouRef for name-based lookup'),
  properties: z.string().optional().describe('Comma-separated list of extra properties to return'),
  // search
  searchTerm: z.string().optional().describe('Search term (required for mode=search)'),
  searchFields: z.string().optional().describe('Comma-separated fields to search in'),
  // structure
  onlyFirstLevel: z.boolean().optional().describe('Return only first level of structure tree'),
  // device_status (ouPath/ouId are aliases for path/id, kept for compatibility)
  ouPath: z.string().optional().describe('OU path for device_status mode; defaults to working OU if not provided'),
  ouId: z.string().optional().describe('OU ID for device_status mode'),
  includeSubOus: z.boolean().optional().describe('Include sub-OUs in device_status results'),
});

type OuGetInput = z.infer<typeof ouGetSchema>;

async function ouGetExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouGetSchema.parse(raw) as OuGetInput;
  const client = getClient();

  // Capture the lookup key so suggestions can be generated on 404.
  const lookupQuery: string | null =
    input.mode === 'get' || input.mode === 'subordinate'
      ? (input.path ?? (input.id !== undefined ? String(input.id) : null))
      : input.mode === 'search'
      ? (input.searchTerm ?? null)
      : null;

  try {
    // Resolve ouRef — only for modes that consume the resolved id/path
    let resolvedId: number | undefined = input.id;
    let resolvedPath: string | undefined = input.path;
    if (input.ouRef !== undefined && input.mode !== 'root' && input.mode !== 'search') {
      const match = await resolveOuRef(input.ouRef);
      resolvedId = match.ouid;
      resolvedPath = match.path;
    }

    switch (input.mode) {
      case 'root': {
        const data = await client.request<unknown>('GET', '/api/v1/ou/root');
        return ok(data);
      }

      case 'get': {
        const qs = buildQuery({ path: resolvedPath, id: resolvedId, properties: input.properties });
        const data = await client.request<unknown>('GET', `/api/v1/ou${qs}`);
        return ok(data);
      }

      case 'search': {
        if (!input.searchTerm) return fail('searchTerm is required for mode=search');
        const qs = buildQuery({
          searchTerm: input.searchTerm,
          searchFields: input.searchFields,
          properties: input.properties,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/search${qs}`);
        return ok(data);
      }

      case 'subordinate': {
        // ouRef resolution takes priority; otherwise use path/id with working OU fallback
        const effectivePath = resolvedPath ?? (resolvedId === undefined ? getWorkingOu()?.path : undefined);
        if (!effectivePath && resolvedId === undefined) {
          return fail(
            'path or id is required for mode=subordinate. ' +
              'Set a working OU with scout_context action=set_ou to use it as default.',
          );
        }
        const qs = buildQuery({ path: effectivePath, id: resolvedId, properties: input.properties });
        const data = await client.request<unknown>('GET', `/api/v1/ou/subordinate${qs}`);
        return ok(data);
      }

      case 'structure': {
        const qs = buildQuery({
          path: resolvedPath,
          id: resolvedId,
          onlyFirstLevel: input.onlyFirstLevel,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/structure${qs}`);
        return ok(data);
      }

      case 'device_status': {
        // Merge ouPath/path and ouId/id, then fall back to working OU
        const effectiveOuPath = input.ouPath ?? resolvedPath ?? getWorkingOu()?.path;
        const effectiveOuId =
          input.ouId ?? (resolvedId !== undefined ? String(resolvedId) : undefined);
        const qs = buildQuery({
          ouPath: effectiveOuPath,
          ouId: effectiveOuId,
          includeSubOus: input.includeSubOus,
        });
        const data = await client.request<unknown>('GET', `/api/v1/ou/device/status${qs}`);
        return ok(await enrich(data));
      }
    }
  } catch (err) {
    const baseMsg = `ou_get failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err) && lookupQuery) {
      const suggestions = await suggestOus(lookupQuery);
      return fail(baseMsg + formatOuSuggestions(suggestions));
    }
    return fail(baseMsg);
  }
}

export const ouGetTool = {
  name: 'ou_get',
  description:
    'Read OU information from Scout Board. Modes: get (single OU by path or id), root (root OU), search (find OUs by term), subordinate (direct children of an OU), structure (full tree view), device_status (status of devices in an OU). ' +
    'Use ouRef to identify OUs by name, partial name, path, or ID — no need to look up IDs first.',
  inputSchema: toInputSchema(ouGetSchema),
  execute: ouGetExecute,
};

// ── ou_manage ─────────────────────────────────────────────────────────────────

const ouManageSchema = z.object({
  action: z
    .enum(['add', 'rename', 'delete', 'move', 'converttobase', 'structure_export', 'structure_import'])
    .describe('Operation to perform'),

  // Friendly resolver for the target OU (rename/delete/move/converttobase)
  ouRef: z.string().optional().describe(
    'Target OU — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over path/id for natural-language requests.',
  ),

  // Target OU identification (add uses destoupath/destouid instead)
  path: z.string().optional().describe('Target OU path — use ouRef for name-based lookup'),
  id: z.number().int().optional().describe('Target OU numeric ID — use ouRef for name-based lookup'),

  // Friendly resolver for the destination OU (add/move)
  destouRef: z.string().optional().describe(
    'Destination OU — name, partial name, full path, or numeric ID. ' +
    'Resolved automatically. Preferred over destoupath/destouid.',
  ),

  // add / move
  destoupath: z.string().optional().describe('Destination OU path (add/move) — use destouRef for name-based lookup'),
  destouid: z.number().int().optional().describe('Destination OU ID (add/move) — use destouRef for name-based lookup'),
  name: z.string().optional().describe('New OU name (add) or current name for rename target'),

  // rename
  newname: z.string().optional().describe('New name for rename action'),

  // delete
  forceDeleteOUFilter: z.boolean().optional().describe('Delete affected OU filters when deleting OU'),

  // structure_export body fields
  ouId: z.number().int().optional().describe('OU ID to export (structure_export)'),
  exportOuStructure: z.boolean().optional(),
  exportDeviceConfig: z.boolean().optional(),
  exportAdvancedConfig: z.boolean().optional(),
  exportDevices: z.boolean().optional(),

  // structure_import body fields
  importPayload: z.record(z.string(), z.unknown()).optional().describe('Export payload to import (structure_import)'),
  dryRun: z.boolean().optional().describe('Preview import without applying changes'),
});

type OuManageInput = z.infer<typeof ouManageSchema>;

/**
 * Validates the structure_import payload against the documented request shape
 * (`{parentOuId, data, importOuStructure, importDeviceConfig, importAdvancedConfig, importDevices}`)
 * and returns ONLY those known keys, never the raw caller object. Returns a refusal message string
 * for anything else (unknown key, wrong type, missing `data`) - fail closed.
 * `dryRun` is taken from the tool's own `dryRun` input, not from the payload.
 */
function parseImportPayload(
  payload: Record<string, unknown>,
): { parentOuId: number | undefined; body: Record<string, unknown> } | string {
  const boolKeys = ['importOuStructure', 'importDeviceConfig', 'importAdvancedConfig', 'importDevices'];
  const known = new Set(['parentOuId', 'data', ...boolKeys]);
  for (const k of Object.keys(payload)) {
    if (!known.has(k)) {
      return `Refusing structure_import: importPayload has the unexpected key "${k}". Allowed keys: ${[...known].join(', ')} (dryRun is a separate tool input).`;
    }
  }
  const data = payload['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'Refusing structure_import: importPayload.data must be the export payload object (importPayload = {data, parentOuId?, import* flags}).';
  }
  const parent = payload['parentOuId'];
  if (parent !== undefined && (typeof parent !== 'number' || !Number.isInteger(parent))) {
    return 'Refusing structure_import: importPayload.parentOuId must be an integer OU id.';
  }
  const body: Record<string, unknown> = { data };
  for (const k of boolKeys) {
    const v = payload[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return `Refusing structure_import: importPayload.${k} must be a boolean.`;
    body[k] = v;
  }
  return { parentOuId: parent as number | undefined, body };
}

async function ouManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouManageSchema.parse(raw) as OuManageInput;
  const client = getClient();

  // For add, the relevant lookup is the destination; for all other actions, the target.
  const lookupQuery: string | null =
    input.action === 'add'
      ? (input.destoupath ?? (input.destouid !== undefined ? String(input.destouid) : null))
      : (input.path ?? (input.id !== undefined ? String(input.id) : null));

  try {
    let resolvedId: number | undefined = input.id;
    let resolvedPath: string | undefined = input.path;
    let resolvedDestPath: string | undefined = input.destoupath;
    let resolvedDestId: number | undefined = input.destouid;

    // structure_export is read-only (it doesn't mutate); everything else does.
    const isMutatingAction = input.action !== 'structure_export';
    const opName = `ou_manage(${input.action})`;

    // Gate 1: mode tiers (read-only throws here, before any resolution or confirm).
    const modeCheck = isMutatingAction ? checkMutationAllowed(opName) : { proceed: true };

    // Resolve the write target/destination ONCE, from a fresh tree, requiring that every supplied
    // reference (ouRef / path / id) names the same OU. From here on the gates AND the request use
    // only this resolved OU (requests carry the id, never the raw caller path), so the gated OU and
    // the written OU are the same by construction. gateOuWrite applies, in order: a top-level OU
    // needs SCOUT_ALLOW_BASE_WRITES (Gate 2, derived from the parsed tree - no /ou/root call), the
    // SCOUT_ENV=test scope on the RESOLVED path, then SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS. Every
    // refusal is audit-logged. rename and converttobase are gated too: renaming a protected OU would
    // make its SCOUT_PROTECTED_OUS entry stop matching, and converttobase changes its inheritance.
    let tgt: OuMatch | undefined;
    let dst: OuMatch | undefined;
    let importParent: OuMatch | undefined;
    let importBody: Record<string, unknown> | undefined;
    if (!isMutatingAction) {
      if (input.ouRef !== undefined) {
        const match = await resolveOuRef(input.ouRef);
        resolvedId = match.ouid;
        resolvedPath = match.path;
      }
    } else {
      if (['rename', 'delete', 'move', 'converttobase'].includes(input.action)) {
        tgt = await gateOuWrite(
          opName,
          input.ouRef !== undefined ? [input.ouRef] : [input.path, input.id],
          'target OU',
          { topLevelNeedsBase: true, requiredMessage: `${input.action} requires a target OU (ouRef, path or id).` },
        );
        if (tgt) {
          resolvedId = tgt.ouid;
          resolvedPath = tgt.path;
          // rename/delete/move/converttobase remove, rename, relocate or re-base the WHOLE subtree:
          // refuse if any descendant is protected (so an ANCESTOR of a protected OU cannot be touched)
          // or falls outside SCOUT_ALLOWED_OUS.
          await gateOuSubtree(opName, tgt);
        }
      }
      if (input.action === 'move' || input.action === 'add') {
        dst = await gateOuWrite(
          opName,
          input.destouRef !== undefined ? [input.destouRef] : [input.destoupath, input.destouid],
          'destination OU',
          {
            requiredMessage:
              `${input.action} requires a destination OU (destouRef, destoupath or destouid); ` +
              'refusing rather than leaving the destination to the server.',
          },
        );
        if (dst) { resolvedDestId = dst.ouid; resolvedDestPath = dst.path; }
      }
      if (input.action === 'structure_import') {
        if (!input.importPayload) return fail('importPayload is required for action=structure_import');
        const parsed = parseImportPayload(input.importPayload);
        if (typeof parsed === 'string') return refuseOuWrite(opName, 'structure_import', parsed);
        importParent = await gateOuWrite(
          opName,
          input.ouRef !== undefined
            ? [input.ouRef, parsed.parentOuId]
            : [input.path, input.id, input.ouId, parsed.parentOuId],
          'import parent OU',
          {
            topLevelNeedsBase: true,
            requiredMessage: 'structure_import requires a parent OU (ouRef, path, id, ouId or importPayload.parentOuId).',
          },
        );
        if (!importParent) throw new Error('structure_import: parent OU unresolved');
        await gateOuSubtree(opName, importParent);
        // The export payload format is not documented, so the OUs an import would create or
        // overwrite cannot be enumerated and gated one by one. Fail closed: such an import needs
        // the explicit base-write arming flag, in addition to the parent OU gates above.
        try {
          checkBaseWriteAllowed({
            isBaseOrRoot: true,
            label:
              'an OU structure import (the payload is not enumerable, so the OUs it would create or ' +
              `overwrite under "${importParent.path}" cannot be checked against SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS)`,
          });
        } catch (err) {
          auditLog({
            opName,
            target: importParent.path,
            result: 'refused',
            gate: 'base-write',
            detail: 'structure_import payload not enumerable; SCOUT_ALLOW_BASE_WRITES not set',
          });
          throw err;
        }
        importBody = { ...parsed.body, parentOuId: importParent.ouid };
        if (input.dryRun !== undefined) importBody['dryRun'] = input.dryRun;
        resolvedId = importParent.ouid;
        resolvedPath = importParent.path;
      }
    }

    if (!modeCheck.proceed) {
      return ok({
        status: 'dry_run',
        action: input.action,
        target: resolvedPath ?? resolvedId ?? lookupQuery,
        message: modeCheck.dryRunNotice,
      });
    }

    // ourights preflight (UX aid only; explicit-false refuses, anything else proceeds).
    // Runs after every gate above and after the dry-run short-circuit, before the write.
    const neededRight = OU_MANAGE_RIGHTS[input.action];
    if (isMutatingAction && neededRight !== undefined) {
      // Every mutating action has a resolved, gated OU by now (target, destination, or import parent).
      const preflightOuId: number | undefined = input.action === 'add' ? resolvedDestId : resolvedId;
      const preflightPath = input.action === 'add' ? resolvedDestPath : resolvedPath;
      await checkOuRightPreflight({
        opName: `ou_manage(${input.action})`,
        target: `ou:${preflightPath ?? preflightOuId ?? 'unknown'}`,
        ouId: preflightOuId,
        requiredRight: neededRight,
      });
    }

    // Re-assert, immediately before the mutating call, that the gated OUs still have the
    // gated paths (a rename/move by someone else since the gate must not slip through).
    if (tgt) await assertOuPathUnchanged(tgt.ouid, tgt.path);
    if (dst) await assertOuPathUnchanged(dst.ouid, dst.path);
    if (importParent) await assertOuPathUnchanged(importParent.ouid, importParent.path);

    let result: unknown;

    switch (input.action) {
      case 'add': {
        if (!input.name) return fail('name is required for action=add');
        const qs = buildQuery({ destouid: resolvedDestId, name: input.name });
        result = await client.request<unknown>('POST', `/api/v1/ou${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(add)',
        });
        break;
      }

      case 'rename': {
        if (!input.newname) return fail('newname is required for action=rename');
        const qs = buildQuery({ id: resolvedId, newname: input.newname });
        result = await client.request<unknown>('PUT', `/api/v1/ou${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(rename)',
        });
        break;
      }

      case 'delete': {
        const qs = buildQuery({
          id: resolvedId,
          forceDeleteOUFilter: input.forceDeleteOUFilter,
        });
        result = await client.request<unknown>('DELETE', `/api/v1/ou${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(delete)',
        });
        break;
      }

      case 'move': {
        const qs = buildQuery({
          id: resolvedId,
          destouid: resolvedDestId,
        });
        result = await client.request<unknown>('PUT', `/api/v1/ou/move${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(move)',
        });
        break;
      }

      case 'converttobase': {
        const qs = buildQuery({ id: resolvedId });
        result = await client.request<unknown>('PUT', `/api/v1/ou/converttobase${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(converttobase)',
        });
        break;
      }

      case 'structure_export': {
        const exportId = input.ouId ?? resolvedId;
        if (!exportId) return fail('ouId (or ouRef) is required for action=structure_export');
        const body = {
          ouId: exportId,
          exportOuStructure: input.exportOuStructure,
          exportDeviceConfig: input.exportDeviceConfig,
          exportAdvancedConfig: input.exportAdvancedConfig,
          exportDevices: input.exportDevices,
        };
        result = await client.request<unknown>('POST', '/api/v1/ou/structure/export', body);
        break;
      }

      case 'structure_import': {
        // importBody was built from the validated shape and the resolved parent id above.
        result = await client.request<unknown>('POST', '/api/v1/ou/structure/import', importBody, {
          mutating: true,
          opName: 'ou_manage(structure_import)',
        });
        break;
      }
    }

    if (isDryRunSkip(result)) {
      return ok({ status: 'dry_run', action: input.action, message: result.notice });
    }

    // Invalidate resolver + enrichment cache after any mutation
    if (input.action !== 'structure_export') {
      invalidateOuCache();
      invalidateEnrichmentCache();
    }

    return ok(result);
  } catch (err) {
    if (err instanceof GuardrailError) return fail(`ou_manage blocked: ${err.message}`);
    const baseMsg = `ou_manage failed: ${err instanceof Error ? err.message : String(err)}`;
    if (isNotFound(err) && lookupQuery) {
      const suggestions = await suggestOus(lookupQuery);
      return fail(baseMsg + formatOuSuggestions(suggestions));
    }
    return fail(baseMsg);
  } finally {
    // Never leave a tree cached across a (possibly failed) write: the next gate must re-read.
    if (input.action !== 'structure_export') invalidateOuCache();
  }
}

export const ouManageTool = {
  name: 'ou_manage',
  description:
    'Create, rename, delete, or move OUs in Scout Board, and export/import OU structures. ' +
    'Use ouRef to identify the target OU and destouRef for the destination — both accept names, partial names, paths, or IDs. ' +
    'DESTRUCTIVE: action=delete permanently removes an OU and all its contents. ' +
    'In SCOUT_ENV=test mode, every write target/destination must be under SCOUT_TEST_OU_PATH (checked on the resolved path). ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing); ' +
    'rename/delete/move/converttobase of a top-level OU and structure_import require SCOUT_ALLOW_BASE_WRITES=true; all OU targets are checked against SCOUT_PROTECTED_OUS / SCOUT_ALLOWED_OUS.',
  inputSchema: toInputSchema(ouManageSchema),
  execute: ouManageExecute,
};
