// @effect-diagnostics globalTimers:off
// The process router's gh answers, as t3's GitHub provider reads them: `gh auth status --json hosts` through the
// router's spawner, parsed by t3's own `parseGitHubAuth` (its Settings → Source Control discovery). And its refusals,
// which t3 shows and persists through Patch 0008 (SPI-1182): one line each, live tokens taken out.
import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { parseGitHubAuth } from "../../../t3code/packages/source-control-github/src/server/GitHubSourceControlProvider.ts";
import { resolveEnvironment } from "@t3flare/harness-registry";

import { bindEnvironmentServices, environmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { T3FLARE_FATAL } from "../src/agents/gitRoutes.ts";
import { spawn } from "../src/agents/processRouter.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";

const workspace = (owner: string, name: string): WorkspaceRecord =>
  ({
    id: name,
    host: "github.com",
    owner,
    name,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    createdAt: 0,
    state: "ready",
    workflows: false,
    kind: "project",
    parent: null,
    branch: null,
    unreferencedSince: null,
    deletedAt: null,
    purgeAfter: null,
    lastError: null,
  }) as unknown as WorkspaceRecord;

/** The Environment's services with these Workspaces and no live GitHub token. */
const bindWorkspaces = (records: ReadonlyArray<WorkspaceRecord>) =>
  bindEnvironmentServices({
    workspaces: { list: () => records },
    github: () => ({ live: () => [] }),
  } as unknown as EnvironmentServices);

/** Runs `<name> <args>` through the router's spawner: its exit code, stdout and stderr. */
const run = (name: string, args: ReadonlyArray<string>, cwd?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const handle = yield* spawn(
        ChildProcess.make(name, [...args], cwd === undefined ? {} : { cwd }) as ChildProcess.Command,
      );
      const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
        Stream.runFold(
          stream,
          () => "",
          (acc, bytes) => acc + new TextDecoder().decode(bytes),
        );
      const stdout = yield* text(handle.stdout);
      const stderr = yield* text(handle.stderr);
      const exitCode = yield* handle.exitCode;
      return { exitCode, stdout, stderr };
    }).pipe(Effect.scoped),
  );

const runGh = (args: ReadonlyArray<string>) => run("gh", args);

const authStatus = ["auth", "status", "--json", "hosts"];

describe("gh auth status --json hosts", () => {
  it("is signed in to github.com as the GitHub App when the Environment has no GitHub Workspace yet", async () => {
    bindWorkspaces([]);
    const answer = await runGh(authStatus);
    expect(answer.exitCode).toBe(0);
    const auth = parseGitHubAuth(answer);
    expect(auth.status).toBe("authenticated");
    expect(auth.host).toEqual(expect.objectContaining({ value: "github.com" }));
    expect(auth.account).toEqual(expect.objectContaining({ value: "t3flare[bot]" }));
  });

  it("is signed in as the GitHub App installation's account once a GitHub Workspace names it", async () => {
    bindWorkspaces([workspace("ian-pascoe", "t3flare")]);
    const auth = parseGitHubAuth(await runGh(authStatus));
    expect(auth.status).toBe("authenticated");
    expect(auth.account).toEqual(expect.objectContaining({ value: "ian-pascoe" }));
  });
});

describe("the router's refusals", () => {
  it("are one line with live GitHub tokens taken out, starting with the marker t3 shows", async () => {
    const token = "ghs_liveTokenForThisTest";
    bindEnvironmentServices({
      workspaces: { list: () => [workspace("ian-pascoe", "t3flare")] },
      github: () => ({ live: () => [token] }),
    } as unknown as EnvironmentServices);
    // A worktree outside /w/.wt is refused, naming the path asked for: here one with a line break and a token in it.
    const answer = await run("git", ["worktree", "add", "--", `/tmp/elsewhere\n${token}`, "main"], "/w/t3flare");
    expect(answer.exitCode).toBe(128);
    expect(answer.stderr.startsWith(T3FLARE_FATAL)).toBe(true);
    expect(answer.stderr).toMatch(/^[^\n]*\n$/);
    expect(answer.stderr).toContain("/tmp/elsewhere ***");
    expect(answer.stderr).not.toContain(token);
  });

  it("mask credentials in URLs, as the Container's git stderr can carry them", async () => {
    bindEnvironmentServices({
      workspaces: { list: () => [workspace("ian-pascoe", "t3flare")] },
      github: () => ({ live: () => [] }),
    } as unknown as EnvironmentServices);
    const answer = await run("git", ["worktree", "add", "--", "https://user:pass@host/o/r.git", "main"], "/w/t3flare");
    expect(answer.stderr.startsWith(T3FLARE_FATAL)).toBe(true);
    expect(answer.stderr).toContain("https://***@host/o/r.git");
    expect(answer.stderr).not.toContain("user:pass");
  });
});

