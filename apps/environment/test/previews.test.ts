// G11 (previews, ADR-0031): the seams of the Cloud Environment's previews that run without Browser Run or a Container:
// where a `localhost` navigation goes, which listeners are listed and whose (review M7), the configured URLs stock takes
// (review M4), the Browser Run sessions and profiles kept in the Environment DO (reviews L4, M5), the acquire options
// (review L5), the HTML bridge (review M3), the stream route's socket (review H1), the Shadow's shape (U59) and its
// profile saves (SPI-1123).
import type { PortScan } from "@t3flare/sandbox-image/ports";
import { stopGroupArgv } from "@t3flare/sandbox-image/ports";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_PROFILE_SAVE_SECONDS, MAX_PREVIEW_PORTS } from "@t3flare/harness-registry";

import { containerPreviewPortOf } from "../src/preview/browserRun.ts";
import { acquireOptions } from "../src/preview/cdpSocket.ts";
import {
  BRIDGED_PAGE_ORIGIN,
  fromBrowser,
  HTML_BROWSER_EXECUTABLE,
  spawnHtmlBrowser,
  STOCK_PAGE_ORIGIN,
  toBrowser,
} from "../src/preview/htmlBrowser.ts";
import { type Lookups, normalizeConfiguredUrls, serversOf, threadWorkspaceFrom } from "../src/preview/portDiscovery.ts";
import {
  type PreviewNavigation,
  previewNavigation,
  previewRoutes,
  reachablePorts,
  relaunchMessage,
} from "../src/preview/previewRoutes.ts";
import { closeLeftoverSessions } from "../src/preview/sessions.ts";
import { previewStore, profileChunks } from "../src/preview/store.ts";
import { nodeSocketShim } from "../src/platform/httpServer.ts";
import * as Shadow from "../src/shadows/serverBrowserContexts.ts";
import * as Stock from "t3/src/preview/ServerBrowserContexts.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

