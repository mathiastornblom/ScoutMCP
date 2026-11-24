import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, buildQuery, type McpToolResult } from '../types.js';
import { resolveOuRef, invalidateOuCache, resolveOuForWriteGate } from '../resolver.js';
import { enrich, invalidateEnrichmentCache } from '../enricher.js';
import { suggestOus, formatOuSuggestions, isNotFound } from '../fuzzy.js';
import { getWorkingOu } from '../context.js';
import {
  checkMutationAllowed,
  checkBaseWriteAllowed,
  checkOuWriteAllowed,
  isRootOuTarget,
  isDryRunSkip,
  GuardrailError,
} from '../safety/guardrails.js';
import { checkOuRightPreflight, OU_MANAGE_RIGHTS } from '../safety/preflight.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function assertTestScope(path: string): string | null {
  if (process.env.SCOUT_ENV !== 'test') return null;
  const testRoot = process.env.SCOUT_TEST_OU_PATH;
  if (!testRoot) return 'SCOUT_TEST_OU_PATH must be set when SCOUT_ENV=test';
  if (!path.startsWith(testRoot)) {
    return `Target path "${path}" is outside SCOUT_TEST_OU_PATH "${testRoot}". Blocked in test mode.`;
  }
  return null;
}

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
  inputSchema: zodToJsonSchema(ouGetSchema),
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
  importPayload: z.record(z.unknown()).optional().describe('Export payload to import (structure_import)'),
  dryRun: z.boolean().optional().describe('Preview import without applying changes'),
});

type OuManageInput = z.infer<typeof ouManageSchema>;

