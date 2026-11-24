// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// The Settings page served on localhost with its API (SPI-1337): the real `handleHarness` over in-memory deps (the
// stores, the MCP host, the Open changes and the Owner clients of test/settingsFixture.ts), seeded with the page's
// fixture state (test/fixtures/harnessPage.ts), so Save, Rebuild, Test and the page's other controls run the real route
// code. The live page sits behind Access: a stage's page asks for its Access sign-in first, and `wrangler dev` has no
// Access application to admit a browser. This needs neither, nor Cloudflare.
//
// What the preview stands in for, and what it cannot do:
// - The caller is an owner (`PREVIEW_SUBJECT`); the configured host is the preview's own, so the write guard (Origin and
//   CSRF token) passes for the page's own requests and refuses any other origin's, as on a stage. A request whose Host
//   is not the preview's (`127.0.0.1:<port>` or `localhost:<port>`) is refused, so a rebound DNS name reads nothing.
// - The Builder is simulated: a Rebuild is ready at once, a Test reports building, then ready `TEST_TAKES_MS` later.
// - The Container budget shows one Container running; no Container starts.
// - The MCP engine is simulated from the page fixture: its servers list as the fixture shows them (Commissary with no
//   tools, `fixture` with its tools and refused tool, `docs` failing, `linear` never signed in, as there is no OAuth). A
//   server the Owner adds lists nothing; no request leaves the machine, and no tool can be called.
// - Skills come from a fake GitHub holding one repo, `PREVIEW_SKILLS_REPO`.
// - The Model endpoints read no model list (no request leaves the machine): an add with a model typed works.
// - The Workspaces section reads fixed rows; the routes run as on a stage up to the agents Worker, so a Workspace's
//   usage, the Sweep and the Owner's acts answer 501 "not in the preview" (after the guard and the Purge's typed name).
// State lives in memory and is lost when the process ends.
import { createHash } from "node:crypto";
import http from "node:http";

import {
  applyMcpChange,
  type BaseBuildRecord,
  type Exposure,
  EXPOSURES,
  resolveEnvironment,
  type StoredHarness,
} from "@t3flare/harness-registry";

import type { WorkspacesApi } from "../../src/agents/workspaceActions.ts";
import { type SweepSettings, sweepSettingsOf } from "../../src/agents/deletionSettings.ts";
import type { WorkspaceRecord } from "../../src/agents/workspaces.ts";
import { sealedStore } from "../../src/credentials/sealed.ts";
import { endpointStore } from "../../src/endpoints/store.ts";
import { changeSkills } from "../../src/harness/ops.ts";
import { handleHarness, type HarnessDeps, WORKSPACES_API_PATH } from "../../src/harness/panel.ts";
import { SETTINGS_PAGE_PATH } from "../../src/harness/paths.ts";
import { AUDIT_KEY } from "../../src/harness/store.ts";
import { resolvedForRead } from "../../src/harness/variableSeal.ts";
import type { McpEngineBinding } from "../../src/mcp/host.ts";
import { FIXTURE_AUDIT, FIXTURE_HARNESS, FIXTURE_MCP, FIXTURE_T3_TOOLS } from "../../test/fixtures/harnessPage.ts";
import { DAY, record, t3Tables, viewDeps } from "../../test/fixtures/workspaces.ts";
import { CREDENTIALS_KEY, settingsFixture } from "../../test/settingsFixture.ts";

/** `serve`'s port when `--port` is not given: Wrangler's dev port (8787) and its inspector's (9229) are left free. */
export const DEFAULT_PREVIEW_PORT = 8790;

/** The owner the preview admits, as Access would name them. */
export const PREVIEW_SUBJECT = "preview-owner";

/** How long a simulated Test base build reports building before it is ready. */
export const TEST_TAKES_MS = 3_000;

/** The fake GitHub's one repo, with the two skills the page fixture shows. */
export const PREVIEW_SKILLS_REPO = "mattpocock/skills";

const NOT_IN_PREVIEW = "not in the preview: ";
const NOT_IN_PREVIEW_WORKSPACES =
  "a Workspace's usage, the Sweep and the Owner's acts on the Workspaces need the agents Worker";

