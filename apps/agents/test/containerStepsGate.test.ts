// @effect-diagnostics globalTimers:off
// "mise install runs before the first command of each Container start" (SPI-1150, ADR-0032): every command sent to the
// Container that is not a passive read waits for the lay-down, at the point it is sent (`ContainerStepsBackend`), whoever
// sends it: a Durable agent's command comes through computer, never `WorkspaceDO.exec`. Passive reads never run it.
// Terminals and CLI processes wait before their spawn (`readyForSpawn`).
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { ContainerRefused, ContainerSteps, MAX_ATTEMPTS, sequenced, type SequencedStep, type StepState } from "../src/workspace/containerStep.ts";
import { commandEnvOf, COMPUTER_RUNTIME_KEY, ContainerStepsBackend, PASSIVE_MARKER, readyForSpawn, spawnRuntime } from "../src/workspace/containerStepsGate.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A Container backend whose connect answers runtime `r1`, recording each command as it is sent. */
const container = (sent: Array<string>): WorkspaceBackend =>
  ({
    id: "container-shell",
    type: "cloudflare-container",
    connect: async () =>
      ({
        runtimeId: "r1",
        rpc: {
          sync: {},
          shell: {
            exec: async (input: { source: string; env?: Record<string, string> }) => {
              sent.push(`${input.source}${input.env?.[PASSIVE_MARKER] === undefined ? "" : " (marker kept!)"}`);
              return {} as never;
            },
            getExec: async () => ({}) as never,
            killExec: async () => undefined,
            disposeExec: async () => undefined,
          },
        },
        close: async () => undefined,
      }) as unknown as BackendHandle,
  }) as WorkspaceBackend;

/** A lay-down that ends when `release` is called; records what it was asked for. */
const layDown = () => {
  const asked: Array<string | undefined> = [];
  let release: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { asked, release: () => release(), ensure: (runtime: string | undefined) => {
      asked.push(runtime);
      return done;
    } };
};

const passive = (source: string) => ({ source, env: { [PASSIVE_MARKER]: "1", A: "x" } }) as never;
const active = (source: string) => ({ source, env: { T3FLARE_EXEC: "exec-1" } }) as never;

describe("ContainerStepsBackend", () => {
  it("a Durable agent's command arriving while a passive read holds the connect waits for the lay-down; the read does not", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const handle = await new ContainerStepsBackend(container(sent), gate.ensure).connect({} as never);
    // A status poll (passive, marked by WorkspaceDO.exec) is in flight on the shared connect.
    await handle.rpc.shell.exec(passive("git status"));
    expect(sent).toEqual(["git status"]);
    expect(gate.asked).toEqual([]);
    // The agent's command (unmarked, through computer's stub) on the same handle.
    const agent = handle.rpc.shell.exec(active("node --version"));
    await tick();
    expect(gate.asked).toEqual(["r1"]);
    expect(sent).toEqual(["git status"]);
    gate.release();
    await agent;
    expect(sent).toEqual(["git status", "node --version"]);
  });

  it("a Container a passive read started still lays down before the first active command", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const backend = new ContainerStepsBackend(container(sent), gate.ensure);
    // The passive read's connect starts the Container and its command runs without the lay-down.
    const first = await backend.connect({} as never);
    await first.rpc.shell.exec(passive("git rev-parse HEAD"));
    expect(gate.asked).toEqual([]);
    gate.release();
    await first.rpc.shell.exec(active("bash -c 'node --version'"));
    expect(gate.asked).toEqual(["r1"]);
    expect(sent).toEqual(["git rev-parse HEAD", "bash -c 'node --version'"]);
  });

  it("a Terminal's start on a stopped Container, with a passive read in flight, waits for the lay-down before its spawn", async () => {
    const sent: Array<string> = [];
    const gate = layDown();
    const handle = await new ContainerStepsBackend(container(sent), gate.ensure).connect({} as never);
    const read = handle.rpc.shell.exec(passive("git status"));
    // The Terminal host starts the Container with an active `true`, then spawns once it is ready.
    const events: Array<string> = [];
    const start = handle.rpc.shell.exec(active("true")).then(() => events.push("started"));
    const spawn = start.then(() => readyForSpawn({ running: () => true, runtime: async () => "r1", ensure: gate.ensure, log: () => undefined, refuses: () => false })).then(() => events.push("spawned"));
    await read;
    await tick();
    expect(events).toEqual([]);
    gate.release();
    await spawn;
    expect(events).toEqual(["started", "spawned"]);
    expect(sent).toEqual(["git status", "true"]);
  });
});

