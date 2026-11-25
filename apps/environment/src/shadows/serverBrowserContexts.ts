// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off globalFetch:off
// Shadow of t3code `apps/server/src/preview/ServerBrowserContexts.ts` (G11's M3, ADR-0031; ADR-0001). Stock launches
// Chrome on its host; here every browser is Cloudflare Browser Run, driven by `@cloudflare/playwright` (a port of
// Playwright 1.62.1; t3 types against `playwright-core` 1.64.1, cast at this boundary). Exports what stock does:
// `presentAsChrome` and `ServerBrowserContexts` (`contextFor`, `scratchPage`, `connectDesktopPage`, `clearProfile`,
// `close`), with stock's `Options`.
//
// - **One browser per Workspace.** `contextFor` takes the tab's thread (Patch 0005); a thread's tabs open in its
//   Workspace's browser, acquired with Browser Run's `outboundByHost` routing at most eight Container preview hosts
//   (`http://<port>.t3flare.internal/`) to `ContainerPreviews` made for that Workspace alone (its props are the browser's
//   identity, M0 question 2). Which ports is `previewRoutes` (SPI-1390): the Owner's list, else the ports listening in the
//   Container when the browser starts, then the usual ones. A context with no thread, and `scratchPage`, use one
//   route-less browser.
// - **`localhost`.** Browser Run refuses loopback before any route runs (M0, R1), so every page's `goto` translates
//   `localhost:<port>` (and `127.0.0.1`, `[::1]`, `0.0.0.0`) to the port's preview host (review L6). t3flare's own ports,
//   and a port off the Owner's list, get a page naming why. Any other port the browser does not route restarts it with
//   that port added (Browser Run fixes the routes at acquire): its contexts are saved and closed, so t3 drops their tabs,
//   and the `goto` fails naming the restart.
// - **Profiles** have no user-data directory: each is `storageState({ indexedDB: true })`, kept in the Environment DO's
//   own table (`preview/store.ts`, review L4), loaded into `newContext`, saved before a close and, while open, at most
//   every `BROWSER_PROFILE_SAVE_SECONDS` (60, SPI-1366, SPI-1387) and only after a change (`profileSaver`, SPI-1123). A
//   profile context with no page for `idleBrowserMs` is saved and closed, and an idle browser retires, so an open
//   Environment holds no browser nobody uses.
// - **Lifetime and cost** (review M5): each session id is recorded and closed when the browser closes; a new Environment
//   instance closes the ones the last left (`preview/sessions.ts`). Browser Run closes a session after `keepAlive` with no
//   command sent to it (its events do not count): `disconnected` drops that browser's contexts and fires
//   `onContextClose`, so t3 drops their tabs. A quiet profile context therefore sends nothing (SPI-1123).
// - **Downloads** (M0: the fork cannot copy an artifact off Browser Run's disk, cloudflare/playwright#93): a download's
//   `saveAs` fetches its URL from the page that started it and writes it through t3's own `node:fs` (the State
//   directory), where t3 reads it back. A cross-origin download the page may not read fails as "not available".
// - **Uploads by path** read the file from the tab's own Workspace (`/w/<id>/…` or the agent's `/workspace/…`) and pass
//   it as a buffer; a path in another Workspace is refused.
// - Never `recording`, never a Live View URL, and no URL or cookie is logged (review L5).
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { BROWSER_PROFILE_SAVE_SECONDS, MAX_PREVIEW_PORTS } from "@t3flare/harness-registry";
import { containerPreviewHost, toWorkspace } from "@t3flare/workspace-client";
import * as NodeOS from "node:os";
import type { Browser, BrowserContext, CDPSession, Download, Page } from "playwright-core";

import { environmentServices, previewPortsNow } from "../agents/bindings.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import { BROWSER_KEEP_ALIVE_MS } from "../preview/browserRun.ts";
import { threadWorkspaceFrom } from "../preview/portDiscovery.ts";
import { previewNavigation, previewRoutes, reachablePorts, relaunchMessage } from "../preview/previewRoutes.ts";
import * as StateFs from "../shims/node-fs-promises.ts";

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes an idle browser, and an idle profile context, after this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** Stock's: change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

