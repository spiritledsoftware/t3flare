// The Turn limit on a CLI agent (SPI-1315, ADR-0015): the wrapper reads the Environment's `turnLimitMinutes` at each
// turn's start, and a turn longer than the limit it started with ends its process. A setting changed while the turn
// runs reaches only the thread's next turn.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindEnvironmentServices,
  type EnvironmentServices,
  parkAfterMsNow,
  turnLimitMsNow,
} from "../src/agents/bindings.ts";
import type { ChannelProcess } from "../src/agents/processChannel.ts";
import { type CliSessions, wrapCliAdapter } from "../src/provider/cli/wrapper.ts";

const innerAdapter = {
  instanceId: "codex",
  driver: "codex",
  getCapabilities: () => Effect.succeed({ sessions: {}, tools: {} }),
  planSelectionTransition: () => Effect.die("unused"),
  openSession: () =>
    Effect.succeed({
      providerSession: { capabilities: { sessions: {}, tools: {} } },
      events: Stream.empty,
      startTurn: () => Effect.void,
      respondToRuntimeRequest: () => Effect.void,
      forkThread: () => Effect.die("unused"),
      rollbackThread: () => Effect.die("unused"),
    }),
} as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null };
const turnInput = {
  threadId: "t1",
  runId: "r1",
  rootNodeId: "n1",
  providerThread: { id: "pt1" },
  providerTurnOrdinal: 1,
  runtimePolicy: policy,
  message: { messageId: "message-1", text: "hello" },
} as never;

/** Opens a wrapped session with a fake process, starts one turn, then sets the limit to `after` and waits `waitMs`. */
const turnUnder = async (limit: { at: number }, after: number, waitMs: number): Promise<number> => {
  const sessions: CliSessions = new Map();
  let kills = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* wrapCliAdapter(innerAdapter, {
        sessions,
        takeEnvironmentSkills: () => Effect.void,
        turnLimitMs: () => limit.at,
      }).openSession({
        threadId: "t1",
        providerSessionId: "s1",
        runtimePolicy: policy,
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
      } as never);
      sessions.get("s1")!.process = {
        key: "proc-1",
        turn: () => undefined,
        kill: () => void kills++,
      } as unknown as ChannelProcess;
      yield* runtime.startTurn(turnInput);
      limit.at = after;
      yield* Effect.sleep(`${waitMs} millis`);
    }).pipe(Effect.scoped),
  );
  return kills;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a CLI agent's Turn limit", () => {
  it("off (0, the default since SPI-1386), starts no timer: a 0 ms sleep would end the process at once, and none does", async () => {
    expect(await turnUnder({ at: 0 }, 0, 150)).toBe(0);
    // Raised to 30 ms while the turn runs: the turn keeps the off it started with, so no timer fires for it.
    expect(await turnUnder({ at: 0 }, 30, 150)).toBe(0);
  });

  it("ends the turn's process at the limit read at the turn's start, though the setting is raised mid-turn", async () => {
    expect(await turnUnder({ at: 30 }, 60 * 60_000, 150)).toBe(1);
  });

  it("does not end a running turn when the setting is lowered mid-turn: only the thread's next turn takes it", async () => {
    expect(await turnUnder({ at: 60 * 60_000 }, 10, 150)).toBe(0);
  });
});

describe("turnLimitMsNow", () => {
  afterEach(() => bindEnvironmentServices(undefined as unknown as EnvironmentServices));

  it("reads the Environment's Turn limit, and the default (off, 0: SPI-1386) without services or a reader", () => {
    bindEnvironmentServices({ turnLimitMs: () => 5 * 60_000 } as unknown as EnvironmentServices);
    expect(turnLimitMsNow()).toBe(5 * 60_000);
    bindEnvironmentServices({} as unknown as EnvironmentServices);
    expect(turnLimitMsNow()).toBe(0);
    bindEnvironmentServices(undefined as unknown as EnvironmentServices);
    expect(turnLimitMsNow()).toBe(0);
  });
});

describe("parkAfterMsNow (SPI-1389)", () => {
  afterEach(() => bindEnvironmentServices(undefined as unknown as EnvironmentServices));

  it("reads the Environment's Park after, 0 when off, and the default (10 minutes) without services or a readable store", () => {
    bindEnvironmentServices({ parkAfterMs: () => 60_000 } as unknown as EnvironmentServices);
    expect(parkAfterMsNow()).toBe(60_000);
    bindEnvironmentServices({ parkAfterMs: () => 0 } as unknown as EnvironmentServices);
    expect(parkAfterMsNow()).toBe(0);
    bindEnvironmentServices({
      parkAfterMs: () => {
        throw new Error("storage reset");
      },
    } as unknown as EnvironmentServices);
    expect(parkAfterMsNow()).toBe(600_000);
    bindEnvironmentServices({} as unknown as EnvironmentServices);
    expect(parkAfterMsNow()).toBe(600_000);
    bindEnvironmentServices(undefined as unknown as EnvironmentServices);
    expect(parkAfterMsNow()).toBe(600_000);
  });
});