describe("a preview browser opens any Container port but t3flare's own (SPI-1390)", () => {
  const browser = (routed: ReadonlyArray<number>, allowlist: ReadonlyArray<number> = []) => ({ routed, allowlist });
  const pageOf = (navigation: PreviewNavigation) => {
    if (navigation.kind !== "page") throw new Error(`not a page: ${navigation.kind}`);
    expect(navigation.url.startsWith("data:text/html")).toBe(true);
    return decodeURIComponent(navigation.url);
  };

  it("goes to a routed port's Container preview host, path and query kept, for each loopback name", () => {
    const routed = browser([3000, 4173, 5173, 8787, 9999]);
    expect(previewNavigation("http://localhost:5173/app?x=1#h", routed)).toEqual({
      kind: "go",
      url: "http://5173.t3flare.internal/app?x=1#h",
    });
    expect(previewNavigation("http://127.0.0.1:3000/", routed)).toEqual({
      kind: "go",
      url: "http://3000.t3flare.internal/",
    });
    expect(previewNavigation("https://[::1]:8787/api", routed)).toEqual({
      kind: "go",
      url: "http://8787.t3flare.internal/api",
    });
    expect(previewNavigation("http://0.0.0.0:4173", routed)).toEqual({
      kind: "go",
      url: "http://4173.t3flare.internal/",
    });
    // A dev server on an arbitrary port previews by default.
    expect(previewNavigation("http://localhost:9999/", routed)).toEqual({
      kind: "go",
      url: "http://9999.t3flare.internal/",
    });
  });

  it("restarts the browser with a port it does not route yet, which a refusal never names: any port is allowed", () => {
    expect(previewNavigation("http://localhost:9999/", browser([3000, 5173]))).toEqual({
      kind: "relaunch",
      port: 9999,
    });
    expect(previewNavigation("http://localhost:41234/x", browser([]))).toEqual({ kind: "relaunch", port: 41_234 });
    expect(previewNavigation("http://localhost/", browser([3000]))).toEqual({ kind: "relaunch", port: 80 });
    expect(relaunchMessage(9999)).toBe(
      "Port 9999 was not one of this Workspace's preview browser's ports: Browser Run fixes a browser's ports when it starts, at most 8. The preview browser restarted with port 9999 added, and its tabs closed. Open http://localhost:9999/ again.",
    );
  });

  it("refuses each of t3flare's reserved ports with a page that names it and what it is for, routed or not", () => {
    for (const routed of [[], [8080, 17_781]]) {
      expect(pageOf(previewNavigation("http://localhost:8080/", browser(routed)))).toContain(
        "Port 8080 is reserved by t3flare for computerd, its server that runs the Container's commands and serves its files.",
      );
      expect(pageOf(previewNavigation("http://127.0.0.1:17781/mcp", browser(routed)))).toContain(
        "Port 17781 is reserved by t3flare for the MCP bridge, its server for stdio MCP servers.",
      );
    }
  });

  it("keeps the Owner's opt-in list: a port off it gets a page naming the list and where it is set", () => {
    const listed = browser([4200, 8081], [4200, 8081]);
    expect(previewNavigation("http://localhost:4200/x", listed)).toEqual({
      kind: "go",
      url: "http://4200.t3flare.internal/x",
    });
    // ADR-0049 §4: and where on the Settings page the setting is.
    expect(pageOf(previewNavigation("http://localhost:5173/", listed))).toContain(
      "on ports 4200, 8081 (the Environment setting Container preview ports, under Environment › Advanced › Container preview ports)",
    );
    // A port the Owner added since the browser started: the browser restarts to route it.
    expect(previewNavigation("http://localhost:5173/", browser([4200], [4200, 5173]))).toEqual({
      kind: "relaunch",
      port: 5173,
    });
  });

  it("leaves every other URL as it is", () => {
    for (const url of ["https://example.com/", "http://5173.t3flare.internal/", "not a url", "file:///etc/hosts"])
      expect(previewNavigation(url, browser([5173]))).toEqual({ kind: "go", url });
  });

  it("routes, at most Browser Run's eight: the Owner's list alone, else the wanted port, the listeners, the last routes, then the usual ones", () => {
    expect(MAX_PREVIEW_PORTS).toBe(8);
    expect(previewRoutes({ allowlist: [4200, 8081], wanted: 9999, listening: [9998], previous: [] })).toEqual([
      4200, 8081,
    ]);
    expect(previewRoutes({ allowlist: [], wanted: undefined, listening: [], previous: [] })).toEqual([
      3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787,
    ]);
    expect(previewRoutes({ allowlist: [], wanted: 9999, listening: [9998, 3000], previous: [41_000] })).toEqual([
      9999, 9998, 3000, 41_000, 3001, 4173, 4321, 5173,
    ]);
    // Never a reserved port, and never past eight however many listen.
    const many = Array.from({ length: 12 }, (_, index) => 10_000 + index);
    expect(previewRoutes({ allowlist: [], wanted: 8080, listening: [17_781, ...many], previous: [] })).toEqual(
      many.slice(0, 8),
    );
  });

  it("takes from a Container's scan the ports a preview can reach: not loopback-only, not t3flare's own", () => {
    const listener = (port: number, host: string, pid = 100) => ({
      port,
      host,
      pid,
      pgid: pid,
      comm: "node",
      exec: null,
      thread: null,
    });
    const scan: PortScan = {
      computerd: 7,
      listeners: [
        listener(5173, "0.0.0.0"),
        listener(9999, "0:0:0:0:0:0:0:0"),
        listener(9998, "127.0.0.1"),
        listener(9997, "0:0:0:0:0:0:0:1"),
        listener(9996, "0:0:0:0:0:ffff:7f00:1"),
        listener(8080, "0.0.0.0", 7),
        listener(17_781, "0.0.0.0"),
        listener(5173, "0:0:0:0:0:0:0:0"),
        listener(3000, "10.0.0.2"),
      ],
      table: [],
    };
    expect(reachablePorts(scan)).toEqual([3000, 5173, 9999]);
  });

  it("the preview entrypoint takes any port but t3flare's own: the browser's routes decide which it reaches", () => {
    expect(containerPreviewPortOf(new URL("http://4200.t3flare.internal/"))).toBe(4200);
    expect(containerPreviewPortOf(new URL("http://8080.t3flare.internal/"))).toBeUndefined();
    expect(containerPreviewPortOf(new URL("http://17781.t3flare.internal/"))).toBeUndefined();
    expect(containerPreviewPortOf(new URL("http://99999.t3flare.internal/"))).toBeUndefined();
    expect(containerPreviewPortOf(new URL("https://4200.t3flare.internal/"))).toBeUndefined();
  });
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const scan = (listeners: PortScan["listeners"], computerd: number | null = 7): PortScan => ({
  computerd,
  listeners,
  table: [],
});
const listener = (over: Partial<PortScan["listeners"][number]>): PortScan["listeners"][number] => ({
  port: 5173,
  host: "0.0.0.0",
  pid: 100,
  pgid: 100,
  comm: "node",
  exec: null,
  thread: null,
  ...over,
});

const LOOKUPS: Lookups = {
  terminal: (key) =>
    ({
      "term-a": { workspace: "ws-a", owner: { threadId: "thread-a", terminalId: "default" } },
      "term-b": { workspace: "ws-b", owner: { threadId: "thread-b", terminalId: "default" } },
      "term-unnamed": { workspace: "ws-a", owner: undefined },
    })[key],
  process: (key) =>
    ({
      "proc-a": { workspace: "ws-a", thread: "thread-a" },
      "proc-b": { workspace: "ws-b", thread: "thread-b" },
    })[key],
  threadWorkspace: (thread) => ({ "thread-a": "ws-a", "thread-b": "ws-b" })[thread],
};

describe("port discovery from a Container's scan (C1, review M7)", () => {
  it("lists a terminal's server as the terminal's, and an agent's (CLI key or thread variable) as the agent's", () => {
    const servers = serversOf(
      "ws-a",
      scan([
        listener({ port: 5173, exec: "term-a" }),
        listener({ port: 3000, pid: 101, exec: "proc-a" }),
        listener({ port: 8000, pid: 102, exec: "exec-9", thread: "thread-a" }),
      ]),
      LOOKUPS,
    );
    expect(servers).toEqual([
      {
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000",
        processName: "node",
        pid: 101,
        terminal: null,
        agent: { threadId: "thread-a" },
      },
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 100,
        terminal: { threadId: "thread-a", terminalId: "default" },
        agent: null,
      },
      {
        host: "localhost",
        port: 8000,
        url: "http://localhost:8000",
        processName: "node",
        pid: 102,
        terminal: null,
        agent: { threadId: "thread-a" },
      },
    ]);
  });

  it("leaves out what stock leaves out: an unattributed server, computerd and its port", () => {
    const servers = serversOf(
      "ws-a",
      scan([
        listener({ exec: null }),
        listener({ port: 8080, pid: 7, comm: "computerd" }),
        listener({ port: 9000, pid: 7, exec: "term-a" }),
      ]),
      LOOKUPS,
    );
    expect(servers).toEqual([]);
  });

  it("ignores a marker that names another Workspace's terminal, process or thread (review M7)", () => {
    const servers = serversOf(
      "ws-a",
      scan([
        listener({ port: 3000, exec: "term-b" }),
        listener({ port: 3001, exec: "proc-b" }),
        listener({ port: 4173, exec: "exec-1", thread: "thread-b" }),
        listener({ port: 4321, exec: "exec-2", thread: "no-such-thread" }),
        listener({ port: 5174, exec: "term-unnamed" }),
      ]),
      LOOKUPS,
    );
    expect(servers).toEqual([]);
  });

  it("keeps a hostile process name as data, clipped", () => {
    const [server] = serversOf(
      "ws-a",
      scan([listener({ exec: "term-a", comm: `"><img src=x>\n${"y".repeat(100)}` })]),
      LOOKUPS,
    );
    expect(server?.processName).toBe(`"><img src=x>\n${"y".repeat(100)}`.trim().slice(0, 64));
  });

  it("refuses to signal group 1 or a malformed group", () => {
    expect(stopGroupArgv(1, [1], 3000)).toEqual([]);
    expect(stopGroupArgv(0, [], 3000)).toEqual([]);
    expect(stopGroupArgv(1.5, [], 3000)).toEqual([]);
    expect(stopGroupArgv(42, [42, -1, 43], 3000).slice(3)).toEqual(["t3flare-stop", "42", "30", "42", "43"]);
    // SPI-1364: the grace is the Owner's, looked at every 100 ms; 0 kills at once.
    expect(stopGroupArgv(42, [42], 10_000)[5]).toBe("100");
    expect(stopGroupArgv(42, [42], 0)[5]).toBe("0");
  });
});

describe("configured preview URLs (review M4)", () => {
  it("are taken only on loopback, as stock takes them: nothing else is ever probed", () => {
    expect(
      normalizeConfiguredUrls([
        "http://localhost:5173/",
        "http://0.0.0.0:3000/x",
        "https://example.com/",
        "http://169.254.169.254/",
        "http://10.0.0.1/",
        "file:///etc/passwd",
        "nonsense",
      ]),
    ).toEqual(["http://localhost:5173/", "http://localhost:3000/x"]);
  });
});

describe("a thread's Workspace, from t3's projection", () => {
  it("is its worktree's, else its project's, and none for a deleted thread or an unreadable table", () => {
    const sql = nodeSqlStorage();
    sql.exec("CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)");
    sql.exec(
      "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)",
    );
    sql.exec("INSERT INTO projection_projects VALUES ('p', '/w/demo')");
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'p', '{}', NULL)");
    sql.exec(
      `INSERT INTO orchestration_v2_projection_threads VALUES ('t2', 'p', '{"worktreePath":"/w/.wt/demo/feature"}', NULL)`,
    );
    sql.exec("INSERT INTO orchestration_v2_projection_threads VALUES ('t3', 'p', '{}', '2026-01-01')");
    const of = threadWorkspaceFrom(sql);
    expect(of("t1")).toBe("demo");
    expect(of("t2")).toBe(".wt/demo/feature");
    expect(of("t3")).toBeUndefined();
    expect(threadWorkspaceFrom(nodeSqlStorage())("t1")).toBeUndefined();
  });
});

