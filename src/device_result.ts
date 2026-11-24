/**
 * Post-condition check for device move/delete results.
 *
 * Scout's device helpers filter the id list on the caller's per-device rights and act only on the
 * permitted subset (SBD-UI api/helpers/devices/deviceMove.helper.ts:27-35 `allowedDevices`,
 * deviceDelete.helper.ts allowedToDelete). With NO permitted id they throw (406); with SOME they
 * succeed silently for the subset. The public /rest endpoints our tools use address one device
 * (api/external/helpers/device.helper.ts:100-135, 296-330), so for them a denial is an error, not
 * a silent drop; this check exists so any multi-id response shape (`deviceId: [...]`, as the UI
 * helper returns) can never hide dropped ids, and so a 200 without the documented success status
 * is flagged instead of reported as success.
 *
 * Pure; does not touch device search or any safety gate.
 */

export interface DeviceWriteAssessment {
  /** True when the server reported success in the documented shape (status.result 0) or listed every requested id. */
  confirmed: boolean;
  /** Requested ids that the response does not list as affected (empty when the response lists no ids). */
  droppedIds: string[];
  /** Ids the response lists as affected, when it lists any. */
  affectedIds: string[];
  note?: string;
}

function toIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(Number.isNaN(Number(x)) ? x : Number(x)));
}

export function assessDeviceWriteResult(data: unknown, requestedIds: string[] = []): DeviceWriteAssessment {
  // 204 / empty body: the HTTP success status is the confirmation; nothing to compare, so no warning.
  if (data === undefined || data === null || data === '') return { confirmed: true, droppedIds: [], affectedIds: [] };
  const d = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const resp = (d['response'] !== null && typeof d['response'] === 'object' ? d['response'] : {}) as Record<
    string,
    unknown
  >;
  const listed = toIdList(d['deviceId']) ?? toIdList(d['deviceIds']) ?? toIdList(resp['deviceId']) ?? toIdList(resp['deviceIds']);
  const statusResult = (resp['status'] as { result?: unknown } | undefined)?.result;
  const statusOk = statusResult === 0;

  if (listed) {
    const req = requestedIds.map((x) => String(Number.isNaN(Number(x)) ? x : Number(x)));
    const dropped = req.filter((id) => !listed.includes(id));
    return {
      confirmed: dropped.length === 0,
      droppedIds: dropped,
      affectedIds: listed,
      ...(dropped.length > 0
        ? { note: `Server acted on ${listed.length} of ${req.length} requested device(s); the rest were silently skipped (no rights on them).` }
        : {}),
    };
  }
  if (statusOk) return { confirmed: true, droppedIds: [], affectedIds: [] };
  return {
    confirmed: false,
    droppedIds: [],
    affectedIds: [],
    note: 'Server answered 2xx but the body does not confirm the change (no response.status.result 0 and no affected device ids). Verify with device_get before assuming it happened.',
  };
}
