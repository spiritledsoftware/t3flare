// @effect-diagnostics globalFetch:off
// The Settings page preview's `serve` mode (SPI-1337, scripts/lib/panelPreview.ts): the real routes over in-memory state
// on 127.0.0.1, so the page's own requests pass the write guard with the token the page carries, and a change is kept
// until the process ends. A request from another origin is refused as on a stage; what needs the agents Worker says so.
import { afterEach, describe, expect, it } from "vitest";

import { servePreview } from "../scripts/lib/panelPreview.ts";
import { CSRF_HEADER } from "../src/harness/panel.ts";

const NOW = Date.UTC(2026, 10, 22, 12, 0);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const serve = async () => {
  const preview = await servePreview({ port: 0, now: () => NOW, log: () => undefined });
  close = preview.close;
  return preview;
};

const revisionOf = async (url: string) => ((await (await fetch(`${url}/api/environment`)).json()) as { revision: number }).revision;

const csrfOf = (html: string) => /<meta name="t3flare-csrf" content="([^"]+)">/.exec(html)?.[1];

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

  it("refuses a change without the page's token or from another origin, as the guard does on a stage", async () => {
    const preview = await serve();
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    const revision = await revisionOf(preview.url);
    const post = (headers: Record<string, string>) =>
      fetch(`${preview.url}/api/environment`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ settings: { containerSize: "standard-3" } }) });
    expect((await post({ origin: preview.origin })).status).toBe(403);
    expect((await post({ origin: "http://evil.example", [CSRF_HEADER]: csrf })).status).toBe(403);
    expect(await revisionOf(preview.url)).toBe(revision);
  });

  it("answers what needs the agents Worker with a clear 501, and redirects / to the page", async () => {
    const preview = await serve();
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    const stop = await fetch(`${preview.url}/api/workspaces/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: preview.origin, [CSRF_HEADER]: csrf },
      body: JSON.stringify({ id: "acme" }),
    });
    expect(stop.status).toBe(501);
    expect(await stop.text()).toMatch(/^not in the preview: .*agents Worker/);
    expect((await fetch(`${preview.url}/api/workspaces/usage?id=acme`)).status).toBe(501);
    const root = await fetch(`${preview.origin}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(preview.url);
  });

  it("runs the simulated Builder: a Rebuild is ready at once, a Test reports building", async () => {
    const preview = await serve();
    const csrf = csrfOf(await (await fetch(preview.url)).text())!;
    const post = (path: string, body: unknown) =>
      fetch(`${preview.url}/api/base/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: preview.origin, [CSRF_HEADER]: csrf }, body: JSON.stringify(body) });
    expect(await (await post("rebuild", {})).json()).toMatchObject({ ok: true, record: { state: "ready" } });
    expect(await (await post("test", { imageSetup: "apt-get install -y jq" })).json()).toMatchObject({ ok: true, record: { test: true, state: "building" } });
  });
});
