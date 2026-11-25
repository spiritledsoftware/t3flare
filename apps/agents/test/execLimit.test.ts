// The Workspace's time limits (SPI-1324, SPI-1430): the deadline each Container command takes, and the limit named when
// computer ended the command at it; one t3 cancelled, an abort killed, or anything else ended before that deadline
// claims none.
import { DEFAULT_CHECKPOINT_MS, DEFAULT_CLONE_MS, OFF_DEADLINE_MS } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import {
  checkpointLimit,
  cloneLimit,
  commandLimit,
  limitNoted,
  SPAWN_SLACK_MS,
  spawnTimed,
} from "../src/workspace/execLimit.ts";

const ran = (status: string, ms: number, stderr = "") => ({ exitCode: 143, status, stdout: "", stderr, ms });

describe("the Workspace DO's git time limits (SPI-1324)", () => {
  it("use the carried limit", () => {
    expect(cloneLimit(3_600_000).timeoutMs).toBe(3_600_000);
    expect(checkpointLimit(180_000).timeoutMs).toBe(180_000);
  });

  it("give an off limit, carried or by default for a call without timeoutMs, the off deadline and no limit (SPI-1386)", () => {
    expect(DEFAULT_CLONE_MS).toBe(0);
    expect(DEFAULT_CHECKPOINT_MS).toBe(0);
    expect(OFF_DEADLINE_MS).toBe(10_080 * 60_000);
    for (const carried of [undefined, 0])
      for (const timed of [cloneLimit(carried), checkpointLimit(carried)])
        expect(timed).toEqual({ timeoutMs: OFF_DEADLINE_MS, limit: undefined });
  });
});

describe("a Workspace command's time limit, named when hit (SPI-1430)", () => {
  it("a clone ended at its deadline appends the limit, its value and its place after git's own stderr", () => {
    const { timeoutMs, limit } = cloneLimit(600_000);
    const result = limitNoted(ran("cancelled", 600_004, "Cloning into '/workspace/repo'...\n"), timeoutMs, limit);
    expect(result.stderr).toBe(
      "Cloning into '/workspace/repo'...\nt3flare: the clone stopped at its 10-minute time limit; change it under Environment › Advanced › Clone time limit (minutes).",
    );
    expect(result.exitCode).toBe(143);
  });

  it("a worktree's checkout names itself, under the clone time limit", () => {
    const { timeoutMs, limit } = cloneLimit(600_000, "worktree checkout");
    expect(limitNoted(ran("cancelled", 600_000), timeoutMs, limit).stderr).toBe(
      "the worktree checkout stopped at its 10-minute time limit; change it under Environment › Advanced › Clone time limit (minutes).",
    );
  });

  it("a checkpoint ended at its deadline with no stderr of its own reads as the limit alone", () => {
    const { timeoutMs, limit } = checkpointLimit(300_000);
    expect(limitNoted(ran("cancelled", 300_000), timeoutMs, limit).stderr).toBe(
      "the checkpoint stopped at its 5-minute time limit; change it under Environment › Advanced › Checkpoint time limit (minutes).",
    );
  });

  it("a command names the Command time limit with the minutes the Container took, ready for ` (on the Container)`", () => {
    const { timeoutMs, limit } = commandLimit(5);
    expect(timeoutMs).toBe(300_000);
    expect(limitNoted(ran("cancelled", 300_100), timeoutMs, limit).stderr).toBe(
      "the command stopped at its 5-minute time limit; change it under Environment › Advanced › Command time limit (minutes)",
    );
  });

  it("a command t3 cancelled, or an abort killed, before the deadline claims no limit", () => {
    const { timeoutMs, limit } = commandLimit(5);
    const result = ran("cancelled", 12_000, "partial\n");
    expect(limitNoted(result, timeoutMs, limit)).toBe(result);
  });

  it("a command that ended by itself claims no limit, however long it ran", () => {
    const { timeoutMs, limit } = cloneLimit(60_000);
    for (const status of ["completed", "failed"]) {
      const result = ran(status, 60_500, "fatal: x\n");
      expect(limitNoted(result, timeoutMs, limit)).toBe(result);
    }
  });

  it("an off limit (0, or none carried) runs to the off deadline and names nothing (out of scope)", () => {
    for (const { timeoutMs, limit } of [cloneLimit(undefined), checkpointLimit(0), commandLimit(0)]) {
      expect(timeoutMs).toBe(OFF_DEADLINE_MS);
      const result = ran("cancelled", OFF_DEADLINE_MS);
      expect(limitNoted(result, timeoutMs, limit)).toBe(result);
    }
  });

  it("a deadline set with no limit behind it (a fixed probe's) names nothing", () => {
    const result = ran("cancelled", 10_000);
    expect(limitNoted(result, 10_000, undefined)).toBe(result);
  });
});

describe("a command's run, timed from its spawn (SPI-1430 review)", () => {
  const clock = () => {
    let at = 0;
    return { now: () => at, pass: (ms: number) => (at += ms) };
  };

  it("a slow start (connect, push) then a kill well before the deadline claims no limit", async () => {
    const time = clock();
    const { timeoutMs, limit } = cloneLimit(600_000);
    // A 3-minute cold start, then git killed (an OOM) 5 minutes into its run: 8 minutes after the call.
    const run = await spawnTimed(() => {
      time.pass(180_000);
      return Promise.resolve("handle");
    }, time.now);
    expect(run.handle).toBe("handle");
    time.pass(300_000);
    const result = ran("cancelled", run.ranMs());
    expect(limitNoted(result, timeoutMs, limit)).toBe(result);
  });

  it("a kill at the deadline counted from the spawn names the limit, within the spawn's own answer time", async () => {
    const time = clock();
    const { timeoutMs, limit } = cloneLimit(600_000);
    const run = await spawnTimed(() => {
      time.pass(180_000);
      return Promise.resolve("handle");
    }, time.now);
    // computerd's clock started a moment before its spawn's answer arrived.
    time.pass(600_000 - SPAWN_SLACK_MS);
    expect(limitNoted(ran("cancelled", run.ranMs()), timeoutMs, limit).stderr).toMatch(/^the clone stopped at its/);
  });
});
