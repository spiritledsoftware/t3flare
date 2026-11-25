// @effect-diagnostics globalTimers:off
// SPI-1079: an MCP server's questions as t3 cards. The pure plans (`mcp/elicitation.ts`: card kinds, answers back, the
// rules), the MCP host's live questions and Executor-style pauses over a fake engine, and the Environment's fence on `t3_pending_request`.
import { applyMcpChange, CARD_WAIT_MS, EMPTY_HARNESS } from "@t3flare/harness-registry";
import type { McpAsker, McpQuestionAnswer, McpQuestionCard } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import {
  isPausingServer,
  MCP_CARD_BYTES,
  pauseOf,
  planPause,
  planQuestion,
  SEND_QUESTION,
  type QuestionContext,
} from "../src/mcp/elicitation.ts";
import { McpHost, type McpEngineBinding } from "../src/mcp/host.ts";
import {
  OWNER_ONLY_REFUSAL,
  PARKED_OWNER_ONLY_REFUSAL,
  QUEUED_ANSWER_REFUSAL,
  refuseOwnerOnly,
  TASK_ANSWER_REFUSAL,
} from "../src/mcp/ownerOnly.ts";

const context: QuestionContext = {
  server: "fixture",
  tool: "fixture_ask",
  args: { why: "test" },
  isOwnHost: (host) => host === "t3.example.com",
};
const ask = (params: Record<string, unknown>) =>
  planQuestion({ key: "q1", kind: "elicitation", params: params as never, mode: "live" }, context);

const form = {
  type: "object",
  properties: {
    colour: { type: "string", title: "Colour", enum: ["red", "blue"] },
    note: { type: "string", description: "A note" },
    urgent: { type: "boolean", title: "Urgent" },
    count: { type: "integer", minimum: 1 },
  },
  required: ["colour"],
};

