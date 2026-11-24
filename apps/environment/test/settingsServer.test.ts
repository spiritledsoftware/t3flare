// T-own (plan §5; ADR-0035, plan D2, D7, D14, D16, D17), M3 (SPI-1198): the Settings server for t3flare's own agents,
// through the MCP host as the Environment wires it. D7's mode table, every cell, for a Durable caller (modes from the
// adapter's record) and a relayed CLI caller (modes from its live session); the access switch; no `resume` and no Pause;
// reads that carry no secret value, fingerprint, URL query or authorization URL; the applied cap. Since M4 (SPI-1199) an
// asked change asks on the owner-only card in every mode but plan (settingsCard.test.ts covers the card itself).
import {
  applyMcpChange,
  applyEnvironmentChange,
  type BaseBuildRecord,
  EMPTY_HARNESS,
  MAX_SETUP_BYTES,
  PLAN_REFUSAL,
  DEFAULT_OWNER_ANSWER_MS,
  settingsServerLimitsOf,
  type StoredHarness,
} from "@t3flare/harness-registry";
import {
  MCP_QUESTION_MARKER,
  type McpAsker,
  type McpQuestionAnswer,
  type McpQuestionCard,
} from "@t3flare/session-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { harnessSecrets } from "../src/harness/secrets.ts";
import { addMcpServer, beginMcpSignIn } from "../src/harness/ops.ts";
import { harnessStore } from "../src/harness/store.ts";
import { pauseOf } from "../src/mcp/elicitation.ts";
import { type McpCallAnswer, McpHost } from "../src/mcp/host.ts";
import { registerCliAsker } from "../src/provider/cli/cliAsk.ts";
import { cliThreadState } from "../src/provider/cli/cliAsk.ts";
import { DURABLE_AGENT, durableModes, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import {
  CHANGE_ARGS_BYTES,
  CHANGE_RECORD_BYTES,
  capKeyOf,
  type ChangeRecord,
  settingsChanges,
} from "../src/settings/changes.ts";
import { OFF_MESSAGE, type OwnCaller } from "../src/settings/caller.ts";
import { NO_MODES_REFUSAL, READ_ONLY_REFUSAL, settingsCall } from "../src/settings/server.ts";
import { SETTINGS_TOOLS } from "../src/settings/tools.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { BUDGETED_ENVIRONMENT, CAPPED_HARNESS, CAPPED_LIMITS, memory, structured, textOf } from "./settingsFixture.ts";

// The Settings server's limits as this world's Owner set them (SPI-1322: they are its entry's settings; off by default
// since SPI-1386).
const APPLIED_CAP = CAPPED_LIMITS.appliedPerHour;

const NOW = Date.UTC(2026, 10, 14, 12, 0);
const ORIGIN = "https://t3.example.dev";
const SECRET = "sekret-header-value-0042";

const MODES = {
  plan: { runtimeMode: "full-access", interactionMode: "plan" },
  "approval-required": { runtimeMode: "approval-required", interactionMode: "default" },
  "auto-accept-edits": { runtimeMode: "auto-accept-edits", interactionMode: "default" },
  "full-access": { runtimeMode: "full-access", interactionMode: "default" },
} as const;
type ModeName = keyof typeof MODES;

const unregisters: Array<() => void> = [];
const owner = {};
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});

/** Records `mode` for `caller`'s thread where the Environment keeps it: the adapter's record, or the CLI's live session. */
const recordModes = (caller: OwnCaller, mode: ModeName) => {
  const modes = MODES[mode];
  if (caller.agent === DURABLE_AGENT) {
    noteDurableModes(caller.thread!, modes, owner);
    unregisters.push(() => forgetDurableModes(caller.thread!, owner));
  } else {
    unregisters.push(
      registerCliAsker(caller.thread!, {
        state: () => ({ ...modes, workspace: "ws-1" }),
        ask: async () => ({ approved: false, reason: "not this card" }),
      }),
    );
  }
};

