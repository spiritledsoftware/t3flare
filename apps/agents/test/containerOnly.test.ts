// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
// Container-only submodules (the prod bug of 2026-11-11): the patterns a Container starts with, and the backend made
// again when they change.
import * as fs from "node:fs";
import { join } from "node:path";

import { describeFailure, SKILLS_LOCK_SCRIPT } from "@t3flare/workspace-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTAINER_IGNORE } from "../src/workspace/constants.ts";
import {
  containerPatterns,
  ContainerOnlyBackend,
  containerScript,
  type PatternedBackend,
  submoduleDirsScript,
  submodulePaths,
} from "../src/workspace/containerOnly.ts";

describe("the patterns a Container starts with", () => {
  it("names t3flare's own submodule from its .gitmodules", () => {
    const gitmodules = fs.readFileSync(join(import.meta.dirname, "../../../.gitmodules"), "utf8");
    expect(submodulePaths(gitmodules)).toEqual(["t3code"]);
  });

  it("reads every submodule's path, quoted or nested, once", () => {
    const text =
      '[submodule "a"]\n\tpath = vendor/a\n\turl = x\n[submodule "b"]\n  path = "libs/b"\n[submodule "a2"]\n\tpath = vendor/a\n';
    expect(submodulePaths(text)).toEqual(["vendor/a", "libs/b"]);
  });

  it("keeps submodules and their git directories on the Container's disk, before the harness's re-includes", () => {
    const patterns = containerPatterns(CONTAINER_IGNORE, ["t3code", "vendor/a", "we,ird", "../escape", "glob*"]);
    expect(patterns.slice(-6)).toEqual([
      "/repo/.git/modules",
      "/repo/.git/worktrees",
      "/repo/t3code/**",
      "/repo/vendor/a/**",
      "!/.t3flare",
      "!/.t3flare/**",
    ]);
    expect(patterns.filter((pattern) => /we,ird|escape|glob/.test(pattern))).toEqual([]);
  });

  it("makes the submodules' empty directories a fresh Container lacks, and nothing else", () => {
    expect(submoduleDirsScript(containerPatterns(CONTAINER_IGNORE, ["t3code", "vendor/a"]))).toBe(
      "[ -e /workspace/repo/.git ] && mkdir -p -- '/workspace/repo/t3code' '/workspace/repo/vendor/a' 2>/dev/null\n",
    );
    expect(submoduleDirsScript(containerPatterns(CONTAINER_IGNORE, []))).toBe("");
  });

  it("a repo without submodules still keeps `.git/modules` and `.git/worktrees` local", () => {
    expect(containerPatterns(CONTAINER_IGNORE, [])).toEqual([
      ...CONTAINER_IGNORE.slice(0, -2),
      "/repo/.git/modules",
      "/repo/.git/worktrees",
      ...CONTAINER_IGNORE.slice(-2),
    ]);
  });
});

