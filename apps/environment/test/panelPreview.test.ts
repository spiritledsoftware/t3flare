// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
// The Settings page preview's `serve` mode (SPI-1337, scripts/lib/panelPreview.ts): the real routes over in-memory state
// on 127.0.0.1, so the page's own requests pass the write guard with the token the page carries, and a change is kept
// until the process ends. A request from another origin is refused as on a stage, one for another Host (DNS rebinding)
// reads nothing, and what needs the agents Worker says so once the route's own checks have passed.
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { servePreview, TEST_TAKES_MS } from "../scripts/lib/panelPreview.ts";
import { CSRF_HEADER } from "../src/harness/panel.ts";

const NOW = Date.UTC(2026, 10, 22, 12, 0);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const serve = async (clock: () => number = () => NOW) => {
  const preview = await servePreview({ port: 0, now: clock, log: () => undefined });
  close = preview.close;
  return preview;
};

/** A request to the preview's socket with the Host (and any header) given, which `fetch` would not let a test choose. */
const raw = (port: number, path: string, options: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {}) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {} }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end(options.body);
  });

const revisionOf = async (url: string) => ((await (await fetch(`${url}/api/environment`)).json()) as { revision: number }).revision;

const csrfOf = (html: string) => /<meta name="t3flare-csrf" content="([^"]+)">/.exec(html)?.[1];

const ownerPost = (preview: { readonly url: string; readonly origin: string }, csrf: string, path: string, body: unknown, origin = preview.origin) =>
  fetch(`${preview.url}/api/${path}`, { method: "POST", headers: { "content-type": "application/json", origin, [CSRF_HEADER]: csrf }, body: JSON.stringify(body) });

