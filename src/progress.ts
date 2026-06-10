/**
 * Progress reporting for long-running MCP tool calls.
 *
 * Tools that support incremental status messages call getProgressReporter().log().
 * index.ts wires sendLoggingMessage (notifications/message) into the reporter
 * at the start of each request and clears it when the request finishes.
 *
 * MCP stdio is effectively single-request, so module-level state is safe here.
 */

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface ProgressReporter {
  log(level: LogLevel, message: string): Promise<void>;
}

const noop: ProgressReporter = {
  async log() {},
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
