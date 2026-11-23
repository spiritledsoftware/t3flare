// `ls`, `find` and `grep` (SPI-1321) over a fake Workspace file search: each tool's most results is the `files`
// extension's setting, in its description and as the clamp on the model's `limit`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputerFiles } from "@t3flare/computer-env";
import { describe, expect, it } from "vitest";

import { DEFAULT_FILE_LIMITS, type FileLimits, fileTools } from "../src/extensions/files.ts";

/** A Workspace with `count` of everything, recording the limit each search was asked for. */
const workspace = (count: number) => {
  const asked: Array<number> = [];
  const files = {
    readdir: async () => Array.from({ length: count }, (_, at) => ({ name: `f${at}`, isDirectory: false })),
    find: async (directory: string, _pattern: string, options: { limit: number }) => {
      asked.push(options.limit);
      return Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
        path: `${directory}/f${at}.ts`,
        type: "file",
      }));
    },
    grep: async (_pattern: string, path: string, options: { limit: number }) => {
      asked.push(options.limit);
      return Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
        path: `${path}/a.ts`,
        line: at + 1,
        text: `match ${at}`,
      }));
    },
  };
  // SAFETY: the file tools call only readdir, find and grep, which the fake answers.
  return { files: files as unknown as ComputerFiles, asked };
};

const tools = (count: number, limits: FileLimits) => {
  const { files, asked } = workspace(count);
  const byName = new Map((fileTools(() => files, limits).tools ?? []).map((tool) => [tool.name, tool]));
  return { tool: (name: string) => byName.get(name)!, asked };
};

const run = async (tool: ToolRegistration, args: Record<string, unknown>) => {
  // SAFETY: the file tools read only `api.env.cwd`.
  const result = await tool.execute(args as never, { env: { cwd: "/workspace/repo" } } as never, BACKGROUND_CONTEXT);
  return (result.output ?? []).map((block) => ("text" in block ? block.text : "")).join("");
};

const LIMITS: FileLimits = { lsLimit: 3, findLimit: 4, grepLimit: 5 };

describe("file tools' limits (SPI-1321)", () => {
  it("are the registry's defaults when none are given", () => {
    expect(DEFAULT_FILE_LIMITS).toEqual({ lsLimit: 500, findLimit: 1000, grepLimit: 100 });
    const descriptions = (fileTools(() => undefined).tools ?? []).map((tool) => tool.description);
    expect(descriptions).toEqual([
      expect.stringContaining("Up to 500 entries"),
      expect.stringContaining("Up to 1000 results"),
      expect.stringContaining("Up to 100 matches"),
    ]);
  });

  it("grep returns at most grepLimit matches, says so in its description, and clamps a larger limit", async () => {
    const { tool, asked } = tools(50, LIMITS);
    expect(tool("grep").description).toContain("Up to 5 matches");
    const out = await run(tool("grep"), { pattern: "x", limit: 1000 });
    expect(out.split("\n").filter((line) => line.startsWith("a.ts:"))).toHaveLength(5);
    expect(out).toContain("… more matches");
    expect(asked).toEqual([6]);
    expect((await run(tool("grep"), { pattern: "x", limit: 2 })).split("\n")).toHaveLength(3);
  });

  it("grep asks for as many context lines as the call names (SPI-1361)", async () => {
    const contexts: Array<number> = [];
    const files = {
      grep: async (_pattern: string, _path: string, options: { context: number }) => (
        contexts.push(options.context),
        []
      ),
    } as unknown as ComputerFiles;
    const grep = (fileTools(() => files, LIMITS).tools ?? []).find((tool) => tool.name === "grep")!;
    await run(grep, { pattern: "x", context: 40 });
    await run(grep, { pattern: "x", context: -3 });
    expect(contexts).toEqual([40, 0]);
  });

  it("find and ls take their own limits", async () => {
    const { tool, asked } = tools(50, LIMITS);
    expect(tool("find").description).toContain("Up to 4 results");
    expect(tool("ls").description).toContain("Up to 3 entries");
    expect(
      (await run(tool("find"), { pattern: "*.ts" })).split("\n").filter((line) => line.endsWith(".ts")),
    ).toHaveLength(4);
    expect(asked).toEqual([5]);
    const listed = await run(tool("ls"), { limit: 10 });
    expect(listed.split("\n")).toEqual(["f0", "f1", "f10", "… 47 more"]);
  });
});
