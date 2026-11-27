// @effect-diagnostics nodeBuiltinImport:off
// The base-commit fetch for t3's `delegate_task` (SPI-1454): t3 refuses a worktree delegation unless the project's clone
// holds the parent checkout's commit (`resolveCommit` at the project root, `OrchestratorMcpService.ts`). Each Workspace
// is its own clone, so the Layer fetches a missing commit into the project once, under its own time limit, and retries.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import * as ProcessRouter from "../src/agents/processRouter.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { DELEGATE_BASE_FETCH_TIMEOUT_MS, layerDelegateBaseFetch, withBaseFetch } from "../src/t3/delegateBaseFetch.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const missing = (cwd: string) =>
  new GitCommandError({
    operation: "GitVcsDriver.resolveCommit",
    command: "git rev-parse",
    cwd,
    exitCode: 128,
    detail: "fatal: Needed a single revision",
  });

/** A stock driver whose `resolveCommit` finds `SHA` only after a fetch; `execute` records each call. */
const stockDriver = (fetch: "ok" | "fails" | "times-out") => {
  const executed: Array<GitVcsDriver.ExecuteGitInput> = [];
  let fetched = false;
  const firstError = missing("/w/t3flare");
  const stock = {
    resolveCommit: (input: { cwd: string; revision: string }) =>
      fetched && input.revision === SHA ? Effect.succeed({ commitSha: SHA }) : Effect.fail(firstError),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    execute: (input: GitVcsDriver.ExecuteGitInput) => {
      executed.push(input);
      if (fetch === "ok") {
        fetched = true;
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: "git fetch",
          cwd: input.cwd,
          detail: fetch === "times-out" ? "Git command timed out." : "fatal: couldn't find remote ref",
        }),
      );
    },
  } as unknown as GitVcsDriver.GitVcsDriver["Service"];
  return { driver: withBaseFetch(stock), executed, firstError };
};

const resolve = (driver: GitVcsDriver.GitVcsDriver["Service"], cwd: string, revision: string) =>
  Effect.runPromiseExit(driver.resolveCommit({ cwd, revision }));

afterEach(() => vi.restoreAllMocks());

describe("the base-commit fetch for delegate_task (SPI-1454)", () => {
  it("fetches a commit missing from a project's clone once, under its own limit, and resolves it", async () => {
    const { driver, executed } = stockDriver("ok");
    const exit = await resolve(driver, "/w/t3flare", SHA);
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ commitSha: SHA });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      cwd: "/w/t3flare",
      args: ["fetch", "--quiet", "--no-tags", "--", "origin", SHA],
      timeoutMs: DELEGATE_BASE_FETCH_TIMEOUT_MS,
    });
    expect(DELEGATE_BASE_FETCH_TIMEOUT_MS).toBe(120_000);
  });

  it("keeps t3's refusal when the fetch fails: the original error comes back", async () => {
    const { driver, executed, firstError } = stockDriver("fails");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = await resolve(driver, "/w/t3flare", SHA);
    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: firstError });
    expect(executed).toHaveLength(1);
  });

  it("names the limit and its value when the fetch runs out of time", async () => {
    const { driver, firstError } = stockDriver("times-out");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = await resolve(driver, "/w/t3flare", SHA);
    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: firstError });
    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({
        t3flare: "delegate-base-fetch-timeout",
        limit: "DELEGATE_BASE_FETCH_TIMEOUT_MS",
        ms: 120_000,
        commit: SHA,
      }),
    );
  });

  it.each([
    ["a revision that is not a full commit id", "/w/t3flare", "HEAD"],
    ["a short commit id", "/w/t3flare", SHA.slice(0, 12)],
    ["a worktree Workspace", "/w/.wt/t3flare/t3-520ecfd8", SHA],
    ["a path outside /w", "/tmp/repo", SHA],
    ["/w itself", "/w", SHA],
  ])("never fetches for %s", async (_name, cwd, revision) => {
    const { driver, executed } = stockDriver("ok");
    const exit = await resolve(driver, cwd, revision);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(executed).toEqual([]);
  });

  it("never fetches when the commit is already there", async () => {
    const executed: Array<unknown> = [];
    const stock = {
      resolveCommit: () => Effect.succeed({ commitSha: SHA }),
      execute: (input: unknown) => {
        executed.push(input);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const exit = await resolve(withBaseFetch(stock), "/w/t3flare", SHA);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(executed).toEqual([]);
  });
});