describe("the Container backend made again when the patterns change", () => {
  const timeouts: Array<number> = [];
  let lastTimeout = 60_000;
  const harness = (
    needed: Array<ReadonlyArray<string>>,
    failFirst?: string,
    connected?: (handle: { readonly runtimeId?: string }) => Promise<void>,
  ) => {
    const made: Array<ReadonlyArray<string>> = [];
    let runtimes = 0;
    const connects: Array<ReadonlyArray<string>> = [];
    const madeWith: Array<number> = [];
    let stops = 0;
    let failures = failFirst === undefined ? 0 : 1;
    const backend = new ContainerOnlyBackend({
      initial: ["/a"],
      ...(connected === undefined
        ? {}
        : {
            connected: (handle: { readonly runtimeId?: string | undefined }) =>
              connected(handle.runtimeId === undefined ? {} : { runtimeId: handle.runtimeId }),
          }),
      patterns: () => Promise.resolve(needed.shift() ?? ["/a"]),
      stop: () => {
        stops++;
        return Promise.resolve();
      },
      connectTimeoutMs: () => timeouts.shift() ?? lastTimeout,
      make: (patterns, connectTimeoutMs): PatternedBackend => {
        made.push(patterns);
        madeWith.push(connectTimeoutMs);
        return {
          id: "container-shell",
          type: "cloudflare-container",
          description: "a container",
          handleFetch: () => Promise.resolve(new Response(patterns.join(","))),
          connect: () => {
            if (failures > 0) {
              failures--;
              const error = new Error("Container MOUNT_IGNORE does not match `ignore`");
              error.name = failFirst!;
              return Promise.reject(error);
            }
            connects.push(patterns);
            return Promise.resolve({ rpc: {} as never, runtimeId: `r${++runtimes}`, close: () => Promise.resolve() });
          },
        };
      },
    });
    return { backend, made, madeWith, connects, stops: () => stops };
  };

  it("connects with the patterns each start needs, making a backend only when they change", async () => {
    const h = harness([["/a"], ["/a", "/repo/t3code"], ["/a", "/repo/t3code"]]);
    expect(h.backend.id).toBe("container-shell");
    for (let at = 0; at < 3; at++) await h.backend.connect({} as never);
    expect(h.connects).toEqual([["/a"], ["/a", "/repo/t3code"], ["/a", "/repo/t3code"]]);
    expect(h.made).toEqual([["/a"], ["/a", "/repo/t3code"]]);
    expect(h.backend.patterns).toEqual(["/a", "/repo/t3code"]);
    expect(await (await h.backend.handleFetch(new Request("http://x/"))).text()).toBe("/a,/repo/t3code");
  });

  it("makes the backend again when the connect wait changes (SPI-1364: computer takes it when made)", async () => {
    timeouts.push(60_000, 60_000, 90_000, 90_000);
    lastTimeout = 90_000;
    const h = harness([["/a"], ["/a"], ["/a"]]);
    for (let at = 0; at < 3; at++) await h.backend.connect({} as never);
    expect(h.made).toEqual([["/a"], ["/a"]]);
    expect(h.madeWith).toEqual([60_000, 90_000]);
  });

  it("a running Container started with other patterns is stopped and started again, once", async () => {
    const h = harness([["/a", "/b"]], "ContainerIgnoreMismatchError");
    await h.backend.connect({} as never);
    expect(h.stops()).toBe(1);
    expect(h.connects).toEqual([["/a", "/b"]]);
  });

  it("any other connect failure is the caller's", async () => {
    const h = harness([["/a"]], "WorkspaceTransportError");
    await expect(h.backend.connect({} as never)).rejects.toThrow(/MOUNT_IGNORE/);
    expect(h.stops()).toBe(0);
  });

  it("runs `connected` with the handle's runtime id after every connect, before the handle is given (the Global mise config's lay-down)", async () => {
    const seen: Array<string> = [];
    let release: () => void = () => undefined;
    const h = harness([["/a"], ["/a", "/b"]], "ContainerIgnoreMismatchError", async (handle) => {
      seen.push(`start ${handle.runtimeId}`);
      await new Promise<void>((resolve) => (release = resolve));
      seen.push(`end ${handle.runtimeId}`);
    });
    const first = h.backend.connect({} as never).then(() => seen.push("given"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(["start r1"]);
    release();
    await first;
    expect(seen).toEqual(["start r1", "end r1", "given"]);
    const second = h.backend.connect({} as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await second;
    expect(seen.slice(3)).toEqual(["start r2", "end r2"]);
  });
});

describe("a Container start that runs out its wait names it (SPI-1430)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A backend whose connect fails `afterMs` into the start, with `error`.
  const failing = (error: Error, afterMs: number, connectTimeoutMs = 120_000) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    return new ContainerOnlyBackend({
      initial: ["/a"],
      patterns: () => Promise.resolve(["/a"]),
      stop: () => Promise.resolve(),
      connectTimeoutMs: () => connectTimeoutMs,
      make: (): PatternedBackend => ({
        id: "container-shell",
        type: "cloudflare-container",
        description: "a container",
        handleFetch: () => Promise.resolve(new Response("")),
        connect: () => {
          vi.setSystemTime(Date.now() + afterMs);
          return Promise.reject(error);
        },
      }),
    });
  };

  it("one that failed at its deadline names the wait, its seconds and its place, with computer's error kept", async () => {
    const original = new Error("ContainerBackend(x) [stage=ws]: /api upgrade did not arrive within 90000ms");
    const thrown: unknown = await failing(original, 90_000, 90_000)
      .connect({} as never)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "the Container did not answer within its 90-second time limit; change it under Environment › Advanced › Container start wait (seconds). ContainerBackend(x) [stage=ws]: /api upgrade did not arrive within 90000ms",
    );
    expect((thrown as Error).cause).toBe(original);
  });

  it("one refused before its deadline is computer's error, as it was", async () => {
    const original = new Error("ContainerBackend(x): connect failed at stage=start");
    await expect(failing(original, 2_000).connect({} as never)).rejects.toBe(original);
  });

  it("a budget refusal that took the whole wait still reads as the refusal", async () => {
    const original = new Error('connect failed lastError="t3flare: the Container cannot start: the budget is spent"');
    const thrown: unknown = await failing(original, 120_000)
      .connect({} as never)
      .catch((error: unknown) => error);
    expect(describeFailure(thrown)).toBe("t3flare: the Container cannot start: the budget is spent");
  });
});

describe("the Workspace DO's own Container commands", () => {
  it("start with the Environment skills' lock, before the submodule directories and the command", () => {
    const patterns = containerPatterns([], ["vendor/lib"]);
    const dirs = submoduleDirsScript(patterns);
    expect(dirs).not.toBe("");
    expect(containerScript(patterns, "git status")).toBe(`${SKILLS_LOCK_SCRIPT}${dirs}git status`);
    expect(containerScript([], "git status")).toBe(`${SKILLS_LOCK_SCRIPT}git status`);
  });

  it("are what the Workspace DO runs on the Container backend", () => {
    // No harness drives the DO's `exec` on a Container, so the call site is pinned by its text until one does.
    const source = fs.readFileSync(join(import.meta.dirname, "../src/workspace/WorkspaceDO.ts"), "utf8");
    expect(source).toMatch(
      /backend === CONTAINER_BACKEND \? containerScript\(await this\.#containerPatterns\(\), body\) : body/,
    );
  });
});