/**
 * The most often an open profile context's state is saved, while it has changed: `BROWSER_PROFILE_SAVE_SECONDS`
 * (SPI-1366, SPI-1387).
 */
export const PROFILE_SAVE_MS = BROWSER_PROFILE_SAVE_SECONDS * 1000;
/** The most a download or an uploaded file may be here: the isolate has 128 MB. */
export const TRANSFER_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Keeps a profile context's state saved without keeping its browser alive (SPI-1123). Browser Run's keep-alive counts
 * the commands sent to the browser, and `storageState` is one, so the state is read only after a change was seen: a page
 * opened, a frame navigated or a response came back (events the browser sends), or operator input went out on a CDP
 * session (the preview stream's, `Input.*`). While changed, it is saved at most every `intervalMs`; the mark clears only
 * once a save succeeds, and a state equal to the last one saved is not written. `save` (close, idle-retire) always reads.
 *
 * Known limit: a page that changes its storage from timers alone, with no request, navigation or input (or by an agent's
 * action that makes none), is saved at close or idle-retire, not while open.
 */
export const profileSaver = (
  context: BrowserContext,
  options: {
    readonly saved: string | undefined;
    readonly write: (state: string) => void;
    readonly intervalMs?: number;
  },
) => {
  let changes = 0;
  let savedChanges = 0;
  let last = options.saved;
  let saving = false;
  const mark = () => {
    changes++;
  };
  const save = async () => {
    const at = changes;
    const state = JSON.stringify((await context.storageState({ indexedDB: true } as never)) as unknown);
    if (state !== last) {
      options.write(state);
      last = state;
    }
    savedChanges = Math.max(savedChanges, at);
  };
  const timer = setInterval(
    () => {
      if (saving || changes === savedChanges) return;
      saving = true;
      void save()
        .catch(() => undefined)
        .finally(() => {
          saving = false;
        });
    },
    options.intervalMs ?? BROWSER_PROFILE_SAVE_SECONDS * 1000,
  );
  const watchPage = (page: Page) => {
    mark();
    page.on("framenavigated", mark);
  };
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
  context.on("response", mark);
  const newCDPSession = context.newCDPSession.bind(context);
  context.newCDPSession = (async (target: Parameters<BrowserContext["newCDPSession"]>[0]) => {
    const session = await newCDPSession(target);
    const send = session.send.bind(session) as (method: string, params?: unknown) => Promise<unknown>;
    session.send = ((method: string, params?: unknown) => {
      if (method.startsWith("Input.")) mark();
      return send(method, params);
    }) as CDPSession["send"];
    return session;
  }) as BrowserContext["newCDPSession"];
  const stop = () => clearInterval(timer);
  context.on("close", stop);
  return { save, stop };
};

interface Playwright {
  launch(
    binding: unknown,
    options: { keep_alive?: number; outboundByHost?: unknown },
  ): Promise<Browser & { sessionId(): string }>;
}

const loadPlaywright = async (): Promise<Playwright> =>
  (await import("@cloudflare/playwright")) as unknown as Playwright;

/** The bytes of `url` as `page` may read them (its cookies, its origin's rules), at most TRANSFER_MAX_BYTES. */
const fetchFromPage = async (page: Page, url: string): Promise<Uint8Array> => {
  const answer = await page.evaluate(
    async ({ target, max }) => {
      const response = await fetch(target, { credentials: "include" });
      if (!response.ok && response.type !== "basic") throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > max) throw new Error("too large");
      let binary = "";
      for (let at = 0; at < buffer.length; at += 0x8000)
        binary += String.fromCharCode(...buffer.subarray(at, at + 0x8000));
      return btoa(binary);
    },
    { target: url, max: TRANSFER_MAX_BYTES },
  );
  return Uint8Array.from(atob(answer), (char) => char.charCodeAt(0));
};

type FileInput = string | { readonly name: string; readonly mimeType: string; readonly buffer: Buffer };

