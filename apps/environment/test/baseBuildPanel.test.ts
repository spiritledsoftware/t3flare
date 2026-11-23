// The Base snapshot on the Settings page (SPI-1332, ADR-0047 §4, §5, §9): the Builder's record kept for Status (the
// newest only, a malformed one dropped), the pokes a save sends, the Owner's Rebuild, the page's block and settings, and
// the Sweep's cost guard leaving the Builders alone.
import { type BaseBuildRecord, BUILDERS } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import type { AccessCaller } from "../src/access.ts";
import { keptHolders } from "../src/agents/deletion.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessDeps, REBUILD_BASE_PATH } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 22, 10, 0);
const owner: AccessCaller = { kind: "owner", subject: "owner-sub" };
const KEY = "a".repeat(64);

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
  };
};

const failed: BaseBuildRecord = {
  key: KEY,
  state: "failed",
  failure: {
    at: NOW,
    phase: "running",
    exitCode: 100,
    message: "the Image setup exited 100",
    output: "E: Unable to locate package <nope>\n",
  },
  good: null,
  at: NOW,
};

const setup = (extra: Partial<HarnessDeps> = {}) => {
  const store = harnessStore(memory());
  const deps: HarnessDeps = { caller: owner, host: HOST, store, now: () => NOW, ...extra };
  return { store, deps };
};

const page = async (deps: HarnessDeps) =>
  (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();

const ownerPost = async (deps: HarnessDeps, path: string, body: unknown) =>
  handleHarness(
    new Request(`https://${HOST}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `https://${HOST}`,
        "sec-fetch-site": "same-origin",
        [CSRF_HEADER]: await csrfToken(deps.store.csrfKey(), "owner-sub", NOW),
      },
      body: JSON.stringify(body),
    }),
    deps,
  );

describe("the Base build's record in the Environment DO", () => {
  it("keeps the newest well-formed record and drops the rest", () => {
    const { store } = setup();
    expect(store.lastBaseBuild()).toBeUndefined();
    expect(store.noteBaseBuild(failed)).toBe(true);
    expect(store.noteBaseBuild({ ...failed, state: "maybe" })).toBe(false);
    // A report that arrives late (an older `at`) does not replace a newer one.
    expect(
      store.noteBaseBuild({
        key: KEY,
        state: "building",
        phase: "running",
        since: NOW - 5000,
        good: null,
        at: NOW - 1000,
      }),
    ).toBe(false);
    expect(store.lastBaseBuild()).toEqual(failed);
  });

  it("shows the state in Status, and the failed build's output on the page, escaped", async () => {
    const { store, deps } = setup({ rebuildBase: async () => failed });
    store.noteBaseBuild(failed);
    const status = (await (
      await handleHarness(new Request(`https://${HOST}/_t3flare/settings/api/status`), deps)
    ).json()) as Record<string, unknown>;
    expect(status["Base snapshot"]).toBe("failed 2026-11-22T10:00:00.000Z (exit 100): the Image setup exited 100");
    const html = await page(deps);
    expect(html).toContain('<span class="pill pill-err">Failed</span>');
    expect(html).toContain("E: Unable to locate package &lt;nope&gt;");
    expect(html).toMatch(/<button[^>]*data-base-rebuild/);
    // Once, in its block: not again in Status's list.
    expect(html).not.toContain("<dt>Base snapshot</dt>");
  });

  it("shows no Rebuild where the Builder cannot be reached, and says none reported yet", async () => {
    const html = await page(setup().deps);
    expect(html).toContain("No Base build has reported yet.");
    expect(html).not.toMatch(/<button[^>]*data-base-rebuild/);
  });
});

describe("the Owner's Rebuild", () => {
  it("asks the Builder, keeps its record and answers its line", async () => {
    let asked = 0;
    const building: BaseBuildRecord = {
      key: KEY,
      state: "building",
      phase: "starting",
      since: NOW,
      reason: "the Owner's Rebuild",
      good: null,
      at: NOW,
    };
    const { store, deps } = setup({
      rebuildBase: async () => {
        asked++;
        return building;
      },
    });
    const response = await ownerPost(deps, REBUILD_BASE_PATH, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      record: { state: "building" },
      status: "building since 2026-11-22T10:00:00.000Z (starting; the Owner's Rebuild)",
    });
    expect(asked).toBe(1);
    expect(store.lastBaseBuild()).toEqual(building);
  });

  it("is guarded as every change is, and is not found without a Builder", async () => {
    const { deps } = setup({ rebuildBase: async () => failed });
    const bare = await handleHarness(
      new Request(`https://${HOST}${REBUILD_BASE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      deps,
    );
    expect(bare.status).toBe(403);
    expect((await ownerPost(setup().deps, REBUILD_BASE_PATH, {})).status).toBe(404);
  });

  it("answers 503 when the Builder cannot be reached", async () => {
    const { deps } = setup({
      rebuildBase: async () => {
        throw new Error("no such Durable Object");
      },
    });
    expect((await ownerPost(deps, REBUILD_BASE_PATH, {})).status).toBe(503);
  });
});

describe("a save pokes the Builder", () => {
  it("when what a build is made from or a Builder setting moves, with what moved; never for the rest", async () => {
    const reasons: Array<string> = [];
    const { deps } = setup({ baseInputsChanged: (reason) => void reasons.push(reason) });
    const save = (settings: Record<string, unknown>) =>
      ownerPost(deps, "/_t3flare/settings/api/environment", { settings });
    expect((await save({ containerIdleMinutes: 5, containerBudget: 2 })).status).toBe(200);
    expect(reasons).toEqual([]);
    await save({ imageSetup: "apt-get install -y jq\n" });
    await save({ globalMiseConfig: "[tools]\njq = 'latest'\n", variables: [{ name: "A", value: "1", secret: false }] });
    await save({ imageSetup: "apt-get install -y jq\n" });
    // A Builder setting alone (the schedule saved by itself, finding 5): the Builder reads and arms it again.
    await save({ rebuildEveryDays: 7 });
    await save({ imageSetupMinutes: 10, builderInBudget: true });
    expect(reasons).toEqual([
      "the Image setup changed",
      "the Global mise config changed; the Variables changed",
      "Rebuild every (days) changed",
      "Image setup time limit (minutes) changed; Builder counts against the Container budget changed",
    ]);
  });
});

describe("the Base snapshot's settings on the page", () => {
  it("joins the Image setup's own row: the script as a file, the limits, the Builder's size by its label", async () => {
    const html = await page(setup().deps);
    const start = html.indexOf("<h3>Image setup</h3>");
    expect(start).toBeGreaterThan(-1);
    const row = html.slice(start, html.indexOf('<div class="row">', start));
    expect(row).toMatch(/<textarea class="file"[^>]*data-setting="imageSetup"/);
    for (const key of ["imageSetupMinutes", "snapshotMinutes", "builderSize", "builderInBudget", "rebuildEveryDays"])
      expect(row).toContain(`data-setting="${key}"`);
    expect(row).toContain('<option value="sameAsContainer" selected>Same as Container size</option>');
  });
});

describe("the Sweep's cost guard", () => {
  it("never stops a Builder's lease", () => {
    const namespace = { idFromName: (name: string) => `id:${name}`, get: () => ({}) };
    const kept = keptHolders(namespace, [
      { id: "web-app", state: "ready" },
      { id: "gone", state: "deleting" },
    ]);
    expect(kept.has("id:web-app")).toBe(true);
    expect(kept.has("id:gone")).toBe(false);
    for (const name of Object.values(BUILDERS)) expect(kept.has(`id:${name}`)).toBe(true);
  });
});
