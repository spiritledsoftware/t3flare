// `ls`, `find` and `grep` (SPI-1321, SPI-1388) over a fake Workspace file search: each tool's results when a call names
// no limit are pi's own defaults, in its description; a call may name a larger limit, as in pi, and a result stopped at
// its limit names it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputerFiles } from "@t3flare/computer-env";
import { describe, expect, it } from "vitest";

import { fileTools, GREP_CONTEXT_FLOOR, grepContext } from "../src/extensions/files.ts";
import { DEFAULT_TOOL_OUTPUT_LIMITS } from "../src/extensions/toolOutput.ts";

/** A Workspace with `count` of everything, recording the limit each search was asked for. */
const workspace = (count: number) => {
  const asked: Array<number> = [];
  const files = {
    readdir: async () => ({
      items: Array.from({ length: count }, (_, at) => ({ name: `f${at}`, isDirectory: false })),
    }),
    find: async (directory: string, _pattern: string, options: { limit: number }) => {
      asked.push(options.limit);
      return {
        items: Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
          path: `${directory}/f${at}.ts`,
          type: "file",
        })),
      };
    },
    grep: async (_pattern: string, path: string, options: { limit: number }) => {
      asked.push(options.limit);
      return {
        items: Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
          path: `${path}/a.ts`,
          line: at + 1,
          text: `match ${at}`,
        })),
      };
    },
  };
  // SAFETY: the file tools call only readdir, find and grep, which the fake answers.
  return { files: files as unknown as ComputerFiles, asked };
};

const tools = (count: number) => {
  const { files, asked } = workspace(count);
  const byName = new Map((fileTools(() => files).tools ?? []).map((tool) => [tool.name, tool]));
  return { tool: (name: string) => byName.get(name)!, asked };
};

