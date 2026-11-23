// @effect-diagnostics nodeBuiltinImport:off
// t3's branch selector over a project with a worktree Workspace (SPI-1307, U18): t3's real `GitVcsDriver.listRefs` pairs
// the project's refs with its worktree list by branch name. A worktree Workspace is a full clone, so t3's first-turn
// rename (`git branch -m` in the worktree) never reaches the project's refs; the router adds the worktree's current
// branch to t3's ref snapshot, read from the worktree Workspace's own files. The project's Workspace answers like a
// Workspace DO: real git while its Container runs, `staleRead` once it stops (as in `statusOverStale.test.ts`).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { repoFacts, withinGuard } from "../../agents/src/workspace/gitRepo.ts";
import { staleRead } from "../../agents/src/workspace/staleReads.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import * as ProcessRouter from "../src/agents/processRouter.ts";
import type { WorkspaceRecord, WorkspaceState } from "../src/agents/workspaces.ts";

const REPO_ROOT = "/workspace/repo";
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "t3flare-wtrefs-")));
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

/** A project cloned from an origin with one commit on `main`. */
const project = (name: string) => {
  const origin = join(root, `${name}-origin`);
  git(root, ["init", "-q", "-b", "main", origin]);
  fs.writeFileSync(join(origin, "README.md"), "# t3flare\n");
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-q", "-m", "one"]);
  const dir = join(root, name);
  git(root, ["clone", "-q", origin, dir]);
  return dir;
};

const WORKTREE_ID = ".wt/t3flare/t3-520ecfd8";
const WORKTREE_PATH = `/w/${WORKTREE_ID}`;
const CREATED_AT = 1_763_700_000_000;

/** An argv the project's Workspace was asked to run, and whether it was allowed to start the Container. */
interface Asked {
  readonly argv: ReadonlyArray<string>;
  readonly startContainer: boolean;
  readonly running: boolean;
}

/**
 * The project `t3flare` over `dir` (real git while running, the DO's stale rule once stopped), and one worktree
 * Workspace of it whose own files say it is on `refs/heads/t3/reply-done` (t3's first-turn rename, in its clone).
 */
const environmentOver = (
  dir: string,
  worktree: { state: WorkspaceState; branch: string | null },
  /** The worktree's clone: its Container stopped, its ref snapshot never answered, every other read answered. */
  worktreeDir?: string,
) => {
  const answers = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
  const state = { running: true };
  const asked: Array<Asked> = [];
  const keyOf = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>> | undefined) =>
    JSON.stringify([argv, Object.entries(env ?? {}).toSorted(([a], [b]) => a.localeCompare(b))]);
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const projectStub = {
    git: async (run: {
      argv: ReadonlyArray<string>;
      cwd: string;
      env?: Record<string, string>;
      startContainer: boolean;
      readScope?: "git-dir" | "repo";
    }) => {
      asked.push({ argv: run.argv, startContainer: run.startContainer, running: state.running });
      if (!state.running) {
        if (run.startContainer) return { ran: false, reason: "container_refused", detail: "stopped in this test" };
        const outcome = await staleRead(run, {
          last: (argv) =>
            Promise.resolve(
              answers.has(keyOf(argv, run.env)) ? { rev: 0, answer: answers.get(keyOf(argv, run.env))! } : undefined,
            ),
          journalSince: () => [],
          withinGuard: () => withinGuard({ fs, dir, cache: {} }),
          facts: (base) => repoFacts({ fs, dir, cache: {} }, base),
        });
        if (!outcome.found) return { ran: false, reason: "container_stopped", detail: "no earlier answer" };
        return { ran: true, ...outcome.answer, ms: 0, cached: true, stale: outcome.stale };
      }
      const answer = git(inDir(run.cwd), run.argv.map(inDir));
      const back = {
        ...answer,
        stdout: answer.stdout.replaceAll(dir, REPO_ROOT),
        stderr: answer.stderr.replaceAll(dir, REPO_ROOT),
      };
      if (!run.startContainer) answers.set(keyOf(run.argv, run.env), back);
      return { ran: true, ...back, ms: 0 };
    },
  };
  const worktreeStub = {
    worktreeHead: async () => ({ head: "a".repeat(40), branch: "refs/heads/t3/reply-done" }),
    git: async (run: { argv: ReadonlyArray<string>; cwd: string }) => {
      if (worktreeDir === undefined || (run.argv.includes("for-each-ref") && run.argv.includes("refs/remotes")))
        return { ran: false, reason: "container_stopped", detail: "no earlier answer" };
      const inClone = (word: string) => word.replaceAll(REPO_ROOT, worktreeDir);
      const answer = git(inClone(run.cwd), run.argv.map(inClone));
      return { ran: true, ...answer, stdout: answer.stdout.replaceAll(worktreeDir, REPO_ROOT), ms: 0, cached: true };
    },
  };
  const projectRecord = {
    id: "t3flare",
    kind: "project",
    state: "ready",
    host: "github.com",
    owner: "ian-pascoe",
    name: "t3flare",
    createdAt: CREATED_AT - 1000,
  } as unknown as WorkspaceRecord;
  const worktreeRecord = {
    id: WORKTREE_ID,
    kind: "worktree",
    parent: "t3flare",
    createdAt: CREATED_AT,
    ...worktree,
  } as unknown as WorkspaceRecord;
  bindEnvironmentServices({
    workspaces: {
      resolve: (id: string) =>
        id === "t3flare" ? projectRecord : id === WORKTREE_ID && worktreeDir !== undefined ? worktreeRecord : undefined,
      get: () => projectRecord,
      list: () => [projectRecord],
      worktreesOf: (parent: string) => (parent === "t3flare" ? [worktreeRecord] : []),
    },
    github: () => ({ live: () => [], mint: () => Promise.reject(new Error("no GitHub in this test")) }),
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === WORKTREE_ID ? worktreeStub : projectStub),
      },
    },
  } as unknown as EnvironmentServices);
  return {
    stop: () => {
      state.running = false;
    },
    asked: () => asked,
  };
};

