// The Settings server's reads after the SPI-1198 review (plan D14, D16): a read writes no audit entry, so reads
// cannot evict the log of changes; reads are capped per caller, and those that reach GitHub or an MCP server more
// tightly; `preview_skills` (it mints a GitHub App token) is for a caller that may write; and only what describes the MCP
// server set is scrubbed of URL queries, so Variables, the Global mise config and a SKILL.md read as they are and a
// read-then-write round-trips unchanged.
import {
  applyMcpChange,
  EMPTY_HARNESS,
  type StoredHarness,
  DEFAULT_SETTINGS_SERVER_LIMITS,
  SETTINGS_SERVER_LIMIT_KEYS,
} from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { DURABLE_AGENT, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import { READS_TABLE } from "../src/settings/changes.ts";
import { NO_MODES_REFUSAL } from "../src/settings/server.ts";
import {
  CAPPED_HARNESS,
  CAPPED_LIMITS,
  settingsFixture,
  type SettingsFixture,
  structured,
  textOf,
} from "./settingsFixture.ts";
import { skillMd } from "./skillRepo.fixture.ts";

// The Settings server's limits as the fixture's Owner set them (SPI-1322: they are its entry's settings; off by default
// since SPI-1386).
const NETWORK_READ_CAP = CAPPED_LIMITS.networkReadsPerHour;
const READ_CAP = CAPPED_LIMITS.readsPerHour;

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());

/** A Direct server the owner added, over the caps an Owner set unless `base` says otherwise: what `test_mcp_server` reaches. */
const withDocs = (base: StoredHarness = CAPPED_HARNESS): StoredHarness => {
  const added = applyMcpChange(base, {
    op: "add",
    server: "docs",
    url: "https://docs.example/mcp",
    auth: { kind: "none" },
  });
  if (!added.ok) throw new Error(added.error);
  return added.harness;
};

describe("reads leave the audit log alone and are capped", () => {
  it("test_mcp_server through the server writes no audit entry, however often it runs", async () => {
    fixture = settingsFixture({ harness: withDocs() });
    const run = fixture;
    for (let index = 0; index < 5; index++) await run.call(run.durable(), "test_mcp_server", { server: "docs" });
    expect(run.store.auditLog(1_000)).toEqual([]);
  });

  it(`at most ${NETWORK_READ_CAP} reads that reach the network and ${READ_CAP} reads in all, per thread per hour`, async () => {
    fixture = settingsFixture({ harness: withDocs() });
    const run = fixture;
    for (let index = 0; index < NETWORK_READ_CAP; index++)
      expect(structured(await run.call(run.durable(), "test_mcp_server", { server: "docs" }))).toBeDefined();
    const capped = await run.call(run.durable(), "test_mcp_server", { server: "docs" });
    expect(capped).toMatchObject({ kind: "result", isError: true });
    expect(textOf(capped)).toContain(`${NETWORK_READ_CAP} reads that reach GitHub or an MCP server`);
    expect(textOf(capped)).toContain(
      `the limit of ${NETWORK_READ_CAP} an hour; change it under MCP servers › Settings server › Advanced › Network reads an hour.`,
    );
    // Other reads still run, until the overall cap.
    for (let index = NETWORK_READ_CAP; index < READ_CAP; index++)
      expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    expect(textOf(await run.call(run.durable(), "get_status"))).toContain(
      `${READ_CAP} settings reads in the last hour, the limit of ${READ_CAP} an hour; change it under MCP servers › Settings server › Advanced › Reads an hour.`,
    );
    // Another thread has its own count; an hour later the first reads again.
    expect(await run.call(run.durable("thread-other"), "get_status")).toMatchObject({ isError: false });
    run.advance(60 * 60_000 + 1);
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
  });
});

/** The Harness settings with the Settings server's `limits` set (SPI-1322), as a saved Limits form stores them. */
const withLimits = (stored: StoredHarness, limits: Record<string, number>): StoredHarness => {
  const applied = applyMcpChange(stored, { op: "server", server: "settings", limits });
  if (!applied.ok) throw new Error(applied.error);
  return applied.harness;
};

