// @effect-diagnostics nodeBuiltinImport:off
// Patch 0010 (SPI-1375): t3's git output reaches it as its head under t3's own cap, never as computer's silent tail.
// computer keeps only the last 2,000 lines or 64 KiB of an exec's output unless it runs whole; t3 caps git's output
// itself (`maxOutputBytes`) and, past it, fails or keeps the head with "[truncated]". The Patch puts each call's cap in
// the env t3 spawns git with; the process router carries it to the Workspace, which cuts each stream in the Container
// just past it. Vitest runs t3 unpatched, so the Patches are applied here as build.ts applies them (0008 first, to the
// same file), and the copy's `makeGitVcsDriverCore` runs over the process router, whose Workspace answers through the
// Workspace DO's own git script and an exec that trims output as computer's does.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fromWorkspaceText, GIT_HEAD_SLACK_BYTES, gitOutputCut } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as CheckoutCloner from "t3/src/vcs/CheckoutCloner.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitAnswerOf, gitExecOf, gitOutcome } from "../../agents/src/workspace/gitOutput.ts";
import { computerExec } from "../../agents/test/computerExec.fixture.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { GIT_OUTPUT_CAP_ENV, gitOutputCapOf } from "../src/agents/gitRoutes.ts";
import * as ProcessRouter from "../src/agents/processRouter.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const T3 = path.resolve(here, "../../../t3code");
const VCS = path.join(T3, "apps/server/src/vcs");
const PATCHES = ["0008-git-errors-keep-t3flares-reason.patch", "0010-git-output-cap-reaches-the-router.patch"].map(
  (name) => path.resolve(here, "../../../patches", name),
);
const SOURCE = "apps/server/src/vcs/GitVcsDriverCore.ts";
const REPO_ROOT = "/workspace/repo";
const CWD = "/w/t3flare";

type MakeCore = () => Effect.Effect<GitVcsDriver.GitVcsDriver["Service"], never, never>;
let patchedCore: MakeCore;
let work: string;
let root: string;
afterAll(() => {
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

beforeAll(async () => {
  fs.mkdirSync(path.resolve(here, "../dist"), { recursive: true });
  work = fs.mkdtempSync(path.resolve(here, "../dist/patch-0010-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "t3flare-git-output-")));
  fs.mkdirSync(path.join(work, path.dirname(SOURCE)), { recursive: true });
  fs.copyFileSync(path.join(T3, SOURCE), path.join(work, SOURCE));
  execFileSync("git", ["init", "-q", work]);
  for (const patch of PATCHES) {
    const applied = spawnSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: work, encoding: "utf8" });
    expect(applied.stderr).toBe("");
    expect(applied.status).toBe(0);
  }
  const file = path.join(work, SOURCE);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(
      /from "(\.\.?\/[^"]+)"/g,
      (_, specifier: string) => `from ${JSON.stringify(path.resolve(VCS, specifier))}`,
    );
  fs.writeFileSync(file, text);
  expect(text).toContain(`${GIT_OUTPUT_CAP_ENV}: String(maxOutputBytes)`);
  patchedCore = ((await import(/* @vite-ignore */ file)) as { makeGitVcsDriverCore: MakeCore }).makeGitVcsDriverCore;
});

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...ENV }, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");

/** 30,000 numbered lines: past both of computer's limits (2,000 lines, 64 KiB), well within t3's default 1 MB cap. */
const BIG = Array.from({ length: 30_000 }, (_, at) => `line ${at + 1}\n`).join("");
/** Lines that are each a Workspace path, which the router writes as `/w/t3flare` paths, 5 bytes shorter. */
const PATHS = Array.from({ length: 20_000 }, (_, at) => `${REPO_ROOT}/src/f${at}.ts\n`).join("");

/** The project repo: `big.txt` and `paths.txt` on `main`; on `feature`, `big.txt` rewritten and committed. */
const project = () => {
  const dir = path.join(root, "t3flare");
  if (fs.existsSync(dir)) return dir;
  git(root, ["init", "-q", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, "big.txt"), BIG);
  fs.writeFileSync(path.join(dir, "paths.txt"), PATHS);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "one"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "big.txt"), BIG.replaceAll("line", "LINE"));
  git(dir, ["commit", "-q", "-am", "every line"]);
  return dir;
};

/**
 * The project Workspace `t3flare` over the local repo: each run through the Workspace DO's git script (`gitExecOf`) and
 * its outcome (`gitOutcome`), on an exec that trims as computer's does. `whole: false` drops the whole output the
 * Workspace asks for, as before SPI-1375.
 */
