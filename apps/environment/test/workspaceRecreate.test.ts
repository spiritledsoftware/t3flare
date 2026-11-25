// @effect-diagnostics effectFnOpportunity:off
// SPI-1436: a new project folder at a name whose Workspace was purged before. t3's real ProjectService.create, as
// ws.ts's projectCloneStart calls it (createWorkspaceRootIfMissing), through t3's real WorkspacePaths over the routing
// FileSystem and the real Workspace registry (Node SQLite). The Workspace DOs are a fake that refuses `fs` once
// destroyed, as WorkspaceDO's `#alive()` does; its `makeEmpty` provisions, as the real one does (the workerd test in
// apps/agents runs the real one).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, OrchestrationDispatchCommandError, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { REPO_ROOT } from "@t3flare/workspace-client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "t3/src/config.ts";
import * as RuntimeLayer from "t3/src/orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "t3/src/persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "t3/src/project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "t3/src/project/ProjectFaviconResolver.ts";
import * as ProjectService from "t3/src/project/ProjectService.ts";
import * as RepositoryIdentityResolver from "t3/src/project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as WorkspacePaths from "t3/src/workspace/WorkspacePaths.ts";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { workspaceRegistry, type WorkspaceState } from "../src/agents/workspaces.ts";
import { routing } from "../src/platform/routingFileSystem.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

type FsOp = { readonly op: string; readonly path: string };

/**
 * Workspace DOs whose files are a set of directories each. `destroyed` names the ones a purge `destroy()`ed: their `fs`
 * throws until `makeEmpty` provisions them again. `destroy()` restarts the object, as WorkspaceDO's does: the next
 * `restartFailures` calls (1 by default) fail with its abort reason. `calls` is every RPC, in order, as
 * `<id>.<method>[:<op>]`.
 */
const fakeWorkspaceDOs = (
  options: { destroyed?: Iterable<string>; refuseMakeEmpty?: string; restartFailures?: number } = {},
) => {
  const destroyed = new Set(options.destroyed);
  const restarting = new Map<string, number>();
  const restarted = (id: string) => {
    const left = restarting.get(id) ?? 0;
    if (left === 0) return;
    restarting.set(id, left - 1);
    throw new Error("t3flare: workspace destroyed");
  };
  const dirs = new Map<string, Set<string>>();
  const calls: Array<string> = [];
  const dirsOf = (id: string) => dirs.get(id) ?? dirs.set(id, new Set()).get(id)!;
  const stub = (id: string) => ({
    fs: async (op: FsOp) => {
      calls.push(`${id}.fs:${op.op}`);
      restarted(id);
      if (destroyed.has(id)) throw new Error("t3flare: this Workspace was deleted");
      if (op.op === "mkdir") return (dirsOf(id).add(op.path), { ok: null });
      if (op.op === "stat")
        return dirsOf(id).has(op.path)
          ? { ok: { kind: "directory", size: 0, mtimeMs: 0, mode: 0o755 } }
          : { error: "ENOENT", message: `ENOENT: ${op.path}` };
      if (op.op === "readdir") return { ok: [] };
      if (op.op === "realPath") return { ok: op.path };
      return { error: "ENOENT", message: `ENOENT: ${op.path}` };
    },
    makeEmpty: async (input: { id: string }) => {
      calls.push(`${id}.makeEmpty`);
      restarted(id);
      expect(input.id).toBe(id);
      if (options.refuseMakeEmpty === id) return { error: "EIO", message: "EIO: the disk said no" };
      destroyed.delete(id);
      dirsOf(id).add(REPO_ROOT);
      return { ok: null };
    },
    destroy: async () => {
      calls.push(`${id}.destroy`);
      destroyed.add(id);
      dirs.delete(id);
      restarting.set(id, options.restartFailures ?? 1);
      return { destroyed: true };
    },
  });
  return { calls, WORKSPACES: { idFromName: (name: string) => name, get: stub } };
};