const text = (status: number, body: string) =>
  new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${description}\n`;

/** Runs `work` with the console's log and warn lines dropped: the seeding's changes and listings are not news. */
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const { log, warn } = console;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await work();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

/** The page fixture's Harness settings with its MCP servers added, and their tools' overrides set, as the Owner would. */
const seededHarness = (): StoredHarness => {
  let harness = FIXTURE_HARNESS;
  const apply = (change: Parameters<typeof applyMcpChange>[1]) => {
    const applied = applyMcpChange(harness, change);
    if (!applied.ok) throw new Error(applied.error);
    harness = applied.harness;
  };
  for (const row of FIXTURE_MCP) {
    if (row.setting.kind !== "direct" || row.setting.url === undefined) continue;
    const setting = row.setting.auth;
    const auth =
      setting?.kind === "header" && setting.header !== undefined
        ? { kind: "header" as const, header: setting.header }
        : setting?.kind === "oauth"
          ? { kind: "oauth" as const }
          : { kind: "none" as const };
    apply({ op: "add", server: row.name, url: row.setting.url, auth });
    // The page's rows carry these as text; the fixture's are a class and an Exposure each.
    for (const [tool, cls] of Object.entries(row.overrides ?? {}))
      if (cls === "read" || cls === "write") apply({ op: "class", server: row.name, tool, class: cls });
    const exposures = Object.entries(row.toolExposure ?? {}).filter((entry): entry is [string, Exposure] =>
      (EXPOSURES as ReadonlyArray<string>).includes(entry[1]),
    );
    if (exposures.length > 0) apply({ op: "server", server: row.name, toolExposure: Object.fromEntries(exposures) });
  }
  return harness;
};

/**
 * The MCP engine, simulated from the page fixture: a listed server's tools (each hinted read or write as the fixture
 * has it) and refused tools, a failed one's error, and a refusal for everything else. Nothing is fetched.
 */
const fixtureEngine = (): McpEngineBinding => {
  const failed = (tag: string, message: string) =>
    ({ kind: "failed", error: { _tag: tag, message }, state: {} }) as never;
  return {
    discover: async (target) => {
      const row = FIXTURE_MCP.find((each) => each.name === target.conn);
      if (row === undefined) return failed("NotInPreview", "the preview's MCP engine knows only the fixture's servers");
      if (row.status === "never") return failed("Unauthorized", "the preview has no OAuth sign-in");
      if (row.status === "failed") {
        const [tag = "Error", ...rest] = (row.error ?? "the fixture's listing failed").split(": ");
        return failed(tag, rest.join(": "));
      }
      return {
        kind: "discovered",
        era: "legacy",
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: row.tools.map((tool) => ({
          name: tool.upstream,
          description: `${tool.upstream} (a fixture tool)`,
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: tool.hinted === "read" },
        })),
        prompts: [],
        problems: row.refused.map((refused) => ({ tool: refused.tool, problem: refused.reason })),
        fetchedAt: 0,
        state: {},
      } as never;
    },
    request: async () => failed("NotInPreview", "the preview calls no MCP tool"),
  };
};

/**
 * The Workspaces section's rows, after the page fixture's: a deleted project and its worktrees, and one in use. What a
 * stage asks the agents Worker for (usage, the Sweep, the acts) throws `NOT_IN_PREVIEW`, which the route answers.
 */
const seededWorkspaces = (now: number, sweep: () => SweepSettings): WorkspacesApi => {
  const sql = t3Tables();
  sql.exec(
    "INSERT INTO projection_projects VALUES ('p-live', 'Live app', '/w/live', ?, NULL, NULL)",
    new Date(now - 40 * DAY).toISOString(),
  );
  const rows: ReadonlyArray<WorkspaceRecord> = [
    record({ id: "acme", createdAt: now - 40 * DAY, unreferencedSince: now - 2 * DAY }),
    record({
      id: ".wt/acme/feat-a",
      kind: "worktree",
      parent: "acme",
      branch: "feat-a",
      createdAt: now - 10 * DAY,
      unreferencedSince: now - 2 * DAY,
    }),
    record({
      id: ".wt/acme/feat-b",
      kind: "worktree",
      parent: "acme",
      branch: "t3/feat-b",
      createdAt: now - 10 * DAY,
      state: "tombstoned",
      deletedAt: now - 3 * DAY,
      purgeAfter: now + 4 * DAY,
      lastError: "uncommitted work (--force)",
    }),
    record({ id: "live", owner: "acme", name: "live", createdAt: now - 40 * DAY }),
  ];
  const refuse = async (): Promise<never> => {
    throw new Error(`${NOT_IN_PREVIEW}${NOT_IN_PREVIEW_WORKSPACES}`);
  };
  return {
    deps: {
      ...viewDeps(rows, { sql, purgingSince: now - 20 * DAY }),
      // The Grace as stored now, as the Environment DO reads it (0 is never, SPI-1387).
      settings: sweep,
      purge: refuse,
      restore: refuse,
      stop: refuse,
      audit: () => undefined,
      now: () => now,
    },
    usage: refuse,
    runSweep: refuse,
  };
};

export interface PreviewOptions {
  /** The port the preview listens on: its own origins are `http://127.0.0.1:<port>` and `http://localhost:<port>`. */
  readonly port: number;
  readonly now?: () => number;
  /** Where the simulated Builder and the Environment's pokes are told (the console by default). */
  readonly log?: (line: string) => void;
}

