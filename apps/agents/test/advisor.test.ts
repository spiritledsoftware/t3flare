// The Advisor (SPI-1059) on a real pi-durable Harness over pi-ai's faux provider, the agent and its Advisor Session
// answered from two scripts (told apart by the Advisor's instructions): a Review under the `turn` cadence steers the
// running agent with an attributed Concern; under `request`, the final Review's findings become notes in the same run and
// a Blocker continues it once; findings that cite no evidence are dropped; a failed Review pauses the Advisor without
// stopping the agent, and nothing it does starts a run of its own.
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";

import {
  ADVICE_ENTRY,
  AdvisorObserver,
  type AdvisorSettings,
  advisorExtension,
  advisorPrompt,
  parseFindings,
  validFinding,
} from "../src/extensions/advisor.ts";
import { capText, toolCallRef } from "../src/extensions/advisor/evidence.ts";
import { context, memoryKv } from "./harness.fixture.ts";

type Step = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

/** The observer of the run under way, for a step that changes its settings mid-run. */
let observing: AdvisorObserver | undefined;

const run = async (settings: AdvisorSettings, agent: Array<Step>, advisor: Array<Step>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const advisorPrompts: Array<string> = [];
  const next = async (list: Array<Step>) => {
    const step = list.shift();
    if (step === undefined) throw new Error("script ran out");
    return typeof step === "function" ? step() : step;
  };
  faux.setResponses(
    Array.from({ length: 30 }, () => (transcript: { messages: ReadonlyArray<{ role: string; content: unknown }> }) => {
      // The faux transcript has no system prompt: the Advisor Session is the one whose first user message is a Review.
      if (
        JSON.stringify(transcript.messages.find((message) => message.role === "user")?.content ?? "").includes(
          "Review this observed-agent evidence",
        )
      ) {
        const last = transcript.messages.at(-1);
        if (last?.role === "user")
          advisorPrompts.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
        return next(advisor);
      }
      return next(agent);
    }) as never,
  );
  const registry = createRegistry();
  const ran: Array<string> = [];
  registry.install(
    defineExtension({
      name: "coding-tools",
      tools: [
        defineTool({
          name: "bash",
          description: "run",
          parameters: obj({ command: str() }),
          execute: async (args) => (
            ran.push(args.command),
            { output: [{ type: "text" as const, text: `ran ${args.command}` }] }
          ),
        }),
        defineTool({
          name: "read",
          description: "read",
          parameters: obj({ path: str() }),
          execute: async () => ({ output: [{ type: "text" as const, text: "contents" }] }),
        }),
      ],
    }),
  );
  let harness: Harness | undefined;
  const observer = new AdvisorObserver(() => Promise.resolve(harness!), memoryKv(), settings);
  observing = observer;
  registry.install(advisorExtension(observer));
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const submission = await root.submit({ type: "input", content: "update the changelog and run the tests" }, context);
  harness.resume();
  await root.waitForIdle(context);
  const page = await root.entries({ order: "ascending" }, 200, undefined, context);
  return { observer, root, entries: page.items, status: await submission.status(context), advisorPrompts, ran };
};

const bash = (command: string, id: string) =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });
const report = (findings: ReadonlyArray<unknown>) => fauxAssistantMessage(`Checked.\n${JSON.stringify({ findings })}`);
const model = (entry: EntryRecord) => JSON.stringify(entry.model?.[0] ?? null);

const SETTINGS: AdvisorSettings = {
  model: "inherit",
  reviewEvery: "turn",
  thinkingLevel: "off",
  correctiveTurns: 1,
  reviewTimeoutMs: 120_000,
  maxFindings: 4,
  maxNits: 3,
  maxToolRounds: 8,
  concernCooldownTurns: 3,
  catchUpBacklog: 3,
  catchUpWaitMs: 30_000,
};
const severities = (entries: ReadonlyArray<EntryRecord>) =>
  entries.filter((entry) => entry.kind === ADVICE_ENTRY).map((entry) => (entry.data as { severity: string }).severity);
/** A Review step that waits for `gate` before it reports. */
const gated = (gate: Promise<void>, findings: ReadonlyArray<unknown>) => async () => (await gate, report(findings));
const latch = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