describe("the Environment's Browser Run records (reviews L4, M5)", () => {
  it("keeps the sessions it acquired, and a new instance closes them all", async () => {
    const store = previewStore(nodeSqlStorage());
    store.sessionOpened({ id: "s1", kind: "workspace", workspace: "demo", openedAt: 1 });
    store.sessionOpened({ id: "s2", kind: "html", workspace: null, openedAt: 2 });
    const closed: Array<string> = [];
    expect(
      await closeLeftoverSessions(
        { closeSession: async (id: string) => (closed.push(id), { status: "closed" }) } as never,
        store,
      ),
    ).toBe(2);
    expect(closed).toEqual(["s1", "s2"]);
    expect(store.sessions()).toEqual([]);
  });

  it("keeps a profile's state across rows without splitting a character, of any size (SPI-1365: no 8 MiB cap)", () => {
    const store = previewStore(nodeSqlStorage());
    const big = `${"a".repeat(512 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
    expect(profileChunks(big).every((chunk) => chunk.length <= 512 * 1024)).toBe(true);
    expect(profileChunks(big).join("")).toBe(big);
    store.saveProfile("default", big);
    expect(store.profile("default")).toBe(big);
    const larger = "x".repeat(9 * 1024 * 1024);
    store.saveProfile("default", larger);
    expect(store.profile("default")).toBe(larger);
    store.clearProfile("default");
    expect(store.profile("default")).toBeUndefined();
  });

  it("acquires every browser with a keep-alive and routes, never recording or a Live View (review L5)", () => {
    const options = acquireOptions({ outboundByHost: { "5173.t3flare.internal": {} as never } });
    expect(Object.keys(options).sort()).toEqual(["keepAlive", "outboundByHost"]);
    expect(options.keepAlive).toBe(600_000);
    expect(acquireOptions({})).toEqual({ keepAlive: 600_000 });
  });
});

/** A fake Browser Run browser-level socket: records what t3 sent, answers what the test says. */
const fakeSocket = () => {
  const sent: Array<string> = [];
  const listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  const socket = {
    accept: () => undefined,
    send: (message: string) => void sent.push(message),
    close: () => {
      for (const listener of listeners.close ?? []) listener({ data: null });
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) =>
      void (listeners[type] ??= []).push(listener),
  };
  return { socket, sent, emit: (data: string) => (listeners.message ?? []).forEach((listener) => listener({ data })) };
};

describe("t3's HTML-render Chrome, bridged to Browser Run (review M3)", () => {
  it("rewrites t3's page origin to one Browser Run serves, both ways", () => {
    const sent = JSON.stringify({ method: "Page.navigate", params: { url: `${STOCK_PAGE_ORIGIN}/page.html#x` } });
    expect(toBrowser(sent)).toContain(`${BRIDGED_PAGE_ORIGIN}/page.html#x`);
    expect(fromBrowser(toBrowser(sent))).toBe(sent);
  });

  it("answers stock's library check without a browser", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnHtmlBrowser(
            ChildProcess.make(HTML_BROWSER_EXECUTABLE, ["--version"]) as ChildProcess.StandardCommand,
            {
              binding: () => undefined,
              store: () => previewStore(nodeSqlStorage()),
            },
          );
          return yield* Stream.mkString(Stream.decodeText(handle.stdout));
        }),
      ),
    );
    expect(out).toContain("Browser Run");
  });

  it("carries fd 3 to the browser and the browser to fd 4, closes only its own contexts, and keeps the shared browser", async () => {
    const fake = fakeSocket();
    const store = previewStore(nodeSqlStorage());
    const closedSessions: Array<string> = [];
    const launched: Array<unknown> = [];
    const binding = {
      launch: async (options: unknown) => (
        launched.push(options),
        { sessionId: "shared-1", webSocket: { fetch: async () => ({ webSocket: fake.socket }) } }
      ),
      connectSession: async () => {
        throw new Error("not expected");
      },
      closeSession: async (id: string) => void closedSessions.push(id),
    };
    const encoder = new TextEncoder();
    const commands = [
      JSON.stringify({ id: 1, method: "Target.createBrowserContext", params: {} }),
      JSON.stringify({
        id: 2,
        method: "Page.navigate",
        params: { url: `${STOCK_PAGE_ORIGIN}/page.html` },
        sessionId: "s",
      }),
      JSON.stringify({ id: 3, method: "Browser.close", params: {} }),
    ];
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnHtmlBrowser(
            ChildProcess.make(HTML_BROWSER_EXECUTABLE, ["--headless=new", "--remote-debugging-pipe"], {
              additionalFds: {
                fd3: {
                  type: "input",
                  // As t3 sends them: Browser.close after the context's reply came back.
                  stream: Stream.fromIterable(
                    commands.slice(0, 2).map((command) => encoder.encode(`${command}\0`)),
                  ).pipe(
                    Stream.concat(
                      Stream.fromEffect(Effect.sleep(50).pipe(Effect.as(encoder.encode(`${commands[2]}\0`)))),
                    ),
                    Stream.concat(Stream.never),
                  ),
                },
                fd4: { type: "output" },
              },
            }) as ChildProcess.StandardCommand,
            { binding: () => binding as never, store: () => store, keepAliveMs: () => 90_000 },
          );
          yield* Effect.sleep(10);
          fake.emit(yield* encodeJson({ id: 1, result: { browserContextId: "ctx-1" } }));
          fake.emit(
            yield* encodeJson({
              method: "Fetch.requestPaused",
              params: { request: { url: `${BRIDGED_PAGE_ORIGIN}/page.html` } },
              sessionId: "s",
            }),
          );
          const text = yield* Stream.mkString(Stream.decodeText(handle.getOutputFd(4)));
          const code = yield* handle.exitCode;
          return { text, code };
        }),
      ),
    );
    expect(fake.sent[0]).toContain("Target.createBrowserContext");
    expect(fake.sent[1]).toContain(`${BRIDGED_PAGE_ORIGIN}/page.html`);
    // Browser.close is answered here, and only this render's context is disposed.
    expect(fake.sent.some((message) => message.includes("Browser.close"))).toBe(false);
    expect(fake.sent.at(-1)).toContain('"Target.disposeBrowserContext"');
    expect(fake.sent.at(-1)).toContain("ctx-1");
    expect(
      output.text
        .split("\0")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, result: { browserContextId: "ctx-1" } },
      { method: "Fetch.requestPaused", params: { request: { url: `${STOCK_PAGE_ORIGIN}/page.html` } }, sessionId: "s" },
      { id: 3, result: {} },
    ]);
    expect(output.code).toBe(0);
    expect(closedSessions).toEqual([]);
    expect(store.sessions().map((session) => session.kind)).toEqual(["html"]);
    // Browser Run's keep-alive is the one knob (SPI-1366): the setting as the browser opened, and no close of our own.
    expect(launched).toEqual([{ keepAlive: 90_000 }]);
  });
});

