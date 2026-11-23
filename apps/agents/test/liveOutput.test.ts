// SPI-996: what the Session pushes for t3's live command output and prompt suggestions.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  NESTED_ARGS_BYTES,
  NESTED_OUTPUT_BYTES,
  PUSH_BURST_RESULTS,
  PUSH_ENTRIES_BYTES,
  RPC_MESSAGE_BYTES,
  SESSION_ROW_BYTES,
  T3_DETAIL_STRING_BYTES,
  T3_ON_DEMAND_BYTES,
  T3_OUTPUT_TAIL_CHARS,
  TOOL_LIVE_OUTPUT_BYTES,
  TOOL_OUTPUT_BYTES,
} from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUGGESTION_LIMITS,
  newestMatch,
  PROMPT_SUGGESTION_PROMPT,
  suggestionContext,
  suggestPrompt,
} from "../src/session/promptSuggestion.ts";
import { liveOf, pushedEntry, pushPage } from "../src/session/state.ts";

describe("what t3 is shown of a tool (SPI-1362)", () => {
  const toolResult = (text: string, details?: unknown) => ({
    id: 5,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", content: [{ type: "text", text }], toolCallId: "c", toolName: "bash", details }],
  });
  const textOf = (entry: ReturnType<typeof pushedEntry>) =>
    entry.content.map((block) => (block.type === "text" ? block.text : "")).join("");

  it("derives each cut from t3's own display caps", () => {
    expect(TOOL_OUTPUT_BYTES).toBe(T3_ON_DEMAND_BYTES);
    expect(NESTED_ARGS_BYTES).toBe(T3_DETAIL_STRING_BYTES);
    expect(TOOL_LIVE_OUTPUT_BYTES).toBe(T3_OUTPUT_TAIL_CHARS);
    expect(NESTED_OUTPUT_BYTES).toBe(T3_OUTPUT_TAIL_CHARS);
  });

  it("pushes a tool result's text whole up to t3's on-demand size, and cuts past it", () => {
    const fits = "x".repeat(TOOL_OUTPUT_BYTES);
    expect(textOf(pushedEntry(toolResult(fits), "turn-1"))).toBe(fits);
    const over = textOf(pushedEntry(toolResult(`${fits}y`), "turn-1"));
    expect(new TextEncoder().encode(over).length).toBeLessThanOrEqual(TOOL_OUTPUT_BYTES);
    expect(over).toContain("[cut: ");
  });

  it("pushes a burst of full-size results in one push, a page the RPC carries (SPI-1362)", () => {
    // Each result's text past t3's cut, in one-byte characters: the most characters a pushed result takes.
    const burst = Array.from({ length: 3 * PUSH_BURST_RESULTS }, (_, index) =>
      pushedEntry({ ...toolResult("x".repeat(2 * TOOL_OUTPUT_BYTES)), id: index + 1 }, "turn-1"),
    );
    const page = pushPage(PUSH_ENTRIES_BYTES);
    const taken = burst.findIndex((entry) => !page.take(entry));
    // A round of PUSH_BURST_RESULTS settles in one push; a longer burst goes on in the next page.
    expect(taken).toBeGreaterThanOrEqual(PUSH_BURST_RESULTS);
    expect(taken).toBeLessThan(burst.length);
    // The first of a page always goes, however large.
    expect(pushPage(1).take(burst[0]!)).toBe(true);
    // The page and one whole Session row past it, at two bytes a character, leave the RPC room for the live state.
    expect(2 * (PUSH_ENTRIES_BYTES + SESSION_ROW_BYTES)).toBeLessThan(RPC_MESSAGE_BYTES * 0.75);
  });

  it("pushes a tool's details and an owner's message whole, however large", () => {
    const patch = "+".repeat(200 * 1024);
    expect(pushedEntry(toolResult("ok", { patch }), "turn-1").details).toEqual({ patch });
    const said = "u".repeat(100_000);
    const user = pushedEntry({ id: 1, kind: "pi.user", model: [{ role: "user", content: said }] }, "turn-1");
    expect(textOf(user)).toBe(said);
    const exit = pushedEntry({ id: 2, kind: "t3flare.terminal-exit", data: { text: patch } }, "turn-1");
    expect(exit.details).toEqual({ text: patch });
  });

  it("pushes a nested call's arguments whole up to t3's detail size, then each string cut, and its output's tail", () => {
    const nested = (args: unknown, output: string) =>
      liveOf(
        {
          run: { taskId: 7 },
          nestedTools: [
            { callId: "cm/c1", parentCallId: "cm", name: "bash", arguments: args, status: "running", output },
          ],
        },
        () => "turn-1",
      ).nestedTools![0]!;
    const command = "c".repeat(20_000);
    expect(nested({ command }, "out").args).toEqual({ command });
    const long = nested({ command: "c".repeat(NESTED_ARGS_BYTES) }, "out").args.command as string;
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(NESTED_ARGS_BYTES / 2);
    const output = `${"o".repeat(NESTED_OUTPUT_BYTES)}END`;
    expect(nested({}, output).output).toBe(output.slice(-NESTED_OUTPUT_BYTES));
  });
});