describe("the read caps are the Settings server's limits (SPI-1322)", () => {
  it("readsPerHour: 2 refuses the third read; networkReadsPerHour: 1 the second network read", async () => {
    fixture = settingsFixture({ harness: withLimits(withDocs(), { readsPerHour: 2, networkReadsPerHour: 1 }) });
    const run = fixture;
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    expect(textOf(await run.call(run.durable(), "get_status"))).toContain("made 2 settings reads in the last hour");
    expect(structured(await run.call(run.durable("thread-net"), "test_mcp_server", { server: "docs" }))).toBeDefined();
    expect(textOf(await run.call(run.durable("thread-net"), "test_mcp_server", { server: "docs" }))).toContain(
      "made 1 reads that reach GitHub or an MCP server",
    );
  });

  it("off (the defaults, SPI-1386), no read is refused, and none is counted", async () => {
    fixture = settingsFixture({ harness: withDocs(EMPTY_HARNESS) });
    const run = fixture;
    expect(DEFAULT_SETTINGS_SERVER_LIMITS).toMatchObject({ readsPerHour: 0, networkReadsPerHour: 0 });
    for (let at = 0; at < 300; at++)
      expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    for (let at = 0; at < 30; at++)
      expect(
        structured(await run.call(run.durable("thread-net"), "test_mcp_server", { server: "docs" })),
      ).toBeDefined();
    const kept = run.sql.exec("SELECT name FROM sqlite_master WHERE name = ?", READS_TABLE).toArray();
    const counted =
      kept.length === 0 ? 0 : run.sql.exec(`SELECT COUNT(*) AS count FROM ${READS_TABLE}`).toArray()[0]!.count;
    expect(counted).toBe(0);
  });

  it("a raised cap applies at the caller's next read, to the reads already counted", async () => {
    fixture = settingsFixture({ harness: withLimits(EMPTY_HARNESS, { readsPerHour: 1 }) });
    const run = fixture;
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: true });
    run.store.save(withLimits(run.store.load(), { readsPerHour: 3 }));
    expect(await run.call(run.durable(), "get_status")).toMatchObject({ isError: false });
  });

  it("list_mcp_servers shows the Settings server's limits, resolved", async () => {
    fixture = settingsFixture({ harness: withLimits(CAPPED_HARNESS, { askedPerHour: 12 }) });
    const run = fixture;
    const listed = structured(await run.call(run.durable(), "list_mcp_servers", { server: "settings" })) as {
      servers: Array<{ name: string; limits?: Record<string, number> }>;
    };
    expect(listed.servers.find((server) => server.name === "settings")?.limits).toMatchObject({
      askedPerHour: 12,
      strikes: 3,
      readsPerHour: 240,
    });
  });
});

// ADR-0035's ADR-0049 refinement (SPI-1385): the reads report each setting's disclosure and its place on the page, so an
// agent can point the Owner to a setting the page does not show at once.
describe("the reads report where the Settings page shows each setting", () => {
  it("get_settings reports each Environment and Harness setting's disclosure and place", async () => {
    fixture = settingsFixture();
    const run = fixture;
    type Row = { key: string; disclosure: string; shownWhen?: string; where: string };
    const environment = structured(await run.call(run.durable(), "get_settings", { entity: "environment" })) as {
      settings: Array<Row>;
    };
    const byKey = (rows: Array<Row>, key: string) => rows.find((row) => row.key === key);
    expect(environment.settings.every((row) => ["visible", "contextual", "advanced"].includes(row.disclosure))).toBe(
      true,
    );
    expect(byKey(environment.settings, "containerSize")).toMatchObject({
      disclosure: "visible",
      where: "Environment › Container size",
    });
    expect(byKey(environment.settings, "cloneMinutes")).toMatchObject({
      disclosure: "advanced",
      where: "Environment › Advanced › Clone time limit (minutes)",
    });
    expect(byKey(environment.settings, "containerSetupMinutes")).toMatchObject({
      disclosure: "contextual",
      shownWhen: "shown while Container setup is not empty",
      where: "Environment › Container setup › Container setup time limit (minutes)",
    });
    const harness = structured(await run.call(run.durable(), "get_settings", { entity: "harness" })) as {
      extensions: Array<{ id: string; settings: Array<Row> }>;
    };
    const guardian = harness.extensions.find((entry) => entry.id === "guardian")!.settings;
    expect(byKey(guardian, "model")).toMatchObject({
      disclosure: "contextual",
      shownWhen: "shown while Guardian is on",
    });
    expect(byKey(guardian, "reviewTimeoutSeconds")).toMatchObject({
      disclosure: "advanced",
      shownWhen: "shown while Guardian is on",
      where: "turn Guardian on, then Extensions › Guardian › Advanced › Review time limit (seconds)",
    });
  });

  it("get_settings reports the Settings server's own limits, each under its card's Advanced", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const harness = structured(await run.call(run.durable(), "get_settings", { entity: "harness" })) as {
      settingsServerLimits: Array<{ key: string; value: number; disclosure: string; where: string; tier: string }>;
    };
    expect(harness.settingsServerLimits.map((limit) => limit.key)).toEqual([...SETTINGS_SERVER_LIMIT_KEYS]);
    expect(harness.settingsServerLimits.find((limit) => limit.key === "strikes")).toMatchObject({
      value: CAPPED_LIMITS.strikes,
      tier: "asked",
      disclosure: "advanced",
      where: "MCP servers › Settings server › Advanced › Strikes",
    });
  });

  it("list_mcp_servers reports the Settings server's limits under its Advanced", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const listed = structured(await run.call(run.durable(), "list_mcp_servers", { server: "settings" })) as {
      servers: Array<{ name: string; limitsDisclosure?: Record<string, { disclosure: string; where: string }> }>;
    };
    expect(listed.servers.find((server) => server.name === "settings")?.limitsDisclosure?.strikes).toEqual({
      disclosure: "advanced",
      where: "MCP servers › Settings server › Advanced › Strikes",
    });
  });
});