describe("the preview stream's socket (review H1)", () => {
  it("is the request as Effect reads it, with a socket whose destroy closes the WebSocket", async () => {
    let destroyed = 0;
    const request = new Request("https://t3.example/api/preview-stream/ws?threadId=t", {
      headers: { "sec-websocket-extensions": "permessage-deflate" },
    });
    const shim = nodeSocketShim(request, () => {
      destroyed++;
      throw new Error("already closed");
    });
    expect(shim.url).toBe(request.url);
    expect(shim.method).toBe("GET");
    expect(shim.headers.get("sec-websocket-extensions")).toBe("permessage-deflate");
    // t3 deletes the extensions key off `incoming.headers`: harmless here.
    expect(() => delete (shim.headers as unknown as Record<string, string>)["sec-websocket-extensions"]).not.toThrow();
    expect(await shim.clone().text()).toBe("");
    expect(shim.socket.writableLength).toBe(0);
    expect(() => shim.socket.destroy()).not.toThrow();
    expect(destroyed).toBe(1);
  });
});

describe("the ServerBrowserContexts Shadow (U59)", () => {
  it("exports what stock exports, and the class has stock's public methods", () => {
    expect(Object.keys(Shadow)).toEqual(expect.arrayContaining(Object.keys(Stock)));
    const methods = (prototype: object) =>
      Object.getOwnPropertyNames(prototype).filter(
        (name) =>
          name !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function",
      );
    const stock = methods(Stock.ServerBrowserContexts.prototype).filter(
      (name) =>
        ![
          "launchOptions",
          "launch",
          "sharedBrowser",
          "sharedContext",
          "retireWhenIdle",
          "retire",
          "createContext",
          "profileDirectory",
          "dispose",
        ].includes(name),
    );
    expect(methods(Shadow.ServerBrowserContexts.prototype)).toEqual(expect.arrayContaining(stock));
  });
});