/** The Environment's services for a clone into `/w/repo`, whose Workspace DO answers `clone` with `answer`. */
const bindClone = (answer: Record<string, unknown>, live: ReadonlyArray<string> = []) =>
  bindEnvironmentServices({
    workspaces: {
      list: () => [],
      get: () => undefined,
      create: () => undefined,
      remove: () => undefined,
      setState: () => undefined,
    },
    github: () => ({ live: () => live }),
    agents: { WORKSPACES: { idFromName: (name: string) => name, get: () => ({ clone: async () => answer }) } },
  } as unknown as EnvironmentServices);

const cloneArgs = ["clone", "https://github.com/ian-pascoe/repo.git", "repo"];

describe("a clone's stderr", () => {
  it("passes the Container's through with the router's marker neutralised and live tokens taken out", async () => {
    const token = "ghs_liveTokenForThisTest";
    bindClone({ ran: true, exitCode: 128, stderr: `${T3FLARE_FATAL}from a hook ${token}\nfatal: denied\n`, ms: 0 }, [
      token,
    ]);
    const answer = await run("git", cloneArgs, "/w");
    expect(answer.exitCode).toBe(128);
    expect(answer.stderr).toBe(` ${T3FLARE_FATAL}from a hook ***\nfatal: denied\n`);
  });

  it("is one masked router line when the clone did not run", async () => {
    bindClone({ ran: false, reason: "container_refused", detail: "t3flare: refused\nat https://user:pass@host/r.git" });
    const answer = await run("git", cloneArgs, "/w");
    expect(answer.exitCode).toBe(128);
    expect(answer.stderr).toBe(`${T3FLARE_FATAL}refused at https://***@host/r.git\n`);
  });
});

/** The calls each Workspace DO got, by its id, method and input. */
type Calls = Array<{ readonly id: string; readonly method: string; readonly input: unknown }>;

/**
 * The Environment's services with the project `t3flare` at `/w/t3flare` and `settings` stored, whose Workspace DOs
 * record each call and answer clone, worktree and fs calls as succeeding.
 */
const bindGitLimits = (calls: Calls, settings: Record<string, unknown>) => {
  const project = workspace("ian-pascoe", "t3flare");
  const stored = resolveEnvironment({ revision: 1, settings });
  const answers: Record<string, unknown> = {
    clone: { ran: true, exitCode: 0, stdout: "", stderr: "", ms: 0 },
    worktreeClone: { ok: true, tips: [] },
    worktreeBundle: { ok: true, commit: "c".repeat(40), bundle: null, config: [] },
    worktreeFinish: { ok: true, head: "c".repeat(40) },
    seedProjectRoot: { files: 0 },
    fs: { ok: null },
  };
  bindEnvironmentServices({
    workspaces: {
      list: () => [project],
      get: () => undefined,
      resolve: (id: string) => (id === "t3flare" ? project : undefined),
      create: () => undefined,
      createWorktree: () => undefined,
      remove: () => undefined,
      setState: () => undefined,
      setRemote: () => undefined,
    },
    github: () => ({ live: () => [] }),
    processes: { environmentEpoch: 7 },
    cloneMs: () => stored.cloneMinutes * 60_000,
    checkpointMs: () => stored.checkpointMinutes * 60_000,
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: (id: string) =>
          new Proxy(
            {},
            {
              get: (_, method: string) => async (input: unknown) => {
                calls.push({ id, method, input });
                return answers[method];
              },
            },
          ),
      },
    },
  } as unknown as EnvironmentServices);
};

/** The bound services, as the tests' stubs (`bindGitLimits`) made them. */
const bindingsOf = () =>
  environmentServices() as unknown as {
    agents: { WORKSPACES: { get: (id: string) => unknown } };
  };

const limitOf = (calls: Calls, method: string) =>
  (calls.find((call) => call.method === method)?.input as { timeoutMs?: number } | undefined)?.timeoutMs;

