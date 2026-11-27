// @effect-diagnostics globalConsole:off
// t3's `delegate_task` refuses a worktree delegation unless the project's clone holds the parent checkout's commit: it
// runs `resolveCommit` for that commit at the project root (`OrchestratorMcpService.ts`, "does not contain the parent
// checkout's commit"). In stock t3 a worktree shares the project's objects, so the commit is always there; here each
// Workspace is its own clone in its own Container, so a parent Workspace can be on a commit the project's clone never
// fetched (SPI-1454). This driver, given to t3's MCP services only, fetches such a commit into the project once and
// retries; on any failure the original error stands, so t3's refusal (which names `isolation: "shared"`) is unchanged.
import { GitCommandError } from "@t3tools/contracts";
import { isUnderW, normalize, W_ROOT, WORKTREES_SEGMENT } from "@t3flare/workspace-client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";

/**
 * Guards the base-commit fetch for `delegate_task`: long enough for a stopped project Container to start and fetch in
 * one call, so the first delegation needs no retry (t3's default git timeout, 30 s, is not). Owner-approved, SPI-1454.
 */
export const DELEGATE_BASE_FETCH_TIMEOUT_MS = 120_000;

/** t3's message for a git command that ran out of time (`GitVcsDriverCore.ts` `executeRaw`). */
const T3_TIMED_OUT = "Git command timed out.";

const FULL_COMMIT_ID = /^[0-9a-f]{40}$/;

/** A path in a project Workspace: under `/w`, outside the worktree Workspaces. */
const inProject = (cwd: string): boolean => {
  const path = normalize(cwd);
  const worktrees = `${W_ROOT}/${WORKTREES_SEGMENT}`;
  return isUnderW(path) && path !== W_ROOT && path !== worktrees && !path.startsWith(`${worktrees}/`);
};

const fetchedThen = (
  stock: GitVcsDriver.GitVcsDriver["Service"],
  input: GitVcsDriver.GitResolveCommitInput,
  missing: GitCommandError,
) =>
  Effect.gen(function* () {
    const remote = yield* stock.resolvePrimaryRemoteName(input.cwd);
    yield* stock.execute({
      operation: "t3flare.delegateBaseFetch",
      cwd: input.cwd,
      args: ["fetch", "--quiet", "--no-tags", "--", remote, input.revision],
      timeoutMs: DELEGATE_BASE_FETCH_TIMEOUT_MS,
    });
    return yield* stock.resolveCommit(input);
  }).pipe(
    Effect.catch((error: GitCommandError) => {
      // t3 shows the agent its own refusal in place of any error, so the limit names itself in the log.
      console.warn(
        JSON.stringify(
          error.detail === T3_TIMED_OUT
            ? {
                t3flare: "delegate-base-fetch-timeout",
                limit: "DELEGATE_BASE_FETCH_TIMEOUT_MS",
                ms: DELEGATE_BASE_FETCH_TIMEOUT_MS,
                cwd: input.cwd,
                commit: input.revision,
              }
            : { t3flare: "delegate-base-fetch-failed", cwd: input.cwd, commit: input.revision, detail: error.detail },
        ),
      );
      return Effect.fail(missing);
    }),
  );

/** `stock`, whose `resolveCommit` fetches a full commit id a project's clone lacks, once, before it fails. */
export const withBaseFetch = (stock: GitVcsDriver.GitVcsDriver["Service"]): GitVcsDriver.GitVcsDriver["Service"] => ({
  ...stock,
  resolveCommit: (input) =>
    stock
      .resolveCommit(input)
      .pipe(
        Effect.catch((missing: GitCommandError) =>
          FULL_COMMIT_ID.test(input.revision) && inProject(input.cwd)
            ? fetchedThen(stock, input, missing)
            : Effect.fail(missing),
        ),
      ),
});

/** t3's git driver with the base-commit fetch, for `McpHttpServer.layer` (composition). */
export const layerDelegateBaseFetch = Layer.effect(
  GitVcsDriver.GitVcsDriver,
  Effect.gen(function* () {
    return withBaseFetch(yield* GitVcsDriver.GitVcsDriver);
  }),
).pipe(Layer.provide(GitVcsDriver.layer));