const setup = (
  options: {
    answer?: McpQuestionAnswer;
    harness?: StoredHarness;
    cardWaitMs?: number;
    /** The Base snapshot's record and the Builder's Rebuild (SPI-1332). */
    base?: { readonly record?: BaseBuildRecord; readonly rebuild?: (reason: string) => Promise<BaseBuildRecord> };
    /** The last Test base build's record and the test Builder's Test (SPI-1334). */
    test?: {
      readonly record?: BaseBuildRecord;
      readonly run?: (imageSetup: string, reason: string) => Promise<BaseBuildRecord>;
    };
  } = {},
) => {
  let now = NOW;
  const kv = memory();
  const store = harnessStore(kv);
  // An Owner who set the Settings server's limits and a Container budget of 3 (their values before SPI-1386).
  store.save(options.harness ?? CAPPED_HARNESS);
  store.saveEnvironment(BUDGETED_ENVIRONMENT);
  const secrets = harnessSecrets(kv, () => now);
  const cards: Array<McpQuestionCard> = [];
  const withdrawn: Array<string> = [];
  const asker: McpAsker = {
    ask: async (card) => {
      cards.push(card);
      return options.answer ?? { decision: "accept" };
    },
    withdraw: (id) => void withdrawn.push(id),
  };
  const oauth = {
    begin: async () => ({
      ok: true as const,
      value: { authorizationUrl: "https://auth.example/authorize?state=s3cr3t-state", registration: "dynamic" },
    }),
    status: () => ({ signedIn: false, expiresAt: null, refreshable: false }),
    forget: () => undefined,
    accessToken: async () => undefined,
  };
  // As the Environment DO wires it (SPI-1322): the Settings server's limits as stored now.
  const stored = settingsChanges(
    nodeSqlStorage(),
    () => now,
    undefined,
    () => DEFAULT_OWNER_ANSWER_MS,
    () => settingsServerLimitsOf(store.load()),
  );
  // Every applied change's row, as the changes table keeps it.
  const applied: Array<ChangeRecord> = [];
  const changes = {
    ...stored,
    recordApplied: (record: ChangeRecord) => (applied.push(record), stored.recordApplied(record)),
  };
  const logs: Array<Record<string, unknown>> = [];
  const host: McpHost = new McpHost({
    kv,
    engine: undefined,
    settings: () => store.load(),
    now: () => now,
    settingsServer: (input) =>
      settingsCall(
        {
          ops: { store, mcp: host, secrets, oauth, now: () => now },
          oauthStatus: oauth.status,
          // As the Environment DO wires it: a Durable thread's modes are the adapter's record, a CLI's its live session's.
          modes: (caller) =>
            caller.thread === undefined
              ? undefined
              : caller.agent === DURABLE_AGENT
                ? durableModes(caller.thread)
                : cliThreadState(caller.thread),
          changes,
          origin: () => ORIGIN,
          status: () => ({ "settings revision": store.load().revision }),
          running: async () => ({ count: 0, holders: [] }),
          log: (event) => void logs.push(event),
          ...(options.cardWaitMs === undefined ? {} : { cardWaitMs: options.cardWaitMs }),
          ...(options.base === undefined ? {} : { baseBuild: () => options.base?.record }),
          ...(options.base?.rebuild === undefined ? {} : { rebuildBase: options.base.rebuild }),
          ...(options.test === undefined ? {} : { testBaseBuild: async () => options.test?.record }),
          ...(options.test?.run === undefined ? {} : { testBase: options.test.run }),
        },
        input,
      ),
  });
  const call = (caller: OwnCaller, tool: string, args: Record<string, unknown> = {}) =>
    host.call({ server: "settings", tool, args, caller, asker });
  return {
    kv,
    store,
    secrets,
    oauth,
    host,
    call,
    cards,
    withdrawn,
    logs,
    applied,
    changes,
    advance: (ms: number) => (now += ms),
  };
};

const durable = (thread = "thread-d"): OwnCaller => ({ door: "own", thread, agent: DURABLE_AGENT });
const relayed = (thread = "thread-c"): OwnCaller => ({ door: "own", thread, agent: "codex" });

/** A free change (the idle time lowered: `down-free`, ADR-0048) and an asked one (the budget turned up), both to the Environment. */
const FREE = { expectedRevision: 0, settings: { containerIdleMinutes: 1 } };
const ASKED = { expectedRevision: 0, settings: { containerBudget: 4 } };

describe("the Settings server: D7's mode table, every cell", () => {
  for (const [kind, caller] of [
    ["a Durable caller", durable],
    ["a relayed CLI caller", relayed],
  ] as const) {
    describe(kind, () => {
      for (const mode of Object.keys(MODES) as Array<ModeName>) {
        it(`${mode}: a read runs`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "get_settings", { entity: "environment" });
          expect(answer).toMatchObject({ kind: "result", isError: false });
          expect(structured(answer)).toMatchObject({ entity: "environment", revision: 0 });
          expect(run.cards).toEqual([]);
        });

        it(`${mode}: a free change ${mode === "plan" ? "is refused" : mode === "full-access" ? "runs" : "asks on one card"}`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "change_environment", FREE);
          if (mode === "plan") {
            expect(structured(answer)).toEqual({ status: "refused" });
            expect(textOf(answer)).toBe(PLAN_REFUSAL);
            expect(run.store.loadEnvironment().revision).toBe(0);
            expect(run.cards).toEqual([]);
            return;
          }
          expect(structured(answer)).toMatchObject({ status: "applied", revision: 1 });
          expect(run.store.loadEnvironment().settings.containerIdleMinutes).toBe(1);
          expect(run.cards.length).toBe(mode === "full-access" ? 0 : 1);
        });

        it(`${mode}: an asked change ${mode === "plan" ? "is refused" : "asks on one card, full access included"}`, async () => {
          const run = setup();
          recordModes(caller(), mode);
          const answer = await run.call(caller(), "change_environment", ASKED);
          if (mode === "plan") {
            expect(answer).toMatchObject({ kind: "result", isError: true });
            expect(textOf(answer)).toBe(PLAN_REFUSAL);
            expect(run.store.loadEnvironment().revision).toBe(0);
            expect(run.cards).toEqual([]);
            return;
          }
          expect(structured(answer)).toMatchObject({ status: "applied", revision: 1 });
          expect(run.store.loadEnvironment().settings.containerBudget).toBe(4);
          expect(run.cards.length).toBe(1);
          expect(run.cards[0]!.prompt).toContain("containerBudget: 3 to 4 (turned up)");
          expect(run.store.auditLog(1)[0]).toMatchObject({ tier: "asked", mode: "card", answeredBy: "card" });
        });
      }
    });
  }
});

