/**
 * Shared device-search response parsing.
 *
 * Ground truth for the `/api/v1/device/search` envelope comes from openapi.json's own
 * documented example for that endpoint:
 *
 *   {
 *     "code": 200,
 *     "message": "OK",
 *     "response": {
 *       "status": {
 *         "result": 0,
 *         "msg": {
 *           "visibleDevices": [ { "ClientIdentifier": "...", "Name": "..." }, ... ],
 *           "hiddenDevices": 0
 *         }
 *       }
 *     }
 *   }
 *
 * i.e. `response.status.msg` is an OBJECT carrying `visibleDevices` (an array) and a
 * `hiddenDevices` count — not an array itself, and not one of `{Devices,devices,Items,...}`.
 *
 * Before this fix, two independent and DIFFERENT parsers existed for this same endpoint:
 *   - device.ts's extractSearchDevices() assumed `response.status.msg` was itself an array.
 *   - workflow.ts's extractDevices() assumed a flat array or one of several guessed top-level
 *     keys (Devices/devices/Items/items/Results/results/data) — none of which match the
 *     documented shape at all.
 * Neither matched the real schema. A dedicated test fixture papered over this by serving two
 * different fake shapes to the two different callers, so the test suite could never catch a
 * caller's parser disagreeing with the real API. See `.agents/security-review.md` (BLOCKED
 * entry dated 2026-06-22) for the full writeup of how this produced a fail-open gap in
 * move_devices_by_filter's protected-OU check.
 *
 * This module is now the single source of truth for parsing that response. Both device.ts
 * and workflow.ts call `extractSearchDevices()` from here.
 */

export type DeviceRecord = Record<string, unknown>;

/**
 * Parses the `/api/v1/device/search` response envelope per the documented openapi.json
 * schema: `response.status.msg.visibleDevices` is the array of matched (visible) device
 * records. `hiddenDevices` (a count, not a list) is intentionally not surfaced here — callers
 * that need it can read it directly from the raw response.
 *
 * Returns an empty array if the envelope doesn't match the documented shape at all (e.g. an
 * unexpected error body) — callers that need to distinguish "zero devices matched" from
 * "couldn't parse the response" should use `parseSearchDevices()` instead, which makes that
 * distinction explicit.
 */
export function extractSearchDevices(raw: unknown): DeviceRecord[] {
  const result = parseSearchDevices(raw);
  return result.ok ? result.devices : [];
}

export type ParseSearchDevicesResult =
  | { ok: true; devices: DeviceRecord[]; hiddenDevices: number }
  | { ok: false; reason: string };

/**
 * Same parsing as `extractSearchDevices()`, but reports a parse failure explicitly instead of
 * silently collapsing it to an empty array. Use this wherever "no devices matched" and
 * "the response didn't look like a device-search response" must be told apart — most
 * importantly, anywhere a protected-OU or blast-radius safety check derives its decision from
 * the result (an unparseable response must never be treated as "zero devices, nothing to
 * check").
 */
export function parseSearchDevices(raw: unknown): ParseSearchDevicesResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'response was not a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  const response = r['response'];
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'response.response was missing or not an object' };
  }
  const status = (response as Record<string, unknown>)['status'];
  if (!status || typeof status !== 'object') {
    return { ok: false, reason: 'response.response.status was missing or not an object' };
  }
  const msg = (status as Record<string, unknown>)['msg'];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, reason: 'response.response.status.msg was missing or not an object' };
  }
  const visibleDevices = (msg as Record<string, unknown>)['visibleDevices'];
  if (!Array.isArray(visibleDevices)) {
    return { ok: false, reason: 'response.response.status.msg.visibleDevices was missing or not an array' };
  }
  const hiddenRaw = (msg as Record<string, unknown>)['hiddenDevices'];
  const hiddenDevices = typeof hiddenRaw === 'number' ? hiddenRaw : 0;
  return { ok: true, devices: visibleDevices as DeviceRecord[], hiddenDevices };
}

/** Reads a device record's display name, trying the field names Scout is known to use. */
export function deviceName(d: DeviceRecord): string | undefined {
  return (d['Name'] ?? d['DeviceName'] ?? d['name']) as string | undefined;
}

/**
 * Reads a device record's current OU id, if present. The documented `/api/v1/device/search`
 * example does not include an OU id field on each device record at all (the example only
 * shows ClientIdentifier/Name) — so, unlike the single-device `/api/v1/device` GET (which
 * reliably returns OUID — see config_resolve.ts, enricher.ts, resolver.ts), search results
 * cannot be assumed to carry a per-device OU id. Callers MUST treat "no id on any matched
 * device" as a reason to fail closed, not as "zero source OUs to check" — see
 * `resolveDistinctSourceOuPathsOrThrow` below.
 */
export function deviceOuId(d: DeviceRecord): number | undefined {
  const raw = d['OUID'] ?? d['ouId'] ?? d['OuId'];
  return typeof raw === 'number' ? raw : undefined;
}
