import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface ScoutConfig {
  baseUrl: string;
  username: string;
  password: string;
  domain?: string;
  ignoreTls?: boolean;
}

const CONFIG_PATH = join(homedir(), '.scout-mcp.json');

let _session: ScoutConfig | null = null;

export function getSessionConfig(): ScoutConfig | null {
  return _session;
}

export function setSessionConfig(config: ScoutConfig): void {
  _session = config;
}

export function clearSessionConfig(): void {
  _session = null;
}

export function loadSavedConfig(): ScoutConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ScoutConfig>;
    if (parsed.baseUrl && parsed.username && parsed.password) {
      return parsed as ScoutConfig;
    }
  } catch {
    // No saved config or parse error
  }
  return null;
}

export function saveConfig(config: ScoutConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function deleteSavedConfig(): void {
  try {
    unlinkSync(CONFIG_PATH);
  } catch {
    // Already gone
  }
}

// Priority: in-session config > env vars > saved file
export function resolveConfig(): ScoutConfig | null {
  if (_session) return _session;

  const baseUrl = process.env.SCOUT_BASE_URL;
  const username = process.env.SCOUT_USERNAME;
  const password = process.env.SCOUT_PASSWORD;

  if (baseUrl && username && password) {
    return {
      baseUrl,
      username,
      password,
      domain: process.env.SCOUT_DOMAIN ?? '',
      ignoreTls: process.env.SCOUT_IGNORE_TLS === 'true',
    };
  }

  return loadSavedConfig();
}
