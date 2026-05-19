import { Agent } from 'undici';

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
  private readonly username: string;
  private readonly password: string;
  private readonly domain: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent | undefined;
  private token: string | null = null;

  constructor() {
    const baseUrl = process.env.SCOUT_BASE_URL;
    const username = process.env.SCOUT_USERNAME;
    const password = process.env.SCOUT_PASSWORD;

    if (!baseUrl) throw new ScoutError('SCOUT_BASE_URL is required');
    if (!username) throw new ScoutError('SCOUT_USERNAME is required');
    if (!password) throw new ScoutError('SCOUT_PASSWORD is required');

    // Security: refuse to start without HTTPS to protect credentials in transit
    if (!baseUrl.startsWith('https://')) {
      throw new ScoutError('SCOUT_BASE_URL must use https://');
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.domain = process.env.SCOUT_DOMAIN ?? '';
    const parsedTimeout = parseInt(process.env.SCOUT_REQUEST_TIMEOUT_MS ?? '', 10);
    this.timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS;

    const ignoreTls = process.env.SCOUT_IGNORE_TLS === 'true';
    if (ignoreTls) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async login(): Promise<void> {
    const loginPayload = JSON.stringify({
      username: this.username,
      password: this.password,
      domain: this.domain,
    });
    const loginData64 = Buffer.from(loginPayload).toString('base64');

    const url = `${this.baseUrl}/rest/auth/v1/login`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginData64 }),
      // dispatcher cast: undici fetch accepts dispatcher but @types/node doesn't declare it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.dispatcher ? { dispatcher: this.dispatcher as any } : {}),
    });

    if (!res.ok) {
      const body = await this.tryParseError(res);
      throw new ScoutError(
        body?.message ?? `Login failed (HTTP ${res.status})`,
        res.status,
      );
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
      'Cookie': `ScoutBoardAuthJWT=${this.token}`,
      'Accept': 'application/json',
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
      throw new ScoutError(
        apiError?.message ?? `Request failed (HTTP ${res.status})`,
        res.status,
      );
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
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

export function getClient(): ScoutClient {
  if (!_instance) _instance = new ScoutClient();
  return _instance;
}