describe("planQuestion", () => {
  it("a form with no fields is an approval card; only accept accepts", () => {
    const plan = ask({ message: "Delete the thing?", requestedSchema: { type: "object", properties: {} } });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card).toMatchObject({ kind: "approval", server: "fixture" });
    expect(plan.card.id).toMatch(/^t3flare-elicit-/);
    expect(plan.card.prompt).toContain("Delete the thing?");
    expect(plan.card.prompt).toContain("fixture_ask");
    expect(plan.card.options?.map((option) => option.decision)).toEqual(["accept", "decline", "cancel"]);
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    expect(plan.answerOf({ decision: "decline" }).result).toEqual({ action: "decline" });
    expect(plan.answerOf({ decision: "cancel", reason: "no live turn" }).result).toEqual({ action: "cancel" });
  });

  it("a form with fields is a user_input card, one question per field and a Send question; answers are typed", () => {
    const plan = ask({ message: "Tell me more", requestedSchema: form });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("form");
    const questions = plan.card.questions ?? [];
    expect(questions.map((question) => question.id)).toEqual(["colour", "note", "urgent", "count", SEND_QUESTION]);
    expect(questions[0]?.question).toContain("Tell me more");
    expect(questions[0]?.options.map((option) => option.value)).toEqual(["red", "blue"]);
    expect(questions[2]?.options.map((option) => option.value)).toEqual(["true", "false"]);
    expect(questions[1]?.question).toContain("(optional)");
    const sent = plan.answerOf({
      decision: "accept",
      answers: { colour: "blue", note: "hi", urgent: "true", count: "3", [SEND_QUESTION]: "send" },
    });
    expect(sent.result).toEqual({ action: "accept", content: { colour: "blue", note: "hi", urgent: true, count: 3 } });
    expect(
      plan.answerOf({ decision: "accept", answers: { colour: "blue", [SEND_QUESTION]: "decline" } }).result,
    ).toEqual({ action: "decline" });
    const wrong = plan.answerOf({ decision: "accept", answers: { colour: "green", [SEND_QUESTION]: "send" } });
    expect(wrong.result.action).toBe("cancel");
    expect(wrong.note).toContain("colour");
    expect(plan.answerOf({ decision: "cancel", reason: "the turn ended" }).result).toEqual({ action: "cancel" });
  });

  it("a form that asks for a credential is declined unseen; a malformed one is refused", () => {
    const secret = ask({
      message: "Log in",
      requestedSchema: { type: "object", properties: { user: { type: "string" }, api_key: { type: "string" } } },
    });
    expect(secret).toMatchObject({ kind: "now", answer: { kind: "answered", result: { action: "decline" } } });
    const bad = ask({ message: "?", requestedSchema: { type: "object", properties: { x: { $ref: "#/y" } } } });
    expect(bad).toMatchObject({ kind: "now", answer: { kind: "refused" } });
    expect(planQuestion({ key: "s", kind: "sampling", params: {}, mode: "live" }, context)).toMatchObject({
      kind: "now",
      answer: { kind: "refused" },
    });
  });

  it("a page is an approval card showing its link; http, private and own-host pages are declined unseen", () => {
    const plan = ask({
      mode: "url",
      message: "Connect your account",
      url: "https://auth.example.org/connect?x=1",
      elicitationId: "e1",
    });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("approval");
    expect(plan.card.prompt).toContain("https://auth.example.org/connect?x=1");
    expect(plan.card.options?.[0]).toEqual({ decision: "accept", label: "Opened it" });
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    for (const url of [
      "http://auth.example.org/",
      "https://127.0.0.1/",
      "https://printer.local/",
      "https://t3.example.com/_t3flare/settings",
    ]) {
      expect(ask({ mode: "url", message: "x", url, elicitationId: "e" })).toMatchObject({
        kind: "now",
        answer: { kind: "answered", result: { action: "decline" } },
      });
    }
  });

  it("a question too large for a card is declined unseen, saying why; one under the bound is a card (SPI-1363)", () => {
    // Each option's label is kept twice, so 4,000 options of 100 characters pass 1 MiB stored.
    const options = Array.from({ length: 4000 }, (_, index) => `${index}`.padEnd(100, "o"));
    const huge = ask({
      message: "Pick one",
      requestedSchema: { type: "object", properties: { pick: { type: "string", enum: options } } },
    });
    expect(huge).toMatchObject({ kind: "now", answer: { kind: "answered", result: { action: "decline" } } });
    if (huge.kind !== "now") throw new Error("expected a decline");
    expect(huge.why).toContain(`${MCP_CARD_BYTES / 1024 / 1024} MiB a card holds`);
    const page = ask({
      mode: "url",
      message: "x",
      url: `https://auth.example.org/?q=${"q".repeat(400_000)}`,
      elicitationId: "e",
    });
    expect(page).toMatchObject({ kind: "now", answer: { result: { action: "decline" } } });
    const fine = ask({
      message: "Pick one",
      requestedSchema: { type: "object", properties: { pick: { type: "string", enum: options.slice(0, 200) } } },
    });
    expect(fine.kind).toBe("card");
    const paused = planPause(
      pauseOf(pause("input-required", { type: "object", properties: { pick: { type: "string", enum: options } } }))!,
      { ...context, tool: "call" },
    );
    expect(paused).toMatchObject({ kind: "now", answer: { result: { action: "decline" } } });
  });

  it("a page's address is shown whole, however long it and the server's message are; labels are not cut", () => {
    const url = `https://auth.example.org/connect?state=${"s".repeat(20_000)}`;
    const plan = ask({ mode: "url", message: "m".repeat(40_000), url, elicitationId: "e1" });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.prompt).toContain(`Page: ${url}\n`);
    expect(plan.card.prompt).toContain("TRUNCATED");
    const title = `T${"t".repeat(300)}`;
    const labelled = ask({
      message: "?",
      requestedSchema: { type: "object", properties: { a: { type: "string", title, description: "d".repeat(900) } } },
    });
    if (labelled.kind !== "card") throw new Error("expected a card");
    expect(labelled.card.questions?.[0]).toMatchObject({
      header: title,
      question: expect.stringContaining(`${"d".repeat(900)} (optional)`),
    });
  });
});