/** Upload paths as buffers, read from `workspace` (`/w/<id>/…` of it, or its `/workspace/…`); anything else refused. */
const filesFrom = async (
  workspace: string | undefined,
  files: FileInput | ReadonlyArray<FileInput>,
): Promise<Array<Exclude<FileInput, string>>> => {
  const list = Array.isArray(files) ? (files as ReadonlyArray<FileInput>) : [files as FileInput];
  const out: Array<Exclude<FileInput, string>> = [];
  let total = 0;
  for (const file of list) {
    if (typeof file !== "string") {
      out.push(file);
      continue;
    }
    const at =
      file.startsWith("/workspace/") && workspace !== undefined ? { id: workspace, inner: file } : toWorkspace(file);
    if (workspace === undefined || at === null || at.id !== workspace) {
      throw new Error(`Upload paths must be in this thread's Workspace: ${file}`);
    }
    const answer = (await workspaceRpc(workspace).fs({ op: "read", path: at.inner })) as { readonly ok?: Uint8Array };
    if (answer.ok === undefined) throw new Error(`Could not read ${file}`);
    total += answer.ok.byteLength;
    if (total > TRANSFER_MAX_BYTES)
      throw new Error("The files are larger than the Cloud Environment uploads (16 MiB).");
    out.push({
      name: file.slice(file.lastIndexOf("/") + 1) || "file",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(answer.ok),
    });
  }
  return out;
};

const patched = new WeakSet<object>();

/**
 * The Workspace of each context and page of this module's browsers. Module state, not an instance's: the upload patch is
 * installed once per prototype, and must see the contexts of the instance a restart makes.
 */
const workspaceOf = new WeakMap<object, string | undefined>();

/** Installs the translations on one prototype the fork's pages, choosers and locators share (once). */
const patchUploads = (target: object, method: string, workspaceFor: (self: object) => string | undefined) => {
  const prototype = Object.getPrototypeOf(target) as Record<string, unknown> | null;
  if (prototype === null || patched.has(prototype) || typeof prototype[method] !== "function") return;
  patched.add(prototype);
  const original = prototype[method] as (
    this: object,
    files: FileInput | ReadonlyArray<FileInput>,
    options?: unknown,
  ) => Promise<void>;
  prototype[method] = async function (this: object, files: FileInput | ReadonlyArray<FileInput>, options?: unknown) {
    return original.call(this, await filesFrom(workspaceFor(this), files), options);
  };
};

/**
 * The Container ports each Workspace browser routes, by browser (SPI-1390). Browser Run fixes `outboundByHost` when the
 * browser is acquired, so this is set once, at launch, from `previewRoutes`, and read by each page's `goto` to tell a
 * routed port from one that needs a restart. A route-less browser has none. Weak: a closed browser takes its entry.
 */
const routedOf = new WeakMap<object, ReadonlyArray<number>>();

/**
 * What a Workspace's next browser starts routing after a restart (SPI-1390): the ports pages asked for while it
 * restarted (`wanted`, in the order asked, at most `MAX_PREVIEW_PORTS`), then the routes of the browser it replaces.
 */
interface CarriedRoutes {
  readonly wanted: Array<number>;
  previous: ReadonlyArray<number>;
}

/** How a page's ask for an unrouted port went: `added` to the restart, `full` (the restart routes its most already), or `stale` (its browser was already replaced). */
type RelaunchOutcome = "added" | "full" | "stale";

/** The ports listening in `workspace`'s Container that a preview can reach; none when it is stopped or cannot be asked. */
const listeningIn = async (workspace: string): Promise<ReadonlyArray<number>> => {
  try {
    const { scan } = await workspaceRpc(workspace).listeners();
    return scan === null ? [] : reachablePorts(scan);
  } catch {
    return [];
  }
};

