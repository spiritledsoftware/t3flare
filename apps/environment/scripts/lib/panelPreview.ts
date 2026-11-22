// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
// The Settings page served on localhost with its API (SPI-1337): the real `handleHarness` over in-memory deps (the
// stores, the MCP host, the Open changes and the Owner clients of test/settingsFixture.ts), seeded with the page's
// fixture state (test/fixtures/harnessPage.ts), so Save, Rebuild, Test and the page's other controls run the real route
// code. The live page sits behind Access, so neither `wrangler dev` nor a stage serves it to a local browser.
//
// What the preview stands in for, and what it cannot do:
// - The caller is an owner (`PREVIEW_SUBJECT`); the configured host is the preview's own, so the write guard (Origin and
//   CSRF token) passes for the page's own requests and refuses any other origin's, as on a stage.
// - The Builder is simulated: a Rebuild is ready at once, a Test reports building, then ready `TEST_TAKES_MS` later.
// - The Container budget shows one Container running; no Container starts.
// - The MCP engine is not bound: a server's Test answers that, and nothing leaves the machine.
// - Skills come from a fake GitHub holding one repo, `PREVIEW_SKILLS_REPO`.
// - The Model endpoints read no model list (no request leaves the machine): an add with a model typed works.
// - The Workspaces section reads fixed rows; their usage, the Sweep and the Owner's acts need the agents Worker and answer
//   501 "not in the preview".
// State lives in memory and is lost when the process ends.
import { createHash } from "node:crypto";
import http from "node:http";

import { applyMcpChange, type BaseBuildRecord, type StoredHarness } from "@t3flare/harness-registry";

import type { WorkspacesApi } from "../../src/agents/workspaceActions.ts";
import type { WorkspaceRecord } from "../../src/agents/workspaces.ts";
import { sealedStore } from "../../src/credentials/sealed.ts";
import { endpointStore } from "../../src/endpoints/store.ts";
import { changeSkills } from "../../src/harness/ops.ts";
import { handleHarness, type HarnessDeps, WORKSPACES_API_PATH } from "../../src/harness/panel.ts";
import { SETTINGS_PAGE_PATH } from "../../src/harness/paths.ts";
import { AUDIT_KEY } from "../../src/harness/store.ts";
import { resolvedForRead } from "../../src/harness/variableSeal.ts";
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

const NOT_IN_PREVIEW_WORKSPACES = "a Workspace's usage, the Sweep and the Owner's acts on the Workspaces need the agents Worker";

/** Why `path` is not served by the preview, or undefined when it is. */
const notInPreview = (path: string): string | undefined =>
  path.startsWith(`${WORKSPACES_API_PATH}/`) ? NOT_IN_PREVIEW_WORKSPACES : undefined;

