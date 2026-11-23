// The Environment settings in the panel (SPI-1149, ADR-0032): `handleHarness` over a store, as for the Harness settings.
// Their own revision (an Environment change never moves the Harness one, and the reverse), the audit log's `entity`
// (old entries read as harness), validation, the same CSRF and Origin guards as the old routes, and the page's section.
import { describe, expect, it } from "vitest";

import { csrfToken } from "../src/harness/csrf.ts";
import type { AccessCaller } from "../src/access.ts";
import { CSRF_HEADER, handleHarness } from "../src/harness/panel.ts";
import { budgetNote, SCRIPT } from "../src/harness/pageScript.ts";
import { AUDIT_KEY, harnessStore } from "../src/harness/store.ts";

const HOST = "t3-admin.example.dev";
const NOW = Date.UTC(2026, 10, 13, 10, 30);
/** sha256 of '[tools]\nnode = "24.11.1"\n' (`shasum -a 256`). */
const SHA_OF_TEXT = "0eb09ceb981ac62b1ed4ebb30295ad081a471bb40b9ebda4eb48fcf45aae8cf3";
const owner: AccessCaller = { kind: "owner", subject: "owner-sub" };

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
  };
};

/** The Container budget DO's state as the panel reads it: two Containers running. */
const RUNNING = {
  max: 3,
  leases: [
    { holder: "a1", until: NOW + 60_000, workspace: "web-app" },
    { holder: "b2", until: NOW + 60_000, workspace: null },
  ],
};

const setup = (caller: AccessCaller = owner) => {
  const kv = memory();
  const store = harnessStore(kv);
  return { kv, store, deps: { caller, host: HOST, store, now: () => NOW, budget: async () => RUNNING } };
};

const post = (deps: ReturnType<typeof setup>["deps"], path: string, body: unknown, headers: Record<string, string>) =>
  handleHarness(
    new Request(`https://${HOST}/_t3flare/settings/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    deps,
  );

const ownerHeaders = async (store: ReturnType<typeof setup>["store"]) => ({
  origin: `https://${HOST}`,
  "sec-fetch-site": "same-origin",
  [CSRF_HEADER]: await csrfToken(store.csrfKey(), "owner-sub", NOW),
});

const getJson = async (deps: ReturnType<typeof setup>["deps"], path: string) =>
  (await handleHarness(new Request(`https://${HOST}/_t3flare/settings/api/${path}`), deps)).json() as Promise<any>;

