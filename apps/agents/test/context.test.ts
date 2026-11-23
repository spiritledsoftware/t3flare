// The `context` extension (SPI-1056) on a real pi-durable Harness over pi-ai's faux provider: Notes kept in the
// Session's document within their bounds, History read back from stored entries (also from before a Handoff), and a
// Rollover that hands off to a fresh context the same run goes on in. The compaction hook is checked on its own.
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
  type Harness,
  Harness as HarnessApi,
  type HookApi,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { ContextDoc, contextExtension, MAX_TOTAL_NOTE_CHARACTERS } from "../src/extensions/context.ts";
import { READ_CHARACTERS } from "../src/extensions/context/history.ts";
import { noteIndex } from "../src/extensions/context/notes.ts";
import { conversationIdOf } from "../src/durableIds.ts";
import { CONTINUE_PROMPT, emergencyText, PREPARE_PROMPT, prepareRollover } from "../src/extensions/context/rollover.ts";
import { context } from "./harness.fixture.ts";

const open = async (responses: ReadonlyArray<AssistantMessage>) => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  const registry = createRegistry();
  let harness: Harness | undefined;
  registry.install(contextExtension(() => Promise.resolve(harness!), { rolloverOnCompaction: true }));
  harness = await HarnessApi.open(new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  await root.submit({ type: "input", content: "go" }, context);
  harness.resume();
  await root.waitForIdle(context);
  const page = await root.entries({ order: "ascending" }, 200, undefined, context);
  const results = page.items.flatMap((entry) => {
    const message = entry.model?.[0];
    return message?.role === "toolResult" ? [message as ToolResultMessage] : [];
  });
  return { harness, root, results, entries: page.items };
};

const calls = (...list: ReadonlyArray<[string, Record<string, unknown>]>) =>
  fauxAssistantMessage(
    list.map(([name, args], index) =>
      fauxToolCall(name, args as never, { id: `${name}-${index}-${JSON.stringify(args).length}` }),
    ),
    { stopReason: "toolUse" },
  );
const json = (message: ToolResultMessage | undefined) =>
  JSON.parse(message?.content.map((block) => ("text" in block ? block.text : "")).join("") ?? "null") as Record<
    string,
    unknown
  >;
const text = (message: ToolResultMessage | undefined) =>
  message?.content.map((block) => ("text" in block ? block.text : "")).join("") ?? "";