describe("the Advisor", () => {
  it("steers the running agent with an attributed Concern after a Review under the turn cadence", async () => {
    let reviewed: () => void = () => {};
    const done = new Promise<void>((resolve) => (reviewed = resolve));
    const { entries, status, advisorPrompts } = await run(
      SETTINGS,
      [
        bash("echo changelog >> CHANGELOG.md", "c1"),
        async () => (await done, bash("true", "c2")),
        fauxAssistantMessage("All done, tests pass."),
      ],
      [
        () => {
          reviewed();
          return report([
            {
              severity: "concern",
              message: "The tests were never run; the agent ran `true` instead.",
              evidence: { refs: [toolCallRef("c1")] },
            },
          ]);
        },
        report([]),
      ],
    );
    expect(status.status).toBe("done");
    expect(advisorPrompts[0]).toContain("Current context seed.");
    expect(advisorPrompts[0]).toContain(`"ref":"${toolCallRef("c1")}"`);
    const advice = entries.filter((entry) => entry.kind === ADVICE_ENTRY);
    expect(advice).toHaveLength(1);
    expect(advice[0]?.data).toMatchObject({
      severity: "concern",
      message: "The tests were never run; the agent ran `true` instead.",
    });
    expect(model(advice[0]!)).toContain("Advisor concern: The tests were never run");
    // The steer joined the run: an answer came after it.
    expect(entries.findIndex((entry) => entry.kind === ADVICE_ENTRY)).toBeLessThan(entries.length - 1);
    // The next Review is incremental.
    expect(advisorPrompts[1]).toContain("Incremental update.");
  });

  it("reviews once at the end under the request cadence: a Nit is a note, a Blocker continues the same run once", async () => {
    const { entries, status, advisorPrompts } = await run(
      { ...SETTINGS, reviewEvery: "request" },
      [
        bash("rm CHANGELOG.md", "c1"),
        fauxAssistantMessage("Updated the changelog."),
        fauxAssistantMessage("Restored it; sorry."),
      ],
      [
        report([
          {
            severity: "nit",
            message: "The answer could name the file.",
            evidence: { quote: "Updated the changelog." },
          },
          {
            severity: "blocker",
            message: "The agent deleted CHANGELOG.md but claims it updated it.",
            evidence: { refs: [toolCallRef("c1")], quote: "Updated the changelog." },
          },
          { severity: "concern", message: "Cites nothing." },
          { severity: "concern", message: "Cites a ref it never saw.", evidence: { refs: ["nope"] } },
        ]),
      ],
    );
    expect(advisorPrompts).toHaveLength(1);
    expect(status.status).toBe("done");
    const advice = entries
      .filter((entry) => entry.kind === ADVICE_ENTRY)
      .map((entry) => (entry.data as { severity: string }).severity);
    expect(advice).toEqual(["blocker", "nit"]);
    const continued = entries.findIndex((entry) =>
      JSON.stringify(entry.model ?? []).includes("Address the recorded Advisor blocker"),
    );
    expect(continued).toBeGreaterThan(-1);
    expect(model(entries.at(-1)!)).toContain("Restored it; sorry.");
  });

  it("pauses on a failed Review, leaving the agent running, and starts no run of its own", async () => {
    const { entries, status, observer } = await run(
      { ...SETTINGS, reviewEvery: "request" },
      [bash("ls", "c1"), fauxAssistantMessage("Listed.")],
      [fauxAssistantMessage("I have no report for you.")],
    );
    expect(status.status).toBe("done");
    expect(observer.paused).toContain("held no JSON report");
    const paused = entries.filter((entry) => entry.kind === ADVICE_ENTRY);
    expect(paused.map((entry) => (entry.data as { severity: string }).severity)).toEqual(["paused"]);
    expect(paused[0]?.model).toBeUndefined();
    expect(model(entries.at(-1)!)).toContain("Listed.");
  });

  it("delivers at most maxFindings per Review, and its prompts ask for at most that many (SPI-1320)", async () => {
    expect(advisorPrompt(1)).toContain("at most 1 findings");
    const { entries, advisorPrompts } = await run(
      { ...SETTINGS, reviewEvery: "request", maxFindings: 1 },
      [bash("rm CHANGELOG.md", "c1"), fauxAssistantMessage("Updated the changelog.")],
      [
        report([
          { severity: "concern", message: "It deleted the changelog.", evidence: { refs: [toolCallRef("c1")] } },
          {
            severity: "nit",
            message: "The answer could name the file.",
            evidence: { quote: "Updated the changelog." },
          },
        ]),
      ],
    );
    expect(advisorPrompts[0]).toContain("up to 1 distinct findings");
    expect(severities(entries)).toEqual(["concern"]);
  });

  it("delivers no Nits with maxNits 0 (SPI-1320)", async () => {
    const { entries } = await run(
      { ...SETTINGS, reviewEvery: "request", maxNits: 0 },
      [bash("ls", "c1"), fauxAssistantMessage("Listed.")],
      [report([{ severity: "nit", message: "The answer could say more.", evidence: { quote: "Listed." } }])],
    );
    expect(severities(entries)).toEqual([]);
  });

  it.each([
    [3, ["concern"]],
    [0, ["concern", "concern"]],
  ] as const)(
    "with concernCooldownTurns %i delivers %j while the agent runs (SPI-1320)",
    async (cooldown, expected) => {
      const first = latch();
      const second = latch();
      const { entries } = await run(
        { ...SETTINGS, concernCooldownTurns: cooldown },
        [
          bash("echo a >> CHANGELOG.md", "c1"),
          async () => (await first.opened, bash("echo b >> CHANGELOG.md", "c2")),
          async () => (await second.opened, fauxAssistantMessage("Done.")),
        ],
        [
          () => (
            first.open(),
            report([
              { severity: "concern", message: "The first edit is wrong.", evidence: { refs: [toolCallRef("c1")] } },
            ])
          ),
          () => (
            second.open(),
            report([
              { severity: "concern", message: "The second edit is wrong.", evidence: { refs: [toolCallRef("c2")] } },
            ])
          ),
          report([]),
          report([]),
        ],
      );
      expect(severities(entries)).toEqual(expected);
    },
  );

  it("never holds the agent for the Review under way with catchUpWaitSeconds 0 (SPI-1320)", async () => {
    // The first Review waits until the agent has taken its next step: a held agent would never take it.
    const stepped = latch();
    const { entries, status } = await run(
      { ...SETTINGS, catchUpBacklog: 1, catchUpWaitMs: 0 },
      [
        bash("echo a >> CHANGELOG.md", "c1"),
        () => (stepped.open(), bash("echo b >> CHANGELOG.md", "c2")),
        fauxAssistantMessage("Done."),
      ],
      [gated(stepped.opened, []), report([]), report([])],
    );
    expect(status.status).toBe("done");
    expect(severities(entries)).toEqual([]);
  });

  it("starts a new Advisor Session at the next Review when maxToolRounds changes (SPI-1320)", async () => {
    const reviewed = latch();
    const { advisorPrompts } = await run(
      SETTINGS,
      [
        bash("echo a >> CHANGELOG.md", "c1"),
        async () => {
          await reviewed.opened;
          observing!.configure({ ...SETTINGS, maxToolRounds: 4 });
          return bash("echo b >> CHANGELOG.md", "c2");
        },
        fauxAssistantMessage("Done."),
      ],
      [() => (reviewed.open(), report([])), report([]), report([])],
    );
    expect(advisorPrompts[0]).toContain("Current context seed.");
    expect(advisorPrompts[1]).toContain("Current context seed.");
  });

  it("parses the last report, keeps findings that cite known evidence, and caps tool results", () => {
    expect(parseFindings('example {"findings": [1]} then {"findings": []}')).toEqual([]);
    expect(parseFindings("none")).toBeUndefined();
    const known = new Set(["r1"]);
    expect(validFinding({ severity: "nit", message: "x", evidence: { refs: ["r1"] } }, known)).toEqual({
      severity: "nit",
      message: "x",
      evidence: { refs: ["r1"] },
    });
    expect(validFinding({ severity: "nit", message: "x", evidence: { refs: ["r2"] } }, known)).toBeUndefined();
    expect(validFinding({ severity: "urgent", message: "x", evidence: { quote: "q" } }, known)).toBeUndefined();
    const capped = capText("a".repeat(5_000));
    expect(capped).toContain("1000 characters omitted from this tool result");
    expect(capped.startsWith("a".repeat(2_000))).toBe(true);
  });
});
