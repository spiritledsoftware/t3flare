// The process router's gh answers, as t3's GitHub provider reads them: `gh auth status --json hosts` through the
// router's spawner, parsed by t3's own `parseGitHubAuth` (its Settings → Source Control discovery). And its refusals,
// which t3 shows and persists through Patch 0008 (SPI-1182): one line each, live tokens taken out.
import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import { parseGitHubAuth } from "../../../t3code/packages/source-control-github/src/server/GitHubSourceControlProvider.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
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
});
