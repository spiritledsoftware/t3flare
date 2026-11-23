// The web tools (SPI-1054) over a fake network: `web_fetch` through the SSRF guard (the cases that matter here), and
// `web_search` through an endpoint's search-capable model (an Anthropic Messages answer with `web_search_tool_result`
// blocks, as Commissary returns it for Claude and for Codex upstreams).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { webExtension } from "../../src/extensions/web.ts";
import { UNCONVERTED_NOTE, webFetchTool } from "../../src/extensions/web/fetch.ts";
import { DEFAULT_WEB_LIMITS, type WebLimits } from "../../src/extensions/web/limits.ts";
import { STRUCTURED_MAX_BYTES } from "../../src/extensions/web/output.ts";
import type { WebRequest, WebTransport } from "../../src/extensions/web/net.ts";
import {
  ANSWER_MAX_BYTES,
  readAnswer,
  systemPrompt,
  webSearchTool,
} from "../../src/extensions/web/search.ts";

const PUBLIC = "93.184.215.14";

/** A network: DoH answers from `dns` (public by default), every other request from `pages`. */
const network = (pages: (request: WebRequest) => Response, dns: Record<string, string> = {}) => {
  const sent: Array<WebRequest> = [];
  const transport: WebTransport = (request) => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type");
      const address = dns[name] ?? PUBLIC;
      const v6 = address.includes(":");
      const answer = (type === "AAAA") === v6 ? [{ type: v6 ? 28 : 1, data: address }] : [];
      return Promise.resolve(Response.json({ Status: 0, Answer: answer }));
    }
    sent.push(request);
    return Promise.resolve(pages(request));
  };
  return { transport, sent };
};

const run = async (tool: ToolRegistration, args: Record<string, unknown>) => {
  try {
    return { ok: true as const, result: await tool.execute(args as never, {} as never, BACKGROUND_CONTEXT) };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message };
  }
};

/** The registry's defaults with `overrides`. */
const limits = (overrides: Partial<WebLimits>): WebLimits => ({ ...DEFAULT_WEB_LIMITS, ...overrides });

/** A JSON Schema property of a tool's parameters. */
const parameter = (tool: ToolRegistration, name: string) =>
  (tool.parameters as { properties: Record<string, { maximum?: number; description?: string }> }).properties[name];

/** A network whose page never answers until its request is aborted. */
const hanging = (): WebTransport => (request, signal) => {
  const url = new URL(request.url);
  if (url.hostname === "cloudflare-dns.com")
    return Promise.resolve(
      Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: PUBLIC }] : [] }),
    );
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
};

const textOf = (outcome: Awaited<ReturnType<typeof run>>) =>
  outcome.ok
    ? (outcome.result.output ?? []).map((block) => ("text" in block ? block.text : "")).join("")
    : outcome.error;