describe("ContainerStepsBackend's refusal", () => {
  it("refuses an active command, never sent, when its Container's steps refuse it; a passive read still runs", async () => {
    const sent: Array<string> = [];
    const handle = await new ContainerStepsBackend(container(sent), async () => Promise.reject(new ContainerRefused("Refused: setup failed"))).connect({} as never);
    await expect(handle.rpc.shell.exec(active("npm test"))).rejects.toThrow("Refused: setup failed");
    await handle.rpc.shell.exec(passive("git status"));
    expect(sent).toEqual(["git status"]);
  });

  it("sends the command when the steps fail any other way", async () => {
    const sent: Array<string> = [];
    const handle = await new ContainerStepsBackend(container(sent), async () => Promise.reject(new Error("exec"))).connect({} as never);
    await handle.rpc.shell.exec(active("npm test"));
    expect(sent).toEqual(["npm test"]);
  });
});

describe("ContainerSteps", () => {
  /** A step on a script of ends: each `ensure` resolves when its test says, with the state given. */
  const step = (name: string, events: Array<string>, outcome = "ok", options: { due?: boolean; fails?: boolean; attempts?: number } = {}) => {
    let running = false;
    let released = false;
    let release: () => void = () => undefined;
    const ensure = async (runtime: string | undefined) => {
      events.push(`${name} ${String(runtime)}`);
      running = true;
      // Once released, a step driven again ends at once.
      if (!released) await new Promise<void>((resolve) => (release = resolve));
      running = false;
      events.push(`${name} done`);
      if (options.fails === true) throw new Error(`${name} broke`);
      return { runtime: runtime ?? "", outcome, attempts: options.attempts ?? 1, at: 0 };
    };
    return {
      step: { ensure, due: () => options.due ?? false, inFlight: () => running },
      release: () => {
        released = true;
        release();
      },
    };
  };
  const steps = (...entries: ReadonlyArray<SequencedStep<StepState>>) => new ContainerSteps(entries.map(sequenced));

  it("runs each step after the one before has ended", async () => {
    const events: Array<string> = [];
    const mise = step("mise", events, "laid");
    const setup = step("setup", events);
    const ready = steps({ step: mise.step, doing: "installing the Global mise config" }, { step: setup.step, doing: "running the Container setup" });
    const done = ready.ensure("r1");
    await tick();
    expect(events).toEqual(["mise r1"]);
    expect(ready.doing()).toBe("installing the Global mise config");
    mise.release();
    await tick();
    expect(events).toEqual(["mise r1", "mise done", "setup r1"]);
    expect(ready.doing()).toBe("running the Container setup");
    setup.release();
    await done;
    expect(ready.doing()).toBeUndefined();
  });

  it("holds the second step behind a first that broke (not final), and lets the command go on when nothing refuses", async () => {
    const events: Array<string> = [];
    const mise = step("mise", events, "laid", { fails: true });
    const done = steps({ step: mise.step, doing: "a" }, { step: step("setup", events).step, doing: "b" }).ensure("r1");
    await tick();
    mise.release();
    await expect(done).resolves.toBeUndefined();
    // Driven MAX_ATTEMPTS times by this command, never final, so the setup is not run.
    expect(events.filter((event) => event.startsWith("setup"))).toEqual([]);
    expect(events.filter((event) => event === "mise done")).toHaveLength(MAX_ATTEMPTS);
  });

  it("rejects with ContainerRefused when a step's outcome refuses the Container", async () => {
    const events: Array<string> = [];
    const setup = step("setup", events, "failed");
    const ready = steps({ step: setup.step, doing: "running the Container setup", refusal: (state) => (state?.outcome === "failed" ? "Refused: setup failed" : undefined) });
    const done = ready.ensure("r1");
    await tick();
    setup.release();
    await expect(done).rejects.toBeInstanceOf(ContainerRefused);
  });

  /** A refusal as the Container setup's under refuse: any outcome but ok, and a setup not judged at all. */
  const refusing = (state: StepState | undefined) => (state === undefined ? "Refused: not judged" : state.outcome === "ok" ? undefined : `Refused: ${state.outcome}`);

  it("drives the first step's remaining attempts before the second, so a command waits for both", async () => {
    // Two exec failures at once, then the third attempt (driven by this same command) lays down.
    const events: Array<string> = [];
    const outcomes = [{ outcome: "exec-failed", attempts: 2 }, { outcome: "laid", attempts: 3 }];
    const mise = { ensure: async (runtime: string | undefined) => (events.push(`mise ${String(runtime)}`), { runtime: runtime ?? "", at: 0, ...outcomes.shift()! }), due: () => false, inFlight: () => false };
    const setup = { ensure: async (runtime: string | undefined) => (events.push(`setup ${String(runtime)}`), { runtime: runtime ?? "", outcome: "ok", attempts: 1, at: 0 }), due: () => false, inFlight: () => false };
    await steps({ step: mise, doing: "a" }, { step: setup, doing: "b" }).ensure("r1");
    expect(events).toEqual(["mise r1", "mise r1", "setup r1"]);
  });

  it("drives a first step that never ends final at most MAX_ATTEMPTS times, then lets the command go on", async () => {
    const events: Array<string> = [];
    const mise = { ensure: async () => (events.push("mise"), { runtime: "", outcome: "exec-failed", attempts: 1, at: 0 }), due: () => false, inFlight: () => false };
    await steps({ step: mise, doing: "a" }, { step: step("setup", events).step, doing: "b" }).ensure(undefined);
    expect(events).toEqual(Array.from({ length: MAX_ATTEMPTS }, () => "mise"));
  });

  it("runs the second step once the first is out of attempts", async () => {
    const events: Array<string> = [];
    const mise = step("mise", events, "exec-failed", { attempts: MAX_ATTEMPTS });
    const setup = step("setup", events);
    const done = steps({ step: mise.step, doing: "a" }, { step: setup.step, doing: "b" }).ensure("r1");
    await tick();
    mise.release();
    await tick();
    setup.release();
    await done;
    expect(events).toEqual(["mise r1", "mise done", "setup r1", "setup done"]);
  });

  it("refuses under refuse when the setup was not judged: held behind the first step, or its own run threw", async () => {
    const held = step("mise", [], "exec-failed", { attempts: 1 });
    const unjudged = steps({ step: held.step, doing: "a" }, { step: step("setup", []).step, doing: "b", refusal: refusing }).ensure("r1");
    await tick();
    held.release();
    await expect(unjudged).rejects.toThrow("Refused: not judged");
    const broke = step("setup", [], "ok", { fails: true });
    const thrown = steps({ step: broke.step, doing: "b", refusal: refusing }).ensure("r1");
    await tick();
    broke.release();
    await expect(thrown).rejects.toThrow("Refused: not judged");
  });

  it("the alarm catches up when a step is due and none runs", async () => {
    const events: Array<string> = [];
    const mise = step("mise", events);
    const setup = step("setup", events, "ok", { due: true });
    const ready = steps({ step: mise.step, doing: "a" }, { step: setup.step, doing: "b" });
    expect(steps({ step: step("x", []).step, doing: "x" }).catchUp("r1")).toBe(false);
    expect(ready.catchUp("r1")).toBe(true);
    await tick();
    expect(events).toEqual(["mise r1"]);
    expect(ready.catchUp("r1")).toBe(false);
  });
});