describe("the clone and checkpoint time limits (SPI-1324)", () => {
  it("a new Workspace's clone carries the stored cloneMinutes as timeoutMs", async () => {
    const calls: Calls = [];
    bindGitLimits(calls, { cloneMinutes: 60 });
    const answer = await run("git", cloneArgs, "/w");
    expect(answer.exitCode).toBe(0);
    expect(limitOf(calls, "clone")).toBe(3_600_000);
  });

  it("a worktree's clone and checkout carry cloneMinutes, its seed bundle checkpointMinutes", async () => {
    const calls: Calls = [];
    bindGitLimits(calls, { cloneMinutes: 60, checkpointMinutes: 3 });
    const answer = await run(
      "git",
      ["worktree", "add", "-b", "feature", "--", "/w/.wt/t3flare/x", "main"],
      "/w/t3flare",
    );
    expect(answer.exitCode).toBe(0);
    expect(limitOf(calls, "worktreeClone")).toBe(3_600_000);
    expect(limitOf(calls, "worktreeFinish")).toBe(3_600_000);
    expect(limitOf(calls, "worktreeBundle")).toBe(180_000);
  });

  it("carry the defaults, off (0: the Workspace DO's off deadline, SPI-1386), when nothing is stored", async () => {
    const calls: Calls = [];
    bindGitLimits(calls, {});
    await run("git", cloneArgs, "/w");
    await run("git", ["worktree", "add", "-b", "feature", "--", "/w/.wt/t3flare/x", "main"], "/w/t3flare");
    expect(limitOf(calls, "clone")).toBe(0);
    expect(limitOf(calls, "worktreeClone")).toBe(0);
    expect(limitOf(calls, "worktreeFinish")).toBe(0);
    expect(limitOf(calls, "worktreeBundle")).toBe(0);
  });
});

describe("a git command t3 gives up on (SPI-1364)", () => {
  /** The project's Workspace DO, whose `git` answers only when `answerGit` is called, or when its run is cancelled. */
  const bindSlowGit = (calls: Calls) => {
    let answerGit: (answer: unknown) => void = () => undefined;
    bindGitLimits(calls, {});
    const services = bindingsOf();
    const workspaces = services.agents.WORKSPACES;
    const get = workspaces.get;
    workspaces.get = (id: string) => {
      const inner = get(id) as Record<string, (input: unknown) => Promise<unknown>>;
      return new Proxy(inner, {
        get: (target, method: string) =>
          method === "git"
            ? (input: unknown) => {
                calls.push({ id, method, input });
                return new Promise((resolve) => (answerGit = resolve));
              }
            : method === "cancelRun"
              ? async (input: unknown) => {
                  calls.push({ id, method, input });
                  answerGit({ ran: true, exitCode: 143, stdout: "", stderr: "", ms: 0 });
                  return true;
                }
              : target[method],
      });
    };
    return { answer: (answer: unknown) => answerGit(answer) };
  };

  it("ends the Container's command by the run id its git carried, when t3's own timeout interrupts the spawn", async () => {
    const calls: Calls = [];
    bindSlowGit(calls);
    const timedOut = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* spawn(ChildProcess.make("git", ["push"], { cwd: "/w/t3flare" }) as ChildProcess.Command);
        return yield* handle.exitCode;
      }).pipe(Effect.scoped, Effect.timeoutOption("50 millis")),
    );
    expect(timedOut._tag).toBe("None");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const git = calls.find((call) => call.method === "git")?.input as
      | { runId?: string; environmentEpoch?: number }
      | undefined;
    expect(git?.runId).toMatch(/^[0-9a-f-]{36}$/);
    // SPI-1382: with the Environment's epoch, so a Workspace ends it once a restart left nothing to cancel it.
    expect(git?.environmentEpoch).toBe(7);
    expect(calls.filter((call) => call.method === "cancelRun").map((call) => call.input)).toEqual([git?.runId]);
  });

  it("cancels nothing once the command answered", async () => {
    const calls: Calls = [];
    const slow = bindSlowGit(calls);
    const done = run("git", ["push"], "/w/t3flare");
    await new Promise((resolve) => setTimeout(resolve, 20));
    slow.answer({ ran: true, exitCode: 0, stdout: "", stderr: "", ms: 0 });
    expect((await done).exitCode).toBe(0);
    expect(calls.some((call) => call.method === "cancelRun")).toBe(false);
  });
});
