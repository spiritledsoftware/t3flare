// `WorkspaceEnvHost.readEnv`: the environment code inside the Workspace DO reads files through. Paths resolve against
// its `cwd` as `ComputerExecutionEnv`'s do, so the same paths reach the same files.
import type { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { ContainerAccess } from "./container-files.ts";
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
      value: [
        { name: "README.md", isDirectory: false, isSymbolicLink: false },
        { name: "node_modules", isDirectory: true, isSymbolicLink: false, containerOnly: true },
      ],
    });

    const stopped = routedHost({ running: false, stdout: listing });

    expect(
      await stopped.host.handle(request({ op: "readdir", args: ["/workspace/repo"], reachContainer: true })),
    ).toEqual({
      ok: true,
      value: [{ name: "README.md", isDirectory: false, isSymbolicLink: false }],
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