const pause = (
  status: "approval-required" | "input-required",
  schema: unknown = { type: "object", properties: {} },
) => ({
  content: [{ type: "text", text: JSON.stringify({ status, requestId: "apr_1" }) }],
  structuredContent: {
    status,
    requestId: "apr_1",
    elicitation: {
      mode: "form",
      message: "Approve mac-bridge.messages_send?",
      requestedSchema: schema,
      _meta: { app: "mac-bridge", tool: "messages_send", args: { to: "me" } },
    },
    expiresAt: "2026-11-13T12:00:00Z",
  },
});

describe("Executor-style pauses", () => {
  it("recognises model mode's resume and its pauses, not browser mode's", () => {
    expect(
      isPausingServer({ resume: { inputSchema: { type: "object", properties: { requestId: {}, response: {} } } } }),
    ).toBe(true);
    expect(isPausingServer({ resume: { inputSchema: { type: "object", properties: { requestId: {} } } } })).toBe(false);
    expect(pauseOf(pause("approval-required"))).toMatchObject({ status: "approval-required", requestId: "apr_1" });
    expect(pauseOf({ structuredContent: { status: "user_approval_required", executionId: "x" } })).toBeUndefined();
  });

  it("an approval's card shows Executor's own text and the agent's call; only accept accepts", () => {
    const plan = planPause(pauseOf(pause("approval-required"))!, { ...context, tool: "call" });
    if (plan.kind !== "card") throw new Error("expected a card");
    expect(plan.card.kind).toBe("approval");
    expect(plan.card.prompt).toContain("Approve mac-bridge.messages_send?");
    expect(plan.card.prompt).toContain('"tool": "messages_send"');
    expect(plan.card.prompt).toContain("The agent's call: fixture: call");
    expect(plan.card.prompt).not.toContain("apr_1");
    expect(plan.answerOf({ decision: "accept" }).result).toEqual({ action: "accept" });
    expect(plan.answerOf({ decision: "decline" }).result).toEqual({ action: "decline" });
  });
});

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const tool = (name: string, properties: Record<string, unknown> = {}, readOnlyHint?: boolean) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

/** A host over a direct server `fixture` whose engine answers with `respond` (given the request and the hooks). */
const hostOver = async (
  tools: Array<Record<string, unknown>>,
  respond: (request: any, hooks: any) => Promise<unknown>,
  questionWaitMs?: () => number,
  pausesPerCall?: () => number,
) => {
  const added = applyMcpChange(EMPTY_HARNESS, {
    op: "add",
    server: "fixture",
    url: "https://fixture.example/mcp",
    auth: { kind: "none" },
  });
  if (!added.ok) throw new Error(added.error);
  const requests: Array<any> = [];
  const engine: McpEngineBinding = {
    discover: async () =>
      ({
        kind: "discovered",
        era: "legacy",
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools,
        prompts: [],
        problems: [],
        fetchedAt: 0,
        state: {},
      }) as never,
    request: async (_target, _prior, request, hooks) => {
      requests.push(request);
      return {
        kind: "complete",
        result: { kind: "inline", value: await respond(request, hooks) },
        cacheable: false,
        fetchedAt: 0,
        state: {},
      } as never;
    },
  };
  const host = new McpHost({
    kv: memory(),
    engine,
    settings: () => added.harness,
    now: () => 1,
    ownHost: () => "t3.example.com",
    ...(questionWaitMs === undefined ? {} : { questionWaitMs }),
    ...(pausesPerCall === undefined ? {} : { pausesPerCall }),
  });
  await host.list("fixture");
  return { host, requests };
};

