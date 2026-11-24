// @effect-diagnostics globalDate:off
// M0's exit check (step 2a plan, section 7): `POST /_t3flare/check/agents`. Calls into the agents Worker and back,
// starts Containers in two Workspaces, checks the paths, the Container budget, and a GitHub token's scope. Never boots t3.
// `?repo=<owner/name>&other=<owner/name>`, both required: the repo a Container token is minted for, and one outside it.
import { CONTAINER_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import { applyEnvironmentChange, resolveEnvironment } from "@t3flare/harness-registry";

import { byName } from "../agents/rpc.ts";
import type { EnvironmentDO } from "../environmentDO.ts";
import { harnessStore } from "../harness/store.ts";

/**
 * The Container budget the check tests: three slots held by others, so a fourth start is refused. The Environment has no
 * budget by default (SPI-1386), so the check sets this one for its run and then sets back the Owner's.
 */
const CHECK_BUDGET = 3;

/** Sets the Environment's Container budget to `budget` as a change of its own (the revision moves forward), or throws. */
const setBudget = (environment: EnvironmentDO, budget: number): void => {
  const store = harnessStore(environment.ctxStorage.kv);
  const applied = applyEnvironmentChange(store.loadEnvironment(), { settings: { containerBudget: budget } });
  if (!applied.ok) throw new Error(`the check could not set the Container budget: ${applied.error}`);
  store.saveEnvironment(applied.environment);
};

const pathsScript = (workspaceId: string) => `
set -u
echo "git: $(git --version)"
echo "mise: $(mise ls --current 2>/dev/null | tr -s ' ' | tr '\\n' ';')"
mkdir -p /workspace/repo /w
echo "from the container" > /workspace/repo/from-container.txt
target=/w/${workspaceId}
if mkdir -p "$target" && mount --bind /workspace/repo "$target" 2>/dev/null; then echo "link: bind"; else rmdir "$target" 2>/dev/null; ln -sfn /workspace/repo "$target" && echo "link: symlink"; fi
cd /workspace/repo && git init -q 2>/dev/null
cd "$target" && echo "pwd -P: $(pwd -P)" && echo "toplevel: $(git rev-parse --show-toplevel)"
echo "agent file: $(cat /workspace/repo/from-do.txt 2>/dev/null || echo missing)"
`;

const lsRemote = (repo: string, token: string) =>
  `git -c credential.helper= ls-remote https://x-access-token:${token}@github.com/${repo}.git HEAD >/dev/null 2>&1 && echo ok || echo refused`;

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The check's two repositories from its query, or the reason it is refused (400). No default: they are the Owner's. */
export const agentsCheckRepos = (
  url: URL,
): { readonly repo: string; readonly other: string } | { readonly error: string } => {
  const repo = url.searchParams.get("repo") ?? "";
  const other = url.searchParams.get("other") ?? "";
  if (!REPO.test(repo) || !REPO.test(other))
    return {
      error:
        "repo and other are required query parameters, each owner/name: the repo a Container token is minted for, and one outside it",
    };
  return { repo, other };
};

export const agentsCheck = async (
  environment: EnvironmentDO,
  request: Request,
  repos: { readonly repo: string; readonly other: string },
) => {
  const url = new URL(request.url);
  const agents = environment.agents;
  const report: Record<string, unknown> = { at: new Date().toISOString() };

  // 1. Both directions of the cross-Worker binding.
  report.sessionRoundTrip = await byName(agents.SESSIONS, "thread:m0-check", "SESSIONS").ping("m0");

  // 2. Containers in two Workspaces: start, tools, paths (agent writes on the DO side first).
  const workspaces = ["m0-a", "m0-b"];
  const containers: Record<string, unknown> = {};
  for (const id of workspaces) {
    const workspace = byName(agents.WORKSPACES, id, "WORKSPACES");
    await workspace.writeText("/workspace/repo/from-do.txt", `written by the agent in ${id}`);
    const started = Date.now();
    const result = await workspace.exec({ script: pathsScript(id), timeoutMs: 180_000 });
    containers[id] = {
      exitCode: result.exitCode,
      wallMs: Date.now() - started,
      execMs: result.ms,
      stdout: result.stdout.trim().split("\n"),
      stderr: result.stderr.trim().slice(-2000),
      // A file the Container wrote is read from the Workspace's own files.
      readFromDo: await workspace.readText("/workspace/repo/from-container.txt"),
      state: await workspace.containerState(),
    };
  }
  report.containers = containers;

  // 3. The budget: at a budget of three (`CHECK_BUDGET`, set for the check), with three slots held by others, a fourth
  // start is refused. The Owner's budget is set back afterwards, whatever the check found.
  if (url.searchParams.get("budget") !== "0") {
    const budget = byName(agents.CONTAINER_BUDGET, "budget", "CONTAINER_BUDGET");
    const held = ["m0-fake-1", "m0-fake-2", "m0-fake-3"];
    for (const id of workspaces) await byName(agents.WORKSPACES, id, "WORKSPACES").stopContainer();
    const owners = resolveEnvironment(harnessStore(environment.ctxStorage.kv).loadEnvironment()).containerBudget;
    setBudget(environment, CHECK_BUDGET);
    const acquired = [];
    let refused: { readonly refused: boolean; readonly ran?: unknown; readonly error?: string };
    let stateWhileFull: unknown;
    try {
      for (const holder of held) acquired.push(await budget.acquire(holder, CHECK_BUDGET));
      refused = await byName(agents.WORKSPACES, "m0-c", "WORKSPACES")
        .exec({ script: "echo should-not-run", timeoutMs: 60_000 })
        .then(
          (ran) => ({ refused: false, ran }),
          (error: unknown) => ({ refused: true, error: String(error).slice(0, 500) }),
        );
      stateWhileFull = await budget.state();
    } finally {
      for (const holder of held) await budget.release(holder);
      setBudget(environment, owners);
    }
    report.budget = {
      budget: CHECK_BUDGET,
      acquired: acquired.map((a) => a.ok),
      fourthStart: refused,
      stateWhileFull,
      after: await budget.state(),
    };
  }

  // 4. A Container token names its one repo.
  const { repo, other } = repos;
  if (environment.github.configured) {
    const [owner = "", name = ""] = repo.split("/");
    const minted = await environment.github.mint({
      owner,
      repositories: [name],
      permissions: CONTAINER_GITHUB_PERMISSIONS,
    });
    const workspace = byName(agents.WORKSPACES, "m0-a", "WORKSPACES");
    const result = await workspace.exec({
      script: `echo "own: $(${lsRemote(repo, "$T")})"; echo "other: $(${lsRemote(other, "$T")})"`,
      env: { T: minted.token },
      timeoutMs: 180_000,
    });
    report.githubToken = {
      repo,
      other,
      expiresInMinutes: Math.round((minted.expiresAt - Date.now()) / 60_000),
      stdout: result.stdout.trim().split("\n"),
      exitCode: result.exitCode,
    };
  } else {
    report.githubToken = "not configured";
  }

  for (const id of [...workspaces, "m0-c"]) await byName(agents.WORKSPACES, id, "WORKSPACES").stopContainer();
  report.stopped = true;
  return report;
};
