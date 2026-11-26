// G11's Container previews (ADR-0031): what a preview browser's page gets from the Workspace DO for
// `http://<port>.t3flare.internal/`, over a fake Container port. The carried sockets' streams need workerd's WebSocket
// and are checked on the stage (`scripts/previews.ts`) and in `containerPreview.workerd.test.ts`; their refusals are
// checked here, and the page's script on Node's DOM globals.
// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { closeReason, ContainerPreview, type ContainerPreviewDeps } from "../src/workspace/containerPreview.ts";
import { CONTAINER_PREVIEW_HEADER, CONTAINER_PREVIEW_SCRIPT } from "../src/workspace/containerPreviewScript.ts";

const harness = (options: { running?: boolean; answer?: (request: Request) => Response | Promise<Response> } = {}) => {
  const seen: Array<{
    port: number;
    url: string;
    host: string | null;
    forwarded: string | null;
    cookie: string | null;
  }> = [];
  let used = 0;
  const deps: ContainerPreviewDeps = {
    running: () => options.running ?? true,
    port: (port) =>
      ({
        fetch: async (input: string, init?: RequestInit) => {
          const request = new Request(input, init);
          seen.push({
            port,
            url: request.url,
            host: request.headers.get("host"),
            forwarded: request.headers.get("x-forwarded-host"),
            cookie: request.headers.get("cookie"),
          });
          return (
            options.answer ??
            (() =>
              new Response("<html><head><title>app</title></head><body>hi</body></html>", {
                headers: { "content-type": "text/html" },
              }))
          )(request);
        },
      }) as unknown as Fetcher,
    used: async () => {
      used++;
    },
    hold: () => () => undefined,
    newId: () => "a".repeat(64),
    keepAliveMs: () => 15_000,
    warn: () => undefined,
  };
  return { preview: new ContainerPreview(deps), seen, used: () => used };
};

const at = (path: string, init?: RequestInit) => new Request(`http://5173.t3flare.internal${path}`, init);

