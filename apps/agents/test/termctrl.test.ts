// The `termctrl` extension (SPI-1057) on a real pi-durable Harness over pi-ai's faux provider, its Workspace half
// (`AgentTerminals`) over a fake PTY host that answers like a REPL: a turn starts a Terminal, types into it, polls it and
// stops it, with pi-termctrl's result texts; `bash`'s background job; an exit told after the tool round; and the
// approvals the thread's mode asks for (`terminal_start` and typing ask, a poll does not).
// @effect-diagnostics globalTimers:off globalDate:off
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  MemoryStorage,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { TERMINAL_INPUT_WAIT_MS, TERMINAL_POLL_WAIT_MS, TERMINAL_START_WAIT_MS } from "@t3flare/harness-registry";
import type { AgentTerminalRequest, AgentTerminalResult } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { codingTools } from "../src/extensions/coding-tools.ts";
import { ApprovalStore, permissions } from "../src/extensions/permissions.ts";
import { backgroundJobs, EXIT_ENTRY, type TermctrlHost, termctrlExtension } from "../src/extensions/termctrl.ts";
import {
  exitTails,
  formatExitNotice,
  scrolledLimits,
  screenLimits,
  TERMINAL_WAIT_MS,
  terminalResult,
  terminalSendTool,
  terminalStartTool,
  terminalWaitTool,
  waitOf,
} from "../src/extensions/termctrl/tools.ts";
import { DEFAULT_TOOL_OUTPUT_LIMITS, jobTailOf, type ToolOutputLimits } from "../src/extensions/toolOutput.ts";
import { AgentTerminals } from "../src/workspace/agentTerminals.ts";
import { nodeScrollbackStore } from "./nodeSql.ts";
import { context, memoryKv, until } from "./harness.fixture.ts";

/** A REPL behind a fake PTY host: echoes a line, answers it upper-cased, and exits on `exit`. */
const workspace = (output: ToolOutputLimits = DEFAULT_TOOL_OUTPUT_LIMITS) => {
  const requests: Array<AgentTerminalRequest & { readonly at: number }> = [];
  let terminals: AgentTerminals | undefined;
  const seq = new Map<string, number>();
  const emit = (key: string, data: string) => {
    const n = seq.get(key) ?? 0;
    seq.set(key, n + 1);
    terminals!.frames([{ key, seq: n, data }]);
  };
  const exit = (key: string, code: number) => terminals!.frames([{ key, seq: 999, exit: { code } }]);
  terminals = new AgentTerminals({
    host: {
      open: (input) => {
        if (input.command.includes("sleep 0")) setTimeout(() => (emit(input.key, "quick\r\n"), exit(input.key, 0)), 5);
        else if (input.command === "short-lived")
          setTimeout(() => (emit(input.key, "bye\r\n"), setTimeout(() => exit(input.key, 0), 300)), 5);
        else if (input.command.includes("tee")) setTimeout(() => emit(input.key, "serving on :3000\r\n"), 5);
        else setTimeout(() => emit(input.key, "> "), 5);
        return Promise.resolve();
      },
      input: (key, data) => {
        if (data === "exit\r") exit(key, 0);
        else emit(key, `${data.replace("\r", "")}\r\n= ${data.replace("\r", "").toUpperCase()}\r\n> `);
        return Promise.resolve();
      },
      closeAnswered: (key) => {
        setTimeout(() => exit(key, 130), 5);
        return Promise.resolve({ signalled: 1, survivors: 0, signal: "TERM" });
      },
      kill: () => Promise.resolve({ signalled: 0, survivors: 0, signal: null }),
    },
    now: () => Date.now(),
    nextId: (() => {
      const counts = new Map<string, number>();
      return (owner: string, kind: string) => {
        const next = (counts.get(`${kind}:${owner}`) ?? 0) + 1;
        counts.set(`${kind}:${owner}`, next);
        return next;
      };
    })(),
    env: {},
    repo: "/workspace/repo",
    store: nodeScrollbackStore(),
  });
  let used = false;
  const host: TermctrlHost = {
    owner: () => "session-1",
    toToolPath: (text) => text.replaceAll("/w/fixture", "/workspace/repo"),
    output: () => output,
    call: async <R extends AgentTerminalRequest>(request: R) => {
      requests.push({ ...request, at: Date.now() });
      const answer = await terminals!.handle(request);
      if (request.op === "start" && answer.ok) used = true;
      return answer as AgentTerminalResult<R["op"]>;
    },
  };
  return { host, terminals, used: () => used, requests };
};