describe("a running call's output in the push", () => {
  it("carries the tail of a running call's retained output, and none once it is done", () => {
    const long = `${"x".repeat(TOOL_LIVE_OUTPUT_BYTES)}END`;
    const live = liveOf(
      {
        run: { taskId: 7 },
        tools: [
          { callId: "a", name: "bash", status: "running", output: "1\n2\n" },
          { callId: "b", name: "bash", status: "running", output: long },
          { callId: "c", name: "bash", status: "done", output: "all of it" },
          { callId: "d", name: "bash", status: "running", output: "" },
        ],
      },
      () => "turn-1",
    );
    expect(live.tools).toEqual([
      { callId: "a", name: "bash", status: "running", output: "1\n2\n" },
      { callId: "b", name: "bash", status: "running", output: long.slice(-TOOL_LIVE_OUTPUT_BYTES) },
      { callId: "c", name: "bash", status: "done" },
      { callId: "d", name: "bash", status: "running" },
    ]);
    expect(live.tools[1]!.output!.endsWith("END")).toBe(true);
  });
});

const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason }) as AssistantMessage;

/** The one user message's text (`suggestionContext` writes it as a string). */
const askedText = (asked: ReturnType<typeof suggestionContext>): string => {
  const content = asked.messages[0]!.content;
  return typeof content === "string" ? content : "";
};

describe("prompt suggestions", () => {
  const model = { id: "claude-haiku-5-5", provider: "anthropic" } as never;
  const models = (answer: AssistantMessage | Error) => ({
    completeSimple: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });

  it("asks with t3's prompt, the turn's request and answer only", () => {
    const asked = suggestionContext("fix the build", "Fixed: a missing import.");
    const text = askedText(asked);
    expect(text).toContain("fix the build");
    expect(text).toContain("Fixed: a missing import.");
    expect(text.endsWith(PROMPT_SUGGESTION_PROMPT)).toBe(true);
    expect(askedText(suggestionContext("u", "a".repeat(10_000))).length).toBeLessThan(5_000);
  });

  it("is the model's text, unquoted, however long; nothing on an error, a failure or an empty turn", async () => {
    expect(await suggestPrompt(models(reply('"Now run the tests"')), model, "fix it", "fixed")).toBe(
      "Now run the tests",
    );
    expect(await suggestPrompt(models(reply("")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(reply("x", "error")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(new Error("down")), model, "fix it", "fixed")).toBe("");
    expect(await suggestPrompt(models(reply("y".repeat(400))), model, "fix it", "fixed")).toBe("y".repeat(400));
    expect(await suggestPrompt(models(reply("never asked")), model, "", "fixed")).toBe("");
  });

  it("reads the last excerptCharacters of each and waits timeoutMs, the settings' (SPI-1362)", async () => {
    expect(DEFAULT_SUGGESTION_LIMITS).toEqual({ excerptCharacters: 4_000, timeoutMs: 20_000 });
    const limits = { excerptCharacters: 100, timeoutMs: 20 };
    const text = askedText(suggestionContext(`${"u".repeat(500)}USER`, `${"a".repeat(500)}ANSWER`, limits));
    expect(text).toContain(`…${"u".repeat(96)}USER\n`);
    expect(text).not.toContain("u".repeat(97));
    expect(text).toContain(`…${"a".repeat(94)}ANSWER\n`);
    const hung = {
      completeSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
        new Promise<AssistantMessage>((_, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason)),
        ),
    };
    expect(await suggestPrompt(hung as never, model, "fix it", "fixed", limits)).toBe("");
  });
});

describe("a turn's final answer (SPI-1366: found in any turn, not only among its newest 20 entries)", () => {
  /** `items` newest first, read in pages of `size`, counting the pages read. */
  const pagesOf = <A>(items: ReadonlyArray<A>, size: number) => {
    const read = { pages: 0 };
    const page = async (cursor: number | undefined) => {
      read.pages++;
      const at = cursor ?? 0;
      const next = at + size < items.length ? at + size : undefined;
      return { items: items.slice(at, at + size), ...(next === undefined ? {} : { next }) };
    };
    return { page, read };
  };

  it("pages back past any number of tool entries to the newest that matches, and reads no further", async () => {
    const entries = [...Array.from({ length: 45 }, () => "tool"), "answer", "older answer"];
    const { page, read } = pagesOf(entries, 20);
    expect(await newestMatch(page, (entry) => entry.includes("answer"))).toBe("answer");
    expect(read.pages).toBe(3);
  });

  it("is undefined when no entry matches", async () => {
    const { page } = pagesOf(["tool", "tool"], 1);
    expect(await newestMatch(page, (entry) => entry === "answer")).toBeUndefined();
  });
});
