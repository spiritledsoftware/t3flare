// SPI-1321, SPI-1388: `web_fetch` and `web_search` at their memory bounds in workerd, where a Worker isolate holds 128 MB:
// the largest body web_fetch reads, every one of which it converts (`FETCH_MAX_KIB`), and the largest search answer
// read (`ANSWER_MAX_BYTES`), each of two-byte text, the costlier kind (a JS string of it takes 2 bytes a character).
//
// workerd reports no heap figures, so this is also the measurement behind those two maximums: run it alone with
// `MINIFLARE_WORKERD_V8_FLAGS=--max-old-space-size=<MB>` and find the smallest heap that passes, against the same run of
// an empty test (the measured figures are in `FETCH_MAX_KIB`'s comment).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FETCH_MAX_KIB } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { webFetchTool } from "../src/extensions/web/fetch.ts";
import { DEFAULT_WEB_LIMITS } from "../src/extensions/web/limits.ts";
import { ANSWER_MAX_BYTES, webSearchTool } from "../src/extensions/web/search.ts";
import type { WebTransport } from "../src/extensions/web/net.ts";

const CHUNK = 64 * 1024;

/** One 64 KiB chunk of two-byte HTML, padded with spaces. */
const chunkOf = (): Uint8Array => {
  const encoder = new TextEncoder();
  const blocks: Array<string> = [];
  let bytes = 0;
  for (let at = 0; bytes < CHUNK - 400; at++) {
    const block = `<div class="c${at % 7}"><h2>Section ${at} — é ✓</h2><p>Some <b>bold</b> text, <a href="https://example.com/p/${at}">link ${at}</a>.</p></div>\n`;
    blocks.push(block);
    bytes += encoder.encode(block).byteLength;
  }
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  chunk.set(encoder.encode(blocks.join("")));
  return chunk;
};

/** An HTML page of exactly `bytes` bytes, streamed as fresh copies of one chunk (so each is held, as a real body's are). */
const pageOf = (bytes: number): WebTransport => {
  const chunk = chunkOf();
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
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= bytes) return controller.close();
            const size = Math.min(CHUNK, bytes - sent);
            sent += size;
            controller.enqueue(chunk.slice(0, size));
          },
        }),
        { headers: { "content-type": "text/html" } },
      ),
    );
  };
};

const fetchPage = async (bytes: number) => {
  const tool = webFetchTool(pageOf(bytes));
  // SAFETY: web_fetch reads only its arguments and the context's abort signal, never `api`.
  const result = await tool.execute({ url: "https://example.com/" } as never, {} as never, BACKGROUND_CONTEXT);
  return (result.structuredOutput as { content: string }).content;
};

/**
 * A Messages answer of exactly `bytes` bytes: one search's results (each a distinct page with encrypted content and a
 * two-byte title), then a summary, streamed 64 KiB of results at a time.
 */
const answerOf = (bytes: number): WebTransport => {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"content":[{"type":"web_search_tool_result","tool_use_id":"s","content":[');
  const suffix = encoder.encode(']},{"type":"text","text":"A summary — é ✓."}]}');
  const result = (at: number) =>
    `{"type":"web_search_result","url":"https://example.com/p/${at}","title":"Page ${at} — é ✓","encrypted_content":"${"A".repeat(2_000)}"}`;
  return () => {
    let sent = 0;
    let at = 0;
    const body = bytes - prefix.byteLength - suffix.byteLength;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at === 0 && sent === 0) {
              controller.enqueue(prefix.slice());
              let text = result(at++);
              while (text.length < CHUNK) text += `,${result(at++)}`;
              const first = encoder.encode(text);
              sent += first.byteLength;
              return controller.enqueue(first);
            }
            if (sent >= body) {
              controller.enqueue(suffix.slice());
              return controller.close();
            }
            let text = "";
            while (text.length < CHUNK && sent + encoder.encode(text).byteLength + 2_200 < body)
              text += `,${result(at++)}`;
            // What is left too small for a result is JSON whitespace.
            const chunk = text === "" ? new Uint8Array(body - sent).fill(0x20) : encoder.encode(text);
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
};

describe("web_fetch's memory bounds (SPI-1321)", () => {
  it("converts a body of FETCH_MAX_KIB", async () => {
    expect(await fetchPage(FETCH_MAX_KIB * 1024)).toMatch(/^## Section 0 — é ✓/);
  });

  it("reads a search answer of ANSWER_MAX_BYTES", async () => {
    const endpoint = {
      resolve: async () => ({ baseUrl: "https://llm.example", headers: {}, apiKey: "k", slug: "e/m", modelId: "m" }),
    };
    const tool = webSearchTool(answerOf(ANSWER_MAX_BYTES), endpoint, { ...DEFAULT_WEB_LIMITS, searchesPerCall: 50 });
    // SAFETY: web_search reads only its arguments and the context's abort signal, never `api`.
    const result = await tool.execute({ query: "q" } as never, {} as never, BACKGROUND_CONTEXT);
    expect((result.structuredOutput as { results: Array<unknown> }).results).toHaveLength(8);
  });
});