const notInPreviewResponse = (reason: string) => new Response(`not in the preview: ${reason}\n`, { status: 501, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${description}\n`;

/** The page fixture's Harness settings with its MCP servers added, as the Owner would have added them. */
const seededHarness = (): StoredHarness => {
  let harness = FIXTURE_HARNESS;
  for (const row of FIXTURE_MCP) {
    if (row.setting.kind !== "direct" || row.setting.url === undefined) continue;
    const setting = row.setting.auth;
    const auth = setting?.kind === "header" && setting.header !== undefined ? { kind: "header" as const, header: setting.header } : setting?.kind === "oauth" ? { kind: "oauth" as const } : { kind: "none" as const };
    const applied = applyMcpChange(harness, { op: "add", server: row.name, url: row.setting.url, auth });
    if (!applied.ok) throw new Error(applied.error);
    harness = applied.harness;
  }
  return harness;
};

/** The Workspaces section's rows, after the page fixture's: a deleted project and its worktrees, and one in use. */
const seededWorkspaces = (now: number): WorkspacesApi => {
  const sql = t3Tables();
  sql.exec("INSERT INTO projection_projects VALUES ('p-live', 'Live app', '/w/live', ?, NULL, NULL)", new Date(now - 40 * DAY).toISOString());
  const rows: ReadonlyArray<WorkspaceRecord> = [
    record({ id: "acme", createdAt: now - 40 * DAY, unreferencedSince: now - 2 * DAY }),
    record({ id: ".wt/acme/feat-a", kind: "worktree", parent: "acme", branch: "feat-a", createdAt: now - 10 * DAY, unreferencedSince: now - 2 * DAY }),
    record({ id: ".wt/acme/feat-b", kind: "worktree", parent: "acme", branch: "t3/feat-b", createdAt: now - 10 * DAY, state: "tombstoned", deletedAt: now - 3 * DAY, purgeAfter: now + 4 * DAY, lastError: "uncommitted work (--force)" }),
    record({ id: "live", owner: "acme", name: "live", createdAt: now - 40 * DAY }),
  ];
  const refuse = async (): Promise<never> => {
    throw new Error(`not in the preview: ${NOT_IN_PREVIEW_WORKSPACES}`);
  };
  return {
    deps: { ...viewDeps(rows, { sql, purgingSince: now - 20 * DAY }), purge: refuse, restore: refuse, stop: refuse, audit: () => undefined, now: () => now },
    usage: refuse,
    runSweep: refuse,
  };
};

export interface PreviewOptions {
  /** The preview's own origin, `http://127.0.0.1:<port>`: what the page's requests send as their `Origin`. */
  readonly origin: string;
  readonly now?: () => number;
  /** Where the simulated Builder and the Environment's pokes are told (the console by default). */
  readonly log?: (line: string) => void;
}

/** The preview's request handler and its fixture, seeded. */
export const panelPreview = async (options: PreviewOptions) => {
  const clock = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const host = new URL(options.origin).host;
  const fixture = settingsFixture({ harness: seededHarness() });
  // The fixture's own clock follows the real one, so CSRF tokens, audit entries and Open changes all read one time.
  const tick = () => fixture.advance(clock() - fixture.now());
  tick();
  const now = fixture.now;

  for (const row of FIXTURE_MCP) {
    if (row.setting.kind === "direct" && row.setting.auth?.kind === "header") await fixture.secrets.put(row.name, "header", `preview-${row.name}-value`);
  }
  // The audit log as kept (oldest first), without a console line for each seeded entry.
  fixture.kv.put(AUDIT_KEY, [...FIXTURE_AUDIT].reverse());
  fixture.store.noteT3Tools({ ...FIXTURE_T3_TOOLS, listedAt: now() - 9 * 60_000 });

  const commit = fixture.github.push(PREVIEW_SKILLS_REPO, {
    "skills/grill-me/SKILL.md": skillMd("grill-me", "Grill the user about a plan until each branch of its design tree is settled."),
    "skills/tdd/SKILL.md": skillMd("tdd", "Test-driven development: red, green, then refactor at agreed seams."),
    "skills/tdd/reference.md": "Red, green, refactor.\n",
  });
  const actor = { caller: `owner:${PREVIEW_SUBJECT}` };
  const installed = await changeSkills(fixture.deps.ops, "/install", { source: PREVIEW_SKILLS_REPO, commit, folders: ["skills/grill-me", "skills/tdd"] }, { actor });
  const results = "json" in installed ? (installed.json as { readonly results?: ReadonlyArray<{ readonly error?: string }> }).results : undefined;
  if (results === undefined || results.length !== 2 || results.some((result) => result.error !== undefined)) throw new Error(`the preview's skills could not be installed: ${JSON.stringify(installed)}`);
  const disabled = await changeSkills(fixture.deps.ops, "/enable", { name: "tdd", enabled: false }, { actor });
  if (disabled.status !== 200) throw new Error(`the preview's tdd skill could not be disabled: ${JSON.stringify(disabled)}`);

  // The simulated Builder (ADR-0047 §4–§8): its records are made here, the panel keeps them as it keeps the real one's.
  const snapshot = (key: string) => ({ id: `preview-snapshot-${key.slice(0, 8)}`, size: 412_000_000, key, imageDigest: "sha256:preview", builtAt: now(), tookMs: 95_000 });
  let test: { readonly setup: string; readonly since: number } | undefined;
  const testRecord = (): BaseBuildRecord => {
    if (test === undefined) return { test: true, key: null, state: "none", good: null, at: now() };
    const key = test.setup;
    if (now() - test.since < TEST_TAKES_MS) return { test: true, setup: test.setup, key, state: "building", phase: "running", since: test.since, reason: "the Owner's Test", good: null, at: now() };
    return { test: true, setup: test.setup, key, state: "ready", good: { ...snapshot(key), builtAt: test.since + TEST_TAKES_MS, tookMs: TEST_TAKES_MS }, at: now() };
  };

  const kv = fixture.kv;
  const endpoints = endpointStore(kv, sealedStore(kv, CREDENTIALS_KEY, now));
  const deps: HarnessDeps = {
    ...fixture.panel({ kind: "owner", subject: PREVIEW_SUBJECT }),
    host,
    now,
    ownerEndpoint: `${options.origin}/_t3flare/mcp`,
    budget: async () => ({ max: (await resolvedForRead(fixture.store.loadEnvironment(), undefined)).containerBudget, leases: [{ holder: "preview-lease", workspace: "live" }] }),
    endpoints: { store: endpoints, discover: async () => ({ ok: false, error: "not in the preview: no model list is read; type the model's id" }) },
    workspaces: seededWorkspaces(now()),
    sweepSettingsChanged: () => log("preview: the Sweep settings changed (the Environment would bring the Sweep forward)"),
    baseInputsChanged: (reason) => log(`preview: the Base build's inputs changed (${reason}); the Builder would build again`),
    rebuildBase: async () => {
      const environment = fixture.store.loadEnvironment();
      const key = sha256(JSON.stringify(environment)).slice(0, 64);
      log("preview: Rebuild asked; the simulated Builder is ready at once");
      return { key, revision: environment.revision, imageDigest: "sha256:preview", state: "ready", good: snapshot(key), at: now() };
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
    if (url.pathname === "/" && request.method === "GET") return Response.redirect(`${options.origin}${SETTINGS_PAGE_PATH}`, 302);
    const reason = notInPreview(url.pathname);
    if (reason !== undefined) return notInPreviewResponse(reason);
    // The guard compares `Origin` with `https://<host>`, as the Worker is served over TLS; the preview is plain HTTP on the
    // loopback, so its own origin stands in for that one. Any other Origin goes on as sent, and is refused.
    const origin = request.headers.get("origin");
    if (origin !== options.origin) return handleHarness(request, deps);
    const headers = new Headers(request.headers);
    headers.set("origin", `https://${host}`);
    return handleHarness(new Request(request, { headers }), deps);
  };

  return { handle, fixture, deps };
};

export interface ServeOptions {
  readonly port?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Serves the preview on 127.0.0.1 alone (`port: 0` takes a free port); resolves once it listens. */
export const servePreview = async (options: ServeOptions = {}) => {
  let handle: ((request: Request) => Promise<Response>) | undefined;
  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const chunks: Array<Buffer> = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const each of Array.isArray(value) ? value : [value]) headers.append(name, each);
        }
        const method = incoming.method ?? "GET";
        const request = new Request(`${origin}${incoming.url ?? "/"}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
        const response = await handle!(request);
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
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    ({ handle } = await panelPreview({ origin, ...(options.now === undefined ? {} : { now: options.now }), ...(options.log === undefined ? {} : { log: options.log }) }));
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin,
    url: `${origin}${SETTINGS_PAGE_PATH}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