/** The preview's request handler and its fixture, seeded. */
export const panelPreview = async (options: PreviewOptions) => {
  const clock = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const hosts = [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
  const host = hosts[0]!;
  const fixture = settingsFixture({ harness: seededHarness(), engine: fixtureEngine() });
  // The fixture's own clock follows the real one, so CSRF tokens, audit entries and Open changes all read one time.
  const tick = () => fixture.advance(clock() - fixture.now());
  tick();
  const now = fixture.now;

  await quietly(async () => {
    for (const row of FIXTURE_MCP) {
      if (row.setting.kind === "direct" && row.setting.auth?.kind === "header")
        await fixture.secrets.put(row.name, "header", `preview-${row.name}-value`);
    }
    // Listed as the fixture shows them; an OAuth server never signed in stays unlisted.
    for (const row of FIXTURE_MCP) if (row.status !== "never") await fixture.host.list(row.name);
    fixture.kv.put(AUDIT_KEY, [...FIXTURE_AUDIT].reverse());
    fixture.store.noteT3Tools({ ...FIXTURE_T3_TOOLS, listedAt: now() - 9 * 60_000 });
    const commit = fixture.github.push(PREVIEW_SKILLS_REPO, {
      "skills/grill-me/SKILL.md": skillMd(
        "grill-me",
        "Grill the user about a plan until each branch of its design tree is settled.",
      ),
      "skills/tdd/SKILL.md": skillMd("tdd", "Test-driven development: red, green, then refactor at agreed seams."),
      "skills/tdd/reference.md": "Red, green, refactor.\n",
    });
    const actor = { caller: `owner:${PREVIEW_SUBJECT}` };
    const installed = await changeSkills(
      fixture.deps.ops,
      "/install",
      { source: PREVIEW_SKILLS_REPO, commit, folders: ["skills/grill-me", "skills/tdd"] },
      { actor },
    );
    const results =
      "json" in installed
        ? (installed.json as { readonly results?: ReadonlyArray<{ readonly error?: string }> }).results
        : undefined;
    if (results === undefined || results.length !== 2 || results.some((result) => result.error !== undefined))
      throw new Error(`the preview's skills could not be installed: ${JSON.stringify(installed)}`);
    const disabled = await changeSkills(fixture.deps.ops, "/enable", { name: "tdd", enabled: false }, { actor });
    if (disabled.status !== 200)
      throw new Error(`the preview's tdd skill could not be disabled: ${JSON.stringify(disabled)}`);
  });

  // The simulated Builder (ADR-0047 §4–§8): its records are made here, the panel keeps them as it keeps the real one's.
  const snapshot = (key: string) => ({
    id: `preview-snapshot-${key.slice(0, 8)}`,
    size: 412_000_000,
    key,
    imageDigest: "sha256:preview",
    builtAt: now(),
    tookMs: 95_000,
  });
  let test: { readonly setup: string; readonly since: number } | undefined;
  const testRecord = (): BaseBuildRecord => {
    if (test === undefined) return { test: true, key: null, state: "none", good: null, at: now() };
    const key = test.setup;
    if (now() - test.since < TEST_TAKES_MS)
      return {
        test: true,
        setup: test.setup,
        key,
        state: "building",
        phase: "running",
        since: test.since,
        reason: "the Owner's Test",
        good: null,
        at: now(),
      };
    return {
      test: true,
      setup: test.setup,
      key,
      state: "ready",
      good: { ...snapshot(key), builtAt: test.since + TEST_TAKES_MS, tookMs: TEST_TAKES_MS },
      at: now(),
    };
  };

  const kv = fixture.kv;
  const endpoints = endpointStore(kv, sealedStore(kv, CREDENTIALS_KEY, now));
  const deps: HarnessDeps = {
    ...fixture.panel({ kind: "owner", subject: PREVIEW_SUBJECT }),
    host,
    now,
    ownerEndpoint: `http://${host}/_t3flare/mcp`,
    budget: async () => ({
      max: (await resolvedForRead(fixture.store.loadEnvironment(), undefined)).containerBudget,
      leases: [{ holder: "preview-lease", workspace: "live" }],
    }),
    endpoints: {
      store: endpoints,
      discover: async () => ({ ok: false, error: `${NOT_IN_PREVIEW}no model list is read; type the model's id` }),
    },
    workspaces: seededWorkspaces(now(), () =>
      sweepSettingsOf(resolveEnvironment(fixture.store.loadEnvironment()), undefined),
    ),
    sweepSettingsChanged: () =>
      log("preview: the Sweep settings changed (the Environment would bring the Sweep forward)"),
    baseInputsChanged: (reason) =>
      log(`preview: the Base build's inputs changed (${reason}); the Builder would build again`),
    rebuildBase: async () => {
      const environment = fixture.store.loadEnvironment();
      const key = sha256(JSON.stringify(environment)).slice(0, 64);
      log("preview: Rebuild asked; the simulated Builder is ready at once");
      return {
        key,
        revision: environment.revision,
        imageDigest: "sha256:preview",
        state: "ready",
        good: snapshot(key),
        at: now(),
      };
    },
    testBase: async (imageSetup) => {
      test = { setup: sha256(imageSetup), since: now() };
      log(`preview: Test asked; the simulated test Builder is ready in ${TEST_TAKES_MS / 1000}s`);
      return testRecord();
    },
    readTestBase: async () => testRecord(),
  };

  const handle = async (request: Request): Promise<Response> => {
    tick();
    const url = new URL(request.url);
    // DNS rebinding: a page on another name that resolves here must not read the page (and its CSRF token).
    const requestHost = request.headers.get("host") ?? url.host;
    if (!hosts.includes(requestHost))
      return text(421, `not the preview's host: it answers ${hosts.join(" and ")} alone`);
    if (url.pathname === "/" && request.method === "GET")
      return Response.redirect(`http://${requestHost}${SETTINGS_PAGE_PATH}`, 302);
    // The guard compares `Origin` with `https://<host>`, as the Worker is served over TLS; the preview is plain HTTP on the
    // loopback, so either of its own origins stands in for that one. Any other Origin goes on as sent, and is refused.
    const origin = request.headers.get("origin");
    let forwarded = request;
    if (origin !== null && hosts.some((each) => origin === `http://${each}`)) {
      const headers = new Headers(request.headers);
      headers.set("origin", `https://${host}`);
      forwarded = new Request(request, { headers });
    }
    const response = await handleHarness(forwarded, deps);
    // A Workspaces route that reached the agents Worker's part answers so (the route's own words would be a 503).
    if (response.status === 503 && url.pathname.startsWith(`${WORKSPACES_API_PATH}/`)) {
      const body = await response.text();
      return body.includes(NOT_IN_PREVIEW)
        ? text(501, `${NOT_IN_PREVIEW}${NOT_IN_PREVIEW_WORKSPACES}`)
        : new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  };

  return { handle, fixture, deps };
};

export interface ServeOptions {
  readonly port?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Serves the preview on 127.0.0.1 alone (`port: 0` takes a free port); resolves once it listens and is seeded. */
export const servePreview = async (options: ServeOptions = {}) => {
  let handle: ((request: Request) => Promise<Response>) | undefined;
  let port = 0;
  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const chunks: Array<Buffer> = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        // A request that lands while the fixture is seeded is told to come back, never answered from half-made state.
        const ready = handle;
        if (ready === undefined) {
          outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "1" });
          outgoing.end("the preview is starting; try again in a moment\n");
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each);
        }
        const method = incoming.method ?? "GET";
        const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        const response = await ready(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end(`the preview failed: ${String(error)}\n`);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PREVIEW_PORT, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the preview has no TCP address");
  port = address.port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    ({ handle } = await panelPreview({
      port,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.log === undefined ? {} : { log: options.log }),
    }));
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin,
    port,
    url: `${origin}${SETTINGS_PAGE_PATH}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
