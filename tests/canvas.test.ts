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
    expect(parseNextLink(header)).toBe(
      "https://x.test/api/v1/courses?page=2",
    );
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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 1 }));

    const result = await client.get<{ id: number }>("/users/self");

    expect(result).toEqual({ id: 1 });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("encodes array params with [] suffix and scalars normally", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));

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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));

    await client.get("/courses", { a: undefined, b: null, c: "keep" });

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain("a=");
    expect(calledUrl).not.toContain("b=");
    expect(calledUrl).toContain("c=keep");
  });

  it("throws with status and a body excerpt on non-2xx", async () => {
    const client = new CanvasClient({ baseUrl, token });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse("nope, no.", { status: 403 }),
    );

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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const result = await client.delete<unknown>("/conversations/1");
    expect(result).toBeUndefined();
  });

  it("write sends JSON body and Content-Type header on POST", async () => {
    const client = new CanvasClient({ baseUrl, token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ id: 99 }));

    await client.post("/things", { name: "x" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });
});