describe("readyForSpawn", () => {
  const harness = (running: boolean, runtime: () => Promise<string | undefined>, ensure: (runtime: string | undefined) => Promise<unknown> = async () => undefined, refuses = false) => {
    const calls: Array<string> = [];
    const logged: Array<Record<string, unknown>> = [];
    const deps = {
      running: () => running,
      runtime: async () => {
        calls.push("runtime");
        return runtime();
      },
      ensure: async (id: string | undefined) => {
        calls.push(`ensure ${id}`);
        return ensure(id);
      },
      log: (event: Record<string, unknown>) => void logged.push(event),
      refuses: () => refuses,
    };
    return { calls, logged, ready: () => readyForSpawn(deps) };
  };

  it("on a fresh instance with a running Container, learns the runtime from storage and waits for its lay-down, with no command (so no submodule restart)", async () => {
    // The deps have no command, connect or start: a spawn's wait can neither restart nor start the Container.
    const h = harness(true, async () => "r9");
    await h.ready();
    expect(h.calls).toEqual(["runtime", "ensure r9"]);
  });

  it("never starts a stopped Container: the spawn's own start waits instead", async () => {
    const h = harness(false, async () => "r9");
    await h.ready();
    expect(h.calls).toEqual([]);
  });

  it("logs and goes on when the runtime is unknown or cannot be read, or the lay-down fails", async () => {
    for (const h of [harness(true, async () => undefined), harness(true, async () => Promise.reject(new Error("storage"))), harness(true, async () => "r1", async () => Promise.reject(new Error("exec")))]) {
      await expect(h.ready()).resolves.toBeUndefined();
      expect(h.logged).toHaveLength(1);
      expect(h.logged[0]).toMatchObject({ t3flare: "container-steps-spawn", waited: false });
    }
  });

  it("fails closed under refuse: a runtime it cannot learn refuses the spawn", async () => {
    for (const h of [harness(true, async () => undefined, undefined, true), harness(true, async () => Promise.reject(new Error("storage")), undefined, true)]) {
      await expect(h.ready()).rejects.toBeInstanceOf(ContainerRefused);
    }
  });

  it("refuses the spawn when the Container's steps refuse its commands", async () => {
    const h = harness(true, async () => "r1", async () => Promise.reject(new ContainerRefused("Refused: setup failed")));
    await expect(h.ready()).rejects.toThrow("Refused: setup failed");
  });

  it("prefers computer's stored runtime over the last connect's, which names a replaced Container until the new connect ends", async () => {
    expect(await spawnRuntime(async () => ({ id: "R2" }), "R1")).toBe("R2");
    expect(await spawnRuntime(async () => undefined, "R1")).toBe("R1");
    expect(await spawnRuntime(async () => ({ id: 7 }), "R1")).toBe("R1");
    expect(await spawnRuntime(async () => undefined, undefined)).toBeUndefined();
  });

  it("waits on a replacement Container's lay-down even when the last connect named the one before it", async () => {
    let release = () => {};
    const laid = new Map<string, Promise<void>>([["R1", Promise.resolve()], ["R2", new Promise<void>((resolve) => (release = resolve))]]);
    const events: Array<string> = [];
    const spawn = readyForSpawn({
      running: () => true,
      runtime: () => spawnRuntime(async () => ({ id: "R2" }), "R1"),
      ensure: (id) => laid.get(id ?? "") ?? Promise.resolve(),
      log: () => undefined,
      refuses: () => false,
    }).then(() => events.push("spawned"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push("laid R2");
    release();
    await spawn;
    expect(events).toEqual(["laid R2", "spawned"]);
  });

  it("reads the key computer keeps the runtime id under", async () => {
    // @cloudflare/computer's container backend, as installed: the key and the runtime id its connect answers.
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(`${import.meta.dirname}/../node_modules/@cloudflare/computer/dist/backends/container/index.js`, "utf8");
    expect(code).toContain(`const STORAGE_KEY = "${COMPUTER_RUNTIME_KEY}";`);
    // The stored value's shape `{ id }` (spawnRuntime reads `.id`; any other shape falls back to the last connect's).
    expect(code).toMatch(/STORAGE_KEY[\s\S]{0,800}\{\s*id\b/);
  });
});

describe("commandEnvOf", () => {
  it("marks a passive read only, and drops a mark a caller passed on an active command", () => {
    expect(commandEnvOf({ A: "1" }, { B: "2" }, true)).toEqual({ A: "1", B: "2", [PASSIVE_MARKER]: "1" });
    expect(commandEnvOf({ A: "1" }, { B: "2", [PASSIVE_MARKER]: "1" }, false)).toEqual({ A: "1", B: "2" });
    expect(commandEnvOf({ A: "1" }, undefined, false)).toEqual({ A: "1" });
  });
});