describe("the Settings server's card for a free change", () => {
  it("is an owner-only approval card with no field, written by the server", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    await run.call(durable(), "change_environment", FREE);
    const [card] = run.cards;
    expect(card).toMatchObject({ kind: "approval", server: "settings", title: "settings: change_environment?" });
    expect(card!.id).toContain(MCP_QUESTION_MARKER);
    expect(card!.questions).toBeUndefined();
    expect(card!.options?.map((option) => option.decision)).toEqual(["accept", "decline", "cancel"]);
    expect(card!.prompt).toContain("containerIdleMinutes: 2 to 1");
    expect(card!.prompt).toContain(`Asked by ${DURABLE_AGENT} on thread thread-d`);
    expect(card!.prompt).toContain("Applies when each Workspace's Container next starts");
  });

  it("a change to the Grace applies at the next Sweep, not at a Container start (ADR-0043 §2)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const answer = await run.call(durable(), "change_environment", {
      expectedRevision: 0,
      settings: { graceDays: 14 },
    });
    expect(structured(answer)).toMatchObject({ status: "applied", appliesAt: expect.stringContaining("next Sweep") });
    expect(run.cards[0]!.prompt).toContain("Applies at the next Sweep");
    expect(run.cards[0]!.prompt).not.toContain("Container next starts");
    // Both kinds in one change: both texts.
    await run.call(durable(), "change_environment", {
      expectedRevision: 1,
      settings: { graceDays: 15, containerIdleMinutes: 1 },
    });
    expect(run.cards[1]!.prompt).toContain("Applies at the next Sweep");
    expect(run.cards[1]!.prompt).toContain("Container next starts");
    expect(SETTINGS_TOOLS.find((tool) => tool.name === "change_environment")!.description).toContain("next Sweep");
  });

  it("a change to the MCP calls' settings applies at the next call, never a Container start (SPI-1359)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const smaller = await run.call(durable(), "change_environment", {
      expectedRevision: 0,
      settings: { mcpCallSeconds: 60, mcpResultKiB: 256 },
    });
    expect(structured(smaller)).toMatchObject({
      status: "applied",
      appliesAt:
        "Applies at the next MCP call; a CLI agent's own tool timeout and MCP start wait at its next start; the sign-in time to sign-ins started after it.",
    });
    for (const card of run.cards) expect(card.prompt).not.toContain("Container next starts");
    expect(SETTINGS_TOOLS.find((tool) => tool.name === "change_environment")!.description).toContain(
      "mcpCallSeconds and mcpResultKiB at the next MCP call",
    );
  });

  it("a change to a setting read at its own next use says so, never a Container start (SPI-1366)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const lower = await run.call(durable(), "change_environment", {
      expectedRevision: 0,
      settings: { idleAfterSeconds: 30, textGenerationSeconds: 60 },
    });
    expect(structured(lower)).toMatchObject({
      status: "applied",
      appliesAt: "Applies at each one's next use, as its description says; no Container start is needed.",
    });
  });

  it("a change to how long history is kept applies per key: at the next prune or at each Pi or Claude Code start, never a Container start (SPI-1323)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const usage = await run.call(durable(), "change_environment", {
      expectedRevision: 0,
      settings: { usageRetentionDays: 365 },
    });
    expect(structured(usage)).toMatchObject({
      status: "applied",
      appliesAt:
        "Applies at the next prune of the usage records (at most once an hour, as usage is recorded) and to usage recorded from then on.",
    });
    const pi = await run.call(durable(), "change_environment", {
      expectedRevision: 1,
      settings: { piSessionRetentionDays: 120 },
    });
    expect(structured(pi)).toMatchObject({ status: "applied", appliesAt: "Applies at each Pi or Claude Code start." });
    for (const card of run.cards) expect(card.prompt).not.toContain("Container next starts");
    // Both, with a Container setting: each text names its keys.
    await run.call(durable(), "change_environment", {
      expectedRevision: 2,
      settings: { usageRetentionDays: 400, piSessionRetentionDays: 200, containerIdleMinutes: 1 },
    });
    const both = run.cards[2]!.prompt;
    expect(both).toContain("Container next starts");
    expect(both).toContain("usageRetentionDays: Applies at the next prune");
    expect(both).toContain("piSessionRetentionDays: Applies at each Pi or Claude Code start.");
    const tool = SETTINGS_TOOLS.find((entry) => entry.name === "change_environment")!;
    expect(tool.description).toContain("usageRetentionDays at the next prune");
    expect(tool.description).toContain("piSessionRetentionDays at each Pi or Claude Code start");
  });

  it("a decline changes nothing; an unanswered card is withdrawn and changes nothing", async () => {
    const declined = setup({ answer: { decision: "decline" } });
    recordModes(durable(), "approval-required");
    expect(structured(await declined.call(durable(), "change_environment", FREE))).toEqual({ status: "declined" });
    expect(declined.store.loadEnvironment().revision).toBe(0);
    const late = setup({ answer: { decision: "cancel", reason: "no answer in time" } });
    const answer = await late.call(durable(), "change_environment", FREE);
    expect(structured(answer)).toEqual({ status: "withdrawn" });
    expect(late.withdrawn).toEqual([late.cards[0]!.id]);
    expect(late.store.loadEnvironment().revision).toBe(0);
  });

  it("a card-approved free change is audited with mode card and answeredBy card; in full access with neither (ADR-0035 §11)", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    await run.call(durable(), "change_environment", FREE);
    expect(run.store.auditLog(1)[0]).toMatchObject({ tier: "free", mode: "card", answeredBy: "card" });
    const full = setup();
    recordModes(durable("thread-full"), "full-access");
    await full.call(durable("thread-full"), "change_environment", FREE);
    expect(full.store.auditLog(1)[0]!.mode).toBeUndefined();
    expect(full.store.auditLog(1)[0]!.answeredBy).toBeUndefined();
  });

  for (const [what, change] of [
    ["off", { enabled: false }],
    ["read-only", { writes: false }],
  ] as const) {
    it(`the access switch turned ${what} while the card waited: nothing applies`, async () => {
      const run = setup();
      recordModes(durable(), "approval-required");
      const asker: McpAsker = {
        ask: async () => {
          const switched = applyMcpChange(run.store.load(), { op: "server", server: "settings", ...change });
          if (!switched.ok) throw new Error(switched.error);
          run.store.save(switched.harness);
          return { decision: "accept" };
        },
        withdraw: () => undefined,
      };
      // A free change (its card) and an asked one (its Open change) alike.
      for (const args of [FREE, ASKED]) {
        const answer = await run.host.call({
          server: "settings",
          tool: "change_environment",
          args,
          caller: durable(),
          asker,
        });
        expect(textOf(answer)).toContain(what === "off" ? OFF_MESSAGE : READ_ONLY_REFUSAL);
        expect(structured(answer).status).toBe("refused");
        run.store.save({ ...run.store.load(), mcp: { servers: {} } });
      }
      expect(run.store.loadEnvironment().revision).toBe(0);
    });
  }

  it("a revision that moved while the card waited is refused as moved", async () => {
    const run = setup();
    recordModes(durable(), "approval-required");
    const asker: McpAsker = {
      ask: async () => {
        run.store.saveEnvironment({ ...run.store.loadEnvironment(), revision: 5 });
        return { decision: "accept" };
      },
      withdraw: () => undefined,
    };
    const answer = await run.host.call({
      server: "settings",
      tool: "change_environment",
      args: FREE,
      caller: durable(),
      asker,
    });
    expect(structured(answer)).toMatchObject({ status: "moved", revision: 5 });
  });
});

