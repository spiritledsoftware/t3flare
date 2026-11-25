// SPI-1390 (ADR-0031): a Workspace's preview browser routes the ports a preview can use when it starts, at most Browser
// Run's eight, and restarts to route any other port a page asks for; t3flare's own ports and a port off the Owner's
// list get a page instead. Browser Run is a fake here: what the Shadow asks of it, and what its pages are sent to.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { relaunchMessage } from "../src/preview/previewRoutes.ts";
import { ServerBrowserContexts } from "../src/shadows/serverBrowserContexts.ts";

const launches: Array<{ readonly hosts: ReadonlyArray<string>; readonly browser: FakeBrowser }> = [];

class FakePage extends EventEmitter {
  readonly visited: Array<string> = [];
  goto(url: string) {
    this.visited.push(url);
    return Promise.resolve(null);
  }
  locator() {
    return {};
  }
}

class FakeContext extends EventEmitter {
  readonly #pages: Array<FakePage> = [];
  closed = false;
  readonly owner: FakeBrowser;
  constructor(owner: FakeBrowser) {
    super();
    this.owner = owner;
  }
  browser() {
    return this.owner;
  }
  pages() {
    return this.#pages;
  }
  newPage() {
    const page = new FakePage();
    this.#pages.push(page);
    this.emit("page", page);
    return Promise.resolve(page);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
    return Promise.resolve();
  }
}

class FakeBrowser extends EventEmitter {
  readonly #contexts: Array<FakeContext> = [];
  closed = false;
  readonly id: string;
  constructor(id: string) {
    super();
    this.id = id;
  }
  sessionId() {
    return this.id;
  }
  newContext() {
    const context = new FakeContext(this);
    this.#contexts.push(context);
    return Promise.resolve(context);
  }
  contexts() {
    return this.#contexts.filter((context) => !context.closed);
  }
  isConnected() {
    return !this.closed;
  }
  close() {
    this.closed = true;
    this.emit("disconnected");
    return Promise.resolve();
  }
}

vi.mock("@cloudflare/playwright", () => ({
  launch: (_binding: unknown, options: { readonly outboundByHost?: Record<string, unknown> }) => {
    const browser = new FakeBrowser(`session-${launches.length + 1}`);
    launches.push({ hosts: Object.keys(options.outboundByHost ?? {}), browser });
    return Promise.resolve(browser);
  },
}));

const listener = (port: number, host: string) => ({
  port,
  host,
  pid: 100,
  pgid: 100,
  comm: "node",
  exec: null,
  thread: null,
});

const bind = (allowlist: ReadonlyArray<number>) =>
  bindEnvironmentServices({
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: () => ({
          listeners: () =>
            Promise.resolve({
              running: true,
              scan: { computerd: 1, listeners: [listener(9999, "0.0.0.0"), listener(9998, "127.0.0.1")], table: [] },
            }),
        }),
      },
    },
    sql: { exec: () => ({ toArray: () => [{ worktree: null, root: "/w/ws-a" }] }) },
    browserRun: { closeSession: () => Promise.resolve() },
    containerPreviews: (workspace: string) => ({ workspace }),
    previewStore: {
      sessionOpened: () => undefined,
      sessionClosed: () => undefined,
      profile: () => undefined,
      saveProfile: () => undefined,
    },
    previewPorts: () => allowlist,
  } as unknown as EnvironmentServices);

const hostsOf = (ports: ReadonlyArray<number>) => ports.map((port) => `${port}.t3flare.internal`);

const open = async (allowlist: ReadonlyArray<number> = []) => {
  bind(allowlist);
  const closedTabs: Array<unknown> = [];
  const contexts = new ServerBrowserContexts({
    profilesDir: "/profiles",
    executable: () => Promise.resolve("chrome"),
    onContextClose: (context) => void closedTabs.push(context),
  });
  const tab = async () => {
    const context = await contexts.contextFor("default", "tab", "thread-a");
    return (await context.newPage()) as unknown as FakePage & { goto(url: string): Promise<unknown> };
  };
  return { contexts, tab, closedTabs };
};

