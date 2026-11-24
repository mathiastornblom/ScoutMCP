/**
 * Progress reporting for long-running MCP tool calls.
 *
 * Previously (pre-WS-E): tools called getProgressReporter().log(level, message), which
 * index.ts wired to server.sendLoggingMessage({ level, data: message }) — i.e. progress was
 * piggybacked on the `notifications/message` logging primitive, not the MCP progress
 * protocol. That meant progress updates showed up as log lines with no progress/total
 * semantics and no way for a client to correlate them with a specific in-flight request.
 *
 * Now: tools call getProgressReporter().report(progress, total?, message?), which sends a
 * real `notifications/progress` message (see node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
 * `ProgressNotificationParamsSchema` — { progressToken, progress, total?, message? }) tied to
 * the progressToken taken from the originating request's `_meta.progressToken` (per the MCP
 * spec). If the caller didn't supply a progressToken, report() is a no-op: it resolves
 * immediately and never throws, so tools don't need to branch on whether progress reporting
 * is active.
 *
 * `log()` is kept as a thin compatibility shim (still routes through sendLoggingMessage) for
 * call sites that want free-text status lines rather than numeric progress — device_diagnostics
 * action=run uses this for its "Triggering…" / "Polling…" narration, which doesn't have a
 * natural progress/total shape.
 *
 * MCP stdio is effectively single-request, so module-level state is safe here.
 */

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface ProgressReporter {
  /** Free-text status line, routed through notifications/message (sendLoggingMessage). */
  log(level: LogLevel, message: string): Promise<void>;
  /**
   * Real MCP progress notification (notifications/progress). No-op if the originating
   * request didn't supply a progressToken in `_meta`.
   */
  report(progress: number, total?: number, message?: string): Promise<void>;
}

const noop: ProgressReporter = {
  async log() {},
  async report() {},
};

let _current: ProgressReporter = noop;

export function setProgressReporter(r: ProgressReporter): void {
  _current = r;
}

export function clearProgressReporter(): void {
  _current = noop;
}

export function getProgressReporter(): ProgressReporter {
  return _current;
}

/**
 * Builds a ProgressReporter for one tool call, given the pieces index.ts has at the
 * CallToolRequestSchema handler: the logging sender (sendLoggingMessage) and, separately, a
 * progress sender bound to the request's progressToken (or undefined if none was supplied).
 *
 * Kept as a small factory (rather than constructing the object inline in index.ts) so the
 * "report() is a no-op without a token" contract lives in one place and is unit-testable
 * without spinning up a real Server/transport.
 */
export function createProgressReporter(opts: {
  log: (level: LogLevel, message: string) => Promise<void>;
  sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}): ProgressReporter {
  return {
    async log(level, message) {
      try {
        await opts.log(level, message);
      } catch {
        // Best-effort: if the notification fails (transport not ready) continue silently.
      }
    },
    async report(progress, total, message) {
      if (!opts.sendProgress) return;
      try {
        await opts.sendProgress(progress, total, message);
      } catch {
        // Best-effort: progress notifications must never fail the underlying operation.
      }
    },
  };
}