describe("the Settings server's write checks", () => {
  it("a thread-less caller has no mode record: it reads, and changes nothing", async () => {
    const run = setup();
    const caller: OwnCaller = { door: "own", thread: undefined, agent: DURABLE_AGENT };
    expect(structured(await run.call(caller, "get_settings", { entity: "harness" }))).toMatchObject({
      entity: "harness",
    });
    expect(textOf(await run.call(caller, "change_environment", FREE))).toBe(NO_MODES_REFUSAL);
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("no mode record: writes are refused, reads run", async () => {
    const run = setup();
    expect(textOf(await run.call(durable("thread-fresh"), "change_environment", FREE))).toBe(NO_MODES_REFUSAL);
    expect(textOf(await run.call(relayed("thread-fresh"), "change_environment", FREE))).toBe(NO_MODES_REFUSAL);
    expect(structured(await run.call(durable("thread-fresh"), "get_status"))).toMatchObject({
      access: { enabled: true, writes: true },
      openChanges: [],
    });
  });

  it("expectedRevision is required and a moved one is refused with the current revision; a change that moves nothing is unchanged", async () => {
    const run = setup();
    recordModes(durable(), "full-access");
    expect(
      structured(await run.call(durable(), "change_environment", { settings: { containerIdleMinutes: 1 } })),
    ).toEqual({ status: "refused" });
    expect(structured(await run.call(durable(), "change_environment", { ...FREE, expectedRevision: 3 }))).toEqual({
      status: "moved",
      revision: 0,
    });
    expect(
      structured(
        await run.call(durable(), "change_environment", { expectedRevision: 0, settings: { containerIdleMinutes: 2 } }),
      ),
    ).toEqual({ status: "unchanged", revision: 0 });
    // Validation by the registry comes before the tier: an out-of-range value is refused, never asked.
    expect(
      textOf(
        await run.call(durable(), "change_environment", { expectedRevision: 0, settings: { containerIdleMinutes: 0 } }),
      ),
    ).toMatch(/^Not changed: /);
  });

  it("an applied change is audited as the Settings server's, with the caller derived by the Environment", async () => {
    const run = setup();
    recordModes(relayed(), "full-access");
    await run.call(relayed(), "change_environment", FREE);
    expect(run.store.auditLog(1)[0]).toMatchObject({
      action: "environment.change",
      caller: "agent:thread-c",
      via: "mcp",
      thread: "thread-c",
      agent: "codex",
      tier: "free",
    });
    expect(run.store.auditLog(1)[0]!.answeredBy).toBeUndefined();
  });

  it("a free MCP change runs; turning a server on, adding one and changing the Settings server's own entry are asked", async () => {
    // A Direct server the owner added (revision 1).
    const added = applyMcpChange(EMPTY_HARNESS, {
      op: "add",
      server: "docs",
      url: "https://docs.example/mcp",
      auth: { kind: "none" },
    });
    if (!added.ok) throw new Error(added.error);
    const run = setup({ answer: { decision: "decline" }, harness: added.harness });
    recordModes(durable(), "full-access");
    const off = await run.call(durable(), "change_mcp", {
      expectedRevision: 1,
      change: { op: "server", server: "docs", enabled: false },
    });
    expect(structured(off)).toMatchObject({ status: "applied", revision: 2 });
    for (const args of [
      { expectedRevision: 2, change: { op: "server", server: "docs", enabled: true } },
      {
        expectedRevision: 2,
        change: { op: "add", server: "fixture", url: "https://fixture.example/mcp", auth: { kind: "none" } },
      },
      { expectedRevision: 2, change: { op: "server", server: "settings", exposure: "hidden" } },
    ]) {
      expect(structured(await run.call(durable(), "change_mcp", args)), JSON.stringify(args)).toMatchObject({
        status: "declined",
      });
    }
    expect(run.cards.length).toBe(3);
    expect(run.store.load().revision).toBe(2);
  });

  it("SPI-1322: a move of the Settings server's limits is asked in either direction; one at its value is unchanged", async () => {
    const run = setup({ answer: { decision: "decline" } });
    recordModes(durable(), "full-access");
    for (const limits of [{ askedPerHour: 60 }, { askedPerHour: 1 }, { strikeLockMinutes: 0 }]) {
      const args = { expectedRevision: 0, change: { op: "server", server: "settings", limits } };
      expect(structured(await run.call(durable(), "change_mcp", args)), JSON.stringify(limits)).toMatchObject({
        status: "declined",
      });
    }
    expect(run.cards.length).toBe(3);
    // The card names the limit, from and to.
    expect(JSON.stringify(run.cards[0])).toContain("settings.limits.askedPerHour");
    expect(
      structured(
        await run.call(durable(), "change_mcp", {
          expectedRevision: 0,
          change: { op: "server", server: "settings", limits: { askedPerHour: 6 } },
        }),
      ),
    ).toMatchObject({ status: "unchanged" });
    expect(run.cards.length).toBe(3);
    expect(run.store.load().revision).toBe(0);
  });

  it("SPI-1322: with the strike lock at 0, three declines in a row lock nothing; with strikes at 1, one does", async () => {
    const limited = (limits: Record<string, number>, from: StoredHarness = EMPTY_HARNESS): StoredHarness => {
      const applied = applyMcpChange(from, { op: "server", server: "settings", limits });
      if (!applied.ok) throw new Error(applied.error);
      return applied.harness;
    };
    const run = setup({ answer: { decision: "decline" }, harness: limited({ strikeLockMinutes: 0 }) });
    const agent = durable("thread-unlocked");
    recordModes(agent, "full-access");
    const ask = (settings: Record<string, unknown>) =>
      run.call(agent, "change_environment", { expectedRevision: 0, settings });
    for (const budget of [4, 5, 6])
      expect(structured(await ask({ containerBudget: budget }))).toMatchObject({ status: "declined" });
    // A fourth asks the owner again, on a card.
    expect(structured(await ask({ containerBudget: 7 }))).toMatchObject({ status: "declined" });
    expect(run.cards).toHaveLength(4);
    // The Owner sets one strike to lock, with the default hour: the run already recorded locks at the next ask.
    run.store.save(limited({ strikes: 1, strikeLockMinutes: 60 }, run.store.load()));
    expect(structured(await ask({ containerBudget: 8 }))).toMatchObject({ status: "refused", reason: "strikes" });
    expect(run.cards).toHaveLength(4);
  });

  it(`at most ${APPLIED_CAP} applied changes per caller per hour`, async () => {
    const run = setup();
    recordModes(durable(), "full-access");
    for (let index = 0; index < APPLIED_CAP; index++) {
      const answer = await run.call(durable(), "change_environment", {
        expectedRevision: index,
        settings: { graceDays: 8 + index },
      });
      expect(structured(answer).status).toBe("applied");
    }
    const capped = await run.call(durable(), "change_environment", {
      expectedRevision: APPLIED_CAP,
      settings: { graceDays: 100 },
    });
    expect(textOf(capped)).toContain(`${APPLIED_CAP} settings changes in the last hour`);
    // Another caller has its own count; an hour later the first may change again.
    recordModes(durable("thread-other"), "full-access");
    expect(
      structured(
        await run.call(durable("thread-other"), "change_environment", {
          expectedRevision: APPLIED_CAP,
          settings: { graceDays: 100 },
        }),
      ).status,
    ).toBe("applied");
    run.advance(60 * 60_000 + 1);
    expect(
      structured(
        await run.call(durable(), "change_environment", {
          expectedRevision: APPLIED_CAP + 1,
          settings: { graceDays: 101 },
        }),
      ).status,
    ).toBe("applied");
  });
});

describe("the Settings server's access switch", () => {
  const stored = (change: { enabled?: boolean; writes?: boolean }): StoredHarness => {
    const applied = applyMcpChange(EMPTY_HARNESS, { op: "server", server: "settings", ...change });
    if (!applied.ok) throw new Error(applied.error);
    return applied.harness;
  };

  it("on: every tool is listed, deferred, with readOnlyHint from its fixed class; resume never", async () => {
    const run = setup();
    const view = await run.host.view();
    const settings = view.servers.find((server) => server.name === "settings")!;
    expect(settings).toMatchObject({ kind: "settings", state: "available", exposure: "deferred" });
    expect(settings.tools.map((tool) => [tool.upstream, tool.class])).toEqual(
      SETTINGS_TOOLS.map((tool) => [tool.name, tool.class]),
    );
    expect(settings.tools.some((tool) => tool.upstream === "resume")).toBe(false);
    expect(settings.tools.map((tool) => tool.name)).toContain("mcp__settings__change_mcp");
  });

  it("off: the server is not in the view, and through the host every call is unavailable with the off message", async () => {
    let reached = 0;
    const run = setup({ harness: stored({ enabled: false }) });
    const host = new McpHost({
      kv: run.kv,
      engine: undefined,
      settings: () => run.store.load(),
      settingsServer: async () => {
        reached++;
        return { kind: "result", isError: false, text: "ran" };
      },
    });
    expect((await host.view()).servers.map((server) => server.name)).not.toContain("settings");
    recordModes(durable(), "full-access");
    for (const [tool, args] of [
      ["get_settings", { entity: "harness" }],
      ["change_mcp", { expectedRevision: 1, change: { op: "server", server: "settings", enabled: true } }],
    ] as const) {
      expect(await host.call({ server: "settings", tool, args, caller: durable() })).toEqual({
        kind: "unavailable",
        message: OFF_MESSAGE,
        mayHaveRun: false,
      });
    }
    // Nothing reached the server: it cannot turn itself back on.
    expect(reached).toBe(0);
    expect(run.store.load().revision).toBe(1);
  });

  it("read-only: write tools are not listed and a write call is refused; reads run", async () => {
    const run = setup({ harness: stored({ writes: false }) });
    recordModes(durable(), "full-access");
    const tools = (await run.host.view()).servers.find((server) => server.name === "settings")!.tools;
    expect(tools.every((tool) => tool.class === "read")).toBe(true);
    expect(tools.length).toBe(SETTINGS_TOOLS.filter((tool) => tool.class === "read").length);
    expect(textOf(await run.call(durable(), "change_environment", FREE))).toBe(READ_ONLY_REFUSAL);
    expect(structured(await run.call(durable(), "get_status"))).toMatchObject({
      access: { enabled: true, writes: false },
    });
  });

  it("without the Environment's caller, nothing reaches it", async () => {
    const run = setup();
    expect(
      await run.host.call({ server: "settings", tool: "get_settings", args: { entity: "harness" } }),
    ).toMatchObject({ kind: "unavailable" });
  });
});

describe("the Settings server's reads (plan D14)", () => {
  it("carry no secret value, fingerprint, URL query or authorization URL, and no result is a Pause", async () => {
    const run = setup({ cardWaitMs: 5 });
    const ops = { store: run.store, secrets: run.secrets, oauth: run.oauth, now: () => NOW };
    const added = await addMcpServer(
      ops,
      {
        server: "keyed",
        url: "https://keyed.example/mcp?key=q-s3cr3t",
        auth: { kind: "header", header: "X-Api-Key" },
        value: SECRET,
      },
      { actor: { caller: "owner:sub-1" } },
    );
    expect(added.ok).toBe(true);
    const signed = await addMcpServer(
      ops,
      { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } },
      { actor: { caller: "owner:sub-1" } },
    );
    expect(signed.ok).toBe(true);
    expect((await beginMcpSignIn({ ...ops, mcp: run.host }, "oauthy", { actor: { caller: "owner:sub-1" } })).ok).toBe(
      true,
    );
    recordModes(durable(), "full-access");
    const answers: Array<McpCallAnswer> = [];
    for (const [tool, args] of [
      ["get_settings", { entity: "harness" }],
      ["get_settings", { entity: "environment" }],
      ["list_mcp_servers", {}],
      ["list_mcp_servers", { server: "keyed" }],
      ["get_status", {}],
      ["read_audit", { limit: 50 }],
      ["test_mcp_server", { server: "keyed" }],
    ] as const) {
      answers.push(await run.call(durable(), tool, args));
    }
    // A write's results too.
    answers.push(
      await run.call(durable(), "change_mcp", { expectedRevision: 2, change: { op: "header-value", server: "keyed" } }),
    );
    answers.push(await run.call(durable(), "start_mcp_sign_in", { expectedRevision: 2, server: "oauthy" }));
    for (const answer of answers) {
      const all = JSON.stringify(answer);
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain("fingerprint");
      expect(all).not.toContain("q-s3cr3t");
      expect(all).not.toContain("auth.example");
      expect(all).not.toContain("s3cr3t-state");
      expect(pauseOf({ structuredContent: answer.kind === "result" ? answer.structured : undefined })).toBeUndefined();
    }
    const listed = structured(answers[2]!) as unknown as {
      servers: Array<{ name: string; url?: string; secret?: unknown }>;
    };
    expect(listed.servers.find((server) => server.name === "keyed")).toMatchObject({
      url: "https://keyed.example/mcp",
      secret: { set: true, setAt: NOW },
    });
    // The audit log keeps the subject on the panel; a reader through the server sees `owner`.
    const audit = structured(answers[5]!) as unknown as { entries: Array<{ caller: string }> };
    expect(audit.entries.every((entry) => !entry.caller.includes("sub-1"))).toBe(true);
  });

  it("names a stored server the set ignores", async () => {
    const run = setup({
      harness: {
        ...EMPTY_HARNESS,
        mcp: {
          servers: { settings: { kind: "direct", url: "https://x.example/mcp", enabled: true, exposure: "direct" } },
        },
      },
    });
    recordModes(durable(), "full-access");
    const listed = structured(await run.call(durable(), "list_mcp_servers")) as unknown as {
      servers: Array<{ name: string; kind: string }>;
      ignored: Array<string>;
    };
    expect(listed.servers.find((server) => server.name === "settings")?.kind).toBe("settings");
    expect(listed.ignored).toEqual([expect.stringContaining("settings:")]);
  });
});

// SPI-1332 (ADR-0047 §5): an agent's Rebuild of the Base snapshot is free and names no revision; get_status reads the
// Builder's record, a failure's output included.
describe("the Settings server: the Base snapshot", () => {
  const record: BaseBuildRecord = {
    key: "k".repeat(64),
    state: "failed",
    failure: {
      at: NOW,
      phase: "running",
      exitCode: 3,
      message: "the Image setup exited 3",
      output: "E: Unable to locate package nope\n",
    },
    good: null,
    at: NOW,
  };

  it("rebuild_base runs in full access with no revision, and asks on the free card in another mode", async () => {
    const reasons: Array<string> = [];
    const { call, cards } = setup({
      base: {
        record,
        rebuild: async (reason): Promise<BaseBuildRecord> => (
          reasons.push(reason),
          { key: record.key, state: "building", phase: "starting", since: NOW, good: null, at: NOW }
        ),
      },
    });
    const caller = durable("thread-rb");
    recordModes(caller, "full-access");
    const answer = await call(caller, "rebuild_base");
    expect(structured(answer)).toMatchObject({ status: "applied" });
    expect(textOf(answer)).toContain("The Builder builds the saved settings again");
    expect(reasons).toEqual(["an agent's Rebuild (rebuild_base)"]);
    expect(cards).toHaveLength(0);

    const other = durable("thread-rb2");
    recordModes(other, "approval-required");
    expect(structured(await call(other, "rebuild_base"))).toMatchObject({ status: "applied" });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.prompt).toContain("An agent asks to rebuild the Base snapshot:");
  });

  it("refuses rebuild_base in plan mode, and where there is no Builder", async () => {
    const planned = setup({ base: { record, rebuild: async () => record } });
    const caller = durable("thread-plan");
    recordModes(caller, "plan");
    expect(structured(await planned.call(caller, "rebuild_base"))).toMatchObject({ status: "refused" });
    const none = setup();
    const full = durable("thread-none");
    recordModes(full, "full-access");
    const answer = await none.call(full, "rebuild_base");
    expect(structured(answer)).toMatchObject({ status: "refused" });
    expect(textOf(answer)).toContain("the Builder is not available here");
  });

  it("get_status carries the Base snapshot's record", async () => {
    const { call } = setup({ base: { record } });
    const caller = durable("thread-st");
    recordModes(caller, "full-access");
    expect(structured(await call(caller, "get_status"))).toMatchObject({
      baseSnapshot: { state: "failed", failure: { exitCode: 3, output: "E: Unable to locate package nope\n" } },
    });
    expect(structured(await setup().call(caller, "get_status"))).toMatchObject({ baseSnapshot: null });
  });

  it("lists rebuild_base as a write", () => {
    expect(SETTINGS_TOOLS.find((tool) => tool.name === "rebuild_base")).toMatchObject({ class: "write" });
  });
});