describe("panel-preview.ts serve", () => {
  it("binds 127.0.0.1 and serves the page with a CSRF token; a guarded Environment change round-trips and is kept", async () => {
    const preview = await serve();
    expect(preview.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(preview.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h3>Image setup</h3>");
    const csrf = csrfOf(html);
    expect(csrf).toBeTruthy();

    const revision = await revisionOf(preview.url);
    const change = await fetch(`${preview.url}/api/environment`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: preview.origin, "sec-fetch-site": "same-origin", [CSRF_HEADER]: csrf! },
      body: JSON.stringify({ settings: { containerSize: "standard-2" }, expectedRevision: revision }),
    });
    expect(change.status).toBe(200);
    const read = (await (await fetch(`${preview.url}/api/environment`)).json()) as { revision: number; resolved: { containerSize: string } };
    expect(read).toMatchObject({ revision: revision + 1, resolved: { containerSize: "standard-2" } });
    const audit = (await (await fetch(`${preview.url}/api/audit`)).json()) as { entries: Array<{ action: string; caller: string }> };
    expect(audit.entries[0]).toMatchObject({ action: "environment.change", caller: "owner:preview-owner" });
  });

  it("takes localhost at its port as its own origin as well as 127.0.0.1", async () => {
    const preview = await serve();
    const local = { "content-type": "application/json", host: `localhost:${preview.port}` };
    const csrf = csrfOf((await raw(preview.port, "/_t3flare/settings", { headers: { host: `localhost:${preview.port}` } })).body)!;
    const revision = await revisionOf(preview.url);
    const saved = await raw(preview.port, "/_t3flare/settings/api/environment", {
      method: "POST",
      headers: { ...local, origin: `http://localhost:${preview.port}`, [CSRF_HEADER]: csrf },
      body: JSON.stringify({ settings: { containerIdleMinutes: 9 } }),
    });
    expect(saved.status).toBe(200);
    expect(await revisionOf(preview.url)).toBe(revision + 1);
    expect((await raw(preview.port, "/", { headers: { host: `localhost:${preview.port}` } })).status).toBe(302);
  });

  it("refuses a change without the page's token or from another origin, as the guard does on a stage", async () => {
    const preview = await serve();
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    const revision = await revisionOf(preview.url);
    expect((await ownerPost(preview, "", "environment", { settings: { containerSize: "standard-3" } })).status).toBe(403);
    expect((await ownerPost(preview, csrf, "environment", { settings: { containerSize: "standard-3" } }, "http://evil.example")).status).toBe(403);
    expect((await ownerPost(preview, csrf, "environment", { settings: { containerSize: "standard-3" } }, `http://127.0.0.1:${preview.port + 1}`)).status).toBe(403);
    expect(await revisionOf(preview.url)).toBe(revision);
  });

  it("reads nothing for a Host that is not the preview's own (DNS rebinding)", async () => {
    const preview = await serve();
    const rebound = await raw(preview.port, "/_t3flare/settings", { headers: { host: `rebound.example:${preview.port}` } });
    expect(rebound.status).toBe(421);
    expect(rebound.body).not.toContain("t3flare-csrf");
    expect((await raw(preview.port, "/_t3flare/settings", { headers: { host: "localhost" } })).status).toBe(421);
  });

  it("runs a Workspaces route's own checks first, then answers the agents Worker's part with a clear 501", async () => {
    const preview = await serve();
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    const stop = await ownerPost(preview, csrf, "workspaces/stop", { id: "acme" });
    expect(stop.status).toBe(501);
    expect(await stop.text()).toMatch(/^not in the preview: .*agents Worker/);
    expect((await fetch(`${preview.url}/api/workspaces/usage?id=acme`)).status).toBe(501);
    // The guard, the routes and the Purge's typed name are the stage's.
    expect((await ownerPost(preview, csrf, "workspaces/stop", { id: "acme" }, "http://evil.example")).status).toBe(403);
    expect((await ownerPost(preview, csrf, "workspaces/nope", { id: "acme" })).status).toBe(404);
    expect((await fetch(`${preview.url}/api/workspaces/usage?id=nope`)).status).toBe(404);
    expect((await ownerPost(preview, csrf, "workspaces/purge", { id: "acme", confirm: "wrong" })).status).toBe(400);
    const root = await fetch(`${preview.origin}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(preview.url);
  });

  it("lists the fixture's MCP servers as the page fixture shows them: tools, the owner's class, the hidden and refused tools", async () => {
    const preview = await serve();
    const { servers } = (await (await fetch(`${preview.url}/api/mcp`)).json()) as { servers: Array<Record<string, any>> };
    const byName = Object.fromEntries(servers.map((server) => [server.name, server]));
    expect(byName.commissary).toMatchObject({ status: "ok", tools: [] });
    expect(byName.docs).toMatchObject({ status: "failed", error: "Unreachable: The server is unavailable (HTTP 530)" });
    expect(byName.linear).toMatchObject({ status: "never" });
    const fixture = byName.fixture!;
    expect(fixture.status).toBe("ok");
    expect(fixture.tools.map((tool: { upstream: string }) => tool.upstream)).toEqual(["fixture_echo", "fixture_note", "fixture_inject", "fixture_slow", "fixture_ask", "fixture_page"]);
    expect(fixture.tools.find((tool: { upstream: string }) => tool.upstream === "fixture_echo")).toMatchObject({ class: "write", hinted: "read" });
    expect(fixture.tools.find((tool: { upstream: string }) => tool.upstream === "fixture_note")).toMatchObject({ exposure: "hidden" });
    expect(fixture.overrides).toEqual({ fixture_echo: "write" });
    expect(fixture.refused).toEqual([{ tool: "fixture.flip", reason: "its name collides with fixture_flip as mcp__fixture__fixture_flip" }]);
  });

  it("runs the simulated Builder: a Rebuild is ready at once, a Test builds and is ready once its time has passed", async () => {
    let now = NOW;
    const preview = await serve(() => now);
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    expect(await (await ownerPost(preview, csrf, "base/rebuild", {})).json()).toMatchObject({ ok: true, record: { state: "ready" } });
    expect(await (await ownerPost(preview, csrf, "base/test", { imageSetup: "apt-get install -y jq" })).json()).toMatchObject({ ok: true, record: { test: true, state: "building" } });
    now += TEST_TAKES_MS;
    expect(await (await fetch(`${preview.url}/api/base/test`)).json()).toMatchObject({ record: { test: true, state: "ready" } });
  });
});
