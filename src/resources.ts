/**
 * MCP Resources for Scout Board.
 *
 * Exposes live Scout Board data as browsable MCP resources. The resource list
 * is built dynamically from the connected server at query time — so it reflects
 * whatever Scout Board instance the server is currently authenticated against.
 *
 * Concrete resources (always present):
 *   scout://ou-tree                    — full OU hierarchy snapshot
 *
 * Concrete resources (enumerated from live server when authenticated):
 *   scout://ou/<path>                  — single OU details (one per OU in tree)
 *
 * Resource templates (always present):
 *   scout://devices/{+ouPath}          — device inventory for any OU path
 */

import { getClient } from './client.js';

// ── URI helpers ───────────────────────────────────────────────────────────────

export const URI_OU_TREE = 'scout://ou-tree';
export const URI_OU_PREFIX = 'scout://ou/';
export const URI_DEVICES_TEMPLATE = 'scout://devices/{+ouPath}';
const URI_DEVICES_PREFIX = 'scout://devices/';

/** Encodes an OU path for embedding in a URI (encodes each segment, preserves slashes). */
function encodeOuPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Decodes a URI-embedded OU path back to a plain path. */
function decodeOuPath(uriPath: string): string {
  return uriPath
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/');
}

// ── OU tree flattening ────────────────────────────────────────────────────────

interface OuNode {
  OUID?: number;
  OUName?: string;
  OUPath?: string;
  SubOUs?: OuNode[];
}

function flattenOuTree(node: OuNode): Array<{ ouid: number; name: string; path: string }> {
  const result: Array<{ ouid: number; name: string; path: string }> = [];
  if (node.OUID !== undefined && node.OUPath && node.OUName) {
    result.push({ ouid: node.OUID, name: node.OUName, path: node.OUPath });
  }
  if (Array.isArray(node.SubOUs)) {
    for (const child of node.SubOUs) {
      result.push(...flattenOuTree(child));
    }
  }
  return result;
}

// ── List handlers ─────────────────────────────────────────────────────────────

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Returns the list of available Scout Board resources.
 *
 * Always includes scout://ou-tree. When authenticated, also enumerates one
 * scout://ou/<path> resource per OU in the live server's tree — so the client
 * can browse individual OUs without any tool calls.
 */
export async function listResources(): Promise<ResourceDescriptor[]> {
  const resources: ResourceDescriptor[] = [
    {
      uri: URI_OU_TREE,
      name: 'Scout OU Tree',
      description:
        'Full Scout Board OU hierarchy. ' +
        'Read this to discover all OU names, paths, and IDs in one request. ' +
        'Use the results to pass ouRef values to ou_get, ou_manage, device_command, etc.',
      mimeType: 'application/json',
    },
  ];

  // Enumerate per-OU resources from the live server.
  // Failures are silently ignored — client gets the tree resource but no per-OU entries.
  try {
    const client = getClient();
    const tree = await client.request<OuNode>('GET', '/api/v1/ou/structure');
    const ous = flattenOuTree(tree);

    for (const ou of ous) {
      resources.push({
        uri: `${URI_OU_PREFIX}${encodeOuPath(ou.path)}`,
        name: ou.name,
        description: `OU at ${ou.path} · ID ${ou.ouid}`,
        mimeType: 'application/json',
      });
    }
  } catch {
    // Not configured or unreachable — skip per-OU enumeration
  }

  return resources;
}

/** Resource templates — parameterised URIs the client can expand. */
export function listResourceTemplates(): ResourceTemplateDescriptor[] {
  return [
    {
      uriTemplate: URI_DEVICES_TEMPLATE,
      name: 'Device Inventory',
      description:
        'Devices within a Scout Board OU. ' +
        'URI example: scout://devices/Enterprise/Germany/Berlin ' +
        '(leading / is optional). Append ?includeSubOus=true to include sub-OU devices. ' +
        'Returns up to 1 000 devices.',
      mimeType: 'application/json',
    },
  ];
}

// ── Read handler ──────────────────────────────────────────────────────────────

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Reads a Scout Board resource by URI. Throws on unrecognised URIs or API errors.
 */
export async function readResource(uri: string): Promise<ResourceContent> {
  const client = getClient();

  // ── scout://ou-tree ──────────────────────────────────────────────────────
  if (uri === URI_OU_TREE) {
    const data = await client.request<unknown>('GET', '/api/v1/ou/structure');
    return { uri, mimeType: 'application/json', text: JSON.stringify(data) };
  }

  // ── scout://ou/<path> ────────────────────────────────────────────────────
  if (uri.startsWith(URI_OU_PREFIX)) {
    const encodedPath = uri.slice(URI_OU_PREFIX.length);
    const ouPath = decodeOuPath(encodedPath.startsWith('/') ? encodedPath : '/' + encodedPath);
    const qs = `?path=${encodeURIComponent(ouPath)}`;
    const data = await client.request<unknown>('GET', `/api/v1/ou${qs}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(data) };
  }

  // ── scout://devices/{+ouPath} ────────────────────────────────────────────
  if (uri.startsWith(URI_DEVICES_PREFIX)) {
    const rawPath = uri.slice(URI_DEVICES_PREFIX.length);

    // Split optional inline query params (e.g. ?includeSubOus=true)
    const questionIdx = rawPath.indexOf('?');
    const pathPart = questionIdx >= 0 ? rawPath.slice(0, questionIdx) : rawPath;
    const queryPart = questionIdx >= 0 ? rawPath.slice(questionIdx + 1) : '';
    const params = new URLSearchParams(queryPart);
    const includeSubOus = params.get('includeSubOus') === 'true';

    const ouPath = pathPart.startsWith('/') ? pathPart : '/' + pathPart;

    const qs = new URLSearchParams({
      ouPath,
      searchTerm: '*',
      includeSubOus: String(includeSubOus),
      limit: '1000',
    });
    const data = await client.request<unknown>('GET', `/api/v1/device/search?${qs}`);
    return { uri, mimeType: 'application/json', text: JSON.stringify(data) };
  }

  throw new Error(
    `Unknown Scout resource URI: "${uri}". ` +
      `Available: ${URI_OU_TREE}, ${URI_OU_PREFIX}<ouPath>, ${URI_DEVICES_TEMPLATE}`,
  );
}