describe("a Container preview", () => {
  it("answers an HTML page from the Container's port as `localhost`, with the socket script first in its head", async () => {
    const run = harness();
    const response = await run.preview.serve(
      at("/app?x=1", { headers: { cookie: "session=1", host: "evil.example", "x-forwarded-host": "ws-b" } }),
      5173,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain("__t3flareContainerPreview");
    expect(run.seen).toEqual([
      {
        port: 5173,
        url: "http://localhost:5173/app?x=1",
        host: "localhost:5173",
        forwarded: "5173.t3flare.internal",
        cookie: "session=1",
      },
    ]);
    expect(run.used()).toBe(1);
  });

  it("points a redirect to the dev server itself back at the preview host, and leaves other redirects", async () => {
    const run = harness({
      answer: (request) =>
        new Response(null, {
          status: 302,
          headers: { location: request.url.endsWith("/a") ? "http://localhost:5173/b?c=1" : "https://example.com/" },
        }),
    });
    expect((await run.preview.serve(at("/a"), 5173)).headers.get("location")).toBe(
      "http://5173.t3flare.internal/b?c=1",
    );
    expect((await run.preview.serve(at("/z"), 5173)).headers.get("location")).toBe("https://example.com/");
  });

  it("links the script as a file for a page with a CSP, and serves it", async () => {
    const run = harness({
      answer: () =>
        new Response("<html><head></head></html>", {
          headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'" },
        }),
    });
    expect(await (await run.preview.serve(at("/"), 5173)).text()).toContain(
      '<script src="/__t3flare/ws/shim.js"></script>',
    );
    const shim = await run.preview.serve(at("/__t3flare/ws/shim.js"), 5173);
    expect(shim.headers.get("content-type")).toContain("javascript");
    expect(await shim.text()).toContain("CarriedSocket");
  });

  it("never starts a stopped Container, and is not use then", async () => {
    const run = harness({ running: false });
    const response = await run.preview.serve(at("/"), 5173);
    expect(response.status).toBe(503);
    expect(run.seen).toEqual([]);
    expect(run.used()).toBe(0);
  });

  it("never serves t3flare's own ports, each refused by name with what it is for, asking nothing of the Container", async () => {
    const run = harness();
    const computerd = await run.preview.serve(new Request("http://8080.t3flare.internal/"), 8080);
    expect(computerd.status).toBe(404);
    expect(await computerd.text()).toContain(
      "Port 8080 is reserved by t3flare for computerd, its server that runs the Container's commands and serves its files.",
    );
    const bridge = await run.preview.serve(new Request("http://17781.t3flare.internal/"), 17_781);
    expect(bridge.status).toBe(404);
    expect(await bridge.text()).toContain(
      "Port 17781 is reserved by t3flare for the MCP bridge, its server for stdio MCP servers.",
    );
    expect(run.seen).toEqual([]);
  });

  it("serves any other port (SPI-1390: the browser's routes decide which ports it reaches)", async () => {
    const run = harness();
    expect((await run.preview.serve(new Request("http://9999.t3flare.internal/"), 9999)).status).not.toBe(404);
    expect(run.seen).not.toEqual([]);
  });

  it("says to listen on 0.0.0.0 when nothing answers", async () => {
    const run = harness({ answer: () => Promise.reject(new Error("connection refused")) });
    const response = await run.preview.serve(at("/"), 5173);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("0.0.0.0");
  });

  it("refuses the socket endpoints without the header, from another origin, or for an id it never gave", async () => {
    const run = harness();
    expect((await run.preview.serve(at("/__t3flare/ws/send?id=x", { method: "POST", body: "hi" }), 5173)).status).toBe(
      403,
    );
    expect(
      (
        await run.preview.serve(
          at("/__t3flare/ws/send?id=x", {
            method: "POST",
            body: "hi",
            headers: { [CONTAINER_PREVIEW_HEADER]: "1", origin: "https://evil.example" },
          }),
          5173,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await run.preview.serve(
          at("/__t3flare/ws/send?id=x", {
            method: "POST",
            body: "hi",
            headers: { [CONTAINER_PREVIEW_HEADER]: "1", origin: "http://5173.t3flare.internal" },
          }),
          5173,
        )
      ).status,
    ).toBe(404);
    expect(run.seen).toEqual([]);
  });
});

/** A browser's WebSocket, as a page uses one: the Workers type has no `on*` handlers. */
type PageSocket = WebSocket & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
};

/**
 * The script run as a page runs it, on Node's DOM globals, with a fake `fetch`: `open` answers a stream of events the
 * test writes, and each POST is recorded with its body's bytes as they were when it was sent.
 */
const scriptPage = () => {
  const events = new TransformStream<Uint8Array, Uint8Array>();
  const writer = events.writable.getWriter();
  const posts: Array<{ path: string; body: Uint8Array | string }> = [];
  const window: Record<string, unknown> = {
    WebSocket: class NativeWebSocket {},
    fetch: async (path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(events.readable);
      const body = init.body;
      posts.push({
        path,
        body:
          typeof body === "string"
            ? body
            : body instanceof ArrayBuffer
              ? new Uint8Array(body.slice(0))
              : ArrayBuffer.isView(body)
                ? new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
                : new Uint8Array(await new Response(body).arrayBuffer()),
      });
      return new Response(null, { status: 204 });
    },
  };
  const run = vm.runInThisContext(`(function (window, location) {${CONTAINER_PREVIEW_SCRIPT}})`) as (
    window: Record<string, unknown>,
    location: URL,
  ) => void;
  run(window, new URL("http://6080.t3flare.internal/vnc.html"));
  const socket = new (window.WebSocket as new (url: string) => PageSocket)("ws://6080.t3flare.internal/websockify");
  const event = (type: string, data: unknown) =>
    writer.write(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  const opened = new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  return { socket, posts, event, opened, settle: () => new Promise((resolve) => setTimeout(resolve, 10)) };
};

describe("the carried-socket script's socket", () => {
  it("has every property noVNC 1.7 checks a raw channel for (`core/websock.js`, `attach`)", () => {
    const { socket } = scriptPage();
    // noVNC's `rawChannelProps`, and where its `attach` looks for them.
    const rawChannelProps = ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"];
    const channelProps = [...Object.keys(socket), ...Object.getOwnPropertyNames(Object.getPrototypeOf(socket))];
    expect(rawChannelProps.filter((prop) => !channelProps.includes(prop))).toEqual([]);
  });

  it("calls its `on*` handlers, one per type, the last set winning", async () => {
    const page = scriptPage();
    const seen: string[] = [];
    page.socket.onopen = () => seen.push("first");
    page.socket.onopen = () => seen.push("open");
    page.socket.onmessage = (message) => seen.push(`message ${String(message.data)}`);
    await page.event("open", { id: "x", protocol: "binary" });
    await page.opened;
    await page.event("message", { text: "hi" });
    await page.settle();
    expect(seen).toEqual(["open", "message hi"]);
    expect(page.socket.protocol).toBe("binary");
  });

  it("delivers a binary message's bytes as an ArrayBuffer when asked to", async () => {
    const page = scriptPage();
    page.socket.binaryType = "arraybuffer";
    const received: unknown[] = [];
    page.socket.onmessage = (message) => received.push(message.data);
    await page.event("open", { id: "x", protocol: "" });
    await page.event("message", { binary: btoa("RFB 003.008\n") });
    await page.settle();
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0] as ArrayBuffer)).toBe("RFB 003.008\n");
  });

  it("sends a buffer's bytes as they were at `send`, though the caller reuses it before the POST", async () => {
    const page = scriptPage();
    await page.event("open", { id: "x", protocol: "" });
    await page.opened;
    const buffer = new Uint8Array([1, 2, 3, 4]);
    page.socket.send(buffer.subarray(1, 3));
    buffer.fill(9);
    const whole = new Uint8Array([5, 6]);
    page.socket.send(whole.buffer);
    whole.fill(0);
    page.socket.send("text");
    await page.settle();
    expect(page.posts.map((post) => post.body)).toEqual([new Uint8Array([2, 3]), new Uint8Array([5, 6]), "text"]);
    expect(page.posts.map((post) => post.path)).toEqual([
      "/__t3flare/ws/send?id=x&binary=1",
      "/__t3flare/ws/send?id=x&binary=1",
      "/__t3flare/ws/send?id=x",
    ]);
  });
});

describe("a carried WebSocket's close reason", () => {
  it("is whole up to the 123 bytes a close frame holds, and cut there on a character", () => {
    expect(closeReason("bye")).toBe("bye");
    expect(closeReason("a".repeat(123))).toBe("a".repeat(123));
    expect(closeReason("a".repeat(200))).toBe("a".repeat(123));
    const cut = closeReason(`${"a".repeat(122)}é and more`);
    expect(cut).toBe("a".repeat(122));
    expect(new TextEncoder().encode(closeReason("é".repeat(100))).length).toBe(122);
  });
});
