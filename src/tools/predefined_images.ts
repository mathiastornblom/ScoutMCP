/**
 * Private Scout Board endpoints for predefined images and UEFI listings.
 *
 * These endpoints are NOT in the public OpenAPI spec.
 * They are guarded by SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getClient } from '../client.js';
import { ok, fail, type McpToolResult } from '../types.js';

// ── Logging helpers ───────────────────────────────────────────────────────────

function log(tool: string, method: string, path: string, body?: unknown): void {
  const bodyStr = body !== undefined ? ` body=${JSON.stringify(body)}` : '';
  process.stderr.write(`[scout-mcp/${tool}] ${method} ${path}${bodyStr}\n`);
}

function logOk(tool: string): void {
  process.stderr.write(`[scout-mcp/${tool}] response: 2xx\n`);
}

function logErr(tool: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[scout-mcp/${tool}] error: ${msg}\n`);
}

// ── predefined_images ─────────────────────────────────────────────────────────

const predefinedImagesSchema = z.object({
  action: z
    .enum(['list_images', 'list_uefi'])
    .describe(
      'list_images=list all predefined OS images available for deployment; ' +
        'list_uefi=list all predefined UEFI configurations',
    ),
});

type PredefinedImagesInput = z.infer<typeof predefinedImagesSchema>;

async function predefinedImagesExecute(raw: unknown): Promise<McpToolResult> {
  const input = predefinedImagesSchema.parse(raw) as PredefinedImagesInput;
  const client = getClient();
  const tool = 'predefined_images';

  try {
    switch (input.action) {
      case 'list_images': {
        const path = '/api/v1/predefinedImages';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }

      case 'list_uefi': {
        const path = '/api/v1/predefinedUEFI';
        log(tool, 'GET', path);
        const data = await client.rawRequest<unknown>('GET', path);
        logOk(tool);
        return ok(data);
      }
    }
  } catch (err) {
    logErr(tool, err);
    return fail(`predefined_images failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const predefinedImagesTool = {
  name: 'predefined_images',
  description:
    '[PRIVATE ENDPOINT — not in public OpenAPI spec. Enabled via SCOUT_ENABLE_PRIVATE_ENDPOINTS=true.] ' +
    'List Scout Board predefined OS images and UEFI configurations available for device deployment. ' +
    'Actions: list_images (all predefined OS images), list_uefi (all predefined UEFI configurations).',
  inputSchema: zodToJsonSchema(predefinedImagesSchema),
  execute: predefinedImagesExecute,
};
