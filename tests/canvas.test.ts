import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasClient, parseNextLink } from "../src/canvas.js";

describe("parseNextLink", () => {
  it("returns null when header is null or empty", () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink("")).toBeNull();
  });

  it("extracts the rel=next URL from a multi-rel header", () => {
    const header =
      '<https://x.test/api/v1/courses?page=1>; rel="current",' +
      '<https://x.test/api/v1/courses?page=2>; rel="next",' +
      '<https://x.test/api/v1/courses?page=5>; rel="last",' +
      '<https://x.test/api/v1/courses?page=1>; rel="first"';
    expect(parseNextLink(header)).toBe("https://x.test/api/v1/courses?page=2");
  });

  it("returns null when no next rel is present", () => {
    const header =
      '<https://x.test/api/v1/courses?page=1>; rel="current",' +
      '<https://x.test/api/v1/courses?page=5>; rel="last"';
    expect(parseNextLink(header)).toBeNull();
  });

  it("tolerates extra whitespace around commas", () => {
    const header =
      '  <https://x.test/api/v1/x?page=1>; rel="current"  ,  ' +
      '<https://x.test/api/v1/x?page=2>; rel="next"  ';
    expect(parseNextLink(header)).toBe("https://x.test/api/v1/x?page=2");
  });
});

describe("CanvasClient", () => {
  const baseUrl = "https://canvas.test";
  const token = "test-token";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  }

  it("strips trailing slashes from baseUrl", async () => {
    const client = new CanvasClient({ baseUrl: `${baseUrl}/`, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    await client.get("/users/self");

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(`${baseUrl}/api/v1/users/self`);
  });

  it("sends Bearer auth and Accept JSON on GET", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse({ id: 1 }));

    const result = await client.get<{ id: number }>("/users/self");

    expect(result).toEqual({ id: 1 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("encodes array params with [] suffix and scalars normally", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));

    await client.get("/courses", {
      enrollment_state: "active",
      include: ["term", "teachers"],
      per_page: 50,
    });

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("enrollment_state=active");
    expect(calledUrl).toContain("include%5B%5D=term");
    expect(calledUrl).toContain("include%5B%5D=teachers");
    expect(calledUrl).toContain("per_page=50");
  });

  it("skips undefined and null params", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));

    await client.get("/courses", { a: undefined, b: null, c: "keep" });

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain("a=");
    expect(calledUrl).not.toContain("b=");
    expect(calledUrl).toContain("c=keep");
  });

  it("throws with status and a body excerpt on non-2xx", async () => {
    const client = new CanvasClient({ baseUrl, token });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse("nope, no.", { status: 403 }));

    const err = await client.get("/x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Canvas API 403/);
    expect((err as Error).message).toMatch(/nope, no\./);
  });

  it("paginate follows rel=next until exhausted and concatenates pages", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockResponse([{ id: 1 }, { id: 2 }], {
          headers: {
            link: `<${baseUrl}/api/v1/courses?page=2&per_page=100>; rel="next"`,
          },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse([{ id: 3 }], {
          headers: {
            link: `<${baseUrl}/api/v1/courses?page=3&per_page=100>; rel="next"`,
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse([{ id: 4 }]));

    const all = await client.paginate<{ id: number }>("/courses");

    expect(all.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(firstUrl).toContain("per_page=100");
  });

  it("write returns undefined on 204 No Content", async () => {
    const client = new CanvasClient({ baseUrl, token });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await client.delete<unknown>("/conversations/1");
    expect(result).toBeUndefined();
  });

  it("write sends JSON body and Content-Type header on POST", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse({ id: 99 }));

    await client.post("/things", { name: "x" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });
});

describe("CanvasClient cache", () => {
  const baseUrl = "https://canvas.test";
  const token = "test-token";
  const original = { ...process.env };

  function mockResponse(body: unknown, init: { status?: number } = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...original };
  });

  it("caches GETs by URL within the TTL", async () => {
    delete process.env.CANVAS_NO_CACHE;
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }))
      .mockResolvedValueOnce(mockResponse({ id: 2 }));

    const a = await client.get<{ id: number }>("/users/self");
    const b = await client.get<{ id: number }>("/users/self");

    expect(a).toEqual({ id: 1 });
    expect(b).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats different query params as distinct cache keys", async () => {
    delete process.env.CANVAS_NO_CACHE;
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }))
      .mockResolvedValueOnce(mockResponse({ id: 2 }));

    await client.get("/courses", { enrollment_state: "active" });
    await client.get("/courses", { enrollment_state: "completed" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after TTL expiry", async () => {
    delete process.env.CANVAS_NO_CACHE;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T00:00:00Z"));
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }))
      .mockResolvedValueOnce(mockResponse({ id: 2 }));

    await client.get("/x");
    vi.setSystemTime(new Date("2026-05-06T00:01:01Z"));
    const second = await client.get<{ id: number }>("/x");

    expect(second).toEqual({ id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("CANVAS_NO_CACHE=1 disables the cache", async () => {
    process.env.CANVAS_NO_CACHE = "1";
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }))
      .mockResolvedValueOnce(mockResponse({ id: 2 }));

    const a = await client.get<{ id: number }>("/x");
    const b = await client.get<{ id: number }>("/x");

    expect(a).toEqual({ id: 1 });
    expect(b).toEqual({ id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache after a write", async () => {
    delete process.env.CANVAS_NO_CACHE;
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }))
      .mockResolvedValueOnce(mockResponse({ ok: true }))
      .mockResolvedValueOnce(mockResponse({ id: 2 }));

    await client.get("/x");
    await client.post("/y", { name: "z" });
    const after = await client.get<{ id: number }>("/x");

    expect(after).toEqual({ id: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("paginate is not served from cache", async () => {
    delete process.env.CANVAS_NO_CACHE;
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([{ id: 1 }]))
      .mockResolvedValueOnce(mockResponse([{ id: 2 }]));

    await client.paginate("/courses");
    await client.paginate("/courses");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("CanvasClient rate-limit retry", () => {
  const baseUrl = "https://canvas.test";
  const token = "test-token";
  const original = { ...process.env };

  function mockResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env = { ...original };
  });

  it("retries once on HTTP 429 and returns the second response", async () => {
    process.env.CANVAS_NO_CACHE = "1";
    vi.useFakeTimers();
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(mockResponse({ id: 1 }));

    const promise = client.get<{ id: number }>("/x");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on HTTP 403 with a rate-limit body", async () => {
    process.env.CANVAS_NO_CACHE = "1";
    vi.useFakeTimers();
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse("403 Forbidden (Rate Limit Exceeded)", { status: 403 }))
      .mockResolvedValueOnce(mockResponse({ id: 1 }));

    const promise = client.get<{ id: number }>("/x");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on plain 403 without rate-limit signal", async () => {
    process.env.CANVAS_NO_CACHE = "1";
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse("permission denied", { status: 403 }));

    const err = await client.get("/x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Canvas API 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws if the retry also fails", async () => {
    process.env.CANVAS_NO_CACHE = "1";
    vi.useFakeTimers();
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(mockResponse("still throttled", { status: 429 }));

    const promise = client.get("/x").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Canvas API 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
