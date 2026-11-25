// The Tool output limit (SPI-1362): every tool the model calls is cut to the `tool-output` setting, a tool's own limits
// kept, and bash's and read's descriptions name it.
import {
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
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";

import { codingTools } from "../src/extensions/coding-tools.ts";
import {
  DEFAULT_TOOL_OUTPUT_LIMITS,
  jobTailOf,
  outputCutNote,
  toolOutputExtension,
  withOutputLimits,
} from "../src/extensions/toolOutput.ts";
import { context, until } from "./harness.fixture.ts";

const tool = (name: string, extra: Partial<ToolRegistration> = {}): ToolRegistration =>
  ({
    ...(defineTool({
      name,
      description: name,
      parameters: obj({}),
      execute: async () => ({ output: [] }),
    }) as unknown as ToolRegistration),
    ...extra,
  }) as ToolRegistration;

const limits = { maxBytes: 100 * 1024, maxLines: 3_000 };

describe("the Tool output limit (SPI-1362)", () => {
  it("is the registry's default, 50 KiB or 2,000 lines, with nothing stored", () => {
    expect(DEFAULT_TOOL_OUTPUT_LIMITS).toEqual({ maxBytes: 50 * 1024, maxLines: 2_000 });
    expect(jobTailOf(DEFAULT_TOOL_OUTPUT_LIMITS)).toEqual({ lines: 1_980, bytes: 49 * 1024 });
  });

  it("wraps every named tool with the limit, keeping what its own registration names", () => {
    const wraps = toolOutputExtension(["mcp__x__y", "bash", "todo", "mcp__x__y"], limits).wraps ?? [];
    expect(wraps.map((wrap) => ("tool" in wrap ? wrap.tool : ""))).toEqual(["mcp__x__y", "bash", "todo"]);
    expect(withOutputLimits(tool("mcp__x__y"), limits).outputLimits).toEqual(limits);
    expect(withOutputLimits(tool("bash", { outputLimits: { retain: "tail" } }), limits).outputLimits).toEqual({
      ...limits,
      retain: "tail",
    });
    const own = { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 };
    expect(withOutputLimits(tool("codemode", { outputLimits: own }), limits).outputLimits).toEqual(own);
  });

  it("names the limit in bash's description, and the lower of it and pi-durable's own in read's", () => {
    const tools = codingTools({ output: limits }).tools ?? [];
    const description = (name: string) => tools.find((each) => each.name === name)!.description;
    expect(description("bash")).toContain("last 3000 lines or 100KB");
    expect(description("read")).toContain("truncated to 2000 lines or 50KB");
    const lower = codingTools({ output: { maxBytes: 8 * 1024, maxLines: 500 } }).tools ?? [];
    expect(lower.find((each) => each.name === "read")!.description).toContain("truncated to 500 lines or 8KB");
  });
});

describe("a result cut at the Tool output limit names it (SPI-1388)", () => {
  const NOTE =
    "The output was cut at the Tool output limit: 2,000 lines, t3flare's fixed line limit, or 50 KiB, the Owner's setting under Extensions › Tool output › Output shown to the model (KiB).";
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
  const executeOf = (registration: ToolRegistration, api: Partial<ToolExecutionApi> = {}) =>
    registration.execute({} as never, api as ToolExecutionApi, context);

  it("says the lines are fixed and where the KiB is changed", () => {
    expect(outputCutNote(DEFAULT_TOOL_OUTPUT_LIMITS, DEFAULT_TOOL_OUTPUT_LIMITS)).toBe(NOTE);
    expect(outputCutNote({ maxBytes: 4 * 1024 * 1024, maxLines: 100_000 }, DEFAULT_TOOL_OUTPUT_LIMITS)).toBe(
      "The output was cut at this tool's own limit: 100,000 lines or 4096 KiB.",
    );
  });

  it("adds the note to a result past either limit, and none to one within both", async () => {
    const returning = (text: string) =>
      withOutputLimits(
        tool("x", { execute: async () => ({ output: [{ type: "text", text }] }) }),
        DEFAULT_TOOL_OUTPUT_LIMITS,
      );
    expect((await executeOf(returning(lines(2_001)))).diagnostics).toEqual([
      { severity: "warn", code: "output_limit", message: NOTE },
    ]);
    expect((await executeOf(returning("x".repeat(50 * 1024 + 1)))).diagnostics).toHaveLength(1);
    expect((await executeOf(returning(lines(2_000)))).diagnostics).toBeUndefined();
    // Output that streamed: what the call's retained output says.
    const streamed = withOutputLimits(tool("y", { execute: async () => ({}) }), DEFAULT_TOOL_OUTPUT_LIMITS);
    expect(
      (await executeOf(streamed, { retainedOutput: () => ({ text: "", truncated: true }) })).diagnostics,
    ).toHaveLength(1);
    expect(
      (await executeOf(streamed, { retainedOutput: () => ({ text: "", truncated: false }) })).diagnostics,
    ).toBeUndefined();
  });

  it("reaches the model after pi-durable's own cut, in a real turn", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("many", {} as never, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("streams", {} as never, { id: "c2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "big",
        tools: [
          defineTool({
            name: "many",
            description: "many lines",
            parameters: obj({}),
            execute: async () => ({ output: [{ type: "text" as const, text: lines(5_000) }] }),
          }),
          defineTool({
            name: "streams",
            description: "streams many lines",
            parameters: obj({}),
            outputLimits: { retain: "tail" },
            execute: async (_args, api) => {
              api.output(lines(5_000));
              return {};
            },
          }),
        ],
      }),
    );
    registry.install(toolOutputExtension(["many", "streams"], DEFAULT_TOOL_OUTPUT_LIMITS));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await root.submit({ type: "input", content: "go" }, context);
    harness.resume();
    const results = async () =>
      (await root.entries({ order: "ascending" }, 200, undefined, context)).items.flatMap((entry) =>
        entry.model?.[0]?.role === "toolResult" ? [entry.model[0] as ToolResultMessage] : [],
      );
    await until(async () => (await results()).length === 2, "both results");
    for (const result of await results()) {
      const text = result.content.map((block) => ("text" in block ? block.text : "")).join("");
      expect(text).toContain("Output truncated");
      expect(text).toContain(`[warn] ${NOTE}`);
    }
  });
});
