import { z } from 'zod';

/** JSON Schema object as exposed to MCP clients via tools/list. */
export type JsonSchemaObject = { [key: string]: unknown; type: 'object' };

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/**
 * Normalises Zod 4 output to the shape the previous zod-to-json-schema produced, so MCP clients
 * see no cosmetic churn: closed objects get `additionalProperties: false`, and Zod 4's implicit
 * safe-integer bounds and `propertyNames: {type: string}` on records are dropped.
 */
function normalise(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(normalise);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'object' && n.properties !== undefined && n.additionalProperties === undefined) {
    n.additionalProperties = false;
  }
  if (n.minimum === -SAFE_INT) delete n.minimum;
  if (n.maximum === SAFE_INT) delete n.maximum;
  const pn = n.propertyNames as Record<string, unknown> | undefined;
  if (pn && Object.keys(pn).length === 1 && pn.type === 'string') delete n.propertyNames;
  for (const v of Object.values(n)) normalise(v);
}

/**
 * Converts a Zod 4 schema to the MCP tool `inputSchema` (JSON Schema draft-7, input side).
 * Replaces the zod-to-json-schema package, which does not support Zod 4 (it silently emits
 * empty schemas). The top-level `$schema` key is stripped to match the previous output.
 */
export function toInputSchema(schema: z.ZodType): JsonSchemaObject {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object') {
    throw new Error('toInputSchema: tool input schema must be a z.object()');
  }
  normalise(json);
  return json as JsonSchemaObject;
}