describe("context_notes", () => {
  it("writes, appends, reads, lists, searches, copies and deletes Notes in the Session's document", async () => {
    const { harness, root, results } = await open([
      calls(["context_notes", { action: "write", name: "plan", content: "step 1" }]),
      calls(["context_notes", { action: "append", name: "plan", content: "step 2" }]),
      calls(["context_notes", { action: "read", name: "plan" }]),
      calls(["context_notes", { action: "list" }]),
      calls(["context_notes", { action: "search", query: "step 2" }]),
      calls(["context_notes", { action: "copy", ref: "context:1:note:plan", name: "plan copy" }]),
      calls(["context_notes", { action: "delete", name: "nope" }]),
      fauxAssistantMessage("done"),
    ]);
    expect(json(results[0])).toEqual({ action: "write", name: "plan", saved: true });
    expect(json(results[2])).toMatchObject({
      name: "plan",
      content: "step 1\nstep 2",
      total_characters: 13,
      next_offset: null,
    });
    expect(json(results[3])).toMatchObject({ total: 1, notes: [{ name: "plan", characters: 13 }] });
    expect(json(results[4])).toMatchObject({ matches: [{ name: "plan", offset: 7, preview: "step 1\nstep 2" }] });
    expect(results[5]?.isError).toBe(false);
    expect(results[6]?.isError).toBe(true);
    expect(text(results[6])).toContain("Note not found");
    const state = await harness.snapshot(ContextDoc, root.id, context);
    expect(state?.notes.map((note) => note.name)).toEqual(["plan", "plan copy"]);
  });

  it("bounds Notes only by their total, names counted, so one Note, a name and the count have no bound of their own", async () => {
    const name = "n".repeat(200);
    const { harness, root, results } = await open([
      // One Note past the old 32,000-character bound, under a name past the old 64.
      calls(["context_notes", { action: "write", name, content: "x".repeat(100_000) }]),
      // The total counts names: this content fits the total by itself, not with the names already held.
      calls([
        "context_notes",
        { action: "write", name: "b", content: "y".repeat(MAX_TOTAL_NOTE_CHARACTERS - 100_000 - 1) },
      ]),
      calls([
        "context_notes",
        { action: "write", name: "b", content: "y".repeat(MAX_TOTAL_NOTE_CHARACTERS - 100_000 - 200 - 1) },
      ]),
      calls(["context_notes", { action: "read", ref: `context:1:note:${name}`, offset: 99_990 }]),
      fauxAssistantMessage("done"),
    ]);
    expect(results.map((result) => result.isError)).toEqual([false, true, false, false]);
    expect(text(results[1])).toContain(`Notes would exceed ${MAX_TOTAL_NOTE_CHARACTERS} characters in all`);
    expect(json(results[3])).toMatchObject({ content: "x".repeat(10), total_characters: 100_000 });
    const state = await harness.snapshot(ContextDoc, root.id, context);
    expect(state?.notes.map((note) => note.name)).toEqual([name, "b"]);
  });

  it("keeps more than 64 Notes, and lists as many as the agent asks for", async () => {
    const { results } = await open([
      ...Array.from({ length: 70 }, (_, index) =>
        calls(["context_notes", { action: "write", name: `n${index}`, content: "z" }]),
      ),
      calls(["context_notes", { action: "list", limit: 50 }]),
      calls(["context_notes", { action: "list" }]),
      fauxAssistantMessage("done"),
    ]);
    expect(results.slice(0, 70).every((result) => !result.isError)).toBe(true);
    expect(json(results[70])).toMatchObject({ total: 70, next_offset: 50 });
    expect((json(results[70]).notes as unknown[]).length).toBe(50);
    // With no limit a page is still 20.
    expect((json(results[71]).notes as unknown[]).length).toBe(20);
  });
});

describe("context_history pages", () => {
  it("lists as many entries as the agent asks for, while a read still returns at most READ_CHARACTERS (SPI-1361)", async () => {
    const { results } = await open([
      ...Array.from({ length: 20 }, (_, index) =>
        calls(["context_notes", { action: "write", name: `n${index}`, content: "z".repeat(3_000) }]),
      ),
      calls(["context_history", { action: "list", limit: 30 }]),
      calls(["context_history", { action: "read", ref: "context:1:11", limit: 5_000 }]),
      fauxAssistantMessage("done"),
    ]);
    expect(results[20]?.isError).toBe(false);
    expect((json(results[20]).items as unknown[]).length).toBe(30);
    expect((json(results[21]).content as string).length).toBe(READ_CHARACTERS);
  });
});

describe("noteIndex", () => {
  it("lists every Note's reference however many there are", () => {
    const notes = Array.from({ length: 64 }, (_, index) => ({
      name: `${"a".repeat(60)}${index}`,
      content: "",
      updatedAt: 0,
    }));
    const index = noteIndex(conversationIdOf("1"), notes);
    expect(index.length).toBeGreaterThan(4_000);
    for (const note of notes) expect(index).toContain(`context:1:note:${note.name}`);
  });
});

