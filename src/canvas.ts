export type QueryValue = string | number | boolean | string[] | number[] | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface CanvasClientOptions {
  baseUrl: string;
  token: string;
}

export class CanvasClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor({ baseUrl, token }: CanvasClientOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = path.startsWith("http")
      ? new URL(path)
      : new URL(`${this.baseUrl}/api/v1${path}`);
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

  private async request(url: string): Promise<Response> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Canvas API ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`);
    }
    return res;
  }

  async get<T>(path: string, params?: QueryParams): Promise<T> {
    const res = await this.request(this.buildUrl(path, params));
    return (await res.json()) as T;
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

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (match) return match[1];
  }
  return null;
}
