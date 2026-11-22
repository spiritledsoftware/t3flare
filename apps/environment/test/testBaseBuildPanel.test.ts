// The Test base build on the Settings page (SPI-1334, ADR-0047 §8): the test Builder's record kept apart from the Base
// build's, the Owner's Test of the unsaved Image setup (guarded as every change is, bounded as the setting is), the read
// the page polls, and the result shown beside the Image setup's text area.
import { type BaseBuildRecord, MAX_SETUP_BYTES } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import type { AccessCaller } from "../src/access.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessDeps, refreshedTestRecord, TEST_BASE_PATH } from "../src/harness/panel.ts";
import { SCRIPT, TEST_POLL_FAILURES, TEST_POLL_MS, TEST_POLL_RETRY_MS } from "../src/harness/pageScript.ts";
import { harnessStore } from "../src/harness/store.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 22, 10, 0);
const owner: AccessCaller = { kind: "owner", subject: "owner-sub" };
const KEY = "b".repeat(64);

const memory = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) };
};

const failedTest: BaseBuildRecord = {
  test: true,
  key: KEY,
  state: "failed",
  failure: { at: NOW, phase: "running", exitCode: 100, message: "the Image setup exited 100", output: "E: Unable to locate package <yq>\n" },
  good: null,
  at: NOW,
};
const building: BaseBuildRecord = { test: true, key: KEY, state: "building", phase: "starting", since: NOW, reason: "the Owner's Test", good: null, at: NOW };
const passed: BaseBuildRecord = {
  test: true,
  key: KEY,
  state: "ready",
  good: { id: "snap-t", size: 1_200_000, key: KEY, imageDigest: "img", builtAt: NOW, tookMs: 95_000 },
  at: NOW,
};

const setup = (extra: Partial<HarnessDeps> = {}) => {
  const store = harnessStore(memory());
  const deps: HarnessDeps = { caller: owner, host: HOST, store, now: () => NOW, ...extra };
  return { store, deps };
};

const page = async (deps: HarnessDeps) => (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
const imageSetupRow = (html: string) => {
  const start = html.indexOf("<h3>Image setup</h3>");
  return html.slice(start, html.indexOf('<div class="row">', start));
};

const ownerPost = async (deps: HarnessDeps, path: string, body: unknown) =>
  handleHarness(
    new Request(`https://${HOST}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${HOST}`, "sec-fetch-site": "same-origin", [CSRF_HEADER]: await csrfToken(deps.store.csrfKey(), "owner-sub", NOW) },
      body: JSON.stringify(body),
    }),
    deps,
  );

describe("the Test base build's record in the Environment DO", () => {
  it("keeps a test's record apart from the Base build's, and never one as the other", () => {
    const { store } = setup();
    expect(store.noteTestBaseBuild(failedTest)).toBe(true);
    expect(store.lastTestBaseBuild()).toEqual(failedTest);
    // A test's record is never the Base snapshot's, nor a Base build's a test's.
    expect(store.noteBaseBuild(passed)).toBe(false);
    expect(store.lastBaseBuild()).toBeUndefined();
    const { test: _test, ...base } = passed;
    expect(store.noteTestBaseBuild(base)).toBe(false);
    // The newest only: a late report does not replace it.
    expect(store.noteTestBaseBuild({ ...building, at: NOW - 1 })).toBe(false);
    // A test's digest of the text it ran is hex SHA-256, or the record is dropped.
    expect(store.noteTestBaseBuild({ ...failedTest, setup: "not-a-digest", at: NOW + 1 })).toBe(false);
    expect(store.lastTestBaseBuild()).toEqual(failedTest);
  });
});

