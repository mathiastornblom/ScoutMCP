import { Agent, fetch } from 'undici';
import { type ScoutConfig, resolveConfig } from './session.js';

const DEFAULT_TIMEOUT_MS = 30_000;

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

export class ScoutClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent | undefined;
  private token: string | null = null;

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
    const loginPayload = JSON.stringify({
      username: this.config.username,
      password: this.config.password,
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
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuth();
    return this.doRequest<T>(method, path, body, false);
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.token) await this.login();
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

  // Invalidate cached instance if credentials changed
  const key = `${config.baseUrl}|${config.username}|${config.password}`;
  if (!_instance || _instanceKey !== key) {
    _instance = new ScoutClient(config);
    _instanceKey = key;
  }
  return _instance;
}