const askerAnswering = (answer: (card: McpQuestionCard) => McpQuestionAnswer) => {
  const cards: Array<McpQuestionCard> = [];
  const withdrawn: Array<string> = [];
  const asker: McpAsker = {
    ask: async (card) => {
      cards.push(card);
      return answer(card);
    },
    withdraw: (id) => void withdrawn.push(id),
  };
  return { asker, cards, withdrawn };
};

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("McpHost questions", () => {
  it("an agent's call declares elicitation, and the server's question is answered from the owner's card", async () => {
    const { host, requests } = await hostOver([tool("fixture_ask")], async (_request, hooks) => {
      const answer = await hooks.onInput({
        key: "k",
        kind: "elicitation",
        params: { message: "Colour?", requestedSchema: form },
        mode: "live",
        era: "legacy",
      });
      return text(JSON.stringify(answer));
    });
    const owner = askerAnswering(() => ({ decision: "accept", answers: { colour: "red", [SEND_QUESTION]: "send" } }));
    const answer = await host.call({
      server: "fixture",
      tool: "fixture_ask",
      args: {},
      judged: "write",
      asker: owner.asker,
    });
    expect(requests[0].ctx).toMatchObject({ origin: "agent", answers: { elicitation: true } });
    expect(owner.cards).toHaveLength(1);
    expect(answer).toMatchObject({ kind: "result" });
    expect(JSON.parse((answer as { text: string }).text)).toEqual({
      kind: "answered",
      result: { action: "accept", content: { colour: "red" } },
    });
  });

  it("the server's own withdrawal closes the card that waits", async () => {
    let release: () => void = () => undefined;
    const { host } = await hostOver([tool("fixture_confirm")], async (_request, hooks) => {
      const answer = hooks.onInput({
        key: "k1",
        kind: "elicitation",
        params: { message: "Sure?", requestedSchema: { type: "object", properties: {} } },
        mode: "live",
        era: "legacy",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await hooks.onInputEnded("k1");
      return text(JSON.stringify(await answer));
    });
    const withdrawn: Array<string> = [];
    const asker: McpAsker = {
      ask: (card) =>
        new Promise((resolve) => (release = () => resolve({ decision: "cancel", reason: `withdrawn ${card.id}` }))),
      withdraw: (id) => {
        withdrawn.push(id);
        release();
      },
    };
    const answer = await host.call({ server: "fixture", tool: "fixture_confirm", args: {}, judged: "write", asker });
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]).toMatch(/^t3flare-elicit-/);
    expect(JSON.parse((answer as { text: string }).text)).toEqual({ kind: "answered", result: { action: "cancel" } });
  });

  it("a question waits the host's card wait, read at the call, and closes unanswered after it (a test's short wait)", async () => {
    let waitMs = 30;
    const confirm = async (_request: unknown, hooks: any) =>
      text(
        JSON.stringify(
          await hooks.onInput({
            key: "k",
            kind: "elicitation",
            params: { message: "Sure?", requestedSchema: { type: "object", properties: {} } },
            mode: "live",
            era: "legacy",
          }),
        ),
      );
    const { host, requests } = await hostOver([tool("fixture_confirm")], confirm, () => waitMs);
    const withdrawn: Array<string> = [];
    // An owner who never answers; the card is raised, then the setting moves to an hour: this card keeps its deadline.
    const asker: McpAsker = {
      ask: () => {
        waitMs = 60 * 60_000;
        return new Promise(() => undefined);
      },
      withdraw: (id) => void withdrawn.push(id),
    };
    const answer = await host.call({ server: "fixture", tool: "fixture_confirm", args: {}, judged: "write", asker });
    expect(requests[0].ctx).toMatchObject({ answers: { elicitation: true, inputWaitMs: 30 } });
    expect(withdrawn).toHaveLength(1);
    expect(JSON.parse((answer as { text: string }).text)).toEqual({ kind: "answered", result: { action: "cancel" } });
    // The next call takes the wait now.
    await host.call({
      server: "fixture",
      tool: "fixture_confirm",
      args: {},
      judged: "write",
      asker: { ...askerAnswering(() => ({ decision: "cancel" })).asker },
    });
    expect(requests[1].ctx).toMatchObject({ answers: { inputWaitMs: 60 * 60_000 } });
  });

  it("a question waits until it is answered by default: the engine's input bound is the off deadline (SPI-1389)", async () => {
    const { host, requests } = await hostOver([tool("fixture_echo", {}, true)], async () => text("ok"));
    const owner = askerAnswering(() => ({ decision: "cancel" }));
    await host.call({ server: "fixture", tool: "fixture_echo", args: {}, judged: "read", asker: owner.asker });
    expect(requests[0].ctx).toMatchObject({ answers: { inputWaitMs: CARD_WAIT_MS } });
  });

  it("without an asker nothing is declared", async () => {
    const { host, requests } = await hostOver([tool("fixture_echo", {}, true)], async () => text("ok"));
    await host.call({ server: "fixture", tool: "fixture_echo", args: {}, judged: "read" });
    expect(requests[0].ctx).toEqual({ origin: "agent" });
  });

  const executorTools = [
    tool("call", { calls: {} }),
    tool("execute", { code: {} }),
    tool("resume", { requestId: {}, response: {} }, true),
  ];

  it("a pausing server's resume is hidden from agents and refused when called", async () => {
    const { host, requests } = await hostOver(executorTools, async () => text("never"));
    const view = await host.view();
    expect(view.servers.find((server) => server.name === "fixture")?.tools.map((t) => t.upstream)).toEqual([
      "call",
      "execute",
    ]);
    const answer = await host.call({
      server: "fixture",
      tool: "resume",
      args: { requestId: "apr_1", response: { action: "accept" } },
      judged: "read",
    });
    expect(answer).toMatchObject({ kind: "unavailable", mayHaveRun: false });
    expect(requests).toHaveLength(0);
  });

  it("an approval pause is resumed with accept only after the owner accepts; the agent never sees the requestId", async () => {
    const { host, requests } = await hostOver(executorTools, async (request) =>
      request.tool.name === "call"
        ? pause("approval-required")
        : text(`resumed with ${JSON.stringify(request.arguments.response)}`),
    );
    const owner = askerAnswering(() => ({ decision: "accept" }));
    const answer = await host.call({
      server: "fixture",
      tool: "call",
      args: { calls: { path: "tools.mac-bridge.messages_send" } },
      judged: "write",
      asker: owner.asker,
    });
    expect(owner.cards[0]?.prompt).toContain("Approve mac-bridge.messages_send?");
    expect(owner.cards[0]?.prompt).toContain("tools.mac-bridge.messages_send");
    expect(requests.map((request) => request.tool.name)).toEqual(["call", "resume"]);
    expect(requests[1].arguments).toEqual({ requestId: "apr_1", response: { action: "accept" } });
    expect(answer).toEqual({ kind: "result", isError: false, text: 'resumed with {"action":"accept"}' });
  });

  it("a declined pause is sent Executor's decline, never an accept; an unanswered one is sent cancel", async () => {
    for (const [decision, action] of [
      ["decline", "decline"],
      ["cancel", "cancel"],
    ] as const) {
      const { host, requests } = await hostOver(executorTools, async (request) =>
        request.tool.name === "call" ? pause("approval-required") : text("declined"),
      );
      const owner = askerAnswering(() => ({ decision }));
      await host.call({ server: "fixture", tool: "call", args: {}, judged: "write", asker: owner.asker });
      expect(requests[1].arguments).toEqual({ requestId: "apr_1", response: { action } });
    }
  });

  it("answers as many pauses of one call as the setting allows, then ends it as may have run (SPI-1366)", async () => {
    for (const [allowed, expected] of [
      [3, 3],
      [20, 20],
    ] as const) {
      const { host, requests } = await hostOver(
        executorTools,
        async () => pause("approval-required"),
        undefined,
        () => allowed,
      );
      const owner = askerAnswering(() => ({ decision: "accept" }));
      const answer = await host.call({
        server: "fixture",
        tool: "call",
        args: {},
        judged: "write",
        asker: owner.asker,
      });
      expect(owner.cards).toHaveLength(expected);
      expect(requests.filter((request) => request.tool.name === "resume")).toHaveLength(expected);
      expect(answer).toMatchObject({
        kind: "unavailable",
        mayHaveRun: true,
        message: expect.stringContaining(`more than ${allowed} times`),
      });
    }
  });

  it("an expired outcome that still carries the requestId reaches the agent without it", async () => {
    const { host } = await hostOver(executorTools, async (request) =>
      request.tool.name === "call"
        ? pause("approval-required")
        : {
            content: [{ type: "text", text: '{"requestId":"apr_1"}' }],
            structuredContent: { status: "unavailable", requestId: "apr_1", message: "Request apr_1 expired." },
            isError: true,
          },
    );
    const owner = askerAnswering(() => ({ decision: "accept" }));
    const answer = await host.call({ server: "fixture", tool: "call", args: {}, judged: "write", asker: owner.asker });
    expect(answer).toEqual({ kind: "result", isError: true, text: "Request [request] expired." });
  });
});

