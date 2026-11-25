// t3's workspace services over a Workspace DO (`workspace/layers.ts`): a file read fetches only what t3 shows, the file
// index states a cut, content search highlights every match, and metadata asks for every path at once.
// @effect-diagnostics globalTimers:off
import * as WorkspaceEntries from "t3/src/workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "t3/src/workspace/WorkspaceFileSystem.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import type { FsOp } from "../src/agents/rpc.ts";
import { fitFoundEntries, foundEntryBytes } from "@t3flare/workspace-client";

import {
  INDEX_MAX_BYTES,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
  READ_MAX_BYTES,
} from "../src/workspace/layers.ts";

const ops: Array<FsOp> = [];
let answer: (op: FsOp) => Promise<unknown> = async () => ({ error: "ENOENT", message: "none" });

const bind = () => {
  const record = { id: "demo", state: "ready", kind: "project" };
  bindEnvironmentServices({
    workspaces: {
      list: () => [record],
      resolve: (id: string) => (id === "demo" ? record : undefined),
      get: (id: string) => (id === "demo" ? record : undefined),
      worktreesOf: () => [],
    },
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: () => ({
          fs: (op: FsOp) => {
            ops.push(op);
            return answer(op);
          },
        }),
      },
    },
  } as unknown as EnvironmentServices);
};

const stockEntries = Layer.succeed(
  WorkspaceEntries.WorkspaceEntries,
  {} as WorkspaceEntries.WorkspaceEntries["Service"],
);
const stockFiles = Layer.succeed(WorkspaceFileSystem.WorkspaceFileSystem, {
  getMetadata: () => Effect.succeed({ entries: [] }),
} as unknown as WorkspaceFileSystem.WorkspaceFileSystem["Service"]);

const withEntries = <A, E>(f: (service: WorkspaceEntries.WorkspaceEntries["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* WorkspaceEntries.WorkspaceEntries);
    }).pipe(Effect.provide(layerWorkspaceEntries(stockEntries))) as Effect.Effect<A, E>,
  );
const withFiles = <A, E>(f: (service: WorkspaceFileSystem.WorkspaceFileSystem["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* WorkspaceFileSystem.WorkspaceFileSystem);
    }).pipe(
      Effect.provide(layerWorkspaceFileSystem(stockFiles)),
      Effect.provideService(HostProcess.HomeDirectory, "/root"),
    ) as Effect.Effect<A, E>,
  );

afterEach(() => {
  ops.splice(0);
});

describe("a Workspace file read", () => {
  it("fetches only what t3 shows of a large file, and reports its whole size and the cut", async () => {
    bind();
    const size = 3 * 1024 * 1024;
    answer = async (op) => {
      if (op.op === "stat") return { ok: { kind: "file", size, mtimeMs: 0, mode: 0o644 } };
      if (op.op === "read") {
        const length = Math.min(op.range?.length ?? size, size - (op.range?.offset ?? 0));
        return { ok: new Uint8Array(length).fill(0x61) };
      }
      return { error: "EINVAL", message: op.op };
    };
    const result = await withFiles((files) => files.readFile({ cwd: "/w/demo", relativePath: "big.txt" }));
    expect(READ_MAX_BYTES).toBe(1024 * 1024);
    expect(ops.find((op) => op.op === "read")).toEqual({
      op: "read",
      path: "/workspace/repo/big.txt",
      range: { offset: 0, length: READ_MAX_BYTES },
    });
    expect(result).toMatchObject({ byteLength: size, truncated: true, exists: true });
    expect("contents" in result && result.contents.length).toBe(READ_MAX_BYTES);
  });

  it("reads a small file whole, and answers a missing one when allowed", async () => {
    bind();
    answer = async (op) =>
      op.op === "stat"
        ? { ok: { kind: "file", size: 5, mtimeMs: 0, mode: 0o644 } }
        : { ok: new TextEncoder().encode("hello") };
    const small = await withFiles((files) => files.readFile({ cwd: "/w/demo", relativePath: "a.txt" }));
    expect(small).toMatchObject({ contents: "hello", byteLength: 5, truncated: false, exists: true });
    answer = async () => ({ error: "ENOENT", message: "no such file" });
    const missing = await withFiles((files) =>
      files.readFile({ cwd: "/w/demo", relativePath: "gone.txt", allowMissing: true }),
    );
    expect(missing).toMatchObject({ exists: false, truncated: false });
  });
});

