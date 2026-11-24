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
 * LIVE UPDATE (Scout 26.11.0): the real server returns `msg` as a LIST of rows
 * ({ClientIdentifier, DeviceID, GroupID, IP_Address, Mac_Address, Name}); both shapes are parsed here.
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
  // Shape A (live, Scout 26.11.0): msg is a LIST of device rows. Shape B (openapi.json example):
  // msg is { visibleDevices: [...], hiddenDevices: n }. Anything else is refused, never "empty".
  let rows: unknown;
  let hiddenDevices = 0;
  if (Array.isArray(msg)) {
    rows = msg;
  } else if (msg && typeof msg === 'object') {
    rows = (msg as Record<string, unknown>)['visibleDevices'];
    if (!Array.isArray(rows)) {
      return { ok: false, reason: 'response.response.status.msg.visibleDevices was missing or not an array' };
    }
    const hiddenRaw = (msg as Record<string, unknown>)['hiddenDevices'];
    hiddenDevices = typeof hiddenRaw === 'number' ? hiddenRaw : 0;
  } else {
    return { ok: false, reason: 'response.response.status.msg was neither a device list nor a {visibleDevices} object' };
  }
  const list = rows as unknown[];
  if (list.some((d) => !d || typeof d !== 'object' || Array.isArray(d))) {
    return { ok: false, reason: 'a device row was not a JSON object' };
  }
  return { ok: true, devices: list as DeviceRecord[], hiddenDevices };
}

/** Reads a device record's display name, trying the field names Scout is known to use. */
export function deviceName(d: DeviceRecord): string | undefined {
  return (d['Name'] ?? d['DeviceName'] ?? d['name']) as string | undefined;
}

const OUID_KEYS = ['OUID', 'ouId', 'OuId'] as const;

export type DeviceOuIdResult = { ok: true; id: number } | { ok: false; reason: string };

function strictOuId(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Reads a device record's DIRECT OU id. Live evidence (Scout 26.11.0, GET /api/v1/device/search):
 * rows are {ClientIdentifier, DeviceID, GroupID, IP_Address, Mac_Address, Name} and `GroupID` equals
 * the device's own OU id (verified 6/6 against /api/v1/ou/structure ids; a parent OU has no devices
 * directly because DeviceCount is cumulative). Single-device records carry `OUID`.
 *
 * Strict and fail-closed: every present id key (OUID/ouId/OuId/GroupID) must be a non-negative
 * integer number (no strings, floats, negatives), and all present keys must agree. This function
 * only validates the VALUE; callers must additionally confirm the id exists in a FRESH parsed OU
 * tree (see resolveDeviceSourceOus in safety/ou_gate.ts) before trusting it.
 */
export function readDeviceOuId(d: DeviceRecord): DeviceOuIdResult {
  const found: Array<[string, unknown]> = [];
  for (const k of [...OUID_KEYS, 'GroupID']) {
    if (Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined) found.push([k, d[k]]);
  }
  if (found.length === 0) return { ok: false, reason: 'device record has no OUID/GroupID field' };
  const ids: number[] = [];
  for (const [k, v] of found) {
    const n = strictOuId(v);
    if (n === undefined) return { ok: false, reason: `${k} is not a non-negative integer (${JSON.stringify(v)})` };
    ids.push(n);
  }
  if (new Set(ids).size > 1) {
    return { ok: false, reason: `OU id fields disagree (${found.map(([k, v]) => `${k}=${String(v)}`).join(', ')})` };
  }
  return { ok: true, id: ids[0] };
}

/** Which OU-id keys a row carries, as a stable signature (rows of one search must share it). */
function ouIdShape(d: DeviceRecord): string {
  return [...OUID_KEYS, 'GroupID'].filter((k) => Object.prototype.hasOwnProperty.call(d, k)).join('+');
}

/**
 * Reads the OU id of every row of one search result. Refuses (ok:false) when any row is invalid or
 * when rows disagree on which id fields they carry (a mixed-shape result is not trusted).
 */
export function readDeviceOuIds(devices: DeviceRecord[]): { ok: true; ids: number[] } | { ok: false; reason: string } {
  if (devices.length === 0) return { ok: true, ids: [] };
  const shape = ouIdShape(devices[0]);
  const ids: number[] = [];
  for (let i = 0; i < devices.length; i++) {
    if (ouIdShape(devices[i]) !== shape) {
      return { ok: false, reason: `device rows disagree on shape (row 1 has [${shape}], row ${i + 1} has [${ouIdShape(devices[i])}])` };
    }
    const r = readDeviceOuId(devices[i]);
    if (!r.ok) return { ok: false, reason: `row ${i + 1}: ${r.reason}` };
    ids.push(r.id);
  }
  return { ok: true, ids };
}

/** Value-validated OU id of a record, or undefined (kept for callers that only need a hint). */
export function deviceOuId(d: DeviceRecord): number | undefined {
  const r = readDeviceOuId(d);
  return r.ok ? r.id : undefined;
}