describe("refuseOwnerOnly", () => {
  const call = (args: Record<string, unknown>, id: unknown = 7) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "t3_pending_request", arguments: args },
    });

  it("refuses read and respond on an MCP question's card, and nothing else", () => {
    const refused = refuseOwnerOnly(
      call({ action: "respond", requestId: "runtime-request:codex:t3flare-ask:t3flare-elicit-1", answers: { a: "b" } }),
    );
    expect(JSON.parse(refused!)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: OWNER_ONLY_REFUSAL }], isError: true },
    });
    expect(
      refuseOwnerOnly(
        call({ action: "read", requestId: "runtime-request:piDurable:thread:x:approval:t3flare-elicit-2" }),
      ),
    ).toBeDefined();
    expect(refuseOwnerOnly(call({ action: "list" }))).toBeUndefined();
    expect(
      refuseOwnerOnly(call({ action: "respond", requestId: "runtime-request:piDurable:thread:x:approval:task-9" })),
    ).toBeUndefined();
    expect(refuseOwnerOnly("not json")).toBeUndefined();
    const batch = refuseOwnerOnly(
      `[${call({ action: "respond", requestId: "t3flare-elicit-3" }, 1)},${call({ action: "list" }, 2)}]`,
    );
    expect(JSON.parse(batch!).map((answer: { id: number }) => answer.id)).toEqual([1, 2]);
  });

  it("refuses t3_queue edit, cancel and promote on the Owner's queued answer to a parked question, and task_cancel of its task (SPI-1389)", () => {
    const queue = (args: Record<string, unknown>) =>
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "t3_queue", arguments: args } });
    // The queued runs t3 holds: the Owner's answer to a parked question, and an ordinary message.
    const lookups = {
      queuedMessageOf: (runId: string) =>
        ({ "run-answer": "async-answer:runtime-request:codex:t3flare-park:1", "run-plain": "message-7" })[runId],
    };
    for (const action of ["edit", "cancel", "promote_to_steer"])
      expect(
        JSON.parse(refuseOwnerOnly(queue({ action, queuedRunId: "run-answer", text: "Allow" }), lookups)!),
      ).toMatchObject({ result: { content: [{ text: QUEUED_ANSWER_REFUSAL }], isError: true } });
    // Stopping the delegated task whose thread holds the answer would drop it too.
    const cancelTask = (taskId: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "task_cancel", arguments: { taskId } },
      });
    const tasks = { taskHoldsParkAnswer: (taskId: string) => taskId === "task-holding" };
    expect(JSON.parse(refuseOwnerOnly(cancelTask("task-holding"), tasks)!)).toMatchObject({
      result: { content: [{ text: TASK_ANSWER_REFUSAL }], isError: true },
    });
    expect(refuseOwnerOnly(cancelTask("task-other"), tasks)).toBeUndefined();
    expect(refuseOwnerOnly(queue({ action: "edit", queuedRunId: "run-plain", text: "x" }), lookups)).toBeUndefined();
    expect(refuseOwnerOnly(queue({ action: "list" }), lookups)).toBeUndefined();
    expect(refuseOwnerOnly(queue({ action: "read", queuedRunId: "run-answer" }), lookups)).toBeUndefined();
    // Without a way to read t3's queue, nothing is refused on it.
    expect(refuseOwnerOnly(queue({ action: "edit", queuedRunId: "run-answer", text: "x" }))).toBeUndefined();
  });

  it("refuses read and respond on a parked card's question (SPI-1389), with its own refusal", () => {
    for (const action of ["respond", "read"])
      expect(
        JSON.parse(
          refuseOwnerOnly(
            call({ action, requestId: "runtime-request:codex:t3flare-park:1", answers: { decision: "Allow" } }),
          )!,
        ),
      ).toMatchObject({ result: { content: [{ text: PARKED_OWNER_ONLY_REFUSAL }], isError: true } });
  });
});