describe("a Workspace's file index", () => {
  it("asks for an index bounded by the DO RPC answer's bytes, not a count, and states a cut in search too", async () => {
    bind();
    const asked: Array<unknown> = [];
    answer = async (op) => {
      asked.push(op);
      return op.op === "index"
        ? { ok: { entries: [{ path: "/workspace/repo/f1.ts", kind: "file" }], truncated: true } }
        : { error: "EINVAL", message: op.op };
    };
    const found = await withEntries((entries) => entries.search({ cwd: "/w/demo", query: "f1", limit: 100_000 }));
    expect(found.truncated).toBe(true);
    expect(asked).toEqual([{ op: "index", path: "/workspace/repo", maxBytes: INDEX_MAX_BYTES }]);
    expect(INDEX_MAX_BYTES).toBe(32 * 1024 * 1024 - 64 * 1024);
  });

  it("logs a named cut once per revision, naming the Workspace", async () => {
    bind();
    let revision = 7;
    const cut = "t3flare: the file index of /workspace/repo is cut to 1 entries: at most 1 entries";
    answer = async () => ({
      ok: { entries: [{ path: "/workspace/repo/f1.ts", kind: "file" }], truncated: true, cut, revision },
    });
    const logged: Array<Logger.Options<unknown>> = [];
    const logger = Logger.layer([Logger.make((entry) => void logged.push(entry))], { mergeWithExisting: false });
    const search = () =>
      withEntries((entries) => entries.search({ cwd: "/w/demo", query: "f1", limit: 10 }).pipe(Effect.provide(logger)));
    await search();
    await search();
    expect(logged).toHaveLength(1);
    expect(Logger.formatLogFmt.log(logged[0]!)).toContain("Workspace demo");
    expect(Logger.formatLogFmt.log(logged[0]!)).toContain("at most 1 entries");
    revision = 8;
    await search();
    expect(logged).toHaveLength(2);
  });

  it("the Workspace DO's cut keeps every entry that fits, and says when it left some out", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ path: `p${i}`, kind: "file" as const }));
    const each = foundEntryBytes(entries[0]!);
    expect(fitFoundEntries(entries, each * 10)).toEqual({ entries, truncated: false });
    expect(fitFoundEntries(entries, each * 10 - 1)).toEqual({ entries: entries.slice(0, 9), truncated: true });
    // 100,000 entries of short paths fit easily: the old 5,000 cut is gone.
    const many = Array.from({ length: 100_000 }, (_, i) => ({ path: `src/f${i}.ts`, kind: "file" as const }));
    expect(fitFoundEntries(many, INDEX_MAX_BYTES).truncated).toBe(false);
  });
});

describe("Workspace content search", () => {
  it("highlights every match on a line", async () => {
    bind();
    const line = "x ".repeat(80);
    answer = async () => ({ ok: [{ path: "/workspace/repo/a.txt", line: 1, text: line }] });
    const found = await withEntries((entries) =>
      entries.searchContents({
        cwd: "/w/demo",
        query: "x",
        limit: 10,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      }),
    );
    expect(found.matches[0]?.matchRanges).toHaveLength(80);
  });
});

describe("Workspace metadata", () => {
  it("asks for every path at once", async () => {
    bind();
    let inFlight = 0;
    let most = 0;
    answer = async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: { kind: "file", size: 1, mtimeMs: 0, mode: 0o644 } };
    };
    const paths = Array.from({ length: 20 }, (_, i) => `/w/demo/f${i}`);
    const result = await withFiles((files) => files.getMetadata({ paths }));
    expect(result.entries).toHaveLength(20);
    expect(most).toBe(20);
  });
});