/** A tool that takes 600 ms and sees nothing. */
const nap = defineExtension({
  name: "nap",
  tools: [
    defineTool({
      name: "nap",
      description: "wait",
      parameters: obj({}),
      execute: () =>
        new Promise<ToolExecutionResult>((resolve) =>
          setTimeout(() => resolve({ output: [{ type: "text" as const, text: "rested" }] }), 600),
        ),
    }),
  ],
});

const run = async (
  extensions: (harness: () => Promise<Harness>) => ReadonlyArray<Extension>,
  responses: ReadonlyArray<AssistantMessage>,
  more: ReadonlyArray<Extension> = [],
) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  const registry = createRegistry();
  let harness: Harness | undefined;
  for (const extension of [...extensions(() => Promise.resolve(harness!)), ...more]) registry.install(extension);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await root.submit({ type: "input", content: "go" }, context);
  harness.resume();
  return { harness, root };
};

const call = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const text = (message: ToolResultMessage | undefined) =>
  message?.content.map((block) => ("text" in block ? block.text : "")).join("") ?? "";

const results = async (root: Awaited<ReturnType<typeof run>>["root"]) => {
  const page = await root.entries({ order: "ascending" }, 200, undefined, context);
  return {
    tools: page.items.flatMap((entry) =>
      entry.model?.[0]?.role === "toolResult" ? [entry.model[0] as ToolResultMessage] : [],
    ),
    entries: page.items,
  };
};

describe("termctrl's fixed values and the Tool output limit (SPI-1362, SPI-1388)", () => {
  const small: ToolOutputLimits = { maxBytes: 8 * 1024, maxLines: 120 };
  const view = (screen: string, scrolledOff: ReadonlyArray<string>) => ({
    id: "t1",
    state: "running" as const,
    exit: null,
    screen,
    cursor: null,
    scrolledOff,
    outputMissing: false,
    previous: null,
    shift: null,
  });

  it("keeps the scrolled-off lines to half the output limit and the screen to the rest, so the result fits it", () => {
    expect(scrolledLimits(small)).toEqual({ lines: 60, bytes: 4 * 1024 });
    // TERMINAL_SCROLLED_LINES, and half the default Tool output limit's 50 KiB.
    expect(scrolledLimits(DEFAULT_TOOL_OUTPUT_LIMITS)).toEqual({ lines: 100, bytes: 25 * 1024 });
    const line = (index: number) => `row ${index} ${"x".repeat(70)}`;
    const shown = terminalResult(
      view(
        Array.from({ length: 300 }, (_, index) => line(index)).join("\n"),
        Array.from({ length: 500 }, (_, index) => line(index)),
      ),
      "quiet",
      {},
      small,
    );
    expect(new TextEncoder().encode(shown.text).length).toBeLessThanOrEqual(small.maxBytes);
    expect(shown.text.split("\n").length).toBeLessThanOrEqual(small.maxLines);
    // The cut names its limits.
    expect(shown.text).toContain(
      "(the 60-line or 4.0KB limit: t3flare's fixed scrolled-off lines, and half the Tool output limit)",
    );
    // The screen's last row survives: the Harness keeps a result's head, so nothing of it is cut there.
    expect(shown.text).toContain(line(299));
    expect(shown.text).toContain(`last ${screenLimits(small).lines} lines`);
  });

  it("shows each exit's whole tail, sharing a job's tail between the exits", () => {
    const entry = {
      id: "b1",
      kind: "background_job" as const,
      command: "make",
      cwd: "/",
      state: "exited" as const,
      exit: { code: 0, signal: null },
      startedAt: 0,
      endedAt: 1,
    };
    const fifty = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
    // termctrl's 20-line exit tail is gone: the job's tail bounds it.
    expect(formatExitNotice(entry, fifty)).toContain("line 0\n");
    const output = { maxBytes: 8 * 1024, maxLines: 100 };
    const tails = exitTails([fifty, fifty, fifty, fifty], output);
    const share = Math.floor(jobTailOf(output).lines / 4);
    expect(tails.every((tail) => tail.split("\n").length === share)).toBe(true);
    expect(tails[0]!.endsWith("line 49")).toBe(true);
  });

  it("waits termctrl's fixed waits and asks the Workspace for a job's tail within the output limit", async () => {
    const output = { maxBytes: 8 * 1024, maxLines: 100 };
    const { host, requests } = workspace(output);
    const run = (tool: ReturnType<typeof terminalStartTool>, args: Record<string, unknown>) =>
      tool.execute(
        args as never,
        { getTask: async () => undefined, snapshot: async () => undefined } as never,
        context,
      );
    await run(terminalStartTool(host), { command: "python3" });
    await run(terminalSendTool(host), { id: "t1", text: "1+1\n" });
    const settles = requests.filter((request) => request.op === "settle");
    const waited = settles.map((request) => (request.op === "settle" ? request.deadline - request.at : 0));
    expect(waited[0]).toBeGreaterThan(TERMINAL_START_WAIT_MS - 150);
    expect(waited[0]).toBeLessThanOrEqual(TERMINAL_START_WAIT_MS);
    expect(waited.at(-1)).toBeGreaterThan(TERMINAL_INPUT_WAIT_MS - 100);
    expect(waited.at(-1)).toBeLessThanOrEqual(TERMINAL_INPUT_WAIT_MS);
    expect(
      settles.every(
        (request) => request.op === "settle" && JSON.stringify(request.tail) === JSON.stringify(jobTailOf(output)),
      ),
    ).toBe(true);
    expect(backgroundJobs(host).waitMs).toBe(2_000);
    // The model is told the waits, and each start asks for termctrl's 120 by 40.
    expect(terminalStartTool(host).description).toContain("250 ms of quiet, exit, wait_ms (default 2000)");
    expect(terminalSendTool(host).description).toContain("wait_ms (default 500)");
    expect(terminalSendTool(host).description).toContain("wait_ms (default 30000) for new output");
    expect(requests.find((request) => request.op === "start")).toMatchObject({ cols: 120, rows: 40 });
  });
});

