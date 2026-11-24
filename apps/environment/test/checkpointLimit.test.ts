// The checkpoint time limit (SPI-1324): each of t3's checkpoint operations on a `/w` path reaches the Workspace DO with
// the `checkpointMinutes` stored now, as `timeoutMs`, through the registry Layer (`layerVcsDriverRegistry`).
import { resolveEnvironment } from "@t3flare/harness-registry";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as VcsDriverRegistry from "t3/src/vcs/VcsDriverRegistry.ts";
import { describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { layerVcsDriverRegistry } from "../src/workspace/checkpoints.ts";

/** The services for a project at `/w/repo`, whose Workspace DO records each `checkpoint` call. */
const bind = (calls: Array<{ op: string; options: unknown }>, settings?: Record<string, unknown>) =>
  bindEnvironmentServices({
    workspaces: { resolve: (id: string) => (id === "repo" ? { id, kind: "project" } : undefined) },
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: () => ({
          checkpoint: async (op: { op: string }, options: unknown) => {
            calls.push({ op: op.op, options });
            return { ok: true, value: op.op === "has" ? true : null, by: "do" };
          },
        }),
      },
    },
    ...(settings === undefined
      ? {}
      : { checkpointMs: () => resolveEnvironment({ revision: 1, settings }).checkpointMinutes * 60_000 }),
  } as unknown as EnvironmentServices);

/** The wrapped registry's checkpoint operations for `/w/repo`, over a stock driver that must never be reached. */
const checkpoints = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      return (yield* registry.get("git" as never)).checkpoints;
    }).pipe(
      Effect.provide(
        layerVcsDriverRegistry(
          Layer.succeed(
            VcsDriverRegistry.VcsDriverRegistry,
            VcsDriverRegistry.VcsDriverRegistry.of({
              get: () => Effect.succeed({ checkpoints: {} } as never),
            } as never),
          ),
        ),
      ),
    ),
  );

describe("the checkpoint time limit (SPI-1324)", () => {
  it("rides each checkpoint operation as the stored checkpointMinutes in ms", async () => {
    const calls: Array<{ op: string; options: unknown }> = [];
    bind(calls, { checkpointMinutes: 3 });
    const ops = await checkpoints();
    await Effect.runPromise(ops.captureCheckpoint({ cwd: "/w/repo", checkpointRef: "refs/t3/a" } as never));
    await Effect.runPromise(
      ops.restoreCheckpoint({ cwd: "/w/repo", checkpointRef: "refs/t3/a", fallbackToHead: false } as never),
    );
    await Effect.runPromise(ops.hasCheckpointRef({ cwd: "/w/repo", checkpointRef: "refs/t3/a" } as never));
    expect(calls).toEqual([
      { op: "capture", options: { timeoutMs: 180_000 } },
      { op: "restore", options: { timeoutMs: 180_000 } },
      { op: "has", options: { timeoutMs: 180_000 } },
    ]);
  });

  it("carries the default, off (0: the Workspace DO's off deadline, SPI-1386), when the services hold no setting", async () => {
    const calls: Array<{ op: string; options: unknown }> = [];
    bind(calls);
    const ops = await checkpoints();
    await Effect.runPromise(ops.captureCheckpoint({ cwd: "/w/repo", checkpointRef: "refs/t3/a" } as never));
    expect(calls).toEqual([{ op: "capture", options: { timeoutMs: 0 } }]);
  });
});
