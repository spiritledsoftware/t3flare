// @effect-diagnostics nodeBuiltinImport:off
// Patch 0008 (SPI-1182): t3's `GitCommandError` hides git's stderr (it can echo credentials), so a refusal of
// t3flare's reached t3 as "git worktree add failed" alone. The Patch adds the text of every stderr line starting with
// `fatal: t3flare: ` to the error's detail, in `executeGit` and `executeRaw`; nothing else of stderr. Vitest runs t3
// unpatched, so the Patch is applied here as build.ts applies it (`git apply` to a copy of the pinned file), and the copy's
// `makeGitVcsDriverCore` runs over the process router, whose Workspaces answer like Workspace DOs.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "t3/src/config.ts";
import * as CheckoutCloner from "t3/src/vcs/CheckoutCloner.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { T3FLARE_FATAL } from "../src/agents/gitRoutes.ts";
import * as ProcessRouter from "../src/agents/processRouter.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const T3 = path.resolve(here, "../../../t3code");
const VCS = path.join(T3, "apps/server/src/vcs");
const PATCH = path.resolve(here, "../../../patches/0008-git-errors-keep-t3flares-reason.patch");
const SOURCE = "apps/server/src/vcs/GitVcsDriverCore.ts";
const REFUSAL = "the Container cannot start: Container budget (3) reached: raise it at /_t3flare/settings#environment";
const REPO_ROOT = "/workspace/repo";

