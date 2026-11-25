// `WorkspaceEnvHost.readEnv`: the environment code inside the Workspace DO reads files through. Paths resolve against
// its `cwd` as `ComputerExecutionEnv`'s do, so the same paths reach the same files.
import type { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { type ContainerAccess, GREP_OUTPUT_BYTES, LISTING_BYTES } from "./container-files.ts";
import { ComputerFiles } from "./files.ts";
import { DEFAULT_STALE_TEMP_MS, TEMP_DIR, WorkspaceEnvHost } from "./host.ts";
import type { EnvRequest } from "./wire.ts";

/** A Workspace whose files are `files` (absolute path to text), and the paths it was asked to read. */
const hostOf = (files: Readonly<Record<string, string>>) => {
  const read: string[] = [];

  // SAFETY: `readEnv`'s `readTextFile` uses only `fs.readFile`, which the fake answers.
  const workspace = {
    fs: {
      readFile: async (path: string) => {
        read.push(path);

        const text = files[path];

        if (text === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });

        return new Response(text).body;
      },
    },
  } as unknown as Workspace;

  return { host: new WorkspaceEnvHost(workspace), read };
};

/**
 * A host whose Workspace has `/workspace/repo` with `README.md` in it, and whose Container (running or not) answers each
 * script with `stdout`; the scripts it was sent.
 */
const routedHost = (options: { readonly running: boolean; readonly stdout: string }) => {
  const scripts: string[] = [];

  // SAFETY: the operations these tests call use only `fs.stat`, `fs.lstat` and `fs.readdir`, which the fake answers.
  const workspace = {
    fs: {
      stat: async (path: string) => {
        if (path !== "/workspace/repo/README.md") {
          throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        }

        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: 5,
          mtime: 7,
          inode: 1,
        };
      },
      readdir: async () => [
        {
          name: "README.md",
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: 5,
          mtime: 7,
        },
      ],
    },
  } as unknown as Workspace;

  const container: ContainerAccess = {
    patterns: async () => ["**/node_modules"],
    running: () => options.running,
    run: async (script) => {
      scripts.push(script);

      return { exitCode: 0, stdout: options.stdout, stderr: "" };
    },
  };

  return { host: new WorkspaceEnvHost(workspace, container), scripts };
};

const request = (value: EnvRequest): EnvRequest => value;

