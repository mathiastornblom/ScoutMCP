import { Agent, fetch } from 'undici';
import { type ScoutConfig, resolveConfig, buildCcTokenUrl } from './session.js';
import {
  checkMutationAllowed,
  type MutationCheckResult,
  DRY_RUN_SKIP_MARKER,
} from './safety/guardrails.js';

function makeDryRunSkip<T>(notice?: string): T {
  return {
    [DRY_RUN_SKIP_MARKER]: true,
    notice: notice ?? 'Skipped by SCOUT_MODE=dry-run.',
  } as unknown as T;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Renew token this many ms before its actual expiry to avoid race windows. */
const TOKEN_RENEW_BEFORE_MS = 60_000;

interface ApiError {
  code?: string | number;
  message?: string;
}

export class ScoutError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ScoutError';
  }
}

/** Decode the `exp` claim from a JWT without verifying the signature. */
function parseJwtExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: unknown;
    };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class ScoutClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent | undefined;
  private token: string | null = null;
  /** Unix timestamp (ms) when the current token expires, or null if unknown. */
  private tokenExpiresAt: number | null = null;

  constructor(private readonly config: ScoutConfig) {
    if (!config.baseUrl.startsWith('https://')) {
      throw new ScoutError('baseUrl must use https://');
    }

    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    const parsedTimeout = parseInt(process.env.SCOUT_REQUEST_TIMEOUT_MS ?? '', 10);
    this.timeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

    if (config.ignoreTls) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async login(): Promise<void> {
    if (this.config.authMethod === 'citrix-cloud') {
      return this.loginCitrixCloud();
    }
    const loginPayload = JSON.stringify({
      username: this.config.username ?? '',
      password: this.config.password ?? '',
      domain: this.config.domain ?? '',
    });
    const loginData64 = Buffer.from(loginPayload).toString('base64');

    const url = `${this.baseUrl}/rest/auth/v1/login`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginData64 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (!res.ok) {
      const body = await this.tryParseError(res);
      throw new ScoutError(body?.message ?? `Login failed (HTTP ${res.status})`, res.status);
    }

    const data = (await res.json()) as { token: string };
    if (!data.token) throw new ScoutError('Login response missing token');
    this.token = data.token;
    this.tokenExpiresAt = parseJwtExpiry(data.token);
  }

  /**
   * Citrix Cloud service-principal flow:
   *   1. Mint a CC bearer token via OAuth2 client-credentials (form-urlencoded — JSON gets 400).
   *   2. Exchange it at /rest/auth/v1/ccauth/login using a STANDARD `Bearer` prefix
   *      (NOT Citrix's `CwsAuth Bearer=` prefix — common mistake per the vendor doc).
   * The resulting Scout Board JWT is stored in the same token fields as password auth,
   * so the existing 401→re-login retry in doRequest/doRawRequest re-runs the full flow.
   */
  private async loginCitrixCloud(): Promise<void> {
    // Step 1: mint the Citrix Cloud bearer token.
    const tokenUrl = buildCcTokenUrl(this.config);
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.ccClientId ?? '',
      client_secret: this.config.ccClientSecret ?? '',
    });
    const mintRes = await this.fetchWithTimeout(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (!mintRes.ok) {
      let msg: string;
      switch (mintRes.status) {
        case 401:
          msg =
            'Citrix Cloud rejected the service principal credentials (HTTP 401) — check client_id/secret and region.';
          break;
        case 403:
          msg =
            "Citrix Cloud token endpoint returned 403 — the token endpoint region doesn't match the service principal's tenant region.";
          break;
        case 400:
          msg =
            'Citrix Cloud token endpoint returned 400 — likely a request body-encoding issue (the token request must be application/x-www-form-urlencoded).';
          break;
        default:
          msg = `Citrix Cloud token request failed (HTTP ${mintRes.status}).`;
      }
      throw new ScoutError(msg, mintRes.status);
    }

    // Note: expires_in is a STRING in the CC response; we don't rely on it —
    // the CC token is used exactly once, immediately, to obtain the Scout JWT.
    const mintData = (await mintRes.json()) as { access_token?: string };
    if (!mintData.access_token) {
      throw new ScoutError('Citrix Cloud token response missing access_token');
    }

    // Step 2: exchange the CC token for a Scout Board JWT.
    const exchangeUrl = `${this.baseUrl}/rest/auth/v1/ccauth/login`;
    const exchangeRes = await this.fetchWithTimeout(exchangeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mintData.access_token}`,
        Accept: 'application/json',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (!exchangeRes.ok) {
      let msg: string;
      switch (exchangeRes.status) {
        case 401:
          msg =
            'Scout Board could not validate the Citrix Cloud token (HTTP 401) — server-side CC service configuration issue, contact the Scout Board admin.';
          break;
        case 403:
          msg =
            'Service principal is not registered as a Scout Board user (HTTP 403) — add its client_id under Users with Login + WebService rights.';
          break;
        default:
          msg = `Citrix Cloud login to Scout Board failed (HTTP ${exchangeRes.status}).`;
      }
      throw new ScoutError(msg, exchangeRes.status);
    }

    const data = (await exchangeRes.json()) as { token?: string };
    if (!data.token) throw new ScoutError('ccauth login response missing token');
    this.token = data.token;
    // Scout JWTs carry an exp claim; if not, fall back to the documented 1-hour lifetime.
    this.tokenExpiresAt = parseJwtExpiry(data.token) ?? Date.now() + 3_600_000;
  }

  /**
   * @param opts.mutating - Set true for any call that changes server state (POST/PUT/
   *   DELETE/PATCH that writes data, as opposed to e.g. a POST used as a read/search).
   *   This is the Gate 1 (SCOUT_MODE) chokepoint: callers MUST pass this explicitly for
   *   write-capable calls — it is not inferred from the HTTP verb, because some tools use
   *   POST for read/search operations (e.g. structure export, device search-by-filter).
   *   When mutating=true and SCOUT_MODE=read-only, this throws. When SCOUT_MODE=dry-run,
   *   this returns a DryRunResult<T> sentinel instead of issuing the HTTP call — tools
   *   should check `isDryRunSkip(result)` and report the planned action instead of `data`.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { mutating?: boolean; opName?: string },
  ): Promise<T> {
    if (opts?.mutating) {
      const check = this.checkMode(opts.opName ?? `${method} ${path}`);
      if (!check.proceed) return makeDryRunSkip<T>(check.dryRunNotice);
    }
    await this.ensureAuth();
    return this.doRequest<T>(method, path, body, false);
  }

  /** Like request(), but skips the /rest prefix — for private endpoints served outside /rest/. */
  async rawRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { mutating?: boolean; opName?: string },
  ): Promise<T> {
    if (opts?.mutating) {
      const check = this.checkMode(opts.opName ?? `${method} ${path}`);
      if (!check.proceed) return makeDryRunSkip<T>(check.dryRunNotice);
    }
    await this.ensureAuth();
    return this.doRawRequest<T>(method, path, body, false);
  }

  private checkMode(opName: string): MutationCheckResult {
    return checkMutationAllowed(opName);
  }

  isAuthenticated(): boolean {
    return this.token !== null && !this.isTokenExpired();
  }

  /** Unix ms when the active token expires, or null if unknown / no token. */
  tokenExpiry(): number | null {
    return this.token ? this.tokenExpiresAt : null;
  }

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    return Date.now() >= this.tokenExpiresAt - TOKEN_RENEW_BEFORE_MS;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.token || this.isTokenExpired()) {
      this.token = null;
      this.tokenExpiresAt = null;
      await this.login();
    }
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean,
  ): Promise<T> {
    const url = `${this.baseUrl}/rest${path}`;
    const headers: Record<string, string> = {
      Cookie: `ScoutBoardAuthJWT=${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchWithTimeout(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (res.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiresAt = null;
      await this.login();
      return this.doRequest<T>(method, path, body, true);
    }

    if (!res.ok) {
      const apiError = await this.tryParseError(res);
      // The API sometimes returns {"message":"OK"} on error responses — ignore it.
      const msg =
        apiError?.message && apiError.message !== 'OK'
          ? apiError.message
          : `Request failed (HTTP ${res.status})`;
      throw new ScoutError(msg, res.status);
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  private async doRawRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchWithTimeout(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (res.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiresAt = null;
      await this.login();
      return this.doRawRequest<T>(method, path, body, true);
    }

    if (!res.ok) {
      const apiError = await this.tryParseError(res);
      const msg =
        apiError?.message && apiError.message !== 'OK'
          ? apiError.message
          : `Request failed (HTTP ${res.status})`;
      throw new ScoutError(msg, res.status);
    }

    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  private async fetchWithTimeout(
    url: string,
    init: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return (await fetch(url, {
        ...init,
        signal: controller.signal,
      })) as unknown as Response;
    } finally {
      clearTimeout(timer);
    }
  }

  private async tryParseError(res: Response): Promise<ApiError | undefined> {
    try {
      const text = await res.text();
      if (!text) return undefined;
      return JSON.parse(text) as ApiError;
    } catch {
      return undefined;
    }
  }
}

let _instance: ScoutClient | undefined;
let _instanceKey: string | undefined;

export function getClient(): ScoutClient {
  const config = resolveConfig();
  if (!config) {
    throw new ScoutError(
      'Scout is not configured. Call the scout_configure tool with your server URL, username, and password.',
    );
  }

  // Invalidate cached instance if credentials changed. The key includes the client
  // secret so switching service principals invalidates correctly — it is kept
  // in-memory only and must never be logged.
  const key = [
    config.baseUrl,
    config.authMethod ?? 'password',
    config.username ?? '',
    config.password ?? '',
    config.ccClientId ?? '',
    config.ccClientSecret ?? '',
    config.ccCustomerId ?? '',
    config.ccRegion ?? '',
    config.ccTokenUrl ?? '',
  ].join('|');
  if (!_instance || _instanceKey !== key) {
    _instance = new ScoutClient(config);
    _instanceKey = key;
  }
  return _instance;
}
