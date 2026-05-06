export function htmlToText(html: string | null | undefined, maxLength = 4000): string {
  if (!html) return "";
  let text = String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|blockquote|article|section)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\s*(td|th)[^>]*>/gi, " | ")
    .replace(/<\s*a\s+[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");

  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + `\n…[truncated ${text.length - maxLength} chars]`;
  }
  return text;
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

export function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

export type ExtractedText = { text: string | null; error?: string };

export async function extractText(data: Uint8Array, contentType: string): Promise<ExtractedText> {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("pdf")) {
    try {
      const { extractText: pdfExtract } = await import("unpdf");
      const result = await pdfExtract(data, { mergePages: true });
      const text = Array.isArray(result.text) ? result.text.join("\n\n") : (result.text as string);
      return { text };
    } catch (e) {
      return {
        text: null,
        error: `PDF parse failed (may be encrypted or malformed): ${(e as Error).message}`,
      };
    }
  }
  if (ct.includes("officedocument.wordprocessingml") || ct.includes("application/msword")) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      return { text: result.value };
    } catch (e) {
      return { text: null, error: `DOCX parse failed: ${(e as Error).message}` };
    }
  }
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")) {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(data) };
  }
  return { text: null, error: `unsupported content type: ${contentType || "unknown"}` };
}