const run = async (tool: ToolRegistration, args: Record<string, unknown>) => {
  // SAFETY: the file tools read only `api.env.cwd`.
  const result = await tool.execute(args as never, { env: { cwd: "/workspace/repo" } } as never, BACKGROUND_CONTEXT);
  return (result.output ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

describe("file tools' limits (SPI-1321, SPI-1388)", () => {
  it("default to pi's own 500 entries, 1,000 results and 100 matches, in their descriptions", () => {
    const descriptions = (fileTools(() => undefined).tools ?? []).map((tool) => tool.description);
    expect(descriptions).toEqual([
      expect.stringContaining("Up to 500 entries unless limit says how many"),
      expect.stringContaining("Up to 1,000 results unless limit says how many"),
      expect.stringContaining("Up to 100 matches unless limit says how many"),
    ]);
  });

  it("grep returns the default 100 matches and names the limit when it stops there", async () => {
    const { tool, asked } = tools(150);
    const out = await run(tool("grep"), { pattern: "x" });
    expect(out.split("\n").filter((line) => line.startsWith("a.ts:"))).toHaveLength(100);
    expect(
      out.endsWith("[100 matches limit reached (the default). Use limit=200 for more, or narrow the search]"),
    ).toBe(true);
    expect(asked).toEqual([101]);
  });

  it("grep takes a call's larger limit, as pi does, and a smaller one", async () => {
    const { tool, asked } = tools(150);
    const out = await run(tool("grep"), { pattern: "x", limit: 1000 });
    expect(out.split("\n").filter((line) => line.startsWith("a.ts:"))).toHaveLength(150);
    expect(out).not.toContain("limit reached");
    expect(asked).toEqual([1001]);
    const two = await run(tool("grep"), { pattern: "x", limit: 2 });
    expect(two.split("\n").filter((line) => line.startsWith("a.ts:"))).toHaveLength(2);
    expect(two).toContain("[2 matches limit reached. Use limit=4 for more, or narrow the search]");
  });

  it("grep asks for as much context as every match's share of the result's lines (SPI-1361)", async () => {
    const contexts: Array<number> = [];
    const files = {
      grep: async (_pattern: string, _path: string, options: { context: number }) => (
        contexts.push(options.context),
        { items: [] }
      ),
    } as unknown as ComputerFiles;
    const grep = (fileTools(() => files).tools ?? []).find((tool) => tool.name === "grep")!;
    await run(grep, { pattern: "x", context: 40, limit: 5 });
    await run(grep, { pattern: "x", context: -3, limit: 5 });
    await run(grep, { pattern: "x", context: 1_000_000_000, limit: 5 });
    await run(grep, { pattern: "x", context: 2.5, limit: 5 });
    // A limit of 5 asks for 6 matches; each takes 2 × context + 1 of the result's lines and a `--`.
    const share = Math.floor((DEFAULT_TOOL_OUTPUT_LIMITS.maxLines / 6 - 2) / 2);
    expect(contexts).toEqual([40, 0, share, 2]);
    expect(grepContext(1_000_000_000, 1)).toBe(Math.floor((DEFAULT_TOOL_OUTPUT_LIMITS.maxLines - 2) / 2));
    // Never below what the former clamp allowed: 10 lines, whatever the limit.
    expect(grepContext(10, 101)).toBe(10);
    expect(grepContext(5, 100_001)).toBe(5);
    expect(grepContext(50, 100_001)).toBe(GREP_CONTEXT_FLOOR);
    expect(grepContext(-3, 101)).toBe(0);
  });

  it("grep's result stays within its output lines at the default limit and a huge context (SPI-1361)", async () => {
    const line = "x".repeat(60);
    let answered = 0;
    const files = {
      // A Workspace that gives every match all the context asked for.
      grep: async (_pattern: string, path: string, options: { context: number; limit: number }) => {
        const matches = Array.from({ length: options.limit }, (_, at) => {
          const middle = at * 10_000 + options.context + 1;
          return {
            path: `${path}/a.ts`,
            line: middle,
            text: line,
            context: Array.from({ length: 2 * options.context + 1 }, (_, offset) => ({
              line: middle - options.context + offset,
              text: line,
              isMatch: offset === options.context,
            })),
          };
        });
        answered = new TextEncoder().encode(JSON.stringify(matches)).length;
        return { items: matches };
      },
    } as unknown as ComputerFiles;
    const grep = (fileTools(() => files).tools ?? []).find((tool) => tool.name === "grep")!;
    // A high limit with a small context keeps the context, within the result's lines.
    const kept = await run(grep, { pattern: "x", context: 5, limit: 5_000 });
    expect(kept).toContain("a.ts-1- "); // the first match keeps its context from line 1
    expect(kept.split("\n").length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMITS.maxLines + 1);
    const out = await run(grep, { pattern: "x", context: 1_000_000_000 });
    expect(out.split("\n").length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMITS.maxLines + 1);
    expect(new TextEncoder().encode(out).length).toBeLessThan(1024 * 1024);
    // What the Workspace answers over RPC: every match's context, which the share keeps to the result's lines.
    expect(answered).toBeLessThan(1024 * 1024);
  });

  it("find and ls take a call's limit and name it when they stop there", async () => {
    const { tool, asked } = tools(1_500);
    const found = await run(tool("find"), { pattern: "*.ts" });
    expect(found.split("\n").filter((line) => line.endsWith(".ts"))).toHaveLength(1_000);
    expect(found).toContain(
      "[1,000 results limit reached (the default). Use limit=2,000 for more, or narrow the pattern]",
    );
    expect(asked).toEqual([1_001]);
    expect(
      (await run(tool("find"), { pattern: "*.ts", limit: 4 })).split("\n").filter((line) => line.endsWith(".ts")),
    ).toHaveLength(4);
    const listed = await run(tool("ls"), { limit: 3 });
    expect(listed.split("\n")).toEqual([
      "f0",
      "f1",
      "f10",
      "… 1497 more",
      "",
      "[3 entries limit reached. Use limit=6 for more]",
    ]);
    expect((await run(tool("ls"), {})).split("\n").at(-1)).toBe(
      "[500 entries limit reached (the default). Use limit=1,000 for more]",
    );
    expect((await run(tool("ls"), { limit: 5_000 })).split("\n")).toHaveLength(1_500);
  });
});

describe("file tools' output (SPI-1362)", () => {
  it("take the Tool output limit as their outputLimits, and grep builds its result within its lines", async () => {
    const output = { maxBytes: 8 * 1024, maxLines: 60 };
    const { files } = workspace(1_000);
    const built = fileTools(() => files, output).tools ?? [];
    expect(built.map((tool) => tool.outputLimits)).toEqual([output, output, output]);
    const grep = built.find((tool) => tool.name === "grep")!;
    const out = await run(grep, { pattern: "x", limit: 1_000 });
    expect(out.split("\n").length).toBeLessThanOrEqual(output.maxLines);
    expect(out.endsWith("… more matches; narrow the search")).toBe(true);
    expect(grepContext(1_000, 1, output.maxLines)).toBe(Math.floor((output.maxLines - 2) / 2));
  });
});

describe("file tools' calls and the Workspace's answer bound (SPI-1388)", () => {
  it("take a limit only as a whole number from 1 up to a safe integer", () => {
    for (const tool of fileTools(() => undefined).tools ?? [])
      expect((tool.parameters as { properties: Record<string, unknown> }).properties.limit).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      });
  });

  it("say when the Workspace cut its answer at its byte bound, naming it", async () => {
    const cut = "123 more found past the Workspace's fixed 4 MiB answer limit";
    const files = {
      readdir: async () => ({ items: [{ name: "a", isDirectory: false }], cut }),
      find: async () => ({ items: [{ path: "/workspace/repo/a.ts", type: "file" }], cut }),
      grep: async () => ({ items: [{ path: "/workspace/repo/a.ts", line: 1, text: "x" }], cut }),
    } as unknown as ComputerFiles;
    const byName = new Map((fileTools(() => files).tools ?? []).map((tool) => [tool.name, tool]));
    expect(await run(byName.get("ls")!, {})).toBe(`a\n\n[Stopped short: ${cut}; list a narrower directory]`);
    expect(await run(byName.get("find")!, { pattern: "*" })).toBe(
      `a.ts\n\n[Stopped short: ${cut}; narrow the pattern]`,
    );
    expect(await run(byName.get("grep")!, { pattern: "x", limit: 10_000_000 })).toBe(
      `a.ts:1: x\n\n[Stopped short: ${cut}; narrow the search]`,
    );
  });
});