describe("a Workspace's preview browser (SPI-1390)", () => {
  afterEach(async () => {
    launches.length = 0;
    bindEnvironmentServices(undefined as unknown as EnvironmentServices);
  });

  it("starts routing the Container's reachable listeners, then the usual ports, eight in all, and previews them", async () => {
    const { contexts, tab } = await open();
    const page = await tab();
    expect(launches.map((launch) => launch.hosts)).toEqual([hostsOf([9999, 3000, 3001, 4173, 4321, 5173, 5174, 8000])]);
    await page.goto("http://localhost:9999/app");
    expect(page.visited).toEqual(["http://9999.t3flare.internal/app"]);
    await contexts.close();
  });

  it("restarts with a port it does not route: the tabs close, the goto names the restart, the next browser routes it first", async () => {
    const { contexts, tab, closedTabs } = await open();
    const page = await tab();
    await expect(page.goto("http://localhost:41234/")).rejects.toThrow(relaunchMessage(41_234));
    expect(page.visited).toEqual([]);
    expect(launches[0]?.browser.closed).toBe(true);
    expect(closedTabs).toHaveLength(1);
    const again = await tab();
    expect(launches.map((launch) => launch.hosts)).toEqual([
      hostsOf([9999, 3000, 3001, 4173, 4321, 5173, 5174, 8000]),
      hostsOf([41_234, 9999, 3000, 3001, 4173, 4321, 5173, 5174]),
    ]);
    await again.goto("http://localhost:41234/");
    expect(again.visited).toEqual(["http://41234.t3flare.internal/"]);
    await contexts.close();
  });

  it("joins pages asking together into one restart, each port added, up to eight; a ninth is told it was not", async () => {
    const { contexts, tab } = await open();
    const pages = await Promise.all(Array.from({ length: 9 }, () => tab()));
    const ports = Array.from({ length: 9 }, (_, index) => 41_000 + index);
    const outcomes = await Promise.all(
      pages.map((page, index) =>
        page.goto(`http://localhost:${ports[index]}/`).then(String, (error: Error) => error.message),
      ),
    );
    expect(outcomes.slice(0, 8)).toEqual(ports.slice(0, 8).map((port) => relaunchMessage(port, "added")));
    expect(outcomes[8]).toBe(relaunchMessage(41_008, "full"));
    expect(launches).toHaveLength(1);
    await tab();
    expect(launches[1]?.hosts).toEqual(hostsOf(ports.slice(0, 8)));
    await contexts.close();
  });

  it("never hands out a context that a restart is closing: the next one is the new browser's", async () => {
    const { contexts, tab } = await open();
    const page = await tab();
    const old = await contexts.contextFor("default", "tab", "thread-a");
    const asking = page.goto("http://localhost:41234/").catch(() => undefined);
    const next = await contexts.contextFor("default", "tab", "thread-a");
    expect(next).not.toBe(old);
    expect((next as unknown as FakeContext).owner).toBe(launches[1]?.browser);
    expect(launches[0]?.browser.closed).toBe(true);
    expect(launches[1]?.hosts[0]).toBe("41234.t3flare.internal");
    await asking;
    await contexts.close();
  });

  it("never restarts for port 0: a page names it", async () => {
    const { contexts, tab } = await open();
    const page = await tab();
    await page.goto("http://localhost:0/");
    expect(decodeURIComponent(page.visited[0] ?? "")).toContain("0 is not a port from 1 to 65535");
    expect(launches).toHaveLength(1);
    expect(launches[0]?.browser.closed).toBe(false);
    await contexts.close();
  });

  it("refuses each reserved port with a page naming it, and restarts nothing", async () => {
    const { contexts, tab } = await open();
    const page = await tab();
    await page.goto("http://localhost:8080/");
    await page.goto("http://127.0.0.1:17781/");
    expect(page.visited.map((url) => decodeURIComponent(url))).toEqual([
      expect.stringContaining("Port 8080 is reserved by t3flare for computerd"),
      expect.stringContaining("Port 17781 is reserved by t3flare for the MCP bridge"),
    ]);
    expect(launches).toHaveLength(1);
    await contexts.close();
  });

  it("with the Owner's list, routes it alone, and a port off it gets a page naming the list", async () => {
    const { contexts, tab } = await open([4200, 9999]);
    const page = await tab();
    expect(launches.map((launch) => launch.hosts)).toEqual([hostsOf([4200, 9999])]);
    await page.goto("http://localhost:4200/");
    await page.goto("http://localhost:5173/");
    expect(page.visited[0]).toBe("http://4200.t3flare.internal/");
    expect(decodeURIComponent(page.visited[1] ?? "")).toContain("on ports 4200, 9999 (the Environment setting");
    expect(launches).toHaveLength(1);
    await contexts.close();
  });
});