/**
 * The routing FileSystem as t3 sees it: a worktree Workspace's root exists (t3 stats each listed worktree before it
 * pairs it with a ref); every other path is the local disk's.
 */
const worktreePathsExist = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const local = yield* FileSystem.FileSystem;
    const here = yield* local.stat(root);
    const stat = (path: string) => (path.startsWith("/w/.wt/") ? Effect.succeed(here) : local.stat(path));
    return FileSystem.FileSystem.of({ ...local, stat });
  }),
);

const driver = <A, E>(use: (driver: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* GitVcsDriver.GitVcsDriver);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-wtrefs-config-" })),
          Layer.provideMerge(ProcessRouter.layer),
          Layer.provideMerge(worktreePathsExist),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

const refsOf = async (refresh: boolean) => {
  const result = await driver((git) => git.listRefs({ cwd: "/w/t3flare", refKind: "local", refresh }));
  return new Map(result.refs.map((ref) => [ref.name, ref.worktreePath]));
};

/** The project's `for-each-ref` reads the router answered, by route. */
const snapshotRoutes = () =>
  ProcessRouter.routerTrace()
    .filter((entry) => entry.argv.includes("for-each-ref") && entry.argv.includes("refs/remotes"))
    .map((entry) => entry.route);

beforeEach(() => {
  ProcessRouter.clearWorktreeEntries();
  ProcessRouter.clearRouterTrace();
});

describe(
  "t3's branch selector offers a worktree Workspace on its current branch (SPI-1307)",
  { timeout: 60_000 },
  () => {
    it("after t3's first-turn rename, the worktree's current branch is listed with its path; the old name is not paired", async () => {
      const dir = project("renamed");
      // t3 makes the worktree's branch in the project, then renames it in the worktree's clone only.
      git(dir, ["branch", "--no-track", "--", "t3/520ecfd8", "main"]);
      const environment = environmentOver(dir, { state: "ready", branch: "t3/520ecfd8" });
      const refs = await refsOf(true);
      expect(refs.get("t3/reply-done")).toBe(WORKTREE_PATH);
      expect(refs.get("t3/520ecfd8")).toBeNull();
      // A passive read: never allowed to start the project's Container, and answered as the worktree route.
      expect(environment.asked().filter((run) => run.argv.includes("for-each-ref"))).not.toEqual([]);
      expect(environment.asked().filter((run) => run.startContainer)).toEqual([]);
      expect(snapshotRoutes()).toEqual(["worktree"]);
      expect(
        ProcessRouter.routerTrace().find((entry) => entry.route === "worktree" && entry.argv.includes("for-each-ref"))
          ?.detail,
      ).toMatch(/^1 worktree branches added/);
    });

    it("with the project's Container stopped, its last answer predating the worktree, the pairing holds", async () => {
      const dir = project("stopped");
      const environment = environmentOver(dir, { state: "ready", branch: "t3/520ecfd8" });
      await refsOf(true);
      environment.stop();
      ProcessRouter.clearWorktreeEntries();
      const refs = await refsOf(true);
      expect(refs.get("t3/reply-done")).toBe(WORKTREE_PATH);
      expect(environment.asked().filter((run) => !run.running && run.startContainer)).toEqual([]);
      expect(snapshotRoutes()).toEqual(["worktree", "worktree"]);
    });

    it("a tombstoned, failed or provisioning worktree Workspace adds no ref", async () => {
      const dir = project("not-ready");
      for (const state of ["tombstoned", "failed", "provisioning"] as const) {
        environmentOver(dir, { state, branch: "t3/520ecfd8" });
        ProcessRouter.clearWorktreeEntries();
        const refs = await refsOf(true);
        expect(refs.has("t3/reply-done"), state).toBe(false);
      }
    });

    it("a worktree whose branch the project also has adds no second line", async () => {
      const dir = project("shared-name");
      git(dir, ["branch", "--no-track", "--", "t3/reply-done", "main"]);
      environmentOver(dir, { state: "ready", branch: "t3/520ecfd8" });
      const result = await driver((git) => git.listRefs({ cwd: "/w/t3flare", refKind: "local", refresh: true }));
      expect(result.refs.filter((ref) => ref.name === "t3/reply-done").map((ref) => ref.worktreePath)).toEqual([
        WORKTREE_PATH,
      ]);
    });

    it("the selector's confirming read in the worktree, its Container stopped and never asked before, finds its branch checked out", async () => {
      const dir = project("confirm");
      const clone = join(root, "confirm-worktree");
      git(root, ["clone", "-q", dir, clone]);
      git(clone, ["checkout", "-q", "-b", "t3/reply-done"]);
      environmentOver(dir, { state: "ready", branch: "t3/520ecfd8" }, clone);
      // t3's `readSelectedRef`: the worktree's local refs, the listed name, one result; kept only when it is current.
      const confirming = await driver((git) =>
        git.listRefs({ cwd: WORKTREE_PATH, query: "t3/reply-done", refKind: "local", limit: 1, refresh: true }),
      );
      expect(confirming.refs.map((ref) => [ref.name, ref.current])).toEqual([["t3/reply-done", true]]);
      expect(
        ProcessRouter.routerTrace().find((entry) => entry.cwd === WORKTREE_PATH && entry.argv.includes("refs/remotes")),
      ).toMatchObject({ route: "worktree", exitCode: 0, detail: expect.stringMatching(/^its current branch only/) });
    });

    it("a new worktree based on a branch only the worktree's clone holds: the router's reason names that worktree", async () => {
      const dir = project("held-base");
      environmentOver(dir, { state: "ready", branch: "t3/520ecfd8" });
      const failure = await driver((git) =>
        git
          .createWorktree({ cwd: "/w/t3flare", refName: "t3/reply-done", newRefName: "t3/9f00aa11", path: null })
          .pipe(Effect.flip),
      );
      expect(String(failure)).not.toBe("");
      const branch = ProcessRouter.routerTrace().find((entry) => entry.argv.includes("branch"));
      expect(branch?.route).toBe("worktree");
      expect(branch?.detail).toContain(
        `fatal: t3flare: 't3/reply-done' is a branch of the worktree Workspace at ${WORKTREE_PATH}, not of the project`,
      );
    });
  },
);
