// T-card (plan §5; ADR-0035, plan D6, D9), M4 (SPI-1199): an own agent's asked change on its owner-only card. An
// `approval` card with no field (its shape and the owner-only refusal are in settingsHostile.test.ts); the prompt's
// server-written parts and fixed lines; no Approve on a change that needs the page; the page answering first withdraws the card; a Stop
// withdraws the Open change.
import { applyChange, CARD_TEXT_MAX, CARD_WAIT_MS, EMPTY_HARNESS } from "@t3flare/harness-registry";
import { type McpQuestionCard, PARK_QUESTION_MARKER, PARKED_REASON } from "@t3flare/session-protocol";
import type { McpCallAnswer } from "../src/mcp/host.ts";
import { afterEach, describe, expect, it } from "vitest";

import { handleHarness } from "../src/harness/panel.ts";
import { CHANGES_API_PATH, changePagePath } from "../src/harness/paths.ts";
import { HINT_TRUST_LINE } from "../src/settings/render.ts";
import { addMcpServer } from "../src/harness/ops.ts";
import { HOST, PANEL, settingsFixture, type SettingsFixture, structured, textOf, until } from "./settingsFixture.ts";
import { answerParkedChange, ownerOutcome } from "../src/settings/server.ts";
import { settingsInstructions, settingsOwnerInstructions } from "../src/settings/tools.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { parkedCards } from "../src/provider/cli/parked.ts";
import {
  clearClosedParkedChanges,
  noteChangeClosed,
  type ParkQuestionState,
} from "../src/provider/cli/parkedChanges.ts";
import { nodeSqlStorage, nodeTransaction } from "./nodeSqlStorage.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());

const open = () => new Promise<never>(() => undefined);
const ASKED = { expectedRevision: 0, settings: { containerBudget: 4 } };

