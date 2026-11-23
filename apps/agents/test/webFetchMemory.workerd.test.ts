// SPI-1321: `web_fetch` at its memory bounds in workerd, where a Worker isolate holds 128 MB: the largest body
// `fetchMaxKiB` may allow (`FETCH_MAX_KIB`, returned unconverted) and the largest it converts (`FETCH_CONVERT_MAX_KIB`),
// both of two-byte text, the costlier kind (a JS string of it takes 2 bytes a character).
//
// workerd reports no heap figures, so this is also the measurement behind those two maximums: run it alone with
// `MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=<MB>` and find the smallest heap that passes, against the same run of
// an empty test (the measured figures are in `FETCH_MAX_KIB`'s comment).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FETCH_CONVERT_MAX_KIB, FETCH_MAX_KIB } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { UNCONVERTED_NOTE, webFetchTool } from "../src/extensions/web/fetch.ts";
import { DEFAULT_WEB_LIMITS } from "../src/extensions/web/limits.ts";
import type { WebTransport } from "../src/extensions/web/net.ts";

const CHUNK = 64 * 1024;

/** An HTML page of exactly `bytes` bytes, streamed in 64 KiB chunks of two-byte text. */
const pageOf = (bytes: number): WebTransport => {
  const encoder = new TextEncoder();
  const block = (at: number) =>
    `<div class="c${at % 7}"><h2>Section ${at} — é ✓</h2><p>Some <b>bold</b> text, <a href="https://example.com/p/${at}">link ${at}</a>.</p></div>\n`;
  return (request) => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com")
      return Promise.resolve(
        Response.json({
          Status: 0,
          Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.215.14" }] : [],
        }),
      );
    let sent = 0;
    let at = 0;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= bytes) return controller.close();
            const size = Math.min(CHUNK, bytes - sent);
            let text = "";
            while (encoder.encode(text).byteLength < size - 400) text += block(at++);
            const chunk = new Uint8Array(size).fill(0x20);
            chunk.set(encoder.encode(text));
            sent += size;
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "text/html" } },
      ),
    );
  };
};

const fetchPage = async (bytes: number) => {
  const tool = webFetchTool(pageOf(bytes), { ...DEFAULT_WEB_LIMITS, fetchMaxKiB: FETCH_MAX_KIB });
  const result = await tool.execute({ url: "https://example.com/" } as never, {} as never, BACKGROUND_CONTEXT);
  return (result.structuredOutput as { content: string }).content;
};

describe("web_fetch's memory bounds (SPI-1321)", () => {
  it("returns a body of FETCH_MAX_KIB unconverted", async () => {
    expect(await fetchPage(FETCH_MAX_KIB * 1024)).toMatch(new RegExp(`^${RegExp.escape(UNCONVERTED_NOTE)}\\n<div`));
  });

  it("converts a body of FETCH_CONVERT_MAX_KIB", async () => {
    expect(await fetchPage(FETCH_CONVERT_MAX_KIB * 1024)).toMatch(/^## Section 0 — é ✓/);
  });
});
