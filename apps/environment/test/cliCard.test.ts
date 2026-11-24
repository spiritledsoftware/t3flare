// @effect-diagnostics nodeBuiltinImport:off
// ADR-0028 (review M9): the MCP relay's tool card on a CLI thread is raised as t3's approval card on that thread's live
// turn by the CLI wrapper, and answered from t3's own `respondToRuntimeRequest`. Run over t3's ACP adapter, built with
// the driver's own options (`acpAdapterOptions`), and a scripted agent (fixtures/fake-acp-agent.mjs) whose turn waits on
// a permission request of its own, so the card is asked mid-turn as a relayed tool call would be. (SPI-1040's push
// cards came this way until the back-to-stock cut, owner 2026-11-12.)
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2, type AcpAdapterV2RuntimeInput } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import * as TestProviderHost from "../../../t3code/packages/provider-testing/src/TestProviderHost.ts";
import { makeTurnInput } from "t3/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { acpAdapterOptions, acpFlavor } from "../src/provider/cli/acpDriver.ts";
import {
  approveCliTool,
  cancelCliAsk,
  type CliAnswer,
  type CliAsk,
  cliQuestionAsker,
  registerCliAsker,
} from "../src/provider/cli/cliAsk.ts";
import { type CliSessions, PARKED_CALL_TEXT, wrapCliAdapter, type WrapOptions } from "../src/provider/cli/wrapper.ts";
import type { ChannelProcess } from "../src/agents/processChannel.ts";
import { parkedCards } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { PARKED_REASON } from "@t3flare/session-protocol";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const AGENT = path.join(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    sessionCapabilities: { close: {}, fork: {}, resume: {} },
  },
  authMethods: [],
  agentInfo: { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.106.0" },
};
const SESSION_NEW = {
  sessionId: "claude-session",
  modes: {
    currentModeId: "default",
    availableModes: ["default", "acceptEdits", "plan"].map((id) => ({ id, name: id })),
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "default",
      options: ["default", "comm/claude-sonnet-5-5"].map((value) => ({ value, name: value })),
    },
  ],
};
const OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
/** The agent's own request: holds the turn open until the test answers it. */
const HOLD = {
  request: {
    method: "session/request_permission",
    params: {
      toolCall: { toolCallId: "tc-hold", kind: "execute", title: "execute ls", locations: [], rawInput: {} },
      options: OPTIONS,
    },
  },
};

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

type Event = ProviderAdapter.ProviderAdapterV2Event;

let threads = 0;