/** t3's tables the purge reads its references from (deletion.ts `referencesFrom`), empty. */
const t3Tables = () => {
  const sql = nodeSqlStorage();
  sql.exec(
    "CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, deleted_at TEXT, archived_at TEXT)",
  );
  sql.exec(
    "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, deleted_at TEXT, archived_at TEXT, payload_json TEXT)",
  );
  sql.exec("CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)");
  return sql;
};

/** The registry with `t3flare` left in `state` (or absent), bound as the Environment DO binds it. */
const bind = (state: WorkspaceState | null, dos: ReturnType<typeof fakeWorkspaceDOs>) => {
  const sql = t3Tables();
  const workspaces = workspaceRegistry(nodeSqlStorage());
  if (state !== null) {
    workspaces.create({ id: "t3flare", host: "github.com", owner: "o", name: "t3flare" });
    workspaces.setState("t3flare", state);
  }
  bindEnvironmentServices({ workspaces, sql, agents: dos } as unknown as EnvironmentServices);
  return workspaces;
};

const routingFs = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(Effect.service(FileSystem.FileSystem), (local) =>
    FileSystem.make(routing(local as unknown as Parameters<typeof routing>[0])),
  ),
).pipe(Layer.provide(NodeServices.layer));

const metadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  } as never),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    invalidate: () => Effect.void,
    resolvePath: () => Effect.succeed(null),
  }),
);

const layer = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(metadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-recreate-" })),
  Layer.provideMerge(routingFs),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, "/w")),
);

/** ws.ts's projectCloneStart in shape: create with createWorkspaceRootIfMissing, every non-conflict error hidden. */
const createCloneProject = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const projectService = yield* ProjectService.ProjectService;
    const projectId = ProjectId.make("p-clone");
    return yield* projectService
      .create({
        commandId: CommandId.make(`project-clone-create:${projectId}`),
        projectId,
        title: "t3flare",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          cause._tag === "ProjectConflictError"
            ? cause
            : new OrchestrationDispatchCommandError({ message: "Failed to create clone project.", cause }),
        ),
      );
  }).pipe(Effect.scoped, Effect.provide(layer));

/** The error's message and each cause's, innermost last. */
const chain = (error: unknown): Array<string> => {
  const out: Array<string> = [];
  for (let at = error as { cause?: unknown; message?: string } | undefined; at; at = at.cause as typeof at)
    out.push(at.message ?? "");
  return out;
};

const attempt = async (workspaceRoot: string) => {
  const exit = await Effect.runPromiseExit(createCloneProject(workspaceRoot));
  return Exit.isSuccess(exit) ? { ok: true as const } : { ok: false as const, chain: chain(Cause.squash(exit.cause)) };
};

let warn: MockInstance<typeof console.warn>;
let log: MockInstance<typeof console.log>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** The JSON log lines `kind` named. */
const logged = (spy: MockInstance<(...args: Array<unknown>) => void>, kind: string) =>
  spy.mock.calls
    .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
    .filter((line) => line?.t3flare === kind);