const workspace = (
  options: {
    readonly whole?: boolean;
    /** What the Workspace does to its answer before it goes back: a stale read's patch, say. */
    readonly patch?: (answer: ReturnType<typeof gitAnswerOf>) => ReturnType<typeof gitAnswerOf>;
  } = {},
) => {
  const dir = project();
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const runs: Array<number | undefined> = [];
  const stub = {
    git: async (run: {
      argv: ReadonlyArray<string>;
      cwd: string;
      env?: Record<string, string>;
      stdin?: string;
      maxOutputBytes?: number;
    }) => {
      runs.push(run.maxOutputBytes);
      const exec = gitExecOf({
        argv: run.argv.map(inDir),
        ...(run.maxOutputBytes === undefined ? {} : { maxOutputBytes: run.maxOutputBytes }),
      });
      const result = computerExec({
        ...exec,
        wholeOutput: options.whole ?? exec.wholeOutput,
        cwd: inDir(run.cwd),
        env: {
          ...ENV,
          ...Object.fromEntries(Object.entries(run.env ?? {}).map(([key, value]) => [key, inDir(value)])),
        },
        ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
      });
      const outcome = gitOutcome(result, run.maxOutputBytes);
      if (!outcome.ok) return { ran: false, reason: "container_refused", detail: outcome.detail };
      // The repo's own path, as the Container's git prints it (`--show-toplevel`); the big reads never print it.
      const back = (text: string) => text.replaceAll(dir, REPO_ROOT);
      const answer = (options.patch ?? ((same) => same))(gitAnswerOf(outcome.answer));
      return { ran: true, ...answer, stdout: back(answer.stdout), stderr: back(answer.stderr), ms: 0 };
    },
  };
  const record = { id: "t3flare", kind: "project", state: "ready", name: "t3flare" } as unknown as WorkspaceRecord;
  bindEnvironmentServices({
    processes: { environmentEpoch: 1 },
    workspaces: {
      resolve: (id: string) => (id === "t3flare" ? record : undefined),
      get: () => record,
      list: () => [record],
    },
    github: () => ({ live: () => [], mint: () => Promise.reject(new Error("no GitHub in this test")) }),
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => stub } },
  } as unknown as EnvironmentServices);
  return { runs };
};

/** The routing FileSystem's answer for a Workspace's root, which t3's review asks before reading one: it exists. */
const workspacePathsExist = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const local = yield* FileSystem.FileSystem;
    const exists = (at: string) => (/^\/w\/[^/]+$/.test(at) ? Effect.succeed(true) : local.exists(at));
    return FileSystem.FileSystem.of({ ...local, exists });
  }),
);

