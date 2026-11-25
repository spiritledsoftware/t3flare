// The Workspace's time limits name themselves when hit (SPI-1430): a Container command that computer ended at the
// deadline its limit set says which limit, its value and where to change it; one t3 cancelled or an abort killed before
// that deadline claims none.
import { OFF_DEADLINE_MS } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { checkpointLimit, cloneLimit, commandLimit, limitNoted } from "../src/workspace/execLimit.ts";

const ran = (status: string, ms: number, stderr = "") => ({ exitCode: 143, status, stdout: "", stderr, ms });

describe("a Workspace command's time limit, named when hit (SPI-1430)", () => {
  it("a clone ended at its deadline appends the limit, its value and its place after git's own stderr", () => {
    const { timeoutMs, limit } = cloneLimit(600_000);
    expect(timeoutMs).toBe(600_000);
    const result = limitNoted(ran("cancelled", 600_004, "Cloning into '/workspace/repo'...\n"), timeoutMs, limit);
    expect(result.stderr).toBe(
      "Cloning into '/workspace/repo'...\nt3flare: the clone stopped at its 10-minute time limit; change it under Environment › Advanced › Clone time limit (minutes).",
    );
    expect(result.exitCode).toBe(143);
  });

  it("a checkpoint ended at its deadline with no stderr of its own reads as the limit alone", () => {
    const { timeoutMs, limit } = checkpointLimit(300_000);
    expect(limitNoted(ran("cancelled", 300_000), timeoutMs, limit).stderr).toBe(
      "the checkpoint stopped at its 5-minute time limit; change it under Environment › Advanced › Checkpoint time limit (minutes).",
    );
  });

  it("a command names the Command time limit with the minutes the Container took", () => {
    const { timeoutMs, limit } = commandLimit(5);
    expect(timeoutMs).toBe(300_000);
    expect(limitNoted(ran("cancelled", 300_100), timeoutMs, limit).stderr).toBe(
      "the command stopped at its 5-minute time limit; change it under Environment › Advanced › Command time limit (minutes).",
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