describe("a new project folder at a purged Workspace's name (SPI-1436)", () => {
  it("is made when the purge destroyed its Workspace DO and left no row: by makeEmpty, never fs", async () => {
    const dos = fakeWorkspaceDOs({ destroyed: ["t3flare"] });
    const registry = bind(null, dos);
    expect(await attempt("~/t3flare")).toEqual({ ok: true });
    expect(registry.get("t3flare")?.state).toBe("ready");
    expect(dos.calls).toContain("t3flare.makeEmpty");
    expect(dos.calls).not.toContain("t3flare.fs:mkdir");
    expect(logged(warn, "workspace-create-failed")).toEqual([]);
  });

  it("is made at a name never used", async () => {
    const dos = fakeWorkspaceDOs();
    const registry = bind(null, dos);
    expect(await attempt("~/t3flare")).toEqual({ ok: true });
    expect(registry.get("t3flare")?.state).toBe("ready");
  });

  it("finishes a purge left `deleting` before it makes the folder, riding out the object's restart", async () => {
    const dos = fakeWorkspaceDOs();
    const registry = bind("deleting", dos);
    expect(await attempt("~/t3flare")).toEqual({ ok: true });
    const destroyAt = dos.calls.indexOf("t3flare.destroy");
    expect(destroyAt).toBeGreaterThanOrEqual(0);
    // The first makeEmpty lands on the restarting object and fails; it is sent again.
    expect(dos.calls.slice(destroyAt + 1, destroyAt + 3)).toEqual(["t3flare.makeEmpty", "t3flare.makeEmpty"]);
    expect(logged(log, "workspace-purged")).toEqual([{ t3flare: "workspace-purged", id: "t3flare", sessions: 0 }]);
    // A new row: the old one's repository is gone with it.
    expect(registry.get("t3flare")).toMatchObject({ state: "ready", host: null });
  });

  it("gives up on an object that keeps restarting, logs it, and leaves no row", async () => {
    const dos = fakeWorkspaceDOs({ restartFailures: 100 });
    const registry = bind("deleting", dos);
    expect((await attempt("~/t3flare")).ok).toBe(false);
    expect(dos.calls.filter((call) => call === "t3flare.makeEmpty")).toHaveLength(6);
    expect(registry.get("t3flare")).toBeUndefined();
    expect(logged(warn, "workspace-create-failed")).toEqual([
      { t3flare: "workspace-create-failed", id: "t3flare", reason: expect.stringContaining("workspace destroyed") },
    ]);
  });

  it("logs a purge that throws instead of losing the line", async () => {
    const dos = fakeWorkspaceDOs();
    const registry = bind("deleting", dos);
    bindEnvironmentServices({
      workspaces: registry,
      sql: {
        exec: () => {
          throw new Error("no such table");
        },
      },
      agents: dos,
    } as unknown as EnvironmentServices);
    expect((await attempt("~/t3flare")).ok).toBe(false);
    expect(logged(warn, "workspace-create-failed")).toEqual([
      { t3flare: "workspace-create-failed", id: "t3flare", reason: expect.stringContaining("purge failed") },
    ]);
  });

  it("provisions for a create of the same name still under way (its row `provisioning`)", async () => {
    const dos = fakeWorkspaceDOs({ destroyed: ["t3flare"] });
    const registry = bind(null, dos);
    registry.create({ id: "t3flare" });
    const exit = await Effect.runPromiseExit(
      routing({} as Parameters<typeof routing>[0]).makeDirectory("/w/t3flare", { recursive: true }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(dos.calls).toEqual(["t3flare.makeEmpty"]);
  });

  it("replaces a `failed` row", async () => {
    const dos = fakeWorkspaceDOs();
    const registry = bind("failed", dos);
    expect(await attempt("~/t3flare")).toEqual({ ok: true });
    expect(registry.get("t3flare")).toMatchObject({ state: "ready", host: null });
    expect(dos.calls).not.toContain("t3flare.destroy");
  });

  it("refuses a Tombstone with a reason naming it, keeps it, and logs the reason", async () => {
    const dos = fakeWorkspaceDOs();
    const registry = bind("tombstoned", dos);
    const result = await attempt("~/t3flare");
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.chain.join("\n")).toContain("the Workspace t3flare is a Tombstone");
    expect(registry.get("t3flare")?.state).toBe("tombstoned");
    expect(dos.calls).toEqual([]);
    expect(logged(warn, "workspace-create-failed")).toEqual([
      { t3flare: "workspace-create-failed", id: "t3flare", reason: expect.stringContaining("is a Tombstone") },
    ]);
  });

  it("logs one line with the Workspace and the reason when the folder cannot be made, and leaves no row", async () => {
    const dos = fakeWorkspaceDOs({ refuseMakeEmpty: "t3flare" });
    const registry = bind(null, dos);
    expect((await attempt("~/t3flare")).ok).toBe(false);
    expect(registry.get("t3flare")).toBeUndefined();
    expect(logged(warn, "workspace-create-failed")).toEqual([
      { t3flare: "workspace-create-failed", id: "t3flare", reason: expect.stringContaining("EIO: the disk said no") },
    ]);
  });
});
