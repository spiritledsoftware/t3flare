import { describe, expect, it } from "vitest";

import {
  fromWorkspace,
  fromWorkspaceText,
  isAnyWorkspaceId,
  isUnderW,
  isWorkspaceId,
  isWorktreeId,
  jsonTextBytes,
  jsonTextPrefix,
  toWorkspace,
  worktreeDirOf,
} from "./index.ts";

describe("path translation", () => {
  it("maps /w/<id>/… to the repo inside the Workspace and back", () => {
    expect(toWorkspace("/w/fixture/src/a.ts")).toEqual({ id: "fixture", inner: "/workspace/repo/src/a.ts" });
    expect(toWorkspace("/w/fixture")).toEqual({ id: "fixture", inner: "/workspace/repo" });
    expect(toWorkspace("/w/fixture/")).toEqual({ id: "fixture", inner: "/workspace/repo" });
    expect(toWorkspace("/w")).toBeNull();
    expect(toWorkspace("/w/../etc")).toBeNull();
    expect(toWorkspace("/w/fixture/../../etc/passwd")).toBeNull();
    expect(toWorkspace("/t3/home")).toBeNull();
    expect(fromWorkspace("fixture", "/workspace/repo/src/a.ts")).toBe("/w/fixture/src/a.ts");
    expect(fromWorkspace("fixture", "/workspace/repo")).toBe("/w/fixture");
    expect(fromWorkspace("fixture", "/workspace/.t3flare/x")).toBe("/workspace/.t3flare/x");
  });
  it("rewrites git's printed paths", () => {
    expect(fromWorkspaceText("f", "/workspace/repo\n/workspace/repo/.git\n")).toBe("/w/f\n/w/f/.git\n");
    expect(fromWorkspaceText("f", "/workspace/repository")).toBe("/workspace/repository");
  });
  it("knows /w paths", () => {
    expect(isUnderW("/w")).toBe(true);
    expect(isUnderW("/w/x/y")).toBe(true);
    expect(isUnderW("/wx")).toBe(false);
  });
});

describe("worktree Workspaces (step 2b)", () => {
  it("are addressed by their path below /w, `.wt/<project dir>/<dir>`", () => {
    expect(toWorkspace("/w/.wt/fixture/feature-x-0123456789abcdef/src/a.ts")).toEqual({
      id: ".wt/fixture/feature-x-0123456789abcdef",
      inner: "/workspace/repo/src/a.ts",
    });
    expect(toWorkspace("/w/.wt/fixture/dir")).toEqual({ id: ".wt/fixture/dir", inner: "/workspace/repo" });
    expect(fromWorkspace(".wt/fixture/dir", "/workspace/repo/a")).toBe("/w/.wt/fixture/dir/a");
    expect(fromWorkspaceText(".wt/p/d", "worktree /workspace/repo\n")).toBe("worktree /w/.wt/p/d\n");
  });

  it("are not the directories above them, and never escape", () => {
    expect(toWorkspace("/w/.wt")).toBeNull();
    expect(toWorkspace("/w/.wt/fixture")).toBeNull();
    expect(toWorkspace("/w/.wt/.hidden/dir")).toBeNull();
    expect(toWorkspace("/w/.wt/fixture/..")).toBeNull();
    expect(worktreeDirOf("/w/.wt")).toEqual({ project: null });
    expect(worktreeDirOf("/w/.wt/fixture/")).toEqual({ project: "fixture" });
    expect(worktreeDirOf("/w/.wt/fixture/dir")).toBeNull();
    expect(worktreeDirOf("/w/fixture")).toBeNull();
  });

  it("take any one segment t3 makes from a branch name", () => {
    expect(isWorktreeId(".wt/p/feat-ü-ß-0123456789abcdef")).toBe(true);
    expect(isWorktreeId(".wt/p/a b")).toBe(true);
    expect(isWorktreeId(".wt/p/..")).toBe(false);
    expect(isWorktreeId(".wt/p/a\nb")).toBe(false);
    expect(isWorktreeId(`.wt/p/${"x".repeat(101)}`)).toBe(false);
    expect(isWorktreeId(".wt/p")).toBe(false);
    expect(isWorkspaceId(".wt")).toBe(false);
    expect(isAnyWorkspaceId("fixture")).toBe(true);
  });
});

describe("JSON text bytes (SPI-1394)", () => {
  const stringified = (text: string) => new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;
  const samples = ['"'.repeat(50), "\t".repeat(50), "\u0001".repeat(50), "é".repeat(50), "😀".repeat(50), "a\ud800b"];

  it("counts what JSON.stringify writes, escapes and all", () => {
    for (const text of samples) expect(jsonTextBytes(text)).toBe(stringified(text));
  });

  it("keeps the longest start within the room, exactly, never splitting a surrogate pair", () => {
    // 90% escapes: every room keeps all it can, never less.
    const mixed = Array.from({ length: 1_000 }, (_, at) => (at % 10 === 0 ? "a" : '"')).join("");
    for (const text of [...samples, mixed])
      for (const room of [0, 1, 5, 6, 7, 99, 100, 101, jsonTextBytes(text)]) {
        const end = jsonTextPrefix(text, room);
        expect(jsonTextBytes(text.slice(0, end))).toBeLessThanOrEqual(room);
        if (end < text.length)
          expect(jsonTextBytes(text.slice(0, end + (text.codePointAt(end)! > 0xffff ? 2 : 1)))).toBeGreaterThan(room);
        // A pair split would leave a high surrogate at the end and its low one after it.
        expect(/[\ud800-\udbff]$/.test(text.slice(0, end)) && /^[\udc00-\udfff]/.test(text.slice(end))).toBe(false);
      }
    expect(jsonTextPrefix(mixed, 100_000)).toBe(mixed.length);
  });
});