/** A fake profile context: its events, as the browser would send them, and every `storageState` and `Input.*` it saw. */
const fakeProfileContext = (initial: unknown) => {
  const events = new EventEmitter();
  let state = initial;
  const sent: Array<string> = [];
  const storageState = vi.fn(async () => state);
  const context = {
    pages: () => [],
    on: (event: string, listener: (...args: Array<unknown>) => void) => events.on(event, listener),
    storageState,
    newCDPSession: async () => ({ send: async (method: string) => void sent.push(method) }),
  };
  const page = new EventEmitter();
  return {
    context: context as never as import("playwright-core").BrowserContext,
    storageState,
    setState: (next: unknown) => void (state = next),
    response: () => events.emit("response", {}),
    openPage: () => events.emit("page", page),
    navigate: () => page.emit("framenavigated", {}),
    sent,
  };
};

describe("a profile context's saves (SPI-1123)", () => {
  afterEach(() => void vi.useRealTimers());
  const MINUTE = Shadow.PROFILE_SAVE_MS;

  it("reads no state across several intervals while the context is quiet, so Browser Run's keep-alive can end it", async () => {
    vi.useFakeTimers();
    const fake = fakeProfileContext({ cookies: [] });
    const writes: Array<string> = [];
    const saver = Shadow.profileSaver(fake.context, { saved: undefined, write: (state) => void writes.push(state) });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(fake.storageState).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    saver.stop();
  });

  it("saves once per interval after a response, a navigation, a new page or operator input, and nothing for other commands", async () => {
    vi.useFakeTimers();
    const fake = fakeProfileContext({ cookies: [] });
    const writes: Array<string> = [];
    const saver = Shadow.profileSaver(fake.context, { saved: undefined, write: (state) => void writes.push(state) });
    fake.response();
    fake.response();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([JSON.stringify({ cookies: [] })]);

    fake.openPage();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(2);
    fake.navigate();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(3);

    // The preview stream's input reaches the browser over a CDP session from the context.
    const session = await fake.context.newCDPSession({} as never);
    await session.send("Page.startScreencast" as never);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(3);
    await session.send("Input.dispatchMouseEvent" as never, { type: "mousePressed", x: 1, y: 1 } as never);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(4);
    expect(fake.sent).toEqual(["Page.startScreencast", "Input.dispatchMouseEvent"]);
    saver.stop();
  });

  it("saves every BROWSER_PROFILE_SAVE_SECONDS, 60 s (SPI-1366, SPI-1387)", async () => {
    vi.useFakeTimers();
    expect(BROWSER_PROFILE_SAVE_SECONDS).toBe(60);
    const fake = fakeProfileContext({ cookies: [] });
    const saver = Shadow.profileSaver(fake.context, { saved: undefined, write: () => undefined });
    fake.response();
    await vi.advanceTimersByTimeAsync(BROWSER_PROFILE_SAVE_SECONDS * 1000 - 1);
    expect(fake.storageState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.storageState).toHaveBeenCalledTimes(1);
    saver.stop();
  });

  it("does not write a state equal to the last one saved, and keeps the change after a failed read", async () => {
    vi.useFakeTimers();
    const fake = fakeProfileContext({ cookies: [{ name: "a" }] });
    const writes: Array<string> = [];
    const saver = Shadow.profileSaver(fake.context, {
      saved: JSON.stringify({ cookies: [{ name: "a" }] }),
      write: (state) => void writes.push(state),
    });
    fake.response();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);

    fake.setState({ cookies: [{ name: "b" }] });
    fake.storageState.mockRejectedValueOnce(new Error("Target closed"));
    fake.response();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fake.storageState).toHaveBeenCalledTimes(3);
    expect(writes).toEqual([JSON.stringify({ cookies: [{ name: "b" }] })]);

    // A close's save always reads, and writes only a change.
    await saver.save();
    expect(fake.storageState).toHaveBeenCalledTimes(4);
    expect(writes).toHaveLength(1);
    saver.stop();
  });
});