// SPI-1334 (ADR-0047 §8, ADR-0035's refinement): an agent's Test base build of a proposed Image setup is free and names
// no revision; nothing is saved, and get_status reads the last test's result beside the Base snapshot's.
describe("the Settings server: the Test base build", () => {
  const record: BaseBuildRecord = {
    test: true,
    key: "t".repeat(64),
    state: "failed",
    failure: {
      at: NOW,
      phase: "running",
      exitCode: 100,
      message: "the Image setup exited 100",
      output: "E: Unable to locate package yq\n",
    },
    good: null,
    at: NOW,
  };
  const building: BaseBuildRecord = {
    test: true,
    key: "t".repeat(64),
    state: "building",
    phase: "starting",
    since: NOW,
    good: null,
    at: NOW,
  };

  it("test_base_build runs the proposed text in full access with no revision, saves nothing, and asks on the free card in another mode", async () => {
    const runs: Array<[string, string]> = [];
    const { call, cards, store, applied } = setup({
      test: { record, run: async (imageSetup, reason) => (runs.push([imageSetup, reason]), building) },
    });
    const caller = durable("thread-tb");
    recordModes(caller, "full-access");
    const answer = await call(caller, "test_base_build", { imageSetup: "apt-get install -y yq\n" });
    expect(structured(answer)).toMatchObject({ status: "applied" });
    expect(textOf(answer)).toContain("get_status shows its result as testBaseBuild");
    expect(runs).toEqual([["apt-get install -y yq\n", "an agent's test (test_base_build)"]]);
    expect(store.loadEnvironment().revision).toBe(0);
    expect(cards).toHaveLength(0);
    // The text stays in the test Builder: its change row keeps only its size and SHA-256.
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("apt-get install -y yq\n")),
    );
    expect(applied.at(-1)).toMatchObject({
      tool: "test_base_build",
      args: {
        imageSetup: { bytes: 22, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") },
      },
    });
    expect(JSON.stringify(applied.at(-1))).not.toContain("apt-get");

    const other = durable("thread-tb2");
    recordModes(other, "approval-required");
    expect(structured(await call(other, "test_base_build", { imageSetup: "echo two\n" }))).toMatchObject({
      status: "applied",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.prompt).toContain("An agent asks for a Test base build of a proposed Image setup:");
  });

  it("refuses an Image setup that is not text or past its bound, plan mode, and where there is no test Builder", async () => {
    let runs = 0;
    const { call } = setup({ test: { run: async () => (runs++, building) } });
    const caller = durable("thread-tbr");
    recordModes(caller, "full-access");
    expect(textOf(await call(caller, "test_base_build", {}))).toContain("imageSetup is the Image setup to test");
    expect(
      textOf(await call(caller, "test_base_build", { imageSetup: "é".repeat(Math.floor(MAX_SETUP_BYTES / 2) + 1) })),
    ).toContain(`at most ${MAX_SETUP_BYTES} bytes`);
    const planned = durable("thread-tbp");
    recordModes(planned, "plan");
    expect(structured(await call(planned, "test_base_build", { imageSetup: "true\n" }))).toMatchObject({
      status: "refused",
    });
    expect(runs).toBe(0);
    const none = setup();
    const full = durable("thread-tbn");
    recordModes(full, "full-access");
    expect(textOf(await none.call(full, "test_base_build", { imageSetup: "true\n" }))).toContain(
      "the test Builder is not available here",
    );
  });

  it("get_status carries the last test's result beside the Base snapshot's", async () => {
    const { call } = setup({ test: { record } });
    const caller = durable("thread-tbs");
    recordModes(caller, "full-access");
    expect(structured(await call(caller, "get_status"))).toMatchObject({
      testBaseBuild: {
        test: true,
        state: "failed",
        failure: { exitCode: 100, output: "E: Unable to locate package yq\n" },
      },
    });
    expect(structured(await setup().call(caller, "get_status"))).toMatchObject({ testBaseBuild: null });
  });

  it("lists test_base_build as a write that takes the proposed text", () => {
    expect(SETTINGS_TOOLS.find((tool) => tool.name === "test_base_build")).toMatchObject({
      class: "write",
      inputSchema: { required: ["imageSetup"] },
    });
  });
});