describe("termctrl", () => {
  it("waits as long as the agent asks: a wait runs in Workspace slices, so nothing bounds it (SPI-1361)", () => {
    const poll = TERMINAL_POLL_WAIT_MS;
    expect(waitOf(60 * 60_000, poll)).toBe(60 * 60_000);
    expect(waitOf(undefined, poll)).toBe(poll);
    expect(waitOf(-1, poll)).toBe(0);
    expect(TERMINAL_WAIT_MS).toBe(5 * 60_000);
    const host = { output: () => DEFAULT_TOOL_OUTPUT_LIMITS } as TermctrlHost;
    for (const tool of [terminalStartTool(host), terminalSendTool(host), terminalWaitTool(host)])
      expect(JSON.stringify(tool)).not.toMatch(/clamped|maximum 300000/);
  });

  it("starts, drives, polls and stops a Terminal in a real turn", async () => {
    const ws = workspace();
    const { root } = await run(
      (harness) => [termctrlExtension(harness, { host: ws.host, used: ws.used })],
      [
        call("terminal_start", { command: "node" }, "c1"),
        call("terminal_send", { id: "t1", text: "abc\n" }, "c2"),
        call("terminal_send", { id: "t1", wait_ms: 300 }, "c3"),
        call("terminal_send", { id: "t1", text: "x\n", wait_for_text: "/= Y/", wait_ms: 400 }, "c4"),
        call("terminal_stop", { id: "t1" }, "c5"),
        fauxAssistantMessage("done"),
      ],
    );
    await root.waitForIdle(context);
    const { tools } = await results(root);
    expect(text(tools[0])).toBe("t1 running · settled: quiet · cursor 1:3\n--- screen ---\n> ");
    expect(text(tools[1])).toBe("t1 running · settled: quiet · cursor 3:3\n--- screen ---\n> abc\n= ABC\n> ");
    // A poll that sees nothing new: the wait runs out, and the unchanged screen is not repeated.
    expect(text(tools[2])).toBe("t1 running · settled: timeout · screen unchanged · cursor 3:3");
    // The pattern never appears: the wait times out and says so; only the rows from the previous cursor row down.
    expect(text(tools[3])).toBe(
      't1 running · settled: timeout · cursor 5:3\nwait_for_text "/= Y/" was not seen before the wait ended.\n--- screen (rows 3-5 of 5; rows above unchanged) ---\n> x\n= X\n> ',
    );
    expect(text(tools[4])).toMatch(/^Terminal t1 stopped · cursor 5:3/);
    expect(tools[4]?.isError).toBe(false);
  }, 20_000);

  it("runs bash in the background: a quick command answers as bash, a long one becomes b2", async () => {
    const ws = workspace();
    const { root } = await run(
      (harness) => [
        codingTools({ jobs: backgroundJobs(ws.host) }),
        termctrlExtension(harness, { host: ws.host, used: ws.used }),
      ],
      [
        call("bash", { command: "sleep 0; echo quick", background: true }, "c1"),
        call("bash", { command: "npm run dev", background: true }, "c2"),
        call("terminal_list", {}, "c3"),
        fauxAssistantMessage("done"),
      ],
    );
    await root.waitForIdle(context);
    const { tools } = await results(root);
    expect(text(tools[0])).toBe("quick");
    expect(text(tools[1])).toContain("serving on :3000\n\nCommand moved to the background as b2.");
    expect(text(tools[1])).toMatch(/go to \/tmp\/t3flare-jobs\/term-agent-[a-z0-9]+-b2\.log/);
    expect(text(tools[2])).toMatch(/^Terminals:\n\(none\)\n\nBackground jobs:\nb2 running · \d+s · npm run dev · log /);
  }, 20_000);

  it("tells an unseen exit at the end of the tool round, as a steer into the run", async () => {
    const ws = workspace();
    const { root } = await run(
      (harness) => [termctrlExtension(harness, { host: ws.host, used: ws.used })],
      [
        call("terminal_start", { command: "short-lived", wait_ms: 100 }, "c1"),
        call("nap", {}, "c2"),
        fauxAssistantMessage("done"),
      ],
      [nap],
    );
    // The program exits while the agent naps: its exit is due at that round's end.
    await root.waitForIdle(context);
    const { entries } = await results(root);
    const notices = entries.filter((entry) => entry.kind === EXIT_ENTRY);
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]?.model)).toContain("Terminal t1 exited with code 0 after");
  }, 20_000);

  it("asks before terminal_start and typing as before bash, never before a poll", async () => {
    const ws = workspace();
    const store = new ApprovalStore(memoryKv(), () => {});
    const host = {
      store,
      mode: () => "approval-required" as const,
      interaction: () => "default" as const,
      turn: () => "turn-1",
      workspaceId: () => "fixture",
    };
    const { root } = await run(
      (harness) => [termctrlExtension(harness, { host: ws.host, used: ws.used }), permissions(host)],
      [
        call("terminal_start", { command: "python3" }, "c1"),
        call("terminal_send", { id: "t1", wait_ms: 100 }, "c2"),
        call("terminal_send", { id: "t1", text: "1+1\n" }, "c3"),
        fauxAssistantMessage("done"),
      ],
    );
    await until(() => store.pending().length === 1, "the start's card");
    expect(store.pending()[0]).toMatchObject({ tool: "terminal_start", kind: "command", summary: "Terminal: python3" });
    store.answer(store.pending()[0]!.requestId, "accept");
    await until(
      () => store.pending().length === 1 && store.pending()[0]!.tool === "terminal_send",
      "the typing's card",
    );
    expect(store.pending()[0]!.summary).toBe('Type into t1: "1+1\\n"');
    store.answer(store.pending()[0]!.requestId, "decline");
    await root.waitForIdle(context);
    const { tools } = await results(root);
    expect(tools.map((result) => result.isError)).toEqual([false, false, true]);
    expect(text(tools[2])).toContain("Declined by the owner");
  }, 20_000);
});