describe("context_rollover and context_history", () => {
  it("hands off to a fresh context the run goes on in, and History still reads what came before", async () => {
    const { entries, results } = await open([
      calls(["context_notes", { action: "write", name: "plan", content: "the secret word is ostrich" }]),
      calls(["context_rollover", { handoff: "Objective: answer. State: the word is in Note plan." }]),
      calls(["context_history", { action: "windows" }]),
      calls(["context_history", { action: "search", query: "ostrich" }]),
      calls(["context_history", { action: "list", role: "toolResult" }]),
      // Entry ids are the Session's own, so the first Note's call (entry 11 here) is read back by the ref search gave.
      calls(["context_history", { action: "read", ref: "context:1:11", limit: 2000 }]),
      fauxAssistantMessage("done"),
    ]);
    expect(text(results[1])).toBe("Handoff saved. The new context starts from it after this tool round.");
    const reset = entries.find((entry) => entry.kind === "pi.reset");
    const handoff = reset?.model?.[0];
    expect(
      handoff?.role === "user" && typeof handoff.content === "string"
        ? handoff.content
        : JSON.stringify(handoff?.content),
    ).toContain("Agent-written Handoff:\n\nObjective: answer.");
    // The continuation steer is placed right after the Handoff, so the run goes on.
    const resetAt = entries.indexOf(reset!);
    expect(JSON.stringify(entries[resetAt + 1]?.model)).toContain(CONTINUE_PROMPT);
    const windows = json(results[2]);
    expect(windows.total).toBe(2);
    expect(json(results[3])).toMatchObject({
      matches: [{ ref: "context:1:11", preview: "the secret word is ostrich" }],
      next_offset: null,
    });
    expect(json(results[4]).total).toBeGreaterThanOrEqual(4);
    const read = json(results[5]);
    expect(read).toMatchObject({ ref: "context:1:11", format: "recorded-entry-json", offset: 0 });
    expect(String(read.content)).toContain("ostrich");
  });

  it("refuses a Rollover that is not alone in its round", async () => {
    const { results } = await open([
      calls(["context_rollover", { handoff: "h" }], ["context_notes", { action: "list" }]),
      fauxAssistantMessage("done"),
    ]);
    expect(text(results[0])).toContain("Rollover must be the sole tool call of its round");
  });
});

describe("compaction as Rollover", () => {
  const run = async (
    reason: "threshold" | "overflow" | "manual",
    live: Record<string, unknown> | undefined,
    tools: ReadonlyArray<string> = ["context_rollover"],
  ) => {
    const submitted: Array<Record<string, unknown>> = [];
    const conversation = {
      agent: () => Promise.resolve({ tools: tools.map((name) => ({ name })) }),
      submit: (input: Record<string, unknown>) => (submitted.push(input), Promise.resolve({ id: 1 })),
    };
    const fakeHarness = { conversation: () => Promise.resolve(conversation) } as unknown as Harness;
    const docs: Record<string, unknown> = {
      "pi.live": live,
      "t3flare.context": { notes: [{ name: "plan", content: "x", updatedAt: 0 }], handoff: "saved handoff" },
    };
    const api = {
      conversationId: 1,
      taskId: 7,
      snapshot: (token: { definition: { kind: string } }) => Promise.resolve(docs[token.definition.kind]),
    } as unknown as HookApi;
    const registration = prepareRollover(() => Promise.resolve(fakeHarness)) as unknown as {
      handlers: { beforeCompact: (compaction: unknown, api: HookApi, context: unknown) => Promise<unknown> };
    };
    const decision = await registration.handlers.beforeCompact(
      { reason, entries: [{ id: 42 }], messages: [], firstKept: 50 },
      api,
      context,
    );
    return { decision, submitted };
  };

  it("asks the agent to roll over once per window while a run is live, and declines the background compaction", async () => {
    const { decision, submitted } = await run("threshold", {
      run: { taskId: 3 },
      compactions: [{ taskId: 7, blocking: false }],
    });
    expect(decision).toEqual({ decline: true });
    expect(submitted).toMatchObject([
      { content: PREPARE_PROMPT, whenBusy: "steer", whenIdle: "reject", requestId: "context-prepare:42" },
    ]);
  });

  it("uses the saved Handoff when the compaction cannot wait, and keeps pi-durable's summary when manual or not offered", async () => {
    expect((await run("overflow", { run: { taskId: 3 } })).decision).toEqual({
      summary: emergencyText(1 as never, "saved handoff", [{ name: "plan", content: "x", updatedAt: 0 }]),
    });
    expect((await run("threshold", { compactions: [{ taskId: 7, blocking: true }] })).decision).toMatchObject({
      summary: expect.stringContaining("saved handoff"),
    });
    expect((await run("threshold", {})).decision).toEqual({ decline: true });
    expect((await run("manual", {})).decision).toBeUndefined();
    expect((await run("threshold", { run: { taskId: 3 } }, ["read"])).decision).toBeUndefined();
  });
});