describe("the Owner's Test", () => {
  it("runs the text sent, unsaved, keeps the test's record and answers its view", async () => {
    const asked: Array<string> = [];
    const { store, deps } = setup({
      testBase: async (imageSetup) => {
        asked.push(imageSetup);
        return building;
      },
    });
    const response = await ownerPost(deps, TEST_BASE_PATH, { imageSetup: "apt-get install -y yq\n" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, record: { state: "building" }, view: { state: "building", pill: { label: "Testing", tone: "warn" }, line: "testing since 2026-11-22T10:00:00.000Z (starting)", output: null } });
    expect(asked).toEqual(["apt-get install -y yq\n"]);
    expect(store.lastTestBaseBuild()).toEqual(building);
    // Nothing saved: the Environment settings are as they were.
    expect(store.loadEnvironment().revision).toBe(0);
  });

  it("refuses a body that is not the Image setup's text, or past its bound, without asking", async () => {
    let asked = 0;
    const { deps } = setup({
      testBase: async () => {
        asked++;
        return building;
      },
    });
    expect((await ownerPost(deps, TEST_BASE_PATH, {})).status).toBe(400);
    expect((await ownerPost(deps, TEST_BASE_PATH, { imageSetup: 7 })).status).toBe(400);
    const over = await ownerPost(deps, TEST_BASE_PATH, { imageSetup: "é".repeat(MAX_SETUP_BYTES / 2 + 1) });
    expect(over.status).toBe(413);
    expect(await over.text()).toContain("at most 256 KiB");
    expect(asked).toBe(0);
  });

  it("is guarded as every change is, and is not found without a Builder", async () => {
    const { deps } = setup({ testBase: async () => building });
    const bare = await handleHarness(new Request(`https://${HOST}${TEST_BASE_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"imageSetup":""}' }), deps);
    expect(bare.status).toBe(403);
    expect((await ownerPost(setup().deps, TEST_BASE_PATH, { imageSetup: "" })).status).toBe(404);
  });

  it("answers 503 when the test Builder cannot be reached", async () => {
    const { deps } = setup({
      testBase: async () => {
        throw new Error("no such Durable Object");
      },
    });
    expect((await ownerPost(deps, TEST_BASE_PATH, { imageSetup: "true\n" })).status).toBe(503);
  });

  it("reads the last test's view, which the page polls while it runs", async () => {
    const { store, deps } = setup({ testBase: async () => building });
    const read = async () => (await handleHarness(new Request(`https://${HOST}${TEST_BASE_PATH}`), deps)).json();
    expect(await read()).toMatchObject({ record: null, view: { state: "none", pill: { label: "None" }, line: "no test yet", output: null } });
    store.noteTestBaseBuild(failedTest);
    expect(await read()).toMatchObject({
      record: { state: "failed" },
      view: { state: "failed", pill: { label: "Failed", tone: "err" }, line: "failed 2026-11-22T10:00:00.000Z (exit 100): the Image setup exited 100", output: "E: Unable to locate package <yq>\n" },
    });
  });
});

describe("the Test beside the Image setup", () => {
  it("shows the Test button and the last result in the Image setup's row, the output escaped", async () => {
    const { store, deps } = setup({ testBase: async () => building });
    store.noteTestBaseBuild(failedTest);
    const row = imageSetupRow(await page(deps));
    expect(row).toMatch(/<button type="button"[^>]*data-base-test[^>]*>.*Test<\/button>/);
    expect(row).toContain('<span class="pill pill-err" data-test-pill>Failed</span>');
    expect(row).toContain("E: Unable to locate package &lt;yq&gt;");
    expect(row).toContain("its snapshot is never used");
  });

  it("shows a pass with its size and time, and a test under way for the script to follow", async () => {
    const { store, deps } = setup({ testBase: async () => building });
    store.noteTestBaseBuild({ ...passed, setup: "d".repeat(64) });
    const row = imageSetupRow(await page(deps));
    expect(row).toContain('<span class="pill pill-ok" data-test-pill>Passed</span>');
    // The tested text's digest, for the script to say when the box holds another text.
    expect(row).toContain(`data-test-setup="${"d".repeat(64)}"`);
    expect(row).toMatch(/<p[^>]*data-test-stale hidden>This result is for an earlier text/);
    expect(row).toContain("1.2 MB, took 1 min 35 s");
    store.noteTestBaseBuild({ ...building, at: NOW + 1 });
    expect(imageSetupRow(await page(deps))).toContain('data-test-state="building"');
  });

  it("shows no Test where the test Builder cannot be reached", async () => {
    const row = imageSetupRow(await page(setup().deps));
    expect(row).not.toContain("data-base-test");
  });
});

// Review finding 1: the test Builder's reports are fire-and-forget, so a test kept as building is read again from the
// test Builder on the page's poll, the page and get_status: a missed final report heals.
describe("a missed report of a test", () => {
  it("is healed by reading the test Builder while the kept record says building", async () => {
    let reads = 0;
    const { store, deps } = setup({
      testBase: async () => building,
      readTestBase: async () => (reads++, { ...failedTest, at: NOW + 60_000 }),
    });
    store.noteTestBaseBuild(building);
    const read = async () => (await handleHarness(new Request(`https://${HOST}${TEST_BASE_PATH}`), deps)).json();
    expect(await read()).toMatchObject({ record: { state: "failed" }, view: { pill: { label: "Failed" } } });
    expect(store.lastTestBaseBuild()).toMatchObject({ state: "failed" });
    // Once it has ended, the kept record is answered without asking the test Builder.
    await read();
    expect(reads).toBe(1);
    expect(imageSetupRow(await page(deps))).toContain('data-test-pill>Failed</span>');
  });

  it("keeps the record it has when the test Builder cannot be read", async () => {
    const { store } = setup();
    store.noteTestBaseBuild(building);
    const record = await refreshedTestRecord(store, async () => {
      throw new Error("no such Durable Object");
    });
    expect(record).toEqual(building);
    expect(await refreshedTestRecord(store, undefined)).toEqual(building);
  });
});

// Review findings 3–5: the page's following of a test is bounded, named, and says what the test Builder answered.
describe("the page's script for a test", () => {
  it("polls by its named constants and stops after a bounded run of failed reads, with a way to follow again", async () => {
    expect(SCRIPT).toContain(`setTimeout(follow, ${TEST_POLL_MS})`);
    expect(SCRIPT).toContain(`setTimeout(follow, ${TEST_POLL_RETRY_MS})`);
    expect(SCRIPT).toContain(`failures < ${TEST_POLL_FAILURES}`);
    expect(SCRIPT).toContain("Stopped following the test (");
    const { deps } = setup({ testBase: async () => building });
    expect(imageSetupRow(await page(deps))).toMatch(/<button type="button"[^>]*data-test-follow hidden>Follow again<\/button>/);
  });

  it("announces what the test Builder answered, not a test, for an empty proposal", () => {
    expect(SCRIPT).toContain('view.state === "building" ? "Testing the Image setup above; this shows its result when it ends." : line.charAt(0).toUpperCase()');
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