describe("the Settings server: a change's record is one row (SPI-1365)", () => {
  // Near the most one file setting may be, in three-byte characters: about 2.6 MB of UTF-8.
  const text = "€".repeat(880_000);
  const rowBytes = (record: ChangeRecord) => new TextEncoder().encode(JSON.stringify(record)).length;
  const caller = durable();
  const key = capKeyOf("own", caller.thread!);

  it("asked: opens a near-maximum setup and closes it, its record within the row each time", async () => {
    const run = setup({ answer: { decision: "decline" }, cardWaitMs: 50 });
    recordModes(caller, "full-access");
    const answer = await run.call(caller, "change_environment", {
      expectedRevision: 0,
      settings: { imageSetup: text },
    });
    expect(structured(answer)).toMatchObject({ status: expect.stringMatching(/^(declined|expired|waiting)$/) });
    const [kept] = run.changes.closedBy(key, 0).length > 0 ? run.changes.closedBy(key, 0) : run.changes.openBy(key);
    expect(kept).toBeDefined();
    expect(rowBytes(kept!)).toBeLessThanOrEqual(CHANGE_RECORD_BYTES);
    expect((kept!.args as { settings: { imageSetup: string } }).settings.imageSetup).toBe(text);
  });

  it("free: records a change carrying a near-maximum setup after applying it, within the row", async () => {
    const run = setup();
    recordModes(caller, "full-access");
    const seeded = applyEnvironmentChange(run.store.loadEnvironment(), { settings: { imageSetup: text } });
    if (!seeded.ok) throw new Error(seeded.error);
    run.store.saveEnvironment(seeded.environment);
    const answer = await run.call(caller, "change_environment", {
      expectedRevision: seeded.environment.revision,
      settings: { imageSetup: text, containerIdleMinutes: 1 },
    });
    expect(structured(answer)).toMatchObject({ status: "applied" });
    expect(rowBytes(run.applied.at(-1)!)).toBeLessThanOrEqual(CHANGE_RECORD_BYTES);
  });

  it("refuses a change too large to record before it opens or applies, naming the row", async () => {
    const run = setup();
    recordModes(caller, "full-access");
    const answer = await run.call(caller, "change_environment", {
      expectedRevision: 0,
      settings: { imageSetup: text, containerSetup: text, globalMiseConfig: text },
    });
    expect(structured(answer)).toMatchObject({ status: "refused" });
    expect(textOf(answer)).toContain("one 8 MB SQLite row");
    expect(run.store.loadEnvironment().revision).toBe(0);
    expect(run.cards).toEqual([]);
    expect(CHANGE_ARGS_BYTES).toBeLessThan(CHANGE_RECORD_BYTES);
  });
});
