// The Tool output limit (SPI-1362): every tool the model calls is cut to the `tool-output` setting, a tool's own limits
// kept, and bash's and read's descriptions name it.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";

import { codingTools } from "../src/extensions/coding-tools.ts";
import {
  DEFAULT_TOOL_OUTPUT_LIMITS,
  jobTailOf,
  toolOutputExtension,
  withOutputLimits,
} from "../src/extensions/toolOutput.ts";

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