interface WorkspaceBrowser {
  readonly key: string;
  readonly workspace: string | undefined;
  readonly launched: Promise<Browser & { sessionId(): string }>;
  /** The browser once launched: set before any context of it exists. */
  browser: (Browser & { sessionId(): string }) | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  pending: number;
}

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly browsers = new Map<string, WorkspaceBrowser>();
  /** By Workspace: a restart's routes for the browser that replaces the closed one, until that one launches (SPI-1390). */
  private readonly carried = new Map<string, CarriedRoutes>();
  /** By Workspace: the restart under way, which its next browser waits for before it launches. */
  private readonly relaunching = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private get store() {
    return environmentServices().previewStore;
  }

  private browserFor(workspace: string | undefined): WorkspaceBrowser {
    const key = workspace ?? "";
    const existing = this.browsers.get(key);
    if (existing !== undefined) return existing;
    const launched = (async () => {
      const binding = environmentServices().browserRun;
      if (binding === undefined) throw new Error("Browser Run is not bound in this Environment.");
      const playwright = await loadPlaywright();
      // A restart's next browser launches once the old one is closed, with every port asked for meanwhile.
      await this.relaunching.get(key);
      const carried = this.carried.get(key);
      this.carried.delete(key);
      const ports =
        workspace === undefined
          ? undefined
          : previewRoutes({
              allowlist: previewPortsNow(),
              wanted: carried?.wanted ?? [],
              listening: await listeningIn(workspace),
              previous: carried?.previous ?? [],
            });
      const routes =
        workspace === undefined || ports === undefined
          ? undefined
          : (() => {
              const entry = environmentServices().containerPreviews(workspace);
              return Object.fromEntries(ports.map((port) => [containerPreviewHost(port), entry]));
            })();
      const browser = await playwright.launch(binding, {
        keep_alive: BROWSER_KEEP_ALIVE_MS,
        ...(routes === undefined ? {} : { outboundByHost: routes }),
      });
      routedOf.set(browser, ports ?? []);
      const sessionId = browser.sessionId();
      this.store.sessionOpened({
        id: sessionId,
        kind: workspace === undefined ? "shared" : "workspace",
        workspace: workspace ?? null,
        openedAt: Date.now(),
      });
      browser.on("disconnected", () => {
        this.store.sessionClosed(sessionId);
        if (this.browsers.get(key)?.launched === launched) this.browsers.delete(key);
        // Browser Run ended it (its keep-alive, a release): the contexts and their tabs are gone; t3 drops them.
        for (const [contextKey, pending] of this.contexts) {
          void pending.then(
            (context) => {
              if (context.browser() === browser) {
                this.contexts.delete(contextKey);
                this.options.onContextClose?.(context);
              }
            },
            () => undefined,
          );
        }
      });
      return browser;
    })();
    const entry: WorkspaceBrowser = { key, workspace, launched, browser: undefined, idleTimer: undefined, pending: 0 };
    this.browsers.set(key, entry);
    void launched.then(
      (browser) => {
        entry.browser = browser;
      },
      () => {
        if (this.browsers.get(key) === entry) this.browsers.delete(key);
      },
    );
    return entry;
  }

  private retireWhenIdle(entry: WorkspaceBrowser) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || entry.pending > 0) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => void this.retire(entry), delay);
  }

  private async retire(entry: WorkspaceBrowser) {
    const browser = await entry.launched.catch(() => undefined);
    if (!browser || this.browsers.get(entry.key) !== entry || entry.pending > 0) return;
    if (browser.contexts().length > 0) return;
    this.browsers.delete(entry.key);
    await this.closeBrowser(browser);
  }

  private async closeBrowser(browser: Browser & { sessionId(): string }) {
    const sessionId = browser.sessionId();
    await browser.close().catch(() => undefined);
    await environmentServices()
      .browserRun?.closeSession(sessionId)
      .catch(() => undefined);
    this.store.sessionClosed(sessionId);
  }

  /** Every page of `context` gets the `localhost` translation and the download fix before t3's listeners run. */
  private preparePages(context: BrowserContext, workspace: string | undefined) {
    workspaceOf.set(context, workspace);
    const prepare = (page: Page) => {
      workspaceOf.set(page, workspace);
      const goto = page.goto.bind(page);
      page.goto = (async (url: string, options?: Parameters<Page["goto"]>[1]) => {
        const browser = context.browser();
        const navigation = previewNavigation(url, {
          // The route-less browser has no Container: a loopback URL gets a page saying where previews open.
          workspace: workspace !== undefined,
          routed: (browser === null ? undefined : routedOf.get(browser)) ?? [],
          allowlist: previewPortsNow(),
        });
        if (navigation.kind !== "relaunch" || workspace === undefined) {
          return goto(navigation.kind === "relaunch" ? url : navigation.url, options);
        }
        const { outcome, done } = this.relaunch(workspace, browser, navigation.port);
        await done;
        throw new Error(relaunchMessage(navigation.port, outcome));
      }) as Page["goto"];
      page.on("download", (download: Download) => {
        const target = download.url();
        (download as { saveAs: (path: string) => Promise<void> }).saveAs = async (path: string) => {
          const bytes = await fetchFromPage(page, target).catch(() => {
            throw new Error("This download is not available in the Cloud Environment: the page may not read it.");
          });
          await StateFs.writeFile(path, bytes);
        };
      });
      page.on("filechooser", (chooser) =>
        patchUploads(chooser, "setFiles", (self) => workspaceOf.get((self as { page(): Page }).page())),
      );
      patchUploads(page.locator("html"), "setInputFiles", (self) => workspaceOf.get((self as { page(): Page }).page()));
    };
    for (const page of context.pages()) prepare(page);
    context.on("page", prepare);
  }

  /**
   * Restarts `workspace`'s browser so it routes `port` (SPI-1390): Browser Run fixes a browser's routes when it is
   * acquired. The Workspace's contexts leave the cache at once, so `contextFor` never hands out one that is closing,
   * then are closed, which saves a profile's state and tells t3 to drop their tabs. Pages asking while it restarts join
   * it: each port is `added` to the next browser's routes, up to `MAX_PREVIEW_PORTS`, after which a port is `full`. A
   * page of a browser already replaced is `stale`, and restarts nothing. The next browser launches at the next
   * context, once the old one is closed.
   */
  private relaunch(
    workspace: string,
    browser: Browser | null,
    port: number,
  ): { readonly outcome: RelaunchOutcome; readonly done: Promise<void> } {
    const joining = this.carried.get(workspace);
    if (joining !== undefined) {
      const added = joining.wanted.includes(port) || joining.wanted.length < MAX_PREVIEW_PORTS;
      if (added && !joining.wanted.includes(port)) joining.wanted.push(port);
      return { outcome: added ? "added" : "full", done: this.relaunching.get(workspace) ?? Promise.resolve() };
    }
    const entry = this.browsers.get(workspace);
    // The asking page's browser is already gone: nothing of this Workspace's newer browser is closed.
    if (entry === undefined || entry.browser === undefined || (browser !== null && entry.browser !== browser))
      return { outcome: "stale", done: Promise.resolve() };
    const current = entry.browser;
    const carried: CarriedRoutes = { wanted: [port], previous: [] };
    this.carried.set(workspace, carried);
    this.browsers.delete(workspace);
    clearTimeout(entry.idleTimer);
    const closing: Array<Promise<BrowserContext>> = [];
    for (const [contextKey, pending] of this.contexts) {
      if ((JSON.parse(contextKey) as [string, string | null, string | null])[2] !== workspace) continue;
      this.contexts.delete(contextKey);
      closing.push(pending);
    }
    carried.previous = routedOf.get(current) ?? [];
    const done = (async () => {
      // The port alone, never a URL (review L5).
      console.log(JSON.stringify({ t3flare: "preview-browser-relaunched", port }));
      for (const pending of closing) {
        const context = await pending.catch(() => undefined);
        await context?.close().catch(() => undefined);
      }
      await this.closeBrowser(current);
    })().finally(() => {
      if (this.relaunching.get(workspace) === done) this.relaunching.delete(workspace);
    });
    this.relaunching.set(workspace, done);
    return { outcome: "added", done };
  }

  /** A profile context saves its state after a change (`profileSaver`), and is saved and closed after `idleBrowserMs` with no page. */
  private keepProfile(context: BrowserContext, profileId: string, key: string, pending: Promise<BrowserContext>) {
    const { save, stop } = profileSaver(context, {
      saved: this.store.profile(profileId),
      write: (state) => this.store.saveProfile(profileId, state),
    });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const pageCount = () => context.pages().length;
    const watch = () => {
      clearTimeout(idle);
      const delay = this.options.idleBrowserMs;
      if (delay === undefined || pageCount() > 0) return;
      idle = setTimeout(() => {
        if (pageCount() > 0 || this.contexts.get(key) !== pending) return;
        this.contexts.delete(key);
        void save()
          .catch(() => undefined)
          .then(() => context.close())
          .catch(() => undefined);
      }, delay);
    };
    context.on("page", (page) => {
      clearTimeout(idle);
      page.once("close", watch);
    });
    const close = context.close.bind(context);
    context.close = (async (options?: Parameters<BrowserContext["close"]>[0]) => {
      stop();
      clearTimeout(idle);
      if (!context.browser()?.isConnected()) return close(options);
      await save().catch(() => undefined);
      return close(options);
    }) as BrowserContext["close"];
    context.on("close", () => clearTimeout(idle));
    watch();
  }

  contextFor(profileId: string, isolationKey?: string, threadId?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const workspace = threadId === undefined ? undefined : threadWorkspaceFrom(environmentServices().sql)(threadId);
    const key = JSON.stringify([profileId, isolationKey ?? null, workspace ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(profileId)?.catch(() => undefined) ?? Promise.resolve();
    const pending: Promise<BrowserContext> = cleared
      .then(() => this.createContext(profileId, isolationKey, workspace))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
          const entry = this.browsers.get(workspace ?? "");
          if (entry !== undefined) this.retireWhenIdle(entry);
        });
        if (this.closing) {
          await context.close().catch(() => undefined);
          throw new Error("The preview browser is closed.");
        }
        const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
        if (persistent) this.keepProfile(context, profileId, key, pending);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey: string | undefined, workspace: string | undefined) {
    const entry = this.browserFor(workspace);
    clearTimeout(entry.idleTimer);
    entry.pending++;
    try {
      const browser = await entry.launched;
      const persistent = isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID;
      const saved = persistent ? this.store.profile(profileId) : undefined;
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        ...(saved === undefined ? {} : { storageState: JSON.parse(saved) as never }),
      });
      this.preparePages(context, workspace);
      return context;
    } finally {
      entry.pending--;
      this.retireWhenIdle(entry);
    }
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const entry = this.browserFor(undefined);
    clearTimeout(entry.idleTimer);
    entry.pending++;
    try {
      const context = await (await entry.launched).newContext();
      context.on("close", () => this.retireWhenIdle(entry));
      try {
        const page = await context.newPage();
        page.once("close", () => void context.close().catch(() => undefined));
        return page;
      } catch (cause) {
        await context.close().catch(() => undefined);
        throw cause;
      }
    } finally {
      entry.pending--;
      this.retireWhenIdle(entry);
    }
  }

  // Stock's signature; there is no desktop app on this host.
  async connectDesktopPage(_endpoint: string): Promise<{ browser: Browser; page: Page }> {
    throw new Error("The Cloud Environment has no desktop app to attach to.");
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const existing = this.clearing.get(profileId);
    if (existing) return existing;
    const clearing = (async () => {
      for (const [key, pending] of this.contexts) {
        const [id, isolation] = JSON.parse(key) as [string, string | null, string | null];
        if (id !== profileId || isolation !== null) continue;
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        // Its cookies go first, so the save its close makes keeps nothing of them.
        await context?.clearCookies().catch(() => undefined);
        await context?.close().catch(() => undefined);
      }
      this.store.clearProfile(profileId);
    })();
    this.clearing.set(profileId, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(profileId) === clearing) this.clearing.delete(profileId);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled([...this.contexts.values()].map(async (pending) => (await pending).close()));
    this.contexts.clear();
    const entries = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        clearTimeout(entry.idleTimer);
        const browser = await entry.launched.catch(() => undefined);
        if (browser !== undefined) await this.closeBrowser(browser);
      }),
    );
  }
}