describe("preview_skills is for a caller that may write", () => {
  it("is refused to mode-less and plan-mode threads, and runs for a thread that may write", async () => {
    fixture = settingsFixture();
    const run = fixture;
    run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    const before = run.github.requests.length;
    expect(
      textOf(
        await run.call({ door: "own", thread: "thread-fresh", agent: DURABLE_AGENT }, "preview_skills", {
          source: "o/r",
        }),
      ),
    ).toContain(NO_MODES_REFUSAL);
    const owner = {};
    noteDurableModes("thread-plan", { runtimeMode: "full-access", interactionMode: "plan" }, owner);
    try {
      expect(
        textOf(
          await run.call({ door: "own", thread: "thread-plan", agent: DURABLE_AGENT }, "preview_skills", {
            source: "o/r",
          }),
        ),
      ).toContain("plan mode");
    } finally {
      forgetDurableModes("thread-plan", owner);
    }
    // None of them reached GitHub.
    expect(run.github.requests.length).toBe(before);
    const own = await run.call(run.durable(), "preview_skills", { source: "o/r" });
    expect(structured(own)).toMatchObject({ skills: [{ name: "a" }] });
  });

  it("counts toward the network read cap", async () => {
    fixture = settingsFixture();
    const run = fixture;
    run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a") });
    for (let index = 0; index < NETWORK_READ_CAP; index++)
      await run.call(run.durable(), "preview_skills", { source: "o/r" });
    expect(textOf(await run.call(run.durable(), "preview_skills", { source: "o/r" }))).toContain(
      "reach GitHub or an MCP server",
    );
  });
});

describe("reads show Variables, the Global mise config and a SKILL.md as they are (plan D14)", () => {
  const VARIABLES = { DOCS_URL: "https://docs.example/path?token=abc&x=1", NOTE: "see https://a.example/?q=1" };
  const MISE = '[env]\nMIRROR = "https://mirror.example/simple?index=2"\n';

  it("get_settings answers them unchanged, and writing back what was read is unchanged", async () => {
    fixture = settingsFixture();
    const run = fixture;
    run.store.saveEnvironment({ revision: 3, settings: { variables: VARIABLES, globalMiseConfig: MISE } });
    const read = structured(await run.call(run.durable(), "get_settings", { entity: "environment" }))!;
    const value = (key: string) => read.settings.find((setting: { key: string }) => setting.key === key).value;
    // The old stored shape reads as ADR-0046's list, every Variable plain.
    expect(value("variables")).toEqual(
      Object.entries(VARIABLES).map(([name, text]) => ({ name, value: text, secret: false })),
    );
    expect(value("globalMiseConfig")).toBe(MISE);
    const written = await run.call(run.durable(), "change_environment", {
      expectedRevision: read.revision,
      settings: { variables: value("variables"), globalMiseConfig: value("globalMiseConfig") },
    });
    expect(structured(written)).toEqual({ status: "unchanged", revision: 3 });
    expect(run.cards).toEqual([]);
  });

  it("list_skills answers a SKILL.md with its URLs whole; list_mcp_servers still drops a Direct server's query", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const text = "Read https://docs.example/guide?version=2 first.";
    const commit = run.github.push("o/r", { "skills/a/SKILL.md": skillMd("a", text) });
    const { changeSkills } = await import("../src/harness/ops.ts");
    expect(
      (
        await changeSkills(
          run.deps.ops,
          "/install",
          { source: "o/r", commit, folders: ["skills/a"] },
          { actor: { caller: "owner:o" } },
        )
      ).status,
    ).toBe(200);
    expect(structured(await run.call(run.durable(), "list_skills", { name: "a" }))!.skillMd).toContain(text);
    const { addMcpServer } = await import("../src/harness/ops.ts");
    await addMcpServer(
      run.deps.ops,
      { server: "keyed", url: "https://keyed.example/mcp?key=q-s3cr3t", auth: { kind: "none" } },
      { actor: { caller: "owner:o" } },
    );
    const listed = JSON.stringify(await run.call(run.durable(), "list_mcp_servers"));
    expect(listed).toContain("https://keyed.example/mcp");
    expect(listed).not.toContain("q-s3cr3t");
  });
});
