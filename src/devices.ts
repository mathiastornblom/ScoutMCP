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

import { canonicalizeOuPath } from './ou_path.js';

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
  | {
      ok: true;
      /** The visible rows (legacy envelope `visibleDevices`, or the live list). */
      devices: DeviceRecord[];
      /** Count of hidden devices (integer count, or length of a hidden list). */
      hiddenDevices: number;
      /**
       * Devices that exist but are NOT in `devices`: hidden + pending + denied (integer counts, or the
       * lengths of lists of rows). Gate paths must refuse when this is > 0 (an unlisted device would
       * skip its gate). Rows delivered in hidden/pending/denied LISTS are in `otherRows`.
       */
      unlisted: number;
      otherRows: DeviceRecord[];
    }
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
  let unlisted = 0;
  const otherRows: DeviceRecord[] = [];
  const isRow = (d: unknown): boolean => !!d && typeof d === 'object' && !Array.isArray(d);
  if (Array.isArray(msg)) {
    rows = msg;
  } else if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    rows = m['visibleDevices'];
    if (!Array.isArray(rows)) {
      return { ok: false, reason: 'response.response.status.msg.visibleDevices was missing or not an array' };
    }
    // hidden/pending/denied: absent (0), a non-negative INTEGER count (live single-device read), or a LIST of rows.
    for (const key of ['hiddenDevices', 'pendingDevices', 'deniedDevices'] as const) {
      const v = m[key];
      let n = 0;
      if (v === undefined) n = 0;
      else if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0) return { ok: false, reason: `${key} was not a non-negative integer (${JSON.stringify(v)})` };
        n = v;
      } else if (Array.isArray(v)) {
        if (!v.every(isRow)) return { ok: false, reason: `a ${key} row was not a JSON object` };
        n = v.length;
        otherRows.push(...(v as DeviceRecord[]));
      } else {
        return { ok: false, reason: `${key} was neither a count nor a list` };
      }
      unlisted += n;
      if (key === 'hiddenDevices') hiddenDevices = n;
    }
  } else {
    return { ok: false, reason: 'response.response.status.msg was neither a device list nor a {visibleDevices} object' };
  }
  const list = rows as unknown[];
  if (!list.every(isRow)) {
    return { ok: false, reason: 'a device row was not a JSON object' };
  }
  return { ok: true, devices: list as DeviceRecord[], hiddenDevices, unlisted, otherRows };
}

export type ParseSingleDeviceResult = { ok: true; row: DeviceRecord } | { ok: false; reason: string };

/**
 * Locates THE device row of a single-device read (GET /api/v1/device). Live shape (Scout 26.11.0) is the
 * legacy envelope with `visibleDevices:[row]` and INTEGER hidden/pending/denied counts. Requires exactly
 * one row in total (across every list) and every count to be 0; zero rows, several rows, any non-zero
 * count, bad counts or an unknown shape refuse. A flat record (no `response` key) is accepted as-is
 * (older/other servers); its OU id is still validated by the caller.
 */
export function parseSingleDevice(raw: unknown): ParseSingleDeviceResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'response was not a JSON object' };
  if (!('response' in (raw as Record<string, unknown>))) return { ok: true, row: raw as DeviceRecord };
  const p = parseSearchDevices(raw);
  if (!p.ok) return p;
  if (p.unlisted > 0) return { ok: false, reason: `${p.unlisted} hidden/pending/denied device(s) also matched; the device is ambiguous` };
  const all = [...p.devices, ...p.otherRows];
  if (all.length !== 1) return { ok: false, reason: `expected exactly 1 device row, got ${all.length}` };
  return { ok: true, row: all[0] };
}

/** Reads a device record's display name, trying the field names Scout is known to use. */
export function deviceName(d: DeviceRecord): string | undefined {
  return (d['Name'] ?? d['DeviceName'] ?? d['name']) as string | undefined;
}

const OUID_KEYS = ['OUID', 'ouId', 'OuId'] as const;

export type DeviceOuIdResult = { ok: true; id: number; claimedPath?: string } | { ok: false; reason: string };