/** The owner's POST from the Change page. */
const pagePost = async (run: SettingsFixture, id: string, body: Record<string, unknown>) => {
  const deps = run.panel();
  const csrf = await csrfToken(run.store.csrfKey(), "owner-sub", run.now());
  return handleHarness(
    new Request(`https://${HOST}${CHANGES_API_PATH}/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `https://${HOST}`,
        "sec-fetch-site": "same-origin",
        "x-t3flare-csrf": csrf,
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
};

describe("the asked change's card", () => {
  it("is written by the server: the change, why, when, who, the page's link, and the agent's call last", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable("thread-x"), "change_environment", {
      expectedRevision: 0,
      settings: { containerBudget: 4, variables: { FOO: "bar" } },
    });
    const prompt = run.cards[0]!.prompt;
    const [record] = run.deps.changes.closedBy("own:thread-x", 0);
    expect(prompt.startsWith("A change to the Environment settings (revision 0):")).toBe(true);
    expect(prompt).toContain("- containerBudget: 3 to 4");
    expect(prompt).toContain('added FOO="bar"');
    expect(prompt).toContain("It waits for the owner because:\n- containerBudget: 3 to 4 (turned up)");
    expect(prompt).toContain("Applies when each Workspace's Container next starts");
    expect(prompt).toContain("Asked by piDurable on thread thread-x.");
    expect(prompt).toContain(`The Change page: https://${HOST}${changePagePath(record!.id)}`);
    expect(prompt.indexOf("The agent's call: settings: change_environment")).toBeGreaterThan(
      prompt.indexOf("The Change page"),
    );
  });

  it("asks to widen a tool's Exposure, showing each tool it moves; narrowing one applies at once", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const free = structured(
      await run.call(run.durable(), "change_tools", { expectedRevision: 0, tools: { ask_user: "hidden" } }),
    );
    // Free (the thread's mode still asks for the write itself, so the card says so).
    expect(free).toMatchObject({ status: "applied" });
    expect(run.cards[0]!.prompt).toContain("This change is free (it narrows what agents have)");
    void run.call(run.durable("thread-2"), "change_tools", {
      expectedRevision: 1,
      tools: { web_search: "direct" },
      t3: { tools: { t3_thread_read: "codemode" } },
    });
    await until(() => run.cards.length === 2);
    const prompt = run.cards[1]!.prompt;
    expect(prompt).toContain('- web_search: Exposure: "hidden" to "direct"');
    expect(prompt).toContain('- t3-code/t3_thread_read (t3\'s hint unknown): Exposure: "direct" to "codemode"');
    expect(prompt).toContain("It waits for the owner because:\n- web_search: Exposure hidden to direct");
  });

  it("carries the Guard line when a Guard is turned off, and the hint-trust line for a new server", async () => {
    const guarded = applyChange(EMPTY_HARNESS, { extension: "guardian", enabled: true });
    if (!guarded.ok) throw new Error(guarded.error);
    fixture = settingsFixture({ harness: guarded.harness, answer: { decision: "decline" } });
    const run = fixture;
    await run.call(run.durable(), "change_extension", { expectedRevision: 1, extension: "guardian", enabled: false });
    expect(run.cards[0]!.prompt).toContain("This turns off the Guardian, which reviews risky tool calls.");
    await run.call(run.durable("thread-2"), "change_mcp", {
      expectedRevision: 1,
      change: { op: "add", server: "fixture", url: "https://fixture.example/mcp?key=q", auth: { kind: "none" } },
    });
    expect(run.cards[1]!.prompt).toContain(HINT_TRUST_LINE);
    // An add shows the whole URL it would store, query included (SPI-1199 review): the owner approves exactly that.
    expect(run.cards[1]!.prompt).toContain("https://fixture.example/mcp?key=q (host fixture.example)");
  });

  for (const [what, setup] of [
    [
      "a header value",
      async (run: SettingsFixture) => {
        await addMcpServer(
          run.deps.ops,
          {
            server: "keyed",
            url: "https://keyed.example/mcp",
            auth: { kind: "header", header: "X-Key" },
            value: "old",
          },
          { actor: { caller: "owner:o" } },
        );
        return ["change_mcp", { expectedRevision: 1, change: { op: "header-value", server: "keyed" } }] as const;
      },
    ],
    [
      "a header add",
      async () =>
        [
          "change_mcp",
          {
            expectedRevision: 0,
            change: {
              op: "add",
              server: "keyed",
              url: "https://keyed.example/mcp",
              auth: { kind: "header", header: "X-Key" },
            },
          },
        ] as const,
    ],
    [
      "a sign-in",
      async (run: SettingsFixture) => {
        await addMcpServer(
          run.deps.ops,
          { server: "oauthy", url: "https://oauthy.example/mcp", auth: { kind: "oauth" } },
          { actor: { caller: "owner:o" } },
        );
        return ["start_mcp_sign_in", { expectedRevision: 1, server: "oauthy" }] as const;
      },
    ],
    [
      "text too long for a card",
      async () =>
        [
          "change_environment",
          {
            expectedRevision: 0,
            settings: {
              globalMiseConfig: `[tools]\n${"# a comment line of the config, long enough\n".repeat(Math.floor((2 * CARD_TEXT_MAX) / 44))}`,
            },
          },
        ] as const,
    ],
  ] as const) {
    it(`needs the page for ${what}: no Approve, and "Opened it" only keeps the call waiting`, async () => {
      fixture = settingsFixture({ cardWaitMs: 50 });
      const run = fixture;
      const [tool, args] = await setup(run);
      const revisions = () => run.store.load().revision + run.store.loadEnvironment().revision;
      const before = revisions();
      const answer = await run.call(run.durable(), tool, args as Record<string, unknown>);
      const card = run.cards[0] as McpQuestionCard;
      expect(card.options?.map((option) => option.label)).toEqual(["Opened it", "Decline", "Cancel"]);
      expect(card.prompt).toContain(`${PANEL}/changes/`);
      expect(card.prompt.length).toBeLessThanOrEqual(CARD_TEXT_MAX + 200);
      // SPI-1435: what a park question shows names the page and why, never the card's "Opened it".
      expect(card.pagePrompt).toContain("approved on its Change page only");
      expect(card.pagePrompt).toContain(`${PANEL}/changes/`);
      expect(card.pagePrompt).not.toContain("Opened it");
      // The card said "Opened it" (the fixture accepts): nothing applied, and the change expired with no page answer.
      expect(structured(answer)).toMatchObject({ status: "expired" });
      expect(revisions()).toBe(before);
      expect(run.begun).toEqual([]);
    });
  }

  it("the page answering first withdraws the card, and the call answers applied", async () => {
    fixture = settingsFixture({ answer: open });
    const run = fixture;
    const pending = run.call(run.durable(), "change_environment", ASKED);
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    const response = await pagePost(run, record!.id, { action: "approve" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied", revision: 1 });
    const answer = await pending;
    expect(structured(answer)).toMatchObject({ status: "applied", revision: 1, changeId: record!.id });
    expect(answer.kind === "result" ? answer.text : "").toContain("on the Change page");
    expect(run.withdrawn).toEqual([run.cards[0]!.id]);
    expect(run.store.auditLog(1)[0]).toMatchObject({
      action: "environment.change",
      via: "mcp",
      tier: "asked",
      mode: "card",
      answeredBy: "page",
      change: record!.id,
      caller: "agent:thread-d",
    });
  });

  it("a Stop withdraws the Open change and the card", async () => {
    fixture = settingsFixture({ answer: open });
    const run = fixture;
    const stop = new AbortController();
    const pending = run.call(run.durable(), "change_environment", ASKED, { signal: stop.signal });
    await until(() => run.cards.length === 1);
    const [record] = run.deps.changes.open();
    stop.abort();
    expect(structured(await pending)).toMatchObject({ status: "withdrawn" });
    expect(run.deps.changes.get(record!.id)).toMatchObject({ state: "withdrawn", closed: { by: "stop" } });
    expect(run.withdrawn).toEqual([run.cards[0]!.id]);
    // The page then finds it closed.
    expect((await pagePost(run, record!.id, { action: "approve" })).status).toBe(409);
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("the card's decline closes it as declined; its cancel as withdrawn", async () => {
    fixture = settingsFixture({ answer: { decision: "decline" } });
    expect(structured(await fixture.call(fixture.durable(), "change_environment", ASKED))).toMatchObject({
      status: "declined",
    });
    fixture.dispose();
    fixture = settingsFixture({ answer: { decision: "cancel" } });
    expect(structured(await fixture.call(fixture.durable(), "change_environment", ASKED))).toMatchObject({
      status: "withdrawn",
    });
    expect(fixture.store.loadEnvironment().revision).toBe(0);
  });

  it("asks in full access too (plan D7: the tier is what full access does not skip)", async () => {
    fixture = settingsFixture();
    const run = fixture;
    expect(
      structured(await run.call(run.durable("thread-full", "full-access"), "change_environment", ASKED)),
    ).toMatchObject({ status: "applied" });
    expect(run.cards.length).toBe(1);
  });
});

describe("the asked change's wait (SPI-1316, SPI-1389)", () => {
  /** The change the call opened, read back from the table (it may have closed). */
  const opened = (run: SettingsFixture) =>
    run.deps.changes.get(run.cards[0]!.prompt.match(/changes\/(chg_[\w-]+)/)![1]!);

  it("records expiresAt = createdAt + the wait, and closes unanswered after it, saying how long it waited", async () => {
    // The real path: no cardWaitMs, so the call's timer is the record's own expiresAt - createdAt.
    fixture = settingsFixture({ answer: open, changeWaitMs: () => 40 });
    const run = fixture;
    const answer = await run.call(run.durable(), "change_environment", ASKED);
    expect(structured(answer)).toMatchObject({ status: "expired" });
    const record = opened(run)!;
    expect(record.expiresAt! - record.createdAt).toBe(40);
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("at one minute, an Open change records createdAt + 60,000, and its expired text names a minute", async () => {
    fixture = settingsFixture({
      answer: { decision: "cancel", reason: "no answer in time" },
      changeWaitMs: () => 60_000,
    });
    const run = fixture;
    await run.call(run.durable(), "change_environment", ASKED);
    const record = opened(run)!;
    expect(record.expiresAt).toBe(record.createdAt + 60_000);
    // An Open change that expired says how long it waited: its own record's wait.
    expect(
      textOf(ownerOutcome({ state: "expired" } as never, { ...record, state: "expired" }) as McpCallAnswer),
    ).toContain("the owner did not answer within a minute.");
  });

  it("waits until it is answered by default: its record takes the off deadline its page token needs (SPI-1389)", async () => {
    fixture = settingsFixture({ answer: { decision: "cancel", reason: PARKED_REASON } });
    const run = fixture;
    await run.call(run.durable(), "change_environment", ASKED);
    const record = opened(run)!;
    expect(record.expiresAt! - record.createdAt).toBe(CARD_WAIT_MS);
  });

  it("a parked card keeps the Open change open, answers the call that it parked, and its answer applies it (SPI-1389)", async () => {
    fixture = settingsFixture({ answer: { decision: "cancel", reason: PARKED_REASON } });
    const run = fixture;
    const answer = await run.call(run.durable(), "change_environment", ASKED);
    expect(structured(answer)).toMatchObject({ status: "waiting" });
    expect(textOf(answer)).toContain("Parked: the owner has not answered yet");
    expect((answer as { isError?: boolean }).isError).toBe(false);
    const record = opened(run)!;
    expect(record.state).toBe("open");
    // The card names the change it stands for, so a parked card's record keeps it.
    expect(run.cards[0]!.changeId).toBe(record.id);
    expect(run.withdrawn).toEqual([]);
    expect((await answerParkedChange(run.deps, record.id, true)).text).toMatch(
      /^Applied: the owner approved it on the card\./,
    );
    expect(run.deps.changes.get(record.id)).toMatchObject({ state: "applied" });
    // Answered already (on the page first, or twice): its outcome, nothing applied again.
    expect((await answerParkedChange(run.deps, record.id, false)).text).toMatch(/^Applied/);
  });

  it("a parked change declined on its question closes declined", async () => {
    fixture = settingsFixture({ answer: { decision: "cancel", reason: PARKED_REASON } });
    const run = fixture;
    await run.call(run.durable(), "change_environment", ASKED);
    const record = opened(run)!;
    expect((await answerParkedChange(run.deps, record.id, false)).text).toContain(
      "Not changed: the owner declined it on the card.",
    );
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("Approve on a parked change approved on its Change page only names the page and why, and leaves it open (SPI-1435)", async () => {
    fixture = settingsFixture({ answer: { decision: "cancel", reason: PARKED_REASON } });
    const run = fixture;
    await addMcpServer(
      run.deps.ops,
      { server: "keyed", url: "https://keyed.example/mcp", auth: { kind: "header", header: "X-Key" }, value: "old" },
      { actor: { caller: "owner:o" } },
    );
    await run.call(run.durable(), "change_mcp", {
      expectedRevision: 1,
      change: { op: "header-value", server: "keyed" },
    });
    const record = opened(run)!;
    expect(record.needsPage).toBe("secret");
    // Its card carries the text a park question shows: the change, its page and why, and no "Opened it".
    const pagePrompt = run.cards[0]!.pagePrompt!;
    expect(pagePrompt).toContain(
      `It is approved on its Change page only. It takes a secret, typed only on its Change page: ${PANEL}/changes/${record.id}`,
    );
    expect(pagePrompt).not.toContain("Opened it");
    const answer = await answerParkedChange(run.deps, record.id, true);
    expect(answer.kind).toBe("page-only");
    expect(answer.text).toContain("approved on its Change page only");
    expect(answer.text).toContain(`${PANEL}/changes/`);
    expect(answer.text).toContain("It takes a secret");
    expect(answer.text).not.toContain("no longer open");
    expect(run.deps.changes.get(record.id)).toMatchObject({ state: "open" });
    // Decline on the question still closes it.
    expect(await answerParkedChange(run.deps, record.id, false)).toEqual({
      kind: "outcome",
      text: expect.stringContaining("Not changed: the owner declined it on the card."),
    });
    // Really closed now: an Approve tells its outcome, never the page.
    expect(await answerParkedChange(run.deps, record.id, true)).toEqual({
      kind: "outcome",
      text: expect.stringContaining("Not changed"),
    });
  });

  it("Approve on a parked change that is really gone says it is no longer open (SPI-1435)", async () => {
    fixture = settingsFixture({ answer: { decision: "cancel", reason: PARKED_REASON } });
    const run = fixture;
    expect(await answerParkedChange(run.deps, "no-such-change", true)).toEqual({
      kind: "outcome",
      text: expect.stringContaining("it is no longer open"),
    });
  });

  it("the Settings server's instructions name no deadline for an asked change (SPI-1389)", () => {
    expect(settingsInstructions(1)).toContain("on a card or its Change page (one at a time per thread).");
    // Off (0, the default since SPI-1386), no count.
    expect(settingsInstructions()).toContain("on a card or its Change page.");
    // SPI-1322: the Settings server's openPerThread.
    expect(settingsInstructions(3)).toContain("(at most 3 at a time per thread)");
    expect(settingsOwnerInstructions()).toContain("waits for the owner's answer on its Change page: open the link");
    for (const text of [settingsInstructions(1), settingsOwnerInstructions()]) expect(text).not.toContain("at most a");
  });
});

describe("a parked change closed elsewhere (SPI-1404)", () => {
  const PARK_ID = `runtime-request:codex:${PARK_QUESTION_MARKER}:x`;

  /** A CLI turn parked on the change its call opened: the fixture's parked card, its record kept as `park` keeps it. */
  const parkedRun = async (question: () => ParkQuestionState = () => "pending") => {
    const closed: Array<[string, string, boolean]> = [];
    const sql = nodeSqlStorage();
    const parked = parkedCards(sql, nodeTransaction(sql));
    // As the Environment DO wires it: the close notes an answer's decision on the parked cards.
    fixture = settingsFixture({
      answer: { decision: "cancel", reason: PARKED_REASON },
      changeClosed: (id, state) => void closed.push([id, state, noteChangeClosed(parked, id, state)]),
    });
    const run = fixture;
    await run.call(run.durable(), "change_environment", ASKED);
    const changeId = run.cards[0]!.changeId!;
    parked.park({ id: PARK_ID, thread: "thread-d", kind: "change", title: "t", changeId, parkedAt: 1 });
    const answered: Array<[string, boolean]> = [];
    const dismissed: Array<string> = [];
    const reconcile = () =>
      clearClosedParkedChanges({
        parked,
        change: (id) => run.deps.changes.get(id),
        question,
        answer: async (card, approve) => void answered.push([card.id, approve]),
        dismiss: async (card) => void dismissed.push(card.id),
        log: (event) => void run.logs.push(event),
      });
    return { run, changeId, parked, closed, answered, dismissed, reconcile };
  };

  it("approved on its page: the close is told, its question answered Approve once, its record kept", async () => {
    let question: ParkQuestionState = "pending";
    const { run, changeId, parked, closed, answered, dismissed, reconcile } = await parkedRun(() => question);
    // Still open: nothing to do.
    expect(await reconcile()).toEqual({ answered: 0, dismissed: 0, dropped: 0 });
    expect((await pagePost(run, changeId, { action: "approve" })).status).toBe(200);
    expect(closed).toEqual([[changeId, "applied", true]]);
    expect(parked.get(PARK_ID)?.answeredElsewhere).toEqual({ approve: true });
    expect(await reconcile()).toEqual({ answered: 1, dismissed: 0, dropped: 0 });
    expect(answered).toEqual([[PARK_ID, true]]);
    expect(dismissed).toEqual([]);
    // `answerText` reads the record when the answer's message comes, and tells the agent the page's outcome.
    expect(parked.get(PARK_ID)).toBeDefined();
    expect((await answerParkedChange(run.deps, changeId, true)).text).toMatch(/^Applied: .*on the Change page/);
    // t3 holds the answer now: a second run does nothing.
    question = "answered";
    expect(await reconcile()).toEqual({ answered: 0, dismissed: 0, dropped: 0 });
    expect(answered).toHaveLength(1);
  });

  it("declined on its page: its question answered Decline", async () => {
    const { run, changeId, answered, reconcile } = await parkedRun();
    expect((await pagePost(run, changeId, { action: "decline" })).status).toBe(200);
    await reconcile();
    expect(answered).toEqual([[PARK_ID, false]]);
  });

  it("expired: its question dismissed and its record dropped, with no answer", async () => {
    const { run, parked, answered, dismissed, reconcile } = await parkedRun();
    run.advance(CARD_WAIT_MS + 1);
    expect(await reconcile()).toEqual({ answered: 0, dismissed: 1, dropped: 1 });
    expect(dismissed).toEqual([PARK_ID]);
    expect(answered).toEqual([]);
    expect(parked.get(PARK_ID)).toBeUndefined();
    expect(await reconcile()).toEqual({ answered: 0, dismissed: 0, dropped: 0 });
  });

  it("a question already answered keeps its record; one dismissed by hand, or gone, drops it", async () => {
    for (const [question, kept] of [
      ["answered", true],
      ["dismissed", false],
      ["gone", false],
    ] as const) {
      const { run, changeId, parked, answered, dismissed, reconcile } = await parkedRun(() => question);
      await pagePost(run, changeId, { action: "approve" });
      await reconcile();
      expect([answered, dismissed]).toEqual([[], []]);
      expect(parked.get(PARK_ID) !== undefined).toBe(kept);
      run.dispose();
    }
  });

  it("a failed answer is logged and left for the next run", async () => {
    const { run, changeId, parked, reconcile } = await parkedRun();
    await pagePost(run, changeId, { action: "approve" });
    const failing = await clearClosedParkedChanges({
      parked,
      change: (id) => run.deps.changes.get(id),
      question: () => "pending",
      answer: async () => {
        throw new Error("t3 refused");
      },
      dismiss: async () => undefined,
      log: (event) => void run.logs.push(event),
    });
    expect(failing).toEqual({ answered: 0, dismissed: 0, dropped: 0 });
    expect(run.logs).toContainEqual(expect.objectContaining({ t3flare: "cli-park-clear-failed", changeId }));
    expect(await reconcile()).toMatchObject({ answered: 1 });
  });

  it("a delivery retried after the change's row is pruned still answers with the page's decision", async () => {
    const { run, changeId, parked } = await parkedRun();
    expect((await pagePost(run, changeId, { action: "decline" })).status).toBe(200);
    const answered: Array<[string, boolean]> = [];
    const dismissed: Array<string> = [];
    const cleared = await clearClosedParkedChanges({
      parked,
      // The closed row is gone (kept `keptMs`), as after a long-failing delivery.
      change: () => undefined,
      question: () => "pending",
      answer: async (card, approve) => void answered.push([card.id, approve]),
      dismiss: async (card) => void dismissed.push(card.id),
      log: (event) => void run.logs.push(event),
    });
    expect(cleared).toEqual({ answered: 1, dismissed: 0, dropped: 0 });
    expect([answered, dismissed]).toEqual([[[PARK_ID, false]], []]);
  });

  for (const [resolved, kept] of [
    ["answered", true],
    ["dismissed", false],
  ] as const) {
    it(`refused, its question ${resolved} meanwhile: unlogged, record ${kept ? "kept" : "dropped"}`, async () => {
      let question: ParkQuestionState = "pending";
      const { run, changeId, parked } = await parkedRun(() => question);
      await pagePost(run, changeId, { action: "approve" });
      const logged = run.logs.length;
      const cleared = await clearClosedParkedChanges({
        parked,
        change: (id) => run.deps.changes.get(id),
        question: () => question,
        answer: async () => {
          question = resolved;
          throw new Error(`Runtime request ${PARK_ID} is resolved.`);
        },
        dismiss: async () => undefined,
        log: (event) => void run.logs.push(event),
      });
      expect(cleared).toEqual({ answered: 0, dismissed: 0, dropped: kept ? 0 : 1 });
      expect(run.logs.slice(logged)).toEqual([]);
      expect(parked.get(PARK_ID) !== undefined).toBe(kept);
      run.dispose();
    });
  }
});