describe("WorkspaceEnvHost on Container-only paths", () => {
  it("answers from the Workspace's files alone unless the request asks to reach the Container", async () => {
    const { host, scripts } = routedHost({ running: true, stdout: "" });

    const answer = await host.handle(request({ op: "info", args: ["/workspace/repo/node_modules/a.js", true] }));

    expect(answer).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(scripts).toEqual([]);
  });

  it("runs an operation on a Container-only path on the Container when asked to", async () => {
    const { host, scripts } = routedHost({ running: false, stdout: "regular file\t12\t1.5\n" });

    const answer = await host.handle(request({ op: "info", args: ["/root/.npmrc", true], reachContainer: true }));

    expect(answer).toEqual({
      ok: true,
      value: { name: ".npmrc", path: "/root/.npmrc", kind: "file", size: 12, mtimeMs: 1500 },
    });
    expect(scripts).toHaveLength(1);
  });

  it("leaves a synced path to the Workspace even when asked to reach the Container", async () => {
    const { host, scripts } = routedHost({ running: true, stdout: "" });

    const answer = await host.handle(
      request({ op: "info", args: ["/workspace/repo/README.md", true], reachContainer: true }),
    );

    expect(answer).toMatchObject({ ok: true, value: { kind: "file", size: 5 } });
    expect(scripts).toEqual([]);
  });

  it("adds a synced directory's Container-only entries, marked, only while the Container runs", async () => {
    const listing = "d\tnode_modules\nf\tREADME.md\n";
    const running = routedHost({ running: true, stdout: listing });

    expect(
      await running.host.handle(request({ op: "readdir", args: ["/workspace/repo"], reachContainer: true })),
    ).toEqual({
      ok: true,
      value: {
        items: [
          { name: "README.md", isDirectory: false, isSymbolicLink: false },
          { name: "node_modules", isDirectory: true, isSymbolicLink: false, containerOnly: true },
        ],
      },
    });

    const stopped = routedHost({ running: false, stdout: listing });

    expect(
      await stopped.host.handle(request({ op: "readdir", args: ["/workspace/repo"], reachContainer: true })),
    ).toEqual({
      ok: true,
      value: { items: [{ name: "README.md", isDirectory: false, isSymbolicLink: false }] },
    });
    expect(stopped.scripts).toEqual([]);
  });

  it("refuses an operation the file tools do not run on the Container, pointing at bash", async () => {
    const { host, scripts } = routedHost({ running: true, stdout: "" });

    expect(
      await host.handle(
        request({
          op: "remove",
          args: ["/workspace/repo/node_modules", true, true],
          reachContainer: true,
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "not_supported",
        message:
          "/workspace/repo/node_modules is only on the Container, where the file tools cannot remove it: use bash",
        path: "/workspace/repo/node_modules",
      },
    });
    expect(scripts).toEqual([]);
  });

  it("says which paths are Container-only, for bash's routing", async () => {
    const { host } = routedHost({ running: false, stdout: "" });

    expect(
      await host.handle(
        request({
          op: "containerOnly",
          args: [["/tmp/x", "/workspace/repo/node_modules", "/workspace/repo/src"]],
        }),
      ),
    ).toEqual({ ok: true, value: [true, true, false] });
  });
});

describe("WorkspaceEnvHost's searches on the Workspace (SPI-1388)", () => {
  /** A Workspace with `count` of everything, each line `width` characters, recording the limit each search asked. */
  const searching = (count: number, width: number) => {
    const asked: number[] = [];
    // SAFETY: `readdir`, `find` and `grep` use only the same-named `fs` methods, which the fake answers.
    const workspace = {
      fs: {
        readdir: async (_path: string, options: { limit: number }) => {
          asked.push(options.limit);
          return Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
            name: `${at}`.padEnd(width, "x"),
            isDirectory: false,
          }));
        },
        find: async (_directory: string, _pattern: string, options: { limit: number }) => {
          asked.push(options.limit);
          return Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
            path: `/${at}`.padEnd(width, "x"),
            type: "file",
          }));
        },
        grep: async (_pattern: string, _path: string, options: { limit: number }) => {
          asked.push(options.limit);
          return Array.from({ length: Math.min(count, options.limit) }, (_, at) => ({
            path: "/a",
            line: at,
            text: "x".repeat(width),
          }));
        },
      },
    } as unknown as Workspace;
    return { host: new WorkspaceEnvHost(workspace), asked };
  };
  const answerBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const grep = (limit: number) =>
    request({
      op: "grep",
      args: [
        "x",
        "/workspace/repo",
        { ignoreCase: false, regex: true, context: 0, limit, include: undefined, exclude: [] },
      ],
    });

  it("answers what fits in full, with no cut", async () => {
    const { host } = searching(10, 10);
    const answer = await host.handle(grep(100));
    expect(answer.ok && answer.value).toEqual({ items: expect.any(Array) });
    expect(answer.ok && (answer.value as { items: unknown[] }).items).toHaveLength(10);
  });

  it("cuts a grep at GREP_OUTPUT_BYTES, naming the limit, however many a call asks for", async () => {
    const { host, asked } = searching(10_000, 1_000);
    const answer = await host.handle(grep(10_000_000));
    if (!answer.ok) throw new Error("refused");
    const value = answer.value as { items: unknown[]; cut?: string };
    expect(answerBytes(value.items)).toBeLessThanOrEqual(GREP_OUTPUT_BYTES);
    expect(value.cut).toMatch(/^\d+ more found past the Workspace's fixed 4 MiB answer limit$/);
    // The Workspace asks for no more matches than the bound could carry at their smallest.
    expect(asked[0]).toBeLessThan(GREP_OUTPUT_BYTES / 30);
    expect(asked[0]).toBeGreaterThan(GREP_OUTPUT_BYTES / 40);
  });

  it("says a search stopped at as many as the bound carries, even when what came fits", async () => {
    const { host, asked } = searching(10_000_000, 1);
    const answer = await host.handle(
      request({ op: "find", args: ["/workspace/repo", "*", { limit: 10_000_000, exclude: [] }] }),
    );
    if (!answer.ok) throw new Error("refused");
    const value = answer.value as { items: unknown[]; cut?: string };
    expect(value.items.length).toBeLessThanOrEqual(asked[0]!);
    expect(answerBytes(value.items)).toBeLessThanOrEqual(LISTING_BYTES);
    expect(value.cut).toMatch(/the Workspace's fixed 1 MiB answer limit/);
  });

  it("asks for no more entries than LISTING_BYTES carries, and names the stop", async () => {
    const { host, asked } = searching(10_000_000, 1);
    const answer = await host.handle(request({ op: "readdir", args: ["/workspace/repo"] }));
    if (!answer.ok) throw new Error("refused");
    const value = answer.value as { items: unknown[]; cut?: string };
    expect(asked[0]).toBeLessThan(LISTING_BYTES / 40);
    expect(asked[0]).toBeGreaterThan(LISTING_BYTES / 60);
    expect(answerBytes(value.items)).toBeLessThanOrEqual(LISTING_BYTES);
    expect(value.cut).toMatch(/the Workspace's fixed 1 MiB answer limit/);
  });

  it("cuts a directory listing at LISTING_BYTES", async () => {
    const { host } = searching(5_000, 1_000);
    const answer = await host.handle(request({ op: "readdir", args: ["/workspace/repo"] }));
    if (!answer.ok) throw new Error("refused");
    const value = answer.value as { items: unknown[]; cut?: string };
    expect(answerBytes(value.items)).toBeLessThanOrEqual(LISTING_BYTES);
    expect(value.cut).toMatch(/more found past the Workspace's fixed 1 MiB answer limit$/);
  });
});

describe("grep answers by bytes per line (SPI-1394)", () => {
  const MiB = 1024 * 1024;
  const answerBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const grep = (path: string, context: number) =>
    request({
      op: "grep",
      args: ["x", path, { ignoreCase: false, regex: true, context, limit: 100, include: undefined, exclude: [] }],
      reachContainer: true,
    });
  type Answer = { items: Array<{ text: string; context?: Array<{ text: string }> }>; cut?: string };
  const valueOf = (answer: Awaited<ReturnType<WorkspaceEnvHost["handle"]>>): Answer => {
    if (!answer.ok) throw new Error("refused");
    return answer.value as unknown as Answer;
  };

  /** A Workspace whose grep finds `matches`, each with its context. */
  const workspaceFinding = (matches: ReadonlyArray<{ text: string; context?: string[] }>) =>
    new WorkspaceEnvHost({
      fs: {
        grep: async () =>
          matches.map((match, at) => ({
            path: "/workspace/repo/min.js",
            line: at + 1,
            text: match.text,
            context: match.context?.map((text, line) => ({ line, text, isMatch: text === match.text })),
          })),
      },
    } as unknown as Workspace);

  it("cuts a matching line longer than the 4 MiB answer, marked, and names the cut", async () => {
    const line = "x".repeat(5 * MiB);
    const value = valueOf(await workspaceFinding([{ text: line }, { text: line }]).handle(grep("/workspace/repo", 0)));
    expect(answerBytes(value.items)).toBeLessThanOrEqual(GREP_OUTPUT_BYTES);
    expect(value.items).toHaveLength(1);
    expect(value.items[0]?.text.length).toBeGreaterThan(3 * MiB);
    expect(value.items[0]?.text).toMatch(/x … \[line cut short at the Workspace's fixed 4 MiB answer limit\]$/);
    expect(value.cut).toBe(
      "a match too long for the Workspace's fixed 4 MiB answer limit was cut short; 1 more found past the Workspace's fixed 4 MiB answer limit",
    );
  });

  it("counts each match's context toward the answer, keeping short lines whole and cutting the long ones", async () => {
    const long = "y".repeat(2 * MiB);
    const value = valueOf(
      await workspaceFinding([{ text: "x short", context: ["before", long, "x short", long, "after"] }]).handle(
        grep("/workspace/repo", 2),
      ),
    );
    expect(answerBytes(value.items)).toBeLessThanOrEqual(GREP_OUTPUT_BYTES);
    const context = value.items[0]?.context?.map((line) => line.text) ?? [];
    expect(value.items[0]?.text).toBe("x short");
    expect([context[0], context[2], context[4]]).toEqual(["before", "x short", "after"]);
    expect(context[1]).toMatch(/^y+ … \[line cut short/);
    expect(context[3]).toMatch(/^y+ … \[line cut short/);
    expect(value.cut).toBe("a match too long for the Workspace's fixed 4 MiB answer limit was cut short");
  });

  it("drops a match that would fit an answer of its own once the answer is full, as before", async () => {
    const line = "x".repeat(MiB);
    const value = valueOf(
      await workspaceFinding(Array.from({ length: 5 }, () => ({ text: line }))).handle(grep("/workspace/repo", 0)),
    );
    expect(value.items).toHaveLength(3);
    expect(value.items.every((match) => match.text === line)).toBe(true);
    expect(value.cut).toBe("2 more found past the Workspace's fixed 4 MiB answer limit");
  });

  /** ripgrep's JSON events for `lines` matching in `/root/min.js`, as the Container's grep script prints them. */
  const events = (lines: readonly string[]) =>
    lines
      .map((text, at) =>
        JSON.stringify({
          type: "match",
          data: { path: { text: "./min.js" }, lines: { text: `${text}\n` }, line_number: at + 1 },
        }),
      )
      .join("\n");

  it("names the Container's read cut at GREP_OUTPUT_BYTES, which it once made silently", async () => {
    const read = `${events(Array.from({ length: 50 }, () => "x".repeat(100 * 1024)))}\n`;
    expect(read.length).toBeGreaterThan(GREP_OUTPUT_BYTES + 1);
    const { host } = routedHost({ running: true, stdout: `/root\n${read.slice(0, GREP_OUTPUT_BYTES + 1)}.\n` });
    const value = valueOf(await host.handle(grep("/root", 0)));
    expect(value.items.length).toBeGreaterThan(30);
    expect(value.items.length).toBeLessThan(50);
    expect(value.cut).toBe(
      "the search read only the first 4 MiB of ripgrep's output, the Container's fixed grep read limit",
    );
  });

  it("leaves the Container's whole read uncut, and bounds its answer as the Workspace's", async () => {
    const whole = routedHost({ running: true, stdout: `/root\n${events(["x a", "x b"])}\n.\n` });
    expect(valueOf(await whole.host.handle(grep("/root", 0)))).toEqual({
      items: [
        { path: "/root/min.js", line: 1, text: "x a" },
        { path: "/root/min.js", line: 2, text: "x b" },
      ],
    });

    // Each match carries its context, so the answer can outgrow the events: 3 MiB of lines, each in 3 matches' context.
    const lines = Array.from({ length: 3 }, () => "x".repeat(MiB));
    const wide = routedHost({ running: true, stdout: `/root\n${events(lines)}\n.\n` });
    const value = valueOf(await wide.host.handle(grep("/root", 2)));
    expect(answerBytes(value.items)).toBeLessThanOrEqual(GREP_OUTPUT_BYTES);
    expect(value.cut).toMatch(/the Workspace's fixed 4 MiB answer limit/);
  });
});

describe("ComputerFiles across a deploy (SPI-1388)", () => {
  it("takes a Workspace DO's bare array from before the bound as the whole answer, and a Listed one as it is", async () => {
    const answering = (value: unknown) => new ComputerFiles({ fileOperation: async () => ({ ok: true, value }) });
    const entry = { name: "a", isDirectory: false, isSymbolicLink: false };
    expect(await answering([entry]).readdir("/workspace/repo")).toEqual({ items: [entry] });
    expect(await answering({ items: [entry], cut: "why" }).readdir("/workspace/repo")).toEqual({
      items: [entry],
      cut: "why",
    });
    const found = { path: "/a", type: "file" };
    expect(await answering([found]).find("/", "*", { limit: 1, exclude: [] })).toEqual({ items: [found] });
    const match = { path: "/a", line: 1, text: "x" };
    expect(
      await answering([match]).grep("x", "/", {
        ignoreCase: false,
        regex: true,
        context: 0,
        limit: 1,
        include: undefined,
        exclude: [],
      }),
    ).toEqual({ items: [match] });
  });
});

describe("WorkspaceEnvHost.readEnv", () => {
  it("resolves a relative path against its cwd, and normalizes an absolute one", async () => {
    const { host, read } = hostOf({
      "/workspace/repo/a/SKILL.md": "relative",
      "/workspace/b/SKILL.md": "absolute",
    });

    const env = host.readEnv("/workspace/repo");

    expect(getOrThrow(await env.readTextFile("a/./SKILL.md", BACKGROUND_CONTEXT))).toBe("relative");
    expect(getOrThrow(await env.readTextFile("/workspace//x/../b/SKILL.md", BACKGROUND_CONTEXT))).toBe("absolute");
    expect(read).toEqual(["/workspace/repo/a/SKILL.md", "/workspace/b/SKILL.md"]);
  });
});

describe("WorkspaceEnvHost.prepare", () => {
  const NOW = 10 * DEFAULT_STALE_TEMP_MS;

  /** A Workspace whose temp directory holds entries modified `ages` ago (by name); the temp paths it removed. */
  const tempHost = (ages: Readonly<Record<string, number>>, options?: { readonly staleTempMs?: () => number }) => {
    const removed: string[] = [];

    // SAFETY: `prepare` uses only `fs.stat`, `fs.mkdir`, `fs.readdir`, `fs.lstat` and `fs.rm`, which the fake answers.
    const workspace = {
      fs: {
        stat: async () => ({ isDirectory: true }),
        mkdir: async () => undefined,
        readdir: async (path: string) =>
          path === TEMP_DIR ? Object.keys(ages).map((name) => ({ name })) : ([] as Array<{ name: string }>),
        lstat: async (path: string) => ({ mtime: NOW - (ages[path.slice(TEMP_DIR.length + 1)] ?? 0) }),
        rm: async (path: string) => {
          if (path.startsWith(`${TEMP_DIR}/`)) removed.push(path.slice(TEMP_DIR.length + 1));
        },
      },
    } as unknown as Workspace;

    return { host: new WorkspaceEnvHost(workspace, undefined, options), removed };
  };

  it("removes temp entries older than the stale age it was given", async () => {
    const { host, removed } = tempHost({ old: 2000, fresh: 500 }, { staleTempMs: () => 1000 });

    await host.prepare("/workspace", NOW);

    expect(removed).toEqual(["old"]);
  });

  it("keeps temp entries for a day unless told otherwise", async () => {
    expect(DEFAULT_STALE_TEMP_MS).toBe(24 * 60 * 60 * 1000);

    const { host, removed } = tempHost({ old: DEFAULT_STALE_TEMP_MS + 1, fresh: DEFAULT_STALE_TEMP_MS - 1 });

    await host.prepare("/workspace", NOW);

    expect(removed).toEqual(["old"]);
  });
});