function strictOuId(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** Enricher-added companion keys per id key (own properties only; see src/enricher.ts). */
const CLAIM_KEYS: Record<string, { path: string; name: string }> = {
  OUID: { path: '_OUIDPath', name: '_OUIDName' },
  ouId: { path: '_ouIdPath', name: '_ouIdName' },
  OuId: { path: '_OuIdPath', name: '_OuIdName' },
  GroupID: { path: '_GroupIDPath', name: '_GroupIDName' },
};

function hasOwn(d: DeviceRecord, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined;
}

/**
 * Pure shape check of the OPTIONAL enriched path/name keys (no resolver import). Present keys must be
 * well-formed and consistent; the claimed path is returned so resolveDeviceSourceOus can compare it
 * with the fresh OU tree. Absent keys are normal and change nothing. Never used as a fallback id source.
 */
function readClaimedPath(d: DeviceRecord, idKeys: string[]): { ok: true; claimedPath?: string } | { ok: false; reason: string } {
  const claimed: string[] = [];
  for (const [idKey, keys] of Object.entries(CLAIM_KEYS)) {
    const pathPresent = hasOwn(d, keys.path);
    const namePresent = hasOwn(d, keys.name);
    if (!pathPresent && !namePresent) continue;
    if (!idKeys.includes(idKey)) return { ok: false, reason: `${pathPresent ? keys.path : keys.name} is present without ${idKey}` };
    if (!pathPresent) return { ok: false, reason: `${keys.name} is present without ${keys.path}` };
    const raw = d[keys.path];
    if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: `${keys.path} is not a non-empty string` };
    let canon: string;
    try {
      canon = canonicalizeOuPath(raw);
    } catch (err) {
      return { ok: false, reason: `${keys.path} is not a valid OU path (${err instanceof Error ? err.message : String(err)})` };
    }
    if (namePresent) {
      const nm = d[keys.name];
      const last = canon.split('/').filter((x) => x !== '').pop();
      if (typeof nm !== 'string' || last === undefined || nm.normalize('NFC').toLowerCase() !== last) {
        return { ok: false, reason: `${keys.name} does not match the last segment of ${keys.path}` };
      }
    }
    claimed.push(canon);
  }
  if (new Set(claimed).size > 1) return { ok: false, reason: `claimed OU paths disagree (${claimed.join(', ')})` };
  return { ok: true, claimedPath: claimed[0] };
}

/**
 * Reads a device record's DIRECT OU id. Live evidence (Scout 26.11.0, GET /api/v1/device/search):
 * rows are {ClientIdentifier, DeviceID, GroupID, IP_Address, Mac_Address, Name} and `GroupID` equals
 * the device's own OU id (verified 6/6 against /api/v1/ou/structure ids; a parent OU has no devices
 * directly because DeviceCount is cumulative). Single-device records carry `OUID`.
 *
 * Strict and fail-closed: every present id key (OUID/ouId/OuId/GroupID) must be a non-negative
 * integer number (no strings, floats, negatives), and all present keys must agree. This function
 * only validates the VALUE (and the shape of optional enriched _*Path/_*Name keys, returned as
 * `claimedPath`); callers must additionally confirm the id exists in a FRESH parsed OU
 * tree and that claimedPath equals that tree's path (see resolveDeviceSourceOus in safety/ou_gate.ts).
 */
export function readDeviceOuId(d: DeviceRecord): DeviceOuIdResult {
  const found: Array<[string, unknown]> = [];
  for (const k of [...OUID_KEYS, 'GroupID']) {
    if (hasOwn(d, k)) found.push([k, d[k]]);
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
  const claim = readClaimedPath(d, found.map(([k]) => k));
  if (!claim.ok) return { ok: false, reason: claim.reason };
  return { ok: true, id: ids[0], ...(claim.claimedPath !== undefined ? { claimedPath: claim.claimedPath } : {}) };
}

/** Which OU-id keys a row carries, as a stable signature (rows of one search must share it). */
function ouIdShape(d: DeviceRecord): string {
  return [...OUID_KEYS, 'GroupID'].filter((k) => Object.prototype.hasOwnProperty.call(d, k)).join('+');
}

/**
 * Reads the OU id of every row of one search result. Refuses (ok:false) when any row is invalid or
 * when rows disagree on which id fields they carry (a mixed-shape result is not trusted).
 */
export function readDeviceOuIds(
  devices: DeviceRecord[],
): { ok: true; ids: number[]; claimedPaths: Array<string | undefined> } | { ok: false; reason: string } {
  if (devices.length === 0) return { ok: true, ids: [], claimedPaths: [] };
  const shape = ouIdShape(devices[0]);
  const ids: number[] = [];
  const claimedPaths: Array<string | undefined> = [];
  for (let i = 0; i < devices.length; i++) {
    if (ouIdShape(devices[i]) !== shape) {
      return { ok: false, reason: `device rows disagree on shape (row 1 has [${shape}], row ${i + 1} has [${ouIdShape(devices[i])}])` };
    }
    const r = readDeviceOuId(devices[i]);
    if (!r.ok) return { ok: false, reason: `row ${i + 1}: ${r.reason}` };
    ids.push(r.id);
    claimedPaths.push(r.claimedPath);
  }
  return { ok: true, ids, claimedPaths };
}

/** Value-validated OU id of a record, or undefined (kept for callers that only need a hint). */
export function deviceOuId(d: DeviceRecord): number | undefined {
  const r = readDeviceOuId(d);
  return r.ok ? r.id : undefined;
}