// Over t3's real driver and the process router: a project clone one commit behind its origin, as when a parent
// Workspace is on a commit pushed after the project's last fetch.
const REPO_ROOT = "/workspace/repo";
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "t3flare-basefetch-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, args: ReadonlyArray<string>) => {
  try {
    return {
      exitCode: 0,
      stdout: execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8"),
      stderr: "",
    };
  } catch (error) {
    const failed = error as { status: number; stdout: Buffer; stderr: Buffer };
    return {
      exitCode: failed.status ?? 1,
      stdout: failed.stdout?.toString("utf8") ?? "",
      stderr: failed.stderr?.toString("utf8") ?? "",
    };
  }
};

/** A project cloned from its origin, then one commit pushed to the origin that the clone has not fetched. */
const projectBehind = (name: string) => {
  const origin = join(root, `${name}-origin`);
  git(root, ["init", "-q", "-b", "main", origin]);
  fs.writeFileSync(join(origin, "README.md"), "# t3flare\n");
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-q", "-m", "one"]);
  const dir = join(root, name);
  git(root, ["clone", "-q", origin, dir]);
  fs.writeFileSync(join(origin, "README.md"), "# t3flare\n\ntwo\n");
  git(origin, ["commit", "-q", "-am", "two"]);
  return { dir, commit: git(origin, ["rev-parse", "HEAD"]).stdout.trim() };
};

/**
 * The project `t3flare` over `dir`, real git while its Container runs; records each argv it is asked to run. A stopped
 * Container answers no passive read (none was answered before) and starts for a command allowed to start it.
 */
const environmentOver = (dir: string, container: "running" | "stopped" = "running") => {
  const asked: Array<ReadonlyArray<string>> = [];
  const state = { running: container === "running" };
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const projectStub = {
    git: async (run: { argv: ReadonlyArray<string>; cwd: string; startContainer: boolean }) => {
      asked.push(run.argv);
      if (!state.running && !run.startContainer)
        return { ran: false, reason: "container_stopped", detail: "no earlier answer" };
      state.running = true;
      const answer = git(inDir(run.cwd), run.argv.map(inDir));
      return {
        ran: true,
        ...answer,
        stdout: answer.stdout.replaceAll(dir, REPO_ROOT),
        stderr: answer.stderr.replaceAll(dir, REPO_ROOT),
        ms: 0,
      };
    },
  };
  const projectRecord = {
    id: "t3flare",
    kind: "project",
    state: "ready",
    host: "github.com",
    owner: "example-owner",
    name: "t3flare",
    createdAt: 1_763_700_000_000,
  } as unknown as WorkspaceRecord;
  bindEnvironmentServices({
    processes: { environmentEpoch: 1 },
    workspaces: {
      resolve: (id: string) => (id === "t3flare" ? projectRecord : undefined),
      get: () => projectRecord,
      list: () => [projectRecord],
      worktreesOf: () => [],
    },
    github: () => ({ live: () => [], mint: () => Promise.reject(new Error("no GitHub in this test")) }),
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => projectStub } },
  } as unknown as EnvironmentServices);
  return { asked };
};

const viaLayer = <A, E>(use: (driver: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* use(yield* GitVcsDriver.GitVcsDriver);
    }).pipe(
      Effect.provide(
        layerDelegateBaseFetch.pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-basefetch-config-" })),
          Layer.provideMerge(ProcessRouter.layer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

describe("delegate_task's check over the router (SPI-1454)", { timeout: 60_000 }, () => {
  it("finds a commit the project's clone had not fetched, after one fetch by its id", async () => {
    const { dir, commit } = projectBehind("running");
    expect(git(dir, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).exitCode).not.toBe(0);
    const environment = environmentOver(dir);
    const exit = await viaLayer((driver) => driver.resolveCommit({ cwd: "/w/t3flare", revision: commit }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ commitSha: commit });
    expect(environment.asked.filter((argv) => argv.includes("fetch"))).toEqual([
      ["fetch", "--quiet", "--no-tags", "--", "origin", commit],
    ]);
  });

  it("starts a stopped project Container with the fetch, though its remote cannot be read before", async () => {
    const { dir, commit } = projectBehind("stopped");
    const environment = environmentOver(dir, "stopped");
    const exit = await viaLayer((driver) => driver.resolveCommit({ cwd: "/w/t3flare", revision: commit }));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ commitSha: commit });
    expect(environment.asked.filter((argv) => argv.includes("fetch"))).toEqual([
      ["fetch", "--quiet", "--no-tags", "--", "origin", commit],
    ]);
  });
});