/** A wrapped Claude session over the scripted agent, its turn started and waiting on the agent's own request. */
const session = Effect.fn("session")(function* (
  wrap: Omit<WrapOptions, "sessions"> = {},
  prompts: ReadonlyArray<ReadonlyArray<unknown>> = [[HOLD]],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3flare-cli-card-" });
  const scriptPath = path.join(cwd, "..", `${path.basename(cwd)}.script.json`);
  const logPath = path.join(cwd, "..", `${path.basename(cwd)}.log`);
  yield* fileSystem.writeFileString(
    scriptPath,
    yield* encodeJson({ initialize: INITIALIZE, sessionNew: SESSION_NEW, prompts }),
  );
  yield* fileSystem.writeFileString(logPath, "");
  const PATH = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const spawn = Effect.fn("spawn")(function* (input: AcpAdapterV2RuntimeInput) {
    const {
      processEnvironment: _env,
      runtimePolicy: _policy,
      mcpServers: _mcp,
      acpMcpServers: _acp,
      httpMcpServers: _http,
      ...rest
    } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...rest,
        spawn: {
          command: process.execPath,
          args: [AGENT],
          cwd: input.cwd,
          env: { PATH, FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath },
          extendEnv: false,
        },
        authenticateOnAuthRequired: false,
        ownDetachedProcessGroup: true,
        processGroupPlatform: process.platform,
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const sessions: CliSessions = new Map();
  const adapter = wrapCliAdapter(
    yield* makeAcpAdapterV2(acpAdapterOptions(instanceId, acpFlavor("claude", driver, { spawn }), undefined)),
    { parkAfterMs: () => 0, ...wrap, sessions },
  );
  const threadId = ThreadId.make(`thread-card-${++threads}`);
  const modelSelection = { instanceId, model: "comm/claude-sonnet-5-5" } as const;
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-card-${threads}`),
    modelSelection,
    runtimePolicy,
  });
  const queue = yield* Queue.unbounded<Event>();
  const seen: Array<Event> = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Queue.offer(queue, event)))),
    Effect.forkScoped,
  );
  const until = Effect.fn("until")(function* (predicate: (event: Event) => boolean) {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  }, Effect.timeout("20 seconds"));
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const agentLog = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { received?: string; params?: Record<string, unknown> });
  return {
    runtime,
    threadId,
    providerThread,
    instanceId,
    runtimePolicy,
    modelSelection,
    until,
    seen,
    agentLog,
    session: [...sessions.values()][0]!,
  };
});

type Harness = Effect.Success<ReturnType<typeof session>>;

const startTurn = Effect.fn("startTurn")(function* (
  harness: Harness,
  answer?: { readonly messageId: string; readonly text: string; readonly ordinal: number },
) {
  const { runtime, threadId, providerThread, instanceId, runtimePolicy, modelSelection } = harness;
  const input = makeTurnInput({
    threadId,
    providerThread,
    instanceId,
    runtimePolicy,
    now: yield* DateTime.now,
    modelSelection,
    ...(answer === undefined ? {} : { ordinal: answer.ordinal, messageText: answer.text }),
  });
  yield* runtime.startTurn(
    answer === undefined
      ? input
      : { ...input, message: { ...input.message, messageId: MessageId.make(answer.messageId) } },
  );
  // The agent's own request: the turn is live, and its provider turn known.
  const hold = yield* harness.until(
    (event) => event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
  );
  if (hold.type !== "runtime_request.updated") throw new Error("expected the agent's request");
  return hold.runtimeRequest;
});

const isCard = (event: Event) =>
  event.type === "runtime_request.updated" && event.runtimeRequest.id.includes(":t3flare-ask:");
const cardOpened = (event: Event) =>
  isCard(event) && event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending";

const ask = (harness: Harness, askId: string) =>
  Effect.promise(() =>
    approveCliTool({
      thread: harness.threadId,
      askId,
      title: "Allow fixture: fixture_note?",
      summary: 'fixture_note {"line":"x"}',
      detail: "fixture: fixture_note",
      tool: "fixture/fixture_note",
      argsHash: "h1",
    }),
  );

const test = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layerTest> | import("effect/Scope").Scope>) =>
  Effect.runPromise(body.pipe(Effect.scoped, Effect.provide(layerTest)));

describe("a relay tool call asked on a CLI thread (ADR-0028, M9)", () => {
  it("raises t3's approval card on the live turn and answers with the owner's decision", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        const hold = yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-1").pipe(Effect.forkScoped);
        const opened = yield* harness.until(cardOpened);
        if (opened.type !== "runtime_request.updated") throw new Error("expected the card");
        // The card's node and turn item are on the agent's own turn, beside its request.
        expect(opened.runtimeRequest.providerTurnId).toBe(hold.providerTurnId);
        expect(opened.runtimeRequest.kind).toBe("permission");
        expect(opened.runtimeRequest.responseCapability).toMatchObject({ type: "live" });
        const node = yield* harness.until(
          (event) => event.type === "node.updated" && event.node.runtimeRequestId === opened.runtimeRequest.id,
        );
        expect(node.type === "node.updated" && [node.node.kind, node.node.status, node.node.parentNodeId]).toEqual([
          "approval_request",
          "waiting",
          node.type === "node.updated" ? node.node.rootNodeId : null,
        ]);
        const item = yield* harness.until(
          (event) =>
            event.type === "turn_item.updated" &&
            "requestId" in event.turnItem &&
            event.turnItem.requestId === opened.runtimeRequest.id,
        );
        if (item.type !== "turn_item.updated" || item.turnItem.type !== "approval_request")
          throw new Error("expected the card's turn item");
        expect(item.turnItem.title).toBe("Allow fixture: fixture_note?");
        expect(item.turnItem.prompt).toContain("fixture_note");
        expect(item.turnItem.options?.map((option) => option.decision)).toEqual([
          "accept",
          "acceptForSession",
          "decline",
        ]);
        // The agent's own items are numbered from the turn's ordinal; the card comes after them.
        const ordinals = harness.seen.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.id !== item.turnItem.id ? [event.turnItem.ordinal] : [],
        );
        expect(item.turnItem.ordinal).toBeGreaterThan(Math.max(0, ...ordinals));

        yield* harness.runtime.respondToRuntimeRequest({
          requestId: opened.runtimeRequest.id,
          decision: "acceptForSession",
        });
        expect(yield* Fiber.join(answer)).toEqual({ approved: true, forSession: true });
        const closed = yield* harness.until(isCard);
        expect(
          closed.type === "runtime_request.updated" && [closed.runtimeRequest.status, closed.runtimeRequest.decision],
        ).toEqual(["resolved", "acceptForSession"]);
        // The CLI never saw the card: only its own request was answered to it.
        expect(harness.agentLog().filter((entry) => entry.received === "response")).toHaveLength(0);

        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        const terminal = yield* harness.until((event) => event.type === "turn.terminal");
        expect(terminal.type === "turn.terminal" && terminal.status).toBe("completed");
      }),
    ));

  it("a decline refuses, and a second answer to a closed card is an error", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-3").pipe(Effect.forkScoped);
        const card = yield* harness.until(cardOpened);
        if (card.type !== "runtime_request.updated") throw new Error("expected the card");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: card.runtimeRequest.id, decision: "decline" });
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "decline" });
        // As t3's adapters answer an unknown request.
        const late = yield* harness.runtime
          .respondToRuntimeRequest({ requestId: card.runtimeRequest.id, decision: "accept" })
          .pipe(Effect.flip);
        expect(late._tag).toBe("ProviderAdapterRuntimeRequestResponseError");
      }),
    ));

  it("withdraws the card when the calling CLI goes away (review M7)", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-6").pipe(Effect.forkScoped);
        yield* harness.until(cardOpened);
        cancelCliAsk("ask-6");
        const closed = yield* harness.until(isCard);
        expect(closed.type === "runtime_request.updated" && closed.runtimeRequest.status).toBe("cancelled");
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "the agent went away" });
      }),
    ));

  it("closes an open card before t3 sees the turn end, and refuses once no turn is live", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        // Before any turn: nothing to ask on.
        expect((yield* ask(harness, "ask-7")).approved).toBe(false);
        const hold = yield* startTurn(harness);
        const answer = yield* ask(harness, "ask-8").pipe(Effect.forkScoped);
        const card = yield* harness.until(cardOpened);
        if (card.type !== "runtime_request.updated") throw new Error("expected the card");
        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        yield* harness.until((event) => event.type === "turn.terminal");
        expect(yield* Fiber.join(answer)).toEqual({ approved: false, reason: "the turn ended" });
        const order = harness.seen.flatMap((event) =>
          event.type === "turn.terminal"
            ? ["terminal"]
            : isCard(event) && event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled"
              ? ["cancelled"]
              : [],
        );
        expect(order).toEqual(["cancelled", "terminal"]);
        expect(yield* ask(harness, "ask-9")).toEqual({ approved: false, reason: "no live turn to ask on" });
      }),
    ));
});

describe("an MCP server's question asked on a CLI thread (SPI-1079)", () => {
  const formCard = {
    id: "t3flare-elicit-form-1",
    kind: "form" as const,
    server: "fixture",
    title: "fixture asks",
    prompt: "fixture asks: Colour?",
    questions: [
      {
        id: "colour",
        header: "Colour",
        question: "fixture asks: Colour?",
        options: [{ label: "red", description: "red", value: "red" }],
        allowCustomAnswer: false,
        required: true,
      },
      {
        id: "t3flare_send",
        header: "Send",
        question: "Send?",
        options: [{ label: "Send", description: "Send", value: "send" }],
        allowCustomAnswer: false,
        required: true,
      },
    ],
  };

  it("a form is t3's user_input card, its id marked, answered with the owner's answers", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        yield* startTurn(harness);
        const answer = yield* Effect.promise(() => cliQuestionAsker(harness.threadId).ask(formCard)).pipe(
          Effect.forkScoped,
        );
        const opened = yield* harness.until(cardOpened);
        if (opened.type !== "runtime_request.updated") throw new Error("expected the card");
        expect(opened.runtimeRequest.kind).toBe("user_input");
        expect(opened.runtimeRequest.id).toContain(":t3flare-ask:t3flare-elicit-form-1");
        const item = yield* harness.until(
          (event) =>
            event.type === "turn_item.updated" &&
            "requestId" in event.turnItem &&
            event.turnItem.requestId === opened.runtimeRequest.id,
        );
        if (item.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
          throw new Error("expected a user_input item");
        expect(item.turnItem.questions.map((question) => question.id)).toEqual(["colour", "t3flare_send"]);
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: opened.runtimeRequest.id,
          answers: { colour: "red", t3flare_send: "send" },
        });
        expect(yield* Fiber.join(answer)).toEqual({
          decision: "accept",
          answers: { colour: "red", t3flare_send: "send" },
        });
      }),
    ));

  it("a confirmation is t3's mcp-elicitation approval card; a decline is a decline; no live turn is a cancel", () =>
    test(
      Effect.gen(function* () {
        const harness = yield* session();
        expect(
          yield* Effect.promise(() => cliQuestionAsker(harness.threadId).ask({ ...formCard, id: "t3flare-elicit-0" })),
        ).toMatchObject({ decision: "cancel" });
        yield* startTurn(harness);
        const card = {
          id: "t3flare-elicit-confirm-1",
          kind: "approval" as const,
          server: "fixture",
          title: "fixture asks",
          prompt: "Delete it?",
          options: [
            { decision: "accept" as const, label: "Approve" },
            { decision: "decline" as const, label: "Decline" },
          ],
        };
        const answer = yield* Effect.promise(() => cliQuestionAsker(harness.threadId).ask(card)).pipe(
          Effect.forkScoped,
        );
        const opened = yield* harness.until(cardOpened);
        if (opened.type !== "runtime_request.updated") throw new Error("expected the card");
        expect(opened.runtimeRequest.kind).toBe("mcp-elicitation");
        const item = yield* harness.until(
          (event) =>
            event.type === "turn_item.updated" &&
            "requestId" in event.turnItem &&
            event.turnItem.requestId === opened.runtimeRequest.id,
        );
        if (item.type !== "turn_item.updated" || item.turnItem.type !== "approval_request")
          throw new Error("expected an approval item");
        expect([item.turnItem.requestKind, item.turnItem.prompt]).toEqual(["mcp-elicitation", "Delete it?"]);
        yield* harness.runtime.respondToRuntimeRequest({ requestId: opened.runtimeRequest.id, decision: "decline" });
        expect(yield* Fiber.join(answer)).toMatchObject({ decision: "decline" });
      }),
    ));
});

describe("a CLI card waits until it is answered (SPI-1389)", () => {
  /** A live turn whose owner never answers, or whose turn parks: what each card was asked with, and its signal. */
  const owner = (thread: string, answer?: CliAnswer) => {
    const asked: Array<{ readonly ask: CliAsk; readonly signal: AbortSignal }> = [];
    const unregister = registerCliAsker(thread, {
      ask: (card, signal) =>
        new Promise((resolve) => {
          asked.push({ ask: card, signal });
          if (answer !== undefined) resolve(answer);
          signal.addEventListener("abort", () => resolve({ approved: false, reason: "withdrawn" }), { once: true });
        }),
    });
    return { asked, unregister };
  };
  const approve = (thread: string) =>
    approveCliTool({
      thread,
      askId: `ask-${thread}`,
      title: "t",
      summary: "s",
      detail: "",
      tool: "srv/t",
      argsHash: "h",
    });

  it("arms no timer: a tool card's signal is only the agent's going away", async () => {
    const silent = owner("wait-thread-1");
    const pending = approve("wait-thread-1");
    await Promise.resolve();
    expect(silent.asked[0]!.signal.aborted).toBe(false);
    expect(silent.asked[0]!.ask.park).toEqual({ kind: "tool", tool: "srv/t", argsHash: "h" });
    cancelCliAsk("ask-wait-thread-1");
    expect(await pending).toEqual({ approved: false, reason: "the agent went away" });
    silent.unregister();
  });

  it("hands a parked card's text back to the relay, and an MCP question's park as a cancel for PARKED_REASON", async () => {
    const parked = owner("wait-thread-2", { approved: false, parked: "Parked." });
    expect(await approve("wait-thread-2")).toEqual({ approved: false, parked: "Parked." });
    const question = { id: "card-2", kind: "approval", server: "fixture", title: "Sure?", prompt: "Sure?" } as const;
    expect(await cliQuestionAsker("wait-thread-2").ask(question)).toEqual({
      decision: "cancel",
      reason: PARKED_REASON,
    });
    expect(parked.asked[1]!.ask.park).toEqual({ kind: "question", tool: "fixture", argsHash: "" });
    // The Settings server's card names its Open change: its park keeps the change.
    await cliQuestionAsker("wait-thread-2").ask({ ...question, server: "settings", changeId: "chg_1" });
    expect(parked.asked[2]!.ask.park).toEqual({ kind: "change", tool: "settings", argsHash: "", changeId: "chg_1" });
    parked.unregister();
  });
});

describe("a CLI agent's turn parks after Park after, and its answer resumes it (SPI-1389)", () => {
  /** A fake process on the session: what the park does to it. */
  const fakeProcess = (harness: Harness) => {
    const calls = { kill: 0, turns: [] as Array<boolean> };
    harness.session.process = {
      key: "proc-park",
      parkAfterMs: undefined,
      kill: () => void calls.kill++,
      turn: (active: boolean) => void calls.turns.push(active),
      modelFailure: async () => null,
    } as unknown as ChannelProcess;
    return calls;
  };
  const isPark = (event: Event) =>
    event.type === "runtime_request.updated" &&
    event.runtimeRequest.id.includes(":t3flare-park:") &&
    event.runtimeRequest.status === "pending";

  it("raises each open card again as a question, answers the held call parked, cancels the CLI's own request, keeps both, and ends the turn and the process; each answer allows its call once", () =>
    test(
      Effect.gen(function* () {
        const store = parkedCards(nodeSqlStorage());
        let parkMs = 150;
        const harness = yield* session({ parkAfterMs: () => parkMs, parked: () => store }, [[HOLD], [HOLD], [HOLD]]);
        const process = fakeProcess(harness);
        yield* startTurn(harness);
        const held = yield* ask(harness, "ask-park").pipe(Effect.forkScoped);
        const first = yield* harness.until(isPark);
        const second = yield* harness.until(isPark);
        const parks = [first, second].flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        // Non-blocking questions: t3 sends their answers as messages, and they outlive the turn.
        for (const request of parks) {
          expect(request.kind).toBe("user_input");
          expect(request.responseCapability).toEqual({ type: "message" });
        }
        expect(yield* Fiber.join(held)).toEqual({ approved: false, parked: PARKED_CALL_TEXT });
        yield* harness.until((event) => event.type === "turn.terminal");
        expect(process.kill).toBe(1);
        // The CLI's own request was cancelled, never allowed.
        expect(
          harness
            .agentLog()
            .filter((entry) => (entry as { answered?: string }).answered === "session/request_permission"),
        ).toEqual([{ answered: "session/request_permission", result: { outcome: { outcome: "cancelled" } } }]);
        const records = parks.map((request) => store.get(request.id)!);
        expect(
          records.map((record) => [record.kind, record.thread]).toSorted(([a], [b]) => a!.localeCompare(b!)),
        ).toEqual([
          ["native", harness.threadId],
          ["tool", harness.threadId],
        ]);
        const tool = records.find((record) => record.kind === "tool")!;
        const native = records.find((record) => record.kind === "native")!;
        expect([tool.tool, tool.argsHash, tool.title]).toEqual([
          "fixture/fixture_note",
          "h1",
          "Allow fixture: fixture_note?",
        ]);
        // The question says it parked and where Park after is changed.
        const item = harness.seen.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.requestId === tool.id,
        );
        if (item?.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
          throw new Error("expected the park question's item");
        expect(item.turnItem.questions[0]!.question).toContain(
          "The turn parked: this card reached its 1-minute time limit; change it under",
        );
        expect(item.turnItem.questions[0]!.question).toContain("Park after (minutes)");
        expect(item.turnItem.questions[0]!.options.map((option) => option.label)).toEqual([
          "Allow",
          "Allow for this session",
          "Decline",
        ]);

        // The tool's answer: a new turn that tells the agent what to repeat, with a one-time allowance for that call.
        parkMs = 0;
        // Its prompt asks the same request again, which still waits (its own answer is not in yet).
        const again = yield* startTurn(harness, {
          messageId: `async-answer:${tool.id}`,
          text: `${item.turnItem.questions[0]!.question}\nAllow`,
          ordinal: 2,
        });
        const prompts = harness.agentLog().filter((entry) => entry.received === "session/prompt");
        expect(yield* encodeJson(prompts.at(-1)!.params)).toContain(
          "Repeat that call now with exactly the same arguments",
        );
        expect(store.get(tool.id)).toBeUndefined();
        expect(store.take(harness.threadId, "tool", "fixture/fixture_note", "h2")).toBeUndefined();
        expect(store.take(harness.threadId, "tool", "fixture/fixture_note", "h1")).toEqual({ forSession: false });
        expect(store.take(harness.threadId, "tool", "fixture/fixture_note", "h1")).toBeUndefined();
        yield* harness.runtime.respondToRuntimeRequest({ requestId: again.id, decision: "decline" });
        yield* harness.until((event) => event.type === "turn.terminal");

        // The native request's answer: its repeat is allowed once, by the wrapper, without the Owner.
        yield* harness.runtime.startTurn({
          ...makeTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            instanceId: harness.instanceId,
            runtimePolicy: harness.runtimePolicy,
            now: yield* DateTime.now,
            modelSelection: harness.modelSelection,
            ordinal: 3,
            messageText: "Parked\nAllow",
          }),
          message: {
            messageId: MessageId.make(`async-answer:${native.id}`),
            text: "Parked\nAllow",
            attachments: [],
            createdBy: "user",
            creationSource: "server",
          },
        });
        const done = yield* harness.until((event) => event.type === "turn.terminal");
        expect(done.type === "turn.terminal" && done.status).toBe("completed");
        expect(
          harness
            .agentLog()
            .filter((entry) => (entry as { answered?: string }).answered === "session/request_permission")
            .map((entry) => (entry as { result?: { outcome?: unknown } }).result?.outcome),
        ).toEqual([
          { outcome: "cancelled" },
          { outcome: "selected", optionId: "reject" },
          { outcome: "selected", optionId: "allow-once" },
        ]);
        expect(store.threads()).toEqual([]);
      }),
    ));

  it("never parks with Park after off; a Turn limit hit while a card is open parks instead of only killing", () =>
    test(
      Effect.gen(function* () {
        const store = parkedCards(nodeSqlStorage());
        const harness = yield* session({ parkAfterMs: () => 0, turnLimitMs: () => 150, parked: () => store });
        const process = fakeProcess(harness);
        yield* startTurn(harness);
        const parkedEvent = yield* harness.until(isPark);
        if (parkedEvent.type !== "runtime_request.updated") throw new Error("expected a park question");
        expect(store.get(parkedEvent.runtimeRequest.id)).toMatchObject({ kind: "native" });
        const item = harness.seen.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        expect(
          item?.type === "turn_item.updated" &&
            item.turnItem.type === "user_input_request" &&
            item.turnItem.questions[0]!.question,
        ).toContain("The turn parked: it reached the Turn limit, its 1-minute time limit");
        yield* harness.until((event) => event.type === "turn.terminal");
        expect(process.kill).toBe(1);
      }),
    ));
});

describe("the ACP driver's adapter options", () => {
  it("never gives t3's adapter client terminals: the agent's commands run in the Workspace, not in t3", () =>
    test(
      Effect.gen(function* () {
        const options = acpAdapterOptions(
          ProviderInstanceId.make("claudeAgent"),
          acpFlavor("claude", ProviderDriverKind.make("claudeAgent"), {}),
          undefined,
        );
        expect("clientTerminals" in options).toBe(false);
        const harness = yield* session();
        const hold = yield* startTurn(harness);
        yield* harness.runtime.respondToRuntimeRequest({ requestId: hold.id, decision: "accept" });
        const initialize = harness.agentLog().find((entry) => entry.received === "initialize");
        // The agent saw t3's initialize, and its client capabilities do not offer terminals.
        expect(initialize).toBeDefined();
        const capabilities = initialize!.params!.clientCapabilities as { terminal?: boolean };
        expect(capabilities.terminal).toBe(false);
      }),
    ));
});