describe("Environment settings in the panel", () => {
  it("an Environment change moves only the Environment revision; a Harness change moves only the Harness one", async () => {
    const { store, deps } = setup();
    const headers = await ownerHeaders(store);
    expect((await post(deps, "environment", { settings: { containerSize: "standard-2" } }, headers)).status).toBe(200);
    expect(store.loadEnvironment().revision).toBe(1);
    expect(store.load().revision).toBe(0);
    expect((await post(deps, "extensions", { extension: "advisor", enabled: false }, headers)).status).toBe(200);
    expect(store.load().revision).toBe(1);
    expect(store.loadEnvironment().revision).toBe(1);
    expect(await getJson(deps, "environment")).toMatchObject({
      revision: 1,
      resolved: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 },
    });
  });

  it("audits an Environment change with entity environment and the changed settings before and after; old entries read as harness", async () => {
    const { kv, store, deps } = setup({ kind: "service-token" });
    kv.put(AUDIT_KEY, [
      {
        at: NOW - 1000,
        caller: "service-token",
        action: "extension.change",
        target: "codemode",
        after: { enabled: false },
      },
    ]);
    await post(deps, "environment", { settings: { containerSize: "standard-3", containerIdleMinutes: 10 } }, {});
    await post(deps, "environment", { settings: { containerIdleMinutes: 5 } }, {});
    await post(deps, "extensions", { extension: "advisor", enabled: true }, {});
    expect(store.auditLog(10)).toMatchObject([
      { entity: "harness", action: "extension.change", target: "advisor" },
      {
        entity: "environment",
        action: "environment.change",
        target: "containerIdleMinutes",
        before: { containerIdleMinutes: 10 },
        after: { containerIdleMinutes: 5 },
      },
      {
        entity: "environment",
        action: "environment.change",
        target: "containerSize, containerIdleMinutes",
        before: { containerSize: "cpu-1", containerIdleMinutes: 2 },
        after: { containerSize: "standard-3", containerIdleMinutes: 10 },
      },
      { entity: "harness", action: "extension.change", target: "codemode", after: { enabled: false } },
    ]);
    expect((await getJson(deps, "audit")).entries[3].entity).toBe("harness");
  });

  it("audits only the settings a save moved; a save that moves none stores, bumps and audits nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const all = { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 };
    await post(deps, "environment", { settings: all }, {});
    expect(store.auditLog(5)).toMatchObject([
      { target: "containerSize", before: { containerSize: "cpu-1" }, after: { containerSize: "standard-2" } },
    ]);
    expect(store.auditLog(5)[0]?.after).toEqual({ containerSize: "standard-2" });
    const same = await post(deps, "environment", { settings: all }, {});
    expect(await same.json()).toMatchObject({ ok: true, unchanged: true, revision: 1 });
    expect(store.loadEnvironment().revision).toBe(1);
    expect(store.auditLog(5)).toHaveLength(1);
  });

  it("labels an audit entity the page does not know by its stored name (the audit entity is an open set)", async () => {
    const { kv, deps } = setup();
    kv.put(AUDIT_KEY, [
      { at: NOW, entity: "models", caller: "owner:owner-sub", action: "models.change", target: "openai" },
    ]);
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    expect(html).toContain('<td data-label="Settings"><div>models</div></td>');
  });

  it("refuses an invalid change with the setting named, and stores and audits nothing", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    for (const body of [
      { settings: { containerSize: "lite" } },
      { settings: { containerIdleMinutes: 0 } },
      { settings: { secrets: "x" } },
      { containerSize: "standard-1" },
      "[]",
    ]) {
      expect((await post(deps, "environment", body, {})).status).toBe(400);
    }
    const response = await post(deps, "environment", { settings: { containerIdleMinutes: 10_081 } }, {});
    expect(await response.text()).toContain("containerIdleMinutes: at most 10080");
    expect(store.loadEnvironment().revision).toBe(0);
    expect(store.auditLog(10)).toEqual([]);
  });

  it("refuses the owner's change without CSRF, with a wrong Origin, cross-site, or form-encoded; a script's wrong Origin too", async () => {
    const { store, deps } = setup();
    const good = await ownerHeaders(store);
    const body = { settings: { containerSize: "standard-4" } };
    expect((await post(deps, "environment", body, { ...good, [CSRF_HEADER]: "" })).status).toBe(403);
    expect((await post(deps, "environment", body, { ...good, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(deps, "environment", body, { ...good, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(
      (await post(deps, "environment", "settings=x", { ...good, "content-type": "application/x-www-form-urlencoded" }))
        .status,
    ).toBe(403);
    const script = setup({ kind: "service-token" });
    expect((await post(script.deps, "environment", body, { origin: "https://evil.example" })).status).toBe(403);
    expect(store.loadEnvironment().revision).toBe(0);
  });

  it("answers the settings with their schema, the sizes' costs at the budget set, and the Containers running now", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { containerBudget: 5 } }, await ownerHeaders(store));
    const answer = await getJson(deps, "environment");
    expect(answer.revision).toBe(1);
    expect(answer.schema.containerSize.schema.values).toEqual([
      "cpu-1",
      "standard-1",
      "standard-2",
      "standard-3",
      "standard-4",
    ]);
    expect(answer.schema.containerBudget.schema).toMatchObject({ minimum: 1, maximum: 100, default: 3 });
    expect(answer.costs.budget).toBe(5);
    expect(answer.costs.rows).toHaveLength(5);
    expect(answer.running).toEqual({ count: 2, holders: ["web-app", "b2"] });
  });

  it("tells the Environment DO when a save moved the Grace, and only then (ADR-0043 §5)", async () => {
    const { deps } = setup({ kind: "service-token" });
    let moved = 0;
    const told = { ...deps, sweepSettingsChanged: () => void moved++ };
    await post(told, "environment", { settings: { containerIdleMinutes: 5 } }, {});
    expect(moved).toBe(0);
    await post(told, "environment", { settings: { graceDays: 3 } }, {});
    expect(moved).toBe(1);
    await post(told, "environment", { settings: { graceDays: 3, sweepPurges: true } }, {});
    expect(moved).toBe(1);
    await post(told, "environment", { settings: { sweepPurges: false } }, {});
    expect(moved).toBe(2);
    expect((await post(told, "environment", { settings: { graceDays: 0 } }, {})).status).toBe(400);
    expect(moved).toBe(2);
  });

  it("keeps the Grace out of the Environment section's form: the Workspaces section shows it (ADR-0044 §1)", async () => {
    const { deps } = setup();
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    expect(html).not.toContain('data-setting="graceDays"');
    expect(html).not.toContain('data-setting="sweepPurges"');
  });

  it("refuses a budget out of 1 to 100", async () => {
    const { deps } = setup({ kind: "service-token" });
    for (const budget of [11, 100])
      expect((await post(deps, "environment", { settings: { containerBudget: budget } }, {})).status).toBe(200);
    for (const budget of [0, 101])
      expect((await post(deps, "environment", { settings: { containerBudget: budget } }, {})).status).toBe(400);
  });

  it("shows an Environment section with the size, the idle time, the budget beside the running Containers, and the cost table", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { containerSize: "standard-1" } }, await ownerHeaders(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    expect(html).toContain('id="environment"');
    expect(html).toMatch(/<option value="standard-1" selected>/);
    expect(html).toContain('data-setting="containerIdleMinutes"');
    expect(html).toContain('data-setting="containerBudget"');
    expect(html).toContain("$1.20");
    expect(html).toMatch(/Running now<\/dt><dd>2 of 3/);
    // The current size's row and the summary; each row carries its one-Container hour for the script's live update.
    expect(html).toMatch(/<tr data-size="standard-1" data-per-hour="0\.074016" aria-current="true">/);
    expect(html).toContain("With these settings, at most $0.22 an hour: 3 Containers of standard-1, every vCPU busy.");
    expect(html).toContain("data-budget-head>3 Containers, an hour<");
    expect(html).toContain("web-app");
    // The budget's consequence, stated once, and rewritten by the script as the budget input changes.
    const note =
      "Each running Container is billed for its size; at this budget, up to 3 can run at once. Your Cloudflare account&#39;s own Container limits (concurrent memory, vCPU and disk) also apply; t3flare does not check them.";
    expect(html.split(note)).toHaveLength(2);
    expect(html).toContain('aria-describedby="environment-containerBudget-hint environment-containerBudget-note"');
    expect(html).toContain(`<p class="hint" id="environment-containerBudget-note" data-budget-note>${note}</p>`);
    // The script's rewrite is the note's text around the input's count, as page.ts renders it (no code is built here).
    const [before, after, ...rest] = budgetNote(40).split("40");
    expect(rest).toEqual([]);
    expect(SCRIPT).toContain(`budgetLine.textContent = ${JSON.stringify(before)} + count + ${JSON.stringify(after)};`);
    expect(budgetNote(40)).toContain("up to 40 can run at once.");
  });

  it("audits the Global mise config as its size and SHA-256, never its text", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const text = '[tools]\nnode = "24.11.1"\n';
    await post(deps, "environment", { settings: { globalMiseConfig: text } }, {});

    expect(store.auditLog(1)).toEqual([
      expect.objectContaining({
        entity: "environment",
        target: "globalMiseConfig",
        before: {
          globalMiseConfig: { bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
        },
        after: { globalMiseConfig: { bytes: 25, sha256: SHA_OF_TEXT } },
      }),
    ]);
    expect(JSON.stringify(store.auditLog(1))).not.toContain("24.11.1");
  });

  it("renders the Global mise config as a text area without maxlength, its first newline kept", async () => {
    const { store, deps } = setup();
    await post(deps, "environment", { settings: { globalMiseConfig: "\n[tools]\n" } }, await ownerHeaders(store));
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    const area = /<textarea[^>]*data-setting="globalMiseConfig"[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
    expect(area).not.toBeNull();
    expect(area![0]).not.toContain("maxlength");
    expect(area![0]).toContain('data-kind="file"');
    // An HTML parser drops one newline right after <textarea>: the page writes one, so the text's own survives.
    expect(area![1]).toBe("\n\n[tools]\n");
    expect(html).toContain("put no secret in it");
  });

  it("shows the last Global mise lay-down in Status, and refuses a malformed one", async () => {
    const { store, deps } = setup();
    expect((await getJson(deps, "status"))["last Global mise lay-down"]).toBeNull();
    const report = {
      workspace: "web-app",
      runtime: "r1",
      revision: 3,
      sha256: SHA_OF_TEXT,
      bytes: 25,
      source: "environment",
      outcome: "not-laid",
      install: 1,
      timedOut: false,
      ms: 900,
      at: NOW,
    };
    expect(store.noteGlobalMise(report)).toBe(true);
    expect(store.noteGlobalMise({ ...report, workspace: "x".repeat(10_000) })).toBe(false);
    expect(store.noteGlobalMise({ ...report, outcome: "maybe" })).toBe(false);
    expect((await getJson(deps, "status"))["last Global mise lay-down"]).toBe(
      "web-app at revision 3: not laid down (mise install exit 1), 2026-11-13T10:30:00.000Z",
    );
  });

  it("shows the last Container setup in Status with the end of its output, and refuses a malformed report (ADR-0047 §7)", async () => {
    const { store, deps } = setup();
    expect((await getJson(deps, "status"))["last Container setup"]).toBeNull();
    expect((await getJson(deps, "status"))["last Container setup output"]).toBeNull();
    const report = {
      workspace: "web-app",
      runtime: "r1",
      revision: 4,
      sha256: SHA_OF_TEXT,
      bytes: 25,
      source: "environment",
      outcome: "failed",
      exitCode: 2,
      timedOut: false,
      output: "E: Unable to locate package ripgrep\n",
      failure: "carryOn",
      ms: 2_400,
      at: NOW,
    };
    expect(store.noteContainerSetup(report)).toBe(true);
    expect(store.noteContainerSetup({ ...report, output: 7 })).toBe(false);
    expect(store.noteContainerSetup({ ...report, outcome: "maybe" })).toBe(false);
    const status = await getJson(deps, "status");
    expect(status["last Container setup"]).toBe(
      "web-app at revision 4: failed, exit 2 after 2.4 s, 2026-11-13T10:30:00.000Z",
    );
    expect(status["last Container setup output"]).toBe("E: Unable to locate package ripgrep\n");
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    // A region named by its label, opening at the end of the output (column-reverse around one span).
    expect(html).toMatch(
      /<dt id="status-container-setup-output">last Container setup output<\/dt><dd><pre class="status-output" tabindex="0" role="region" aria-labelledby="status-container-setup-output"><span>E: Unable to locate package ripgrep\n<\/span><\/pre>/,
    );
  });

  it("shows a Container setup with no output as a block that says so, and one line of output as a block too", async () => {
    const { store, deps } = setup();
    const report = {
      workspace: "web-app",
      runtime: "r1",
      revision: 4,
      sha256: SHA_OF_TEXT,
      bytes: 25,
      source: "environment",
      outcome: "ok",
      exitCode: 0,
      timedOut: false,
      output: "",
      failure: "carryOn",
      ms: 10,
      at: NOW,
    };
    store.noteContainerSetup(report);
    const page = async () => (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    expect(await page()).toMatch(/<pre class="status-output"[^>]*><span>\(no output\)<\/span><\/pre>/);
    store.noteContainerSetup({ ...report, output: "done" });
    expect(await page()).toMatch(/<pre class="status-output"[^>]*><span>done<\/span><\/pre>/);
  });

  it("renders the Container setup's time limit and failure policy in its row, the policy by label", async () => {
    const { deps } = setup();
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    const row =
      /<div class="row"><div class="row-title"><h3>Container setup<\/h3>[\s\S]*?<\/div><\/div><\/div>/.exec(
        html,
      )?.[0] ?? "";
    expect(row).toContain('data-setting="containerSetup"');
    expect(row).toContain('data-setting="containerSetupMinutes"');
    expect(row).toContain(
      '<option value="carryOn" selected>Carry on</option><option value="refuse">Refuse commands</option>',
    );
    const containers = /<h3>Containers<\/h3>[\s\S]*?<\/div><\/div><\/div>/.exec(html)?.[0] ?? "";
    expect(containers).not.toContain("containerSetup");
  });

  it("renders the Global mise install time limit in the Global mise config's row (SPI-1313)", async () => {
    const { deps } = setup();
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    const row =
      /<div class="row"><div class="row-title"><h3>Global mise config<\/h3>[\s\S]*?<\/div><\/div><\/div>/.exec(
        html,
      )?.[0] ?? "";
    expect(row).toContain('data-setting="globalMiseInstallMinutes"');
    expect(row).toContain('min="1" max="10080" step="1" value="10"');
    const containers = /<h3>Containers<\/h3>[\s\S]*?<\/div><\/div><\/div>/.exec(html)?.[0] ?? "";
    expect(containers).not.toContain("globalMiseInstallMinutes");
  });
});

// SPI-1152: the Variables in the same section and guards; the audit log keeps names and values (the page shows them to
// the owner anyway), the Workers Logs line neither.
describe("Variables in the panel", () => {
  it("stores a set of Variables through the same route and audits their names and values before and after", async () => {
    const { store, deps } = setup();
    const headers = await ownerHeaders(store);
    expect(
      (await post(deps, "environment", { settings: { variables: { NODE_ENV: "development" } } }, headers)).status,
    ).toBe(200);
    const logged: Array<string> = [];
    const log = console.log;
    console.log = (line: string) => void logged.push(line);
    try {
      expect(
        (
          await post(
            deps,
            "environment",
            {
              settings: {
                variables: [
                  { name: "NODE_ENV", value: "test", secret: false },
                  { name: "REGION", value: "eu", secret: false },
                ],
              },
            },
            headers,
          )
        ).status,
      ).toBe(200);
    } finally {
      console.log = log;
    }
    const now = [
      { name: "NODE_ENV", value: "test", secret: false },
      { name: "REGION", value: "eu", secret: false },
    ];
    expect(await getJson(deps, "environment")).toMatchObject({ revision: 2, resolved: { variables: now } });
    expect(store.auditLog(1)).toMatchObject([
      {
        entity: "environment",
        action: "environment.change",
        target: "variables",
        before: { variables: [{ name: "NODE_ENV", value: "development", secret: false }] },
        after: { variables: now },
      },
    ]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({
      t3flare: "harness-change",
      entity: "environment",
      caller: "owner",
      action: "environment.change",
      target: "variables",
    });
  });

  it("refuses only what breaks t3flare, with the whole reason, and stores nothing (ADR-0046 §3)", async () => {
    const { store, deps } = setup({ kind: "service-token" });
    const named = await post(deps, "environment", { settings: { variables: { "MY-VAR": "x" } } }, {});
    expect(named.status).toBe(400);
    expect(await named.text()).toBe(
      'variables: "MY-VAR" is not a name a shell can export: letters, digits and _, not starting with a digit\n',
    );
    const value = await post(deps, "environment", { settings: { variables: { OK: "a\u0000b" } } }, {});
    expect(await value.text()).toBe('variables: "OK"\'s value holds a NUL character, which no environment can\n');
    expect(store.loadEnvironment().revision).toBe(0);
    expect(store.auditLog(5)).toEqual([]);
    // What the old rules refused now stores: a credential-looking name and value, a name t3flare sets.
    expect(
      (
        await post(
          deps,
          "environment",
          { settings: { variables: { GITHUB_TOKEN: `ghp_${"b".repeat(36)}`, PATH: "/opt/bin" } } },
          {},
        )
      ).status,
    ).toBe(200);
  });

  it("shows the Variables as a list in the Environment section: each name and value, escaped, and a way to add one", async () => {
    const { store, deps } = setup();
    await post(
      deps,
      "environment",
      { settings: { variables: { NODE_ENV: "test", GREETING: '<b>"hi"</b>' } } },
      await ownerHeaders(store),
    );
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), deps)).text();
    expect(html).toContain('data-setting="variables" data-kind="variables"');
    expect(html).toContain('<input type="text" data-variable-name aria-label="Name" value="NODE_ENV"');
    expect(html).toContain(">test</textarea>");
    expect(html).toContain("&lt;b&gt;&quot;hi&quot;&lt;/b&gt;</textarea>");
    expect(html).not.toContain('<b>"hi"</b>');
    expect(html).toContain("data-variable-add");
  });
});
