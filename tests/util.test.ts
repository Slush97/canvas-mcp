import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daysAgoIso, daysFromNowIso, extractText, htmlToText } from "../src/util.js";

describe("htmlToText", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText("")).toBe("");
  });

  it("strips simple tags and collapses whitespace", () => {
    expect(htmlToText("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("turns <br> into newlines", () => {
    expect(htmlToText("a<br>b<br/>c<br />d")).toBe("a\nb\nc\nd");
  });

  it("separates block elements with newlines", () => {
    expect(htmlToText("<p>one</p><p>two</p><p>three</p>")).toBe("one\ntwo\nthree");
  });

  it("collapses runs of 3+ newlines into a single blank line", () => {
    expect(htmlToText("a<br><br><br><br>b")).toBe("a\n\nb");
  });

  it("formats list items with leading dashes", () => {
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("- a");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("- b");
  });

  it("renders anchors as 'text (href)'", () => {
    expect(htmlToText('see <a href="https://example.com/x">the docs</a>')).toBe(
      "see the docs (https://example.com/x)",
    );
  });

  it("formats table rows with pipe separators and newlines", () => {
    expect(
      htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"),
    ).toContain("| a | b");
  });

  it("decodes named and numeric HTML entities", () => {
    expect(htmlToText("a&nbsp;b&amp;c&lt;d&gt;e&quot;f&#39;g&apos;h")).toBe(`a b&c<d>e"f'g'h`);
    expect(htmlToText("&hellip; &mdash; &ndash;")).toBe("… — –");
    expect(htmlToText("&#65;&#9731;")).toBe("A☃");
  });

  it("strips angle-bracket attributes without leaving fragments", () => {
    expect(htmlToText('<img src="x.png" alt="y"><span class="z">hi</span>')).toBe("hi");
  });

  it("trims and removes leading/trailing whitespace per line", () => {
    expect(htmlToText("   <p>   hello   </p>   ")).toBe("hello");
  });

  it("truncates long output with a [truncated …] marker", () => {
    const long = "x".repeat(5000);
    const out = htmlToText(`<p>${long}</p>`, 100);
    expect(out.length).toBeGreaterThan(100);
    expect(out).toMatch(/\[truncated \d+ chars\]$/);
    expect(out.startsWith("x".repeat(100))).toBe(true);
  });

  it("does not truncate when under the cap", () => {
    expect(htmlToText("<p>short</p>", 100)).toBe("short");
  });
});

describe("daysAgoIso / daysFromNowIso", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("daysAgoIso shifts backwards", () => {
    expect(daysAgoIso(7)).toBe("2026-04-28T12:00:00.000Z");
  });

  it("daysFromNowIso shifts forwards", () => {
    expect(daysFromNowIso(3)).toBe("2026-05-08T12:00:00.000Z");
  });

  it("zero returns now", () => {
    expect(daysAgoIso(0)).toBe("2026-05-05T12:00:00.000Z");
    expect(daysFromNowIso(0)).toBe("2026-05-05T12:00:00.000Z");
  });
});

describe("extractText", () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  it("decodes text/plain as UTF-8", async () => {
    const result = await extractText(encode("hello world"), "text/plain; charset=utf-8");
    expect(result.text).toBe("hello world");
    expect(result.error).toBeUndefined();
  });

  it("decodes text/markdown", async () => {
    const result = await extractText(encode("# title\nbody"), "text/markdown");
    expect(result.text).toBe("# title\nbody");
  });

  it("decodes application/json", async () => {
    const result = await extractText(encode('{"a":1}'), "application/json");
    expect(result.text).toBe('{"a":1}');
  });

  it("decodes application/xml", async () => {
    const result = await extractText(encode("<a/>"), "application/xml");
    expect(result.text).toBe("<a/>");
  });

  it("returns null + error for unsupported binary types", async () => {
    const result = await extractText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/unsupported content type: image\/png/);
  });

  it("returns null + error for empty content type", async () => {
    const result = await extractText(new Uint8Array([1, 2, 3]), "");
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/unsupported content type: unknown/);
  });

  it("returns error when PDF parsing fails on garbage bytes", async () => {
    const result = await extractText(encode("not a real pdf"), "application/pdf");
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/PDF parse failed/);
  });

  it("returns error when DOCX parsing fails on garbage bytes", async () => {
    const result = await extractText(
      encode("not a real docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/DOCX parse failed/);
  });
});
