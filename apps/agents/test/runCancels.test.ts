// SPI-1364: a git command t3 gave up on is ended in the Container, TERM then KILL after t3's own 1 s; one t3 can cancel
// takes no `commandMinutes` cut.
import { describe, expect, it } from "vitest";

import {
  CANCEL_KILL_AFTER_MS,
  CANCELLABLE_RUN_MS,
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
