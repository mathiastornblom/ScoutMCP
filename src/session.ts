import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type ScoutAuthMethod = 'password' | 'citrix-cloud';
export type CcRegion = 'us' | 'eu' | 'ap-s' | 'jp' | 'staging';

export interface ScoutConfig {
  baseUrl: string;
  /** Auth method to Scout Board. Absent or 'password' = classic username/password login. */
  authMethod?: ScoutAuthMethod;
  /** Required in password mode; unused in citrix-cloud mode. */
  username?: string;
  password?: string;
  domain?: string;
  ignoreTls?: boolean;
  /** Citrix Cloud service-principal fields (citrix-cloud mode). */
  ccClientId?: string;
  ccClientSecret?: string;
  ccCustomerId?: string;
  ccRegion?: CcRegion;
  /** Full token-endpoint URL override — takes precedence over ccRegion/ccCustomerId. */
  ccTokenUrl?: string;
}

const CC_REGION_BASES: Record<CcRegion, string> = {
  us: 'https://api-us.cloud.com',
  eu: 'https://api-eu.cloud.com',
  'ap-s': 'https://api-ap-s.cloud.com',
  jp: 'https://api.citrixcloud.jp',
  staging: 'https://api.cloudburrito.com',
};

export const CC_REGIONS = Object.keys(CC_REGION_BASES) as CcRegion[];

/**
 * Build the Citrix Cloud OAuth2 token endpoint URL for a config.
 * ccTokenUrl override wins; staging substitutes `/root/` for the customer id.
 */
export function buildCcTokenUrl(config: ScoutConfig): string {
  if (config.ccTokenUrl) {
    // Fail closed: the client secret is form-POSTed to this URL, so it must be https.
    // Mirrors the enforced https policy on baseUrl (client.ts / configure.ts).
    if (!config.ccTokenUrl.startsWith('https://')) {
      throw new Error(
        `ccTokenUrl (SCOUT_CC_TOKEN_URL) must start with https:// — got "${config.ccTokenUrl}"`,
      );
    }
    return config.ccTokenUrl;
  }
  const region = config.ccRegion;
  if (!region) {
    throw new Error('citrix-cloud auth requires ccRegion or ccTokenUrl');
  }
  const base = CC_REGION_BASES[region];
  const segment = region === 'staging' ? 'root' : config.ccCustomerId;
  if (!segment) {
    throw new Error('citrix-cloud auth requires ccCustomerId (except for staging region)');
  }
  return `${base}/cctrustoauth2/${segment}/tokens/clients`;
}

/**
 * Validate a citrix-cloud config, returning a list of what's missing or invalid (empty = valid).
 */
export function missingCcFields(config: Partial<ScoutConfig>): string[] {
  const missing: string[] = [];
  if (!config.baseUrl) missing.push('baseUrl (SCOUT_BASE_URL)');
  if (!config.ccClientId) missing.push('ccClientId (SCOUT_CC_CLIENT_ID)');
  if (!config.ccClientSecret) missing.push('ccClientSecret (SCOUT_CC_CLIENT_SECRET)');
  if (config.ccTokenUrl && !config.ccTokenUrl.startsWith('https://')) {
    // The client secret is POSTed to this URL — never allow http:// or other schemes.
    missing.push('ccTokenUrl (SCOUT_CC_TOKEN_URL) must start with https://');
  }
  if (!config.ccTokenUrl) {
    if (!config.ccRegion) {
      missing.push('ccRegion (SCOUT_CC_REGION) or ccTokenUrl (SCOUT_CC_TOKEN_URL)');
    } else if (config.ccRegion !== 'staging' && !config.ccCustomerId) {
      missing.push('ccCustomerId (SCOUT_CC_CUSTOMER_ID) — required unless region is staging');
    }
  }
  return missing;
}

function isValidRegion(value: string): value is CcRegion {
  return (CC_REGIONS as string[]).includes(value);
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
    if (parsed.authMethod === 'citrix-cloud') {
      if (missingCcFields(parsed).length === 0) {
        return parsed as ScoutConfig;
      }
      return null;
    }
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
  const authMethod = process.env.SCOUT_AUTH ?? 'password';

  if (authMethod === 'citrix-cloud') {
    const regionRaw = process.env.SCOUT_CC_REGION;
    if (regionRaw && !isValidRegion(regionRaw)) {
      throw new Error(
        `Invalid SCOUT_CC_REGION "${regionRaw}" — expected one of: ${CC_REGIONS.join(', ')}`,
      );
    }
    const config: ScoutConfig = {
      baseUrl: baseUrl ?? '',
      authMethod: 'citrix-cloud',
      ignoreTls: process.env.SCOUT_IGNORE_TLS === 'true',
      ccClientId: process.env.SCOUT_CC_CLIENT_ID,
      ccClientSecret: process.env.SCOUT_CC_CLIENT_SECRET,
      ccCustomerId: process.env.SCOUT_CC_CUSTOMER_ID,
      ccRegion: regionRaw as CcRegion | undefined,
      ccTokenUrl: process.env.SCOUT_CC_TOKEN_URL,
    };
    const missing = missingCcFields(config);
    if (missing.length > 0) {
      throw new Error(
        `SCOUT_AUTH=citrix-cloud is set but the configuration is incomplete. Missing: ${missing.join('; ')}`,
      );
    }
    return config;
  }

  if (authMethod !== 'password') {
    throw new Error(`Invalid SCOUT_AUTH "${authMethod}" — expected "password" or "citrix-cloud"`);
  }

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