describe("web_fetch", () => {
  it("fetches a page as Markdown with its title and URL in details", async () => {
    const { transport, sent } = network(
      () =>
        new Response("<html><head><title>Example</title></head><body><h1>Hello</h1><p>World</p></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const outcome = await run(webFetchTool(transport), { url: "https://example.com/a" });
    expect(textOf(outcome)).toContain("Hello");
    expect(sent[0]?.headers.accept).toContain("text/markdown");
    expect(outcome.ok && outcome.result.details).toMatchObject({ url: "https://example.com/a", format: "markdown" });
  });

  it("refuses a private address, a name that resolves to one, and a redirect to the metadata service", async () => {
    const { transport, sent } = network(
      (request) =>
        request.url.startsWith("https://public.example")
          ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })
          : new Response("no"),
      { "inside.example": "10.0.0.5" },
    );
    const tool = webFetchTool(transport);
    expect(textOf(await run(tool, { url: "http://127.0.0.1/" }))).toMatch(/Unable to fetch .*blocked: loopback/);
    expect(textOf(await run(tool, { url: "https://inside.example/" }))).toMatch(
      /blocked: host resolves to a private address/,
    );
    expect(textOf(await run(tool, { url: "https://public.example/" }))).toMatch(
      /redirect blocked: cloud metadata address/,
    );
    expect(sent.map((request) => request.url)).toEqual(["https://public.example/"]);
  });

  it("names a failing status by its standard phrase, and refuses a body over 5 MiB", async () => {
    const { transport } = network((request) =>
      request.url.endsWith("/missing")
        ? new Response("server text", { status: 404 })
        : new Response("x", { headers: { "content-length": String(6 * 1024 * 1024) } }),
    );
    const tool = webFetchTool(transport);
    expect(textOf(await run(tool, { url: "https://example.com/missing" }))).toBe(
      "Unable to fetch https://example.com/missing: HTTP 404 Not Found",
    );
    expect(textOf(await run(tool, { url: "https://example.com/big" }))).toMatch(/exceeds the 5 MiB limit/);
  });

  it("refuses a body over fetchMaxKiB (SPI-1321)", async () => {
    const { transport } = network(
      () => new Response("x".repeat(64 * 1024 + 1), { headers: { "content-type": "text/plain" } }),
    );
    expect(
      textOf(await run(webFetchTool(transport, limits({ fetchMaxKiB: 64 })), { url: "https://example.com/" })),
    ).toBe("Unable to fetch https://example.com/: response body exceeds the 64 KiB limit");
    const small = network(() => new Response("x".repeat(64 * 1024), { headers: { "content-type": "text/plain" } }));
    expect(
      await run(webFetchTool(small.transport, limits({ fetchMaxKiB: 64 })), { url: "https://example.com/" }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("returns an HTML body over 5 MiB as it came, with a note, and still converts one at 5 MiB (SPI-1321)", async () => {
    const page = (bytes: number) => {
      const head = "<html><body><h1>Big</h1><p>";
      return `${head}${"x".repeat(bytes - head.length)}`;
    };
    const big = network(() => new Response(page(5 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } }));
    const raw = await run(webFetchTool(big.transport, limits({ fetchMaxKiB: 8192 })), { url: "https://example.com/" });
    expect(textOf(raw)).toMatch(
      /^\[The response is over 5 MiB, so it is returned as it came, without conversion\.\]\n/,
    );
    expect(raw.ok && (raw.result.structuredOutput as { content: string }).content).toMatch(
      new RegExp(`^${RegExp.escape(UNCONVERTED_NOTE)}\n<html><body><h1>Big`),
    );
    const fits = network(() => new Response(page(5 * 1024 * 1024), { headers: { "content-type": "text/html" } }));
    const converted = await run(webFetchTool(fits.transport), { url: "https://example.com/" });
    expect(textOf(converted)).toMatch(/^# Big/);
  });

  it("offers a per-call timeout up to the larger of the maximum and the default, and uses the default with none (SPI-1321)", async () => {
    expect(parameter(webFetchTool(hanging()), "timeout")).toMatchObject({
      maximum: 120,
      description: "Total timeout in seconds (default: 30, maximum: 120)",
    });
    const tool = webFetchTool(hanging(), limits({ fetchTimeoutSeconds: 2, fetchMaxTimeoutSeconds: 1 }));
    expect(parameter(tool, "timeout")).toMatchObject({
      maximum: 2,
      description: "Total timeout in seconds (default: 2, maximum: 2)",
    });
    expect(textOf(await run(tool, { url: "https://example.com/" }))).toBe(
      "Unable to fetch https://example.com/: timed out after 2 seconds",
    );
  });

  it("retries a Cloudflare challenge once with the honest user agent", async () => {
    const { transport, sent } = network((request) =>
      request.headers["user-agent"] === "t3flare-web-tools"
        ? new Response("plain text", { headers: { "content-type": "text/plain" } })
        : new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    expect(textOf(await run(webFetchTool(transport), { url: "https://example.com/" }))).toBe("plain text");
    expect(sent).toHaveLength(2);
  });

  it("pages by lines and tells programs where to continue", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const { transport } = network(() => new Response(lines, { headers: { "content-type": "text/plain" } }));
    const outcome = await run(webFetchTool(transport), { url: "https://example.com/", offset: 3, limit: 2 });
    expect(outcome.ok && outcome.result.structuredOutput).toMatchObject({
      content: "line 3\nline 4",
      total_lines: 10,
      next_offset: 5,
    });
  });
});

/** An Anthropic Messages answer with one search and a cited summary, as the proxy returns it. */
const answer = {
  content: [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "pi durable" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        {
          type: "web_search_result",
          url: "https://a.example/one",
          title: "One",
          page_age: "2 days ago",
          encrypted_content: "x",
        },
        { type: "web_search_result", url: "https://b.example/two", title: "Two", encrypted_content: "y" },
      ],
    },
    {
      type: "text",
      text: "Pi Durable runs agents ",
      citations: [
        {
          type: "web_search_result_location",
          url: "https://a.example/one",
          title: "One",
          cited_text: "agents on Durable Objects",
        },
      ],
    },
    { type: "text", text: "on Cloudflare." },
  ],
  usage: { input_tokens: 1200, output_tokens: 80, server_tool_use: { web_search_requests: 1 } },
};

describe("web_search", () => {
  // SPI-1176: an Anthropic Messages Model endpoint's model, its key and headers resolved at each search.
  const endpoint = {
    resolve: async () => ({
      baseUrl: "https://llm.example/",
      headers: { "x-gateway": "team" },
      apiKey: "sk-secret-key",
      slug: "comm/claude-haiku-5-5",
      modelId: "claude-haiku-5-5",
    }),
  };

  it("asks the endpoint's model with the web search server tool, and returns the pages and the cited summary", async () => {
    const { transport, sent } = network(() => Response.json(answer));
    const outcome = await run(webSearchTool(transport, endpoint), { query: "pi durable" });
    const request = sent[0]!;
    expect(request.url).toBe("https://llm.example/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-secret-key");
    expect(request.headers["x-gateway"]).toBe("team");
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      model: "claude-haiku-5-5",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    const text = textOf(outcome);
    expect(text).toContain(
      "Title: One\nURL: https://a.example/one\nPublished: 2 days ago\nText: agents on Durable Objects",
    );
    expect(text).toContain("Title: Two\nURL: https://b.example/two");
    expect(text).toContain("Pi Durable runs agents on Cloudflare.");
    expect(outcome.ok && outcome.result.details).toMatchObject({
      provider: "model-endpoint:comm/claude-haiku-5-5",
      query: "pi durable",
      results: [{ url: "https://a.example/one", title: "One" }, { url: "https://b.example/two" }],
    });
    expect(outcome.ok && outcome.result.usage).toMatchObject({ input: 1200, output: 80 });
  });

  it("trims to numResults and reports no results", async () => {
    const { transport } = network(() => Response.json(answer));
    const outcome = await run(webSearchTool(transport, endpoint), { query: "pi durable", numResults: 1 });
    expect(textOf(outcome)).toContain("Title: One");
    expect(textOf(outcome)).not.toContain("Title: Two");
    expect(outcome.ok && outcome.result.details).toMatchObject({ results: [{ url: "https://a.example/one" }] });
    expect(outcome.ok && (outcome.result.details as { results: Array<unknown> }).results).toHaveLength(1);
    expect(readAnswer({ content: [] }, (text) => text)).toEqual({ results: [], summary: "" });
  });

  it("reports a failed search, and an endpoint's error without the key", async () => {
    const failed = network(() =>
      Response.json({
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "s",
            content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
          },
        ],
      }),
    );
    expect(textOf(await run(webSearchTool(failed.transport, endpoint), { query: "q" }))).toBe(
      "Unable to search the web for q: the search failed (too_many_requests)",
    );
    const refused = network(() =>
      Response.json(
        { type: "error", error: { type: "permission_error", message: "key sk-secret-key has no models" } },
        { status: 403 },
      ),
    );
    const text = textOf(await run(webSearchTool(refused.transport, endpoint), { query: "q" }));
    expect(text).toBe("Unable to search the web for q: HTTP 403 Forbidden: key [REDACTED] has no models");
  });

  it("says why when no endpoint can search, and sends nothing", async () => {
    const { transport, sent } = network(() => Response.json(answer));
    const none = {
      resolve: async () => ({
        error: "no Anthropic Messages Model endpoint with an API key or no auth lists a model to search with",
      }),
    };
    expect(textOf(await run(webSearchTool(transport, none), { query: "q" }))).toBe(
      "Unable to search the web for q: no Anthropic Messages Model endpoint with an API key or no auth lists a model to search with",
    );
    expect(sent).toEqual([]);
  });

  it("asks with the settings' searches and summary tokens, and returns searchResults by default (SPI-1321)", async () => {
    const { transport, sent } = network(() => Response.json(answer));
    const tool = webSearchTool(
      transport,
      endpoint,
      limits({ searchesPerCall: 1, searchSummaryTokens: 300, searchResults: 1 }),
    );
    const outcome = await run(tool, { query: "pi durable" });
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
      max_tokens: 300,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    });
    expect(outcome.ok && (outcome.result.details as { results: Array<unknown> }).results).toHaveLength(1);
  });

  it("reads any answer within the isolate's bound, whatever the settings (SPI-1361)", async () => {
    // An answer of 1 MiB, refused at the defaults before SPI-1361, is read.
    const big = {
      ...answer,
      content: [...answer.content, { type: "text", text: " ".repeat(1024 * 1024) }],
    };
    const { transport } = network(() => Response.json(big));
    expect(textOf(await run(webSearchTool(transport, endpoint), { query: "q" }))).toContain("Title: One");
    // Past the isolate's bound it is refused.
    const huge = {
      ...answer,
      content: [...answer.content, { type: "text", text: " ".repeat(ANSWER_MAX_BYTES) }],
    };
    const refused = network(() => Response.json(huge));
    expect(textOf(await run(webSearchTool(refused.transport, endpoint), { query: "q" }))).toBe(
      `Unable to search the web for q: response body exceeds the ${ANSWER_MAX_BYTES / 1024 / 1024} MiB limit`,
    );
  });

  it("sends the whole query and keeps every cited snippet (SPI-1361)", async () => {
    const cited = Array.from({ length: 5 }, (_, index) => ({
      type: "web_search_result_location",
      url: "https://a.example/one",
      cited_text: `snippet ${index}`,
    }));
    const { transport, sent } = network(() =>
      Response.json({ ...answer, content: [...answer.content, { type: "text", text: "more", citations: cited }] }),
    );
    const query = "q".repeat(10_000);
    const outcome = await run(webSearchTool(transport, endpoint), { query });
    expect(JSON.parse(sent[0]?.body ?? "{}").messages[0].content).toBe(query);
    expect(textOf(outcome)).toContain("snippet 4");
  });

  it("tells the search model how many searches it may run (SPI-1321)", async () => {
    expect(systemPrompt(1)).toContain("(one search)");
    expect(systemPrompt(5)).toContain("(up to 5 searches; stop once the results answer the query)");
    const { transport, sent } = network(() => Response.json(answer));
    await run(webSearchTool(transport, endpoint, limits({ searchesPerCall: 5 })), { query: "q" });
    expect(JSON.parse(sent[0]?.body ?? "{}").system).toBe(systemPrompt(5));
  });

  it("puts no maximum on numResults or contextMaxCharacters (SPI-1361)", () => {
    const tool = webSearchTool(hanging(), endpoint);
    expect(parameter(tool, "numResults")).toMatchObject({ description: "Maximum number of results (default: 8)" });
    expect(parameter(tool, "numResults")?.maximum).toBeUndefined();
    expect(parameter(tool, "contextMaxCharacters")?.maximum).toBeUndefined();
    expect(parameter(tool, "contextMaxCharacters")?.description).not.toContain("50,000");
  });

  it("bounds a program's copy of the results text at the structured limit (SPI-1361)", async () => {
    const long = { ...answer, content: [...answer.content, { type: "text", text: "z".repeat(2 * STRUCTURED_MAX_BYTES) }] };
    const { transport } = network(() => Response.json(long));
    const outcome = await run(webSearchTool(transport, endpoint), {
      query: "q",
      contextMaxCharacters: 4 * STRUCTURED_MAX_BYTES,
    });
    const structured = outcome.ok ? (outcome.result.structuredOutput as { content: string; truncated?: boolean }) : undefined;
    expect(new TextEncoder().encode(structured?.content).length).toBeLessThanOrEqual(STRUCTURED_MAX_BYTES);
    expect(structured?.truncated).toBe(true);
  });

  it("times a search out at searchTimeoutSeconds (SPI-1321)", async () => {
    const tool = webSearchTool(hanging(), endpoint, limits({ searchTimeoutSeconds: 1 }));
    expect(textOf(await run(tool, { query: "q" }))).toBe("Unable to search the web for q: timed out after 1 second");
  });

  it("passes the extension's limits to both tools (SPI-1321)", () => {
    const tools =
      webExtension({ search: endpoint, limits: limits({ fetchTimeoutSeconds: 7, searchResults: 3 }) }).tools ?? [];
    expect(parameter(tools[0]!, "timeout")?.description).toContain("default: 7");
    expect(parameter(tools[1]!, "numResults")?.description).toContain("default: 3");
  });

  it("is offered only when the setting turns it on", () => {
    expect(webExtension().tools?.map((tool) => tool.name)).toEqual(["web_fetch"]);
    expect(webExtension({ search: endpoint }).tools?.map((tool) => tool.name)).toEqual(["web_fetch", "web_search"]);
  });
});
