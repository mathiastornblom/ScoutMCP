/**
 * Shared, fail-closed parser for GET /api/v1/ou/structure.
 *
 * Ground truth is a REAL capture from a Scout 26.11.0 server (tests/fixtures/ou-structure-live.json):
 *
 *   {
 *     "code": 200, "message": "OK",
 *     "response": { "status": { "result": 0, "msg": { "treeStructure": [
 *       { "OUID": 2, "Name": "NorthCreek", "count": 10, "UseParent": 1, "DeviceCount": 10,
 *         "ParentID": -1, "children": [ { "OUID": 10, "Name": "AD", ..., "children": [] }, ... ] },
 *       { "OUID": 4, "Name": "SKY", ... }
 *     ] } } }
 *   }
 *
 * Key facts the rest of the code depends on:
 *   - `treeStructure` is a FOREST: several top-level OUs (ParentID -1) can exist.
 *   - There is NO path field and NO OUName/SubOUs: the name key is `Name`, the child key is
 *     `children`. A path is derived here by walking from the root.
 *   - `DeviceCount` is CUMULATIVE (an OU's count already includes every descendant's devices;
 *     verified on the fixture: NorthCreek 10 > sum of its children 8, Browser 1 == its only
 *     child Google-CEP 1). Never sum DeviceCount over a subtree - read the target's own value.
 *
 * PATH FORMAT (single definition, used by resolver, guardrails, README):
 *   "/" + ancestor names and the OU's own name joined with "/", starting at the top-level OU,
 *   no trailing slash, e.g. "/NorthCreek/Browser/Google-CEP". There is no synthetic "/" root
 *   node (the server has none: top-level OUs are siblings). Names containing "/" would make
 *   paths ambiguous, so they are REJECTED (throw) rather than guessed at.
 *
 * Fail-closed: any envelope that is not exactly this shape throws OuTreeParseError. An empty or
 * unreadable tree is NEVER returned as "no OUs" - callers (protected-OU / allowed-OU / blast
 * radius checks) must see a throw, not an empty tree they could mistake for "nothing to protect".
 */

export class OuTreeParseError extends Error {
  constructor(reason: string) {
    super(`Could not parse /api/v1/ou/structure response: ${reason}`);
    this.name = 'OuTreeParseError';
  }
}

export interface OuTreeNode {
  ouid: number;
  name: string;
  /** Derived path, e.g. "/NorthCreek/Browser/Google-CEP". */
  path: string;
  /** ouid of the parent in this tree; undefined for a top-level OU. */
  parentId: number | undefined;
  /** CUMULATIVE device count (includes all descendants) - see file header. undefined if absent/invalid. */
  deviceCount: number | undefined;
  /** ouids of direct children, in server order. */
  children: number[];
}

export interface OuTree {
  /** Every node, depth-first in server order. */
  nodes: OuTreeNode[];
  byId: Map<number, OuTreeNode>;
  /** ouids of top-level OUs. */
  roots: number[];
}

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Parses the real envelope. Throws OuTreeParseError on anything unexpected (never returns an empty tree). */
export function parseOuTree(raw: unknown): OuTree {
  if (!isObj(raw)) throw new OuTreeParseError('response was not a JSON object');
  const response = raw['response'];
  if (!isObj(response)) throw new OuTreeParseError('response.response was missing or not an object');
  const status = response['status'];
  if (!isObj(status)) throw new OuTreeParseError('response.response.status was missing or not an object');
  const msg = status['msg'];
  if (!isObj(msg)) throw new OuTreeParseError('response.response.status.msg was missing or not an object');
  const result = status['result'];
  if (result !== undefined && result !== 0) {
    throw new OuTreeParseError(`response.response.status.result was ${JSON.stringify(result)}, expected 0`);
  }
  const forest = msg['treeStructure'];
  if (!Array.isArray(forest)) {
    throw new OuTreeParseError('response.response.status.msg.treeStructure was missing or not an array');
  }
  if (forest.length === 0) {
    throw new OuTreeParseError('treeStructure was empty (refusing to treat as "no OUs")');
  }

  const nodes: OuTreeNode[] = [];
  const byId = new Map<number, OuTreeNode>();
  const roots: number[] = [];

  function visit(rawNode: unknown, parent: OuTreeNode | undefined, depth: number): OuTreeNode {
    if (depth > MAX_DEPTH) throw new OuTreeParseError(`tree deeper than ${MAX_DEPTH} levels`);
    if (nodes.length >= MAX_NODES) throw new OuTreeParseError(`tree has more than ${MAX_NODES} OUs`);
    if (!isObj(rawNode)) throw new OuTreeParseError('a tree node was not an object');

    const id = rawNode['OUID'];
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new OuTreeParseError('a tree node had a missing or non-integer OUID');
    }
    const name = rawNode['Name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new OuTreeParseError(`OU ${id} had a missing or empty Name`);
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new OuTreeParseError(`OU ${id} name contains control characters`);
    }
    if (name !== name.trim()) {
      throw new OuTreeParseError(`OU ${id} name has leading or trailing whitespace`);
    }
    if (name.includes('/')) {
      throw new OuTreeParseError(`OU ${id} name contains "/", which would make derived paths ambiguous`);
    }
    if (byId.has(id)) throw new OuTreeParseError(`duplicate OUID ${id}`);

    const dcRaw = rawNode['DeviceCount'] ?? rawNode['count'];
    const deviceCount = typeof dcRaw === 'number' && Number.isInteger(dcRaw) && dcRaw >= 0 ? dcRaw : undefined;

    const childrenRaw = rawNode['children'];
    if (childrenRaw !== undefined && !Array.isArray(childrenRaw)) {
      throw new OuTreeParseError(`OU ${id} had a non-array children field`);
    }

    const node: OuTreeNode = {
      ouid: id,
      name,
      path: `${parent ? parent.path : ''}/${name}`,
      parentId: parent?.ouid,
      deviceCount,
      children: [],
    };
    nodes.push(node);
    byId.set(id, node);
    for (const child of (childrenRaw as unknown[] | undefined) ?? []) {
      node.children.push(visit(child, node, depth + 1).ouid);
    }
    return node;
  }

  for (const top of forest) roots.push(visit(top, undefined, 0).ouid);
  return { nodes, byId, roots };
}

/** Chain from the top-level OU down to `ouid` (inclusive), or undefined if `ouid` is not in the tree. */
export function ouChain(tree: OuTree, ouid: number): OuTreeNode[] | undefined {
  const chain: OuTreeNode[] = [];
  let cur = tree.byId.get(ouid);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId === undefined ? undefined : tree.byId.get(cur.parentId);
  }
  return chain.length > 0 && tree.byId.has(ouid) ? chain : undefined;
}

/** `ouid` plus every descendant, depth-first, or undefined if `ouid` is not in the tree. */
export function ouSubtree(tree: OuTree, ouid: number): OuTreeNode[] | undefined {
  const start = tree.byId.get(ouid);
  if (!start) return undefined;
  const out: OuTreeNode[] = [];
  const walk = (n: OuTreeNode): void => {
    out.push(n);
    for (const c of n.children) walk(tree.byId.get(c)!);
  };
  walk(start);
  return out;
}