async function ouManageExecute(raw: unknown): Promise<McpToolResult> {
  const input = ouManageSchema.parse(raw) as OuManageInput;
  const client = getClient();

  // For add, the relevant lookup is the destination; for all other actions, the target.
  const lookupQuery: string | null =
    input.action === 'add'
      ? (input.destoupath ?? (input.destouid !== undefined ? String(input.destouid) : null))
      : (input.path ?? (input.id !== undefined ? String(input.id) : null));

  try {
    // Resolve ouRef → target OU
    let resolvedId: number | undefined = input.id;
    let resolvedPath: string | undefined = input.path;
    if (input.ouRef !== undefined) {
      const match = await resolveOuRef(input.ouRef);
      resolvedId = match.ouid;
      resolvedPath = match.path;
    }

    // Resolve destouRef → destination OU
    let resolvedDestPath: string | undefined = input.destoupath;
    let resolvedDestId: number | undefined = input.destouid;
    if (input.destouRef !== undefined) {
      const match = await resolveOuRef(input.destouRef);
      resolvedDestId = match.ouid;
      resolvedDestPath = match.path;
    }

    // Destructive guard: delete restricted to test scope
    if (input.action === 'delete' && resolvedPath) {
      const err = assertTestScope(resolvedPath);
      if (err) return fail(err);
    }

    // structure_export is read-only (it doesn't mutate); everything else does.
    const isMutatingAction = input.action !== 'structure_export';

    // Gate 1: mode tiers.
    const modeCheck = isMutatingAction
      ? checkMutationAllowed(`ou_manage(${input.action})`)
      : { proceed: true };

    // Gate 2: root OU is protected the same way as Base config — it's the ancestor of
    // every other OU, so rename/delete/move/converttobase against it is fleet-wide blast
    // radius. We only know "root" by comparing the resolved target against the live
    // root lookup (the API has no syntactic "is root" marker).
    if (isMutatingAction && (resolvedPath !== undefined || resolvedId !== undefined)) {
      const rootResp = await client.request<{ OUID?: number; OUPath?: string }>(
        'GET',
        '/api/v1/ou/root',
      );
      const isRoot = isRootOuTarget({
        resolvedPath,
        resolvedId,
        rootPath: rootResp?.OUPath,
        rootId: rootResp?.OUID,
      });
      checkBaseWriteAllowed({
        isBaseOrRoot: isRoot,
        label: 'the root OU (ancestor of every OU in the fleet)',
      });
    }

    // Gate 6: protected/allowed OU lists. delete and move both change what becomes of an
    // existing OU's subtree, so the *target* OU (the one being deleted/moved/renamed) is
    // always checked when resolved. move additionally relocates that whole subtree under
    // a new parent, which changes what config it inherits going forward — so the
    // *destination* OU is checked too, the same source+destination reasoning used for
    // device_manage(move). rename/converttobase/add are not gated here: rename doesn't
    // change the subtree's position or inheritance, add only affects a brand-new (not yet
    // protected-relevant) OU, and the new OU's parent is the actual write target for add,
    // which is covered by the destination check below when present.
    if (isMutatingAction && (input.action === 'delete' || input.action === 'move')) {
      // Gate on the canonical, server-derived path from a FRESH tree read, never the raw
      // caller string (case/whitespace/slash variants must not dodge SCOUT_PROTECTED_OUS).
      // Unresolvable refs throw -> refused.
      const targetRefs: Array<string | number> =
        input.ouRef !== undefined
          ? [resolvedId as number]
          : [input.path, input.id].filter((r): r is string | number => r !== undefined);
      for (const ref of targetRefs) {
        checkOuWriteAllowed({ targetPath: (await resolveOuForWriteGate(ref)).path });
      }
    }
    if (isMutatingAction && (input.action === 'move' || input.action === 'add')) {
      const destRefs: Array<string | number> =
        input.destouRef !== undefined
          ? [resolvedDestId as number]
          : [input.destoupath, input.destouid].filter((r): r is string | number => r !== undefined);
      for (const ref of destRefs) {
        checkOuWriteAllowed({ targetPath: (await resolveOuForWriteGate(ref)).path });
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
      let preflightOuId: number | undefined =
        input.action === 'add' ? resolvedDestId : input.action === 'structure_import' ? input.ouId : resolvedId;
      const preflightPath = input.action === 'add' ? resolvedDestPath : resolvedPath;
      if (preflightOuId === undefined && preflightPath) {
        try {
          preflightOuId = (await resolveOuRef(preflightPath)).ouid;
        } catch {
          preflightOuId = undefined; // unresolvable -> preflight skipped; server still enforces
        }
      }
      await checkOuRightPreflight({
        opName: `ou_manage(${input.action})`,
        target: `ou:${preflightPath ?? preflightOuId ?? 'unknown'}`,
        ouId: preflightOuId,
        requiredRight: neededRight,
      });
    }

    let result: unknown;

    switch (input.action) {
      case 'add': {
        if (!input.name) return fail('name is required for action=add');
        const qs = buildQuery({ destoupath: resolvedDestPath, destouid: resolvedDestId, name: input.name });
        result = await client.request<unknown>('POST', `/api/v1/ou${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(add)',
        });
        break;
      }

      case 'rename': {
        if (!input.newname) return fail('newname is required for action=rename');
        const qs = buildQuery({ path: resolvedPath, id: resolvedId, newname: input.newname });
        result = await client.request<unknown>('PUT', `/api/v1/ou${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(rename)',
        });
        break;
      }

      case 'delete': {
        const qs = buildQuery({
          path: resolvedPath,
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
          path: resolvedPath,
          id: resolvedId,
          destoupath: resolvedDestPath,
          destouid: resolvedDestId,
        });
        result = await client.request<unknown>('PUT', `/api/v1/ou/move${qs}`, undefined, {
          mutating: true,
          opName: 'ou_manage(move)',
        });
        break;
      }

      case 'converttobase': {
        const qs = buildQuery({ path: resolvedPath, id: resolvedId });
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
        if (!input.importPayload) return fail('importPayload is required for action=structure_import');
        const body = { ...input.importPayload, dryRun: input.dryRun };
        result = await client.request<unknown>('POST', '/api/v1/ou/structure/import', body, {
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
    'In SCOUT_ENV=test mode, delete operations are restricted to paths under SCOUT_TEST_OU_PATH. ' +
    'Gated by SCOUT_MODE (read-only blocks all writes, dry-run plans without executing); ' +
    'rename/delete/move/converttobase against the root OU requires SCOUT_ALLOW_BASE_WRITES=true.',
  inputSchema: zodToJsonSchema(ouManageSchema),
  execute: ouManageExecute,
};