type MakeCore = () => Effect.Effect<GitVcsDriver.GitVcsDriver["Service"], never, never>;
let patchedCore: MakeCore;
/** The patched copy's tree: inside the package (gitignored), so `effect` and `@t3tools/*` resolve from its node_modules. */
let work: string;
/** The local repos the Workspaces run git in. */
let root: string;
afterAll(() => {
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

beforeAll(async () => {
  fs.mkdirSync(path.resolve(here, "../dist"), { recursive: true });
  work = fs.mkdtempSync(path.resolve(here, "../dist/patch-0008-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "t3flare-git-reason-")));
  fs.mkdirSync(path.join(work, path.dirname(SOURCE)), { recursive: true });
  fs.copyFileSync(path.join(T3, SOURCE), path.join(work, SOURCE));
  // A repo of its own: inside t3flare's checkout, `git apply` would take the Patch's paths from t3flare's root and skip them.
  execFileSync("git", ["init", "-q", work]);
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", PATCH], { cwd: work, encoding: "utf8" });
  expect(applied.stderr).toBe("");
  expect(applied.status).toBe(0);
  // The copy's relative imports point at the pinned tree, so it shares t3's services and error classes.
  const file = path.join(work, SOURCE);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(
      /from "(\.\.?\/[^"]+)"/g,
      (_, specifier: string) => `from ${JSON.stringify(path.resolve(VCS, specifier))}`,
    );
  fs.writeFileSync(file, text);
  expect(text).toContain("t3flareReason(result.stderr)");
  patchedCore = ((await import(/* @vite-ignore */ file)) as { makeGitVcsDriverCore: MakeCore }).makeGitVcsDriverCore;
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const realGit = (cwd: string, args: ReadonlyArray<string>) => {
  const run = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

/** A project repo with one commit on `main`. */
const project = () => {
  const dir = path.join(root, "t3flare");
  if (fs.existsSync(dir)) return dir;
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  fs.writeFileSync(path.join(dir, "README.md"), "# t3flare\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: dir, env: ENV });
  return dir;
};

/**
 * The project Workspace `t3flare` over a local repo (real git while its Container runs, as `statusOverStale.test.ts`
 * has it), `containerStderr` added to its answers when given, and every worktree Workspace's clone refused by the
 * Container budget.
 */
const workspaces = (containerStderr?: string) => {
  const dir = project();
  const inDir = (word: string) => word.replaceAll(REPO_ROOT, dir);
  const projectStub = {
    git: async (run: { argv: ReadonlyArray<string>; cwd: string }) => {
      const answer = realGit(inDir(run.cwd), run.argv.map(inDir));
      return {
        ran: true,
        exitCode: containerStderr === undefined ? answer.exitCode : 128,
        stdout: answer.stdout.replaceAll(dir, REPO_ROOT),
        stderr: `${answer.stderr.replaceAll(dir, REPO_ROOT)}${containerStderr ?? ""}`,
        ms: 0,
      };
    },
  };
  const worktreeStub = { worktreeClone: async () => ({ ok: false, error: REFUSAL }) };
  const record = {
    id: "t3flare",
    kind: "project",
    state: "ready",
    host: "github.com",
    owner: "ian-pascoe",
    name: "t3flare",
    cloneUrl: "https://github.com/ian-pascoe/t3flare.git",
  } as unknown as WorkspaceRecord;
  const states = new Map<string, string>();
  bindEnvironmentServices({
    // The process channel's epoch, which a git run t3 can cancel carries (SPI-1382).
    processes: { environmentEpoch: 1 },
    workspaces: {
      resolve: (id: string) => (id === "t3flare" ? record : undefined),
      get: (id: string) => (id === "t3flare" ? record : undefined),
      list: () => [record],
      createWorktree: ({ id }: { id: string }) => void states.set(id, "provisioning"),
      setState: (id: string, state: string) => void states.set(id, state),
      remove: (id: string) => void states.delete(id),
      worktreesOf: () => [],
    },
    github: () => ({ live: () => [], mint: () => Promise.reject(new Error("no GitHub in this test")) }),
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: (name: string) => (name === "t3flare" ? projectStub : worktreeStub),
      },
    },
  } as unknown as EnvironmentServices);
  return { states };
};

/** A spawner whose every command fails with this stderr, for stderr the router never writes. */
const failingSpawner = (stderr: string) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          all: Stream.make(new TextEncoder().encode(stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  );

/** The error `use` fails with, from t3's driver built by `makeCore` (the patched copy's, or t3's own) over `spawner`. */
const failure = (
  makeCore: MakeCore | "stock",
  use: (git: GitVcsDriver.GitVcsDriver["Service"]) => Effect.Effect<unknown, { readonly message: string }>,
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = ProcessRouter.layer,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* Effect.flip(Effect.asVoid(use(yield* GitVcsDriver.GitVcsDriver)));
    }).pipe(
      Effect.provide(
        (makeCore === "stock"
          ? GitVcsDriver.layer
          : Layer.effect(
              GitVcsDriver.GitVcsDriver,
              Effect.map(makeCore(), (core) => GitVcsDriver.GitVcsDriver.of(core)),
            ).pipe(Layer.provide(CheckoutCloner.layer))
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3flare-git-reason-config-" })),
          Layer.provideMerge(spawner),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    ),
  );

const worktreeAdd = (git: GitVcsDriver.GitVcsDriver["Service"]) =>
  git.createWorktree({ cwd: "/w/t3flare", refName: "main", path: "/w/.wt/t3flare/feature" });
const failingCommand = (git: GitVcsDriver.GitVcsDriver["Service"]) =>
  git.execute({ operation: "Test.revParse", cwd: "/w/t3flare", args: ["rev-parse", "--verify", "no-such-ref"] });

describe("Patch 0008: t3's git errors keep t3flare's reason, and only it", { timeout: 60_000 }, () => {
  it("a worktree clone refused by the Container budget: t3's error carries the whole refusal after 'git worktree add failed'", async () => {
    const { states } = workspaces();
    const error = await failure(patchedCore, worktreeAdd);
    expect(error.message).toContain(`git worktree add failed: the worktree Workspace was not made: ${REFUSAL}`);
    expect(states.get(".wt/t3flare/feature")).toBe("failed");
    // t3 unpatched drops it: the case the Patch is for.
    workspaces();
    expect((await failure("stock", worktreeAdd)).message).not.toContain(REFUSAL);
  });

  it("a failure whose stderr has no t3flare line gives t3's stock message exactly", async () => {
    workspaces();
    const patched = await failure(patchedCore, failingCommand);
    const stock = await failure("stock", failingCommand);
    expect(patched.message).toBe(stock.message);
  });

  it("stderr with a credential URL and a t3flare line shows only the t3flare text", async () => {
    const stderr = `fatal: unable to access 'https://user:tok@host/o/r.git/': denied\n${T3FLARE_FATAL}the reason\n`;
    const error = await failure(patchedCore, failingCommand, failingSpawner(stderr));
    expect(error.message).toContain(": the reason");
    expect(error.message).not.toContain("tok@host");
    expect(error.message).not.toContain("unable to access");
  });

  it("the Container's own stderr carrying the marker gives t3's stock message (only the router's lines pass)", async () => {
    const container = `${T3FLARE_FATAL}no such path 'secret' in HEAD\n`;
    workspaces(container);
    const patched = await failure(patchedCore, failingCommand);
    workspaces(container);
    const stock = await failure("stock", failingCommand);
    expect(patched.message).toBe(stock.message);
    expect(patched.message).not.toContain("no such path");
  });

  it("the Patch matches the marker the router writes", () => {
    expect(fs.readFileSync(PATCH, "utf8")).toContain(JSON.stringify(T3FLARE_FATAL));
  });
});
