// SPI-1364: a git command t3 gave up on is ended in the Container, TERM then KILL after t3's own 1 s; one t3 can cancel
// takes no `commandMinutes` cut.
import { describe, expect, it } from "vitest";

import {
  CANCEL_KILL_AFTER_MS,
  CANCELLABLE_RUN_MS,
  dropOrphanedRuns,
  EARLY_CANCEL_MS,
  gitDeadlineMs,
  RunCancels,
} from "../src/workspace/runCancels.ts";

const harness = () => {
  let now = 0;
  const later: Array<{ run: () => void; ms: number }> = [];
  const cancels = new RunCancels({ now: () => now, later: (run, ms) => void later.push({ run, ms }) });
  const run = () => {
    const signals: Array<string> = [];
    return { signals, kill: async (signal?: string) => void signals.push(signal ?? "SIGTERM") };
  };
  return { cancels, later, run, advance: (ms: number) => void (now += ms) };
};

describe("RunCancels", () => {
  it("ends a running exec with TERM, then KILL after t3's grace", () => {
    const h = harness();
    const run = h.run();
    h.cancels.begin("r1");
    h.cancels.started("r1", run);
    expect(h.cancels.cancel("r1")).toBe(true);
    expect(run.signals).toEqual(["SIGTERM"]);
    expect(h.later.map((entry) => entry.ms)).toEqual([CANCEL_KILL_AFTER_MS]);
    h.later[0]!.run();
    expect(run.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps a cancel that came while the run waited for its Container, however long, and ends the exec as it starts", () => {
    const h = harness();
    h.cancels.begin("r1");
    expect(h.cancels.cancel("r1")).toBe(true);
    h.advance(10 * EARLY_CANCEL_MS);
    const run = h.run();
    h.cancels.started("r1", run);
    expect(run.signals).toEqual(["SIGTERM"]);
  });

  it("refuses a run whose cancel arrived before its own RPC", () => {
    const h = harness();
    expect(h.cancels.cancel("r1")).toBe(false);
    expect(h.cancels.begin("r1")).toBe(true);
    expect(h.cancels.begin("r2")).toBe(false);
  });

  it("ends nothing once a run answered, and forgets an early cancel whose run never came", () => {
    const h = harness();
    const finished = h.run();
    h.cancels.begin("r2");
    h.cancels.started("r2", finished);
    h.cancels.end("r2");
    h.cancels.cancel("r2");
    expect(finished.signals).toEqual([]);
    h.cancels.cancel("r3");
    h.advance(EARLY_CANCEL_MS);
    h.cancels.cancel("r4");
    expect(h.cancels.begin("r3")).toBe(false);
  });
});

describe("RunCancels and a run id no RPC opened", () => {
  it("keeps nothing for an exec's run id that `begin` never opened, and cancels nothing of it", () => {
    const h = harness();
    const stray = h.run();
    h.cancels.started("stray", stray);
    expect(h.cancels.cancel("stray")).toBe(false);
    expect(stray.signals).toEqual([]);
  });
});

describe("RunCancels and the Environment's epoch (SPI-1382)", () => {
  it("a newer epoch ends the runs begun under an older one, TERM then KILL; runs of the same epoch survive", () => {
    const h = harness();
    const old = h.run();
    const current = h.run();
    h.cancels.begin("old", 3);
    h.cancels.started("old", old);
    h.cancels.begin("current", 4);
    h.cancels.started("current", current);
    expect(h.cancels.dropBefore(4)).toEqual([{ id: "old", epoch: 3, environmentEpoch: 4 }]);
    expect(old.signals).toEqual(["SIGTERM"]);
    h.later[0]!.run();
    expect(old.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(current.signals).toEqual([]);
    expect(h.cancels.oldestEpoch()).toBe(4);
  });

  it("ends a dropped run that had not started yet as it starts, and drops it once", () => {
    const h = harness();
    h.cancels.begin("old", 3);
    expect(h.cancels.dropBefore(4)).toEqual([{ id: "old", epoch: 3, environmentEpoch: 4 }]);
    expect(h.cancels.dropBefore(5)).toEqual([]);
    const run = h.run();
    h.cancels.started("old", run);
    expect(run.signals).toEqual(["SIGTERM"]);
  });

  it("never drops a run that carries no epoch, nor one that answered", () => {
    const h = harness();
    const bare = h.run();
    h.cancels.begin("bare");
    h.cancels.started("bare", bare);
    h.cancels.begin("done", 1);
    h.cancels.end("done");
    expect(h.cancels.oldestEpoch()).toBeUndefined();
    expect(h.cancels.dropBefore(9)).toEqual([]);
    expect(bare.signals).toEqual([]);
  });
});

describe("dropOrphanedRuns, the Workspace's alarm (SPI-1382)", () => {
  /** A Workspace's running count, as `exec` keeps it: a run counts until its exec ends, which a kill makes it do. */
  const workspace = () => {
    const h = harness();
    let running = 0;
    const exec = (id: string, epoch: number) => {
      running++;
      h.cancels.begin(id, epoch);
      h.cancels.started(id, {
        kill: async () => {
          if (running > 0) running--;
          h.cancels.end(id);
        },
      });
    };
    return { h, exec, running: () => running };
  };

  it("drops an open run from an older epoch, and the idle stop then proceeds", async () => {
    const w = workspace();
    w.exec("orphan", 3);
    expect(w.running()).toBe(1);
    const asked: Array<number> = [];
    const dropped = await dropOrphanedRuns(w.h.cancels, async () => {
      asked.push(4);
      return 4;
    });
    expect(dropped).toEqual([{ id: "orphan", epoch: 3, environmentEpoch: 4 }]);
    await Promise.resolve();
    expect(asked).toEqual([4]);
    expect(w.running()).toBe(0);
    expect(w.h.cancels.oldestEpoch()).toBeUndefined();
  });

  it("keeps a run of the Environment's current epoch", async () => {
    const w = workspace();
    w.exec("live", 4);
    expect(await dropOrphanedRuns(w.h.cancels, async () => 4)).toEqual([]);
    expect(w.running()).toBe(1);
  });

  it("asks the Environment nothing while no cancellable run is open, and drops nothing when it cannot answer", async () => {
    const w = workspace();
    let asks = 0;
    expect(await dropOrphanedRuns(w.h.cancels, async () => ++asks)).toEqual([]);
    expect(asks).toBe(0);
    w.exec("r", 3);
    expect(await dropOrphanedRuns(w.h.cancels, () => Promise.reject(new Error("unreachable")))).toEqual([]);
    expect(w.running()).toBe(1);
  });
});

describe("gitDeadlineMs", () => {
  it("is the run's own limit; for a run t3 can cancel, a backstop far past the command limit; else the command limit", () => {
    expect(gitDeadlineMs({ timeoutMs: 5_000, runId: "r" }, 120_000)).toBe(5_000);
    // t3's 5-minute fetch and its pushes (no timeout) are never cut at the 2-minute default.
    expect(gitDeadlineMs({ runId: "r" }, 120_000)).toBe(CANCELLABLE_RUN_MS);
    expect(CANCELLABLE_RUN_MS).toBeGreaterThan(5 * 60_000);
    expect(CANCELLABLE_RUN_MS).toBeLessThan(2 ** 31 - 1);
    expect(gitDeadlineMs({}, 120_000)).toBe(120_000);
  });
});
