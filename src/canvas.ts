export type QueryValue = string | number | boolean | string[] | number[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface CanvasClientOptions {
  baseUrl: string;
  token: string;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 256;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRateLimitedResponse(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 403 && /rate.?limit/i.test(body)) return true;
  return false;
}

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly cacheEnabled: boolean;
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor({ baseUrl, token }: CanvasClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.cacheEnabled = process.env.CANVAS_NO_CACHE !== "1";
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = path.startsWith("http") ? new URL(path) : new URL(`${this.baseUrl}/api/v1${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(`${key}[]`, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private cacheGet(key: string): unknown {
    if (!this.cacheEnabled) return undefined;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  private cacheSet(key: string, value: unknown): void {
    if (!this.cacheEnabled) return;
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetchWithRetry(url: string, init: RequestInit, method: string): Promise<Response> {
    let res = await fetch(url, init);
    if (res.ok) return res;
    let body = await res.text();
    if (isRateLimitedResponse(res.status, body)) {
      await sleep(RETRY_DELAY_MS);
      res = await fetch(url, init);
      if (res.ok) return res;
      body = await res.text();
    }
    throw new Error(
      `Canvas API ${res.status} ${res.statusText} for ${method} ${url}: ${body.slice(0, 500)}`,
    );
  }

  private async request(url: string): Promise<Response> {
    return this.fetchWithRetry(
      url,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      },
      "GET",
    );
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const url = this.buildUrl(path, params);
    const cached = this.cacheGet(url);
    if (cached !== undefined) return cached as T;
    const res = await this.request(url);
    const value = (await res.json()) as T;
    this.cacheSet(url, value);
    return value;
  }

  async post<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    return this.write<T>("POST", path, body, params);
  }

  async put<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    return this.write<T>("PUT", path, body, params);
  }

  async delete<T>(path: string, params?: QueryParams): Promise<T> {
    return this.write<T>("DELETE", path, undefined, params);
  }

  private async write<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    params?: QueryParams,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const res = await this.fetchWithRetry(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      method,
    );
    this.clearCache();
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async paginate<T>(path: string, params?: QueryParams): Promise<T[]> {
    const all: T[] = [];
    let url: string | null = this.buildUrl(path, { per_page: 100, ...params });
    while (url) {
      const res = await this.request(url);
      const page = (await res.json()) as T[];
      all.push(...page);
      url = parseNextLink(res.headers.get("link"));
    }
    return all;
  }
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (match) return match[1];
  }
  return null;
}