/** `use`'s result (or its failure), from t3's driver built by `makeCore` (the patched copy's, or t3's own). */
const driver = <A>(
  makeCore: MakeCore | "stock",
  use: (git: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, { readonly message: string }>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.result(use(yield* GitVcsDriver.GitVcsDriver));
    }).pipe(
      Effect.provide(
        (makeCore === "stock"
          ? GitVcsDriver.layer
          : Layer.effect(
              GitVcsDriver.GitVcsDriver,
              Effect.map(makeCore(), (core) => GitVcsDriver.GitVcsDriver.of(core)),
            ).pipe(Layer.provide(CheckoutCloner.layer))
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-git-output-config-" })),
          Layer.provideMerge(ProcessRouter.layer),
          Layer.provideMerge(workspacePathsExist),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

const show =
  (file: string, options: { readonly maxOutputBytes?: number; readonly appendTruncationMarker?: boolean }) =>
  (git: GitVcsDriver.GitVcsDriver["Service"]) =>
    git.execute({ operation: "Test.show", cwd: CWD, args: ["show", `main:${file}`], ...options });

const ok = <A>(result: { readonly _tag: "Success"; readonly success: A } | { readonly _tag: "Failure" }): A => {
  if (result._tag !== "Success") throw new Error(`expected a success: ${JSON.stringify(result)}`);
  return result.success;
};

describe("Patch 0010: t3's git output is its head under t3's own cap (SPI-1375)", { timeout: 120_000 }, () => {
  it("a read past 64 KiB and 2,000 lines, under t3's 1 MB cap, is whole; the Workspace got t3's cap", async () => {
    const { runs } = workspace();
    const result = ok(await driver(patchedCore, show("big.txt", {})));
    expect(result.stdout).toBe(BIG);
    expect(runs).toEqual([1_000_000]);
  });

  it("the same read on the Workspace as it was (computer's default window) is tailed: the seam catches it", async () => {
    workspace({ whole: false });
    const result = ok(await driver(patchedCore, show("big.txt", {})));
    expect(result.stdout).not.toBe(BIG);
    expect(BIG.endsWith(result.stdout)).toBe(true);
  });

  it("past the cap with the marker: the head, marked truncated", async () => {
    workspace();
    const result = ok(
      await driver(patchedCore, show("big.txt", { maxOutputBytes: 10_000, appendTruncationMarker: true })),
    );
    expect(result.stdout).toBe(BIG.slice(0, 10_000));
    expect(result.stdoutTruncated).toBe(true);
  });

  it("past the cap without it: t3's own failure", async () => {
    workspace();
    const result = await driver(patchedCore, show("big.txt", { maxOutputBytes: 10_000 }));
    expect(result._tag === "Failure" && result.failure.message).toContain("Git output exceeded 10000 bytes");
  });

  it("a head whose Workspace paths the router rewrites shorter is still cut exactly past the cap", async () => {
    workspace();
    const result = ok(
      await driver(patchedCore, show("paths.txt", { maxOutputBytes: 10_000, appendTruncationMarker: true })),
    );
    expect(result.stdout).toBe(fromWorkspaceText("t3flare", PATHS).slice(0, 10_000));
    expect(result.stdoutTruncated).toBe(true);
    // The slack outlasts the rewrite: 20,000 paths of 5 bytes each would not fit it.
    expect(PATHS.length).toBeGreaterThan(10_000 + GIT_HEAD_SLACK_BYTES);
  });

  it("a cut answer that comes back shorter than the cap (a stale read's patch, say) fails, never reads as whole", async () => {
    workspace({ patch: (answer) => ({ ...answer, stdout: answer.stdout.slice(0, 5_000) }) });
    const result = await driver(patchedCore, show("big.txt", { maxOutputBytes: 10_000, appendTruncationMarker: true }));
    expect(result._tag === "Failure" && result.failure.message).toContain("t3 cannot tell it was cut");
  });

  it("with no cap (t3's Infinity), a read is whole", async () => {
    const { runs } = workspace();
    const result = ok(await driver(patchedCore, show("big.txt", { maxOutputBytes: Number.POSITIVE_INFINITY })));
    expect(result.stdout).toBe(BIG);
    expect(runs).toEqual([undefined]);
  });

  it("t3 unpatched sends no cap: its reads are whole too", async () => {
    const { runs } = workspace();
    expect(ok(await driver("stock", show("big.txt", {}))).stdout).toBe(BIG);
    expect(runs).toEqual([undefined]);
  });

  it("a commit message's context, a PR's range and the review panel work on a large diff", async () => {
    const dir = project();
    workspace();
    fs.writeFileSync(path.join(dir, "big.txt"), BIG.replaceAll("line", "Line"));
    git(dir, ["add", "big.txt"]);
    try {
      // A commit message's staged patch, read as `prepareCommitContext` reads it (49,000 bytes, marked); the call itself
      // stages into a temporary index on t3's side, which needs the git bridge this test does not have.
      const commit = ok(
        await driver(patchedCore, (git) =>
          git.execute({
            operation: "Test.stagedPatch",
            cwd: CWD,
            args: ["diff", "--cached", "--patch", "--minimal"],
            maxOutputBytes: 49_000,
            appendTruncationMarker: true,
          }),
        ),
      );
      expect(commit.stdout.startsWith("diff --git a/big.txt b/big.txt")).toBe(true);
      expect(Buffer.byteLength(commit.stdout)).toBe(49_000);
      expect(commit.stdoutTruncated).toBe(true);
      const range = ok(await driver(patchedCore, (git) => git.readRangeContext(CWD, "main")));
      expect(range.commitSummary).toContain("every line");
      expect(range.diffSummary).toContain("big.txt");
      expect(range.diffPatch.startsWith("diff --git a/big.txt b/big.txt")).toBe(true);
      expect(range.diffPatch.endsWith("\n\n[truncated]")).toBe(true);
      const review = ok(await driver(patchedCore, (git) => git.getReviewDiffPreview({ cwd: CWD, baseRef: "main" })));
      expect(review.sources.map((source) => source.files?.map((file) => file.path))).toEqual([
        ["big.txt"],
        ["big.txt"],
      ]);
    } finally {
      git(dir, ["reset", "-q", "--hard"]);
    }
  });

  it("the router reads the cap Patch 0010 sets, and nothing else", () => {
    expect(gitOutputCapOf({ [GIT_OUTPUT_CAP_ENV]: "49000" })).toBe(49_000);
    expect(gitOutputCapOf({ [GIT_OUTPUT_CAP_ENV]: "Infinity" })).toBeUndefined();
    expect(gitOutputCapOf({})).toBeUndefined();
    expect(fs.readFileSync(PATCHES[1]!, "utf8")).toContain(`${GIT_OUTPUT_CAP_ENV}: String(maxOutputBytes)`);
  });
});

describe("a stream of a capped git answer, as the router gives it to t3 (SPI-1375)", () => {
  const cap = 100;
  const cut = "x".repeat(gitOutputCut(cap));
  it("not flagged cut, is as the router wrote it, whatever its length", () => {
    expect(ProcessRouter.headForCap("abcdef", false, cap)).toBe("abcdef");
    expect(ProcessRouter.headForCap(cut, false, cap)).toBe(cut);
  });
  it("flagged cut, is its head one byte past t3's cap", () => {
    expect(ProcessRouter.headForCap(`${cut}yy`, true, cap)).toBe("x".repeat(cap + 1));
  });
  it("flagged cut, and shorter than one byte past the cap, is refused: t3 would read it as whole", () => {
    expect(ProcessRouter.headForCap("x".repeat(cap), true, cap)).toBeNull();
    expect(ProcessRouter.headForCap(cut, true, undefined)).toBeNull();
  });
});
