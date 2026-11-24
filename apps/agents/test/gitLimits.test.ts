// The Workspace DO's clone and checkpoint time limits (SPI-1324): the limit the Environment DO carries, else the
// setting's default, for a call that carries none (an older Environment, the admin route). Off (0, the default since
// SPI-1386) gives computerd the off deadline, a week.
import { DEFAULT_CHECKPOINT_MS, DEFAULT_CLONE_MS, OFF_DEADLINE_MS } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { checkpointLimitMs, cloneLimitMs } from "../src/workspace/gitLimits.ts";

describe("the Workspace DO's git time limits (SPI-1324)", () => {
  it("use the carried limit", () => {
    expect(cloneLimitMs(3_600_000)).toBe(3_600_000);
    expect(checkpointLimitMs(180_000)).toBe(180_000);
  });

  it("give an off limit, carried or by default for a call without timeoutMs, the off deadline (SPI-1386)", () => {
    expect(DEFAULT_CLONE_MS).toBe(0);
    expect(DEFAULT_CHECKPOINT_MS).toBe(0);
    expect(OFF_DEADLINE_MS).toBe(10_080 * 60_000);
    for (const carried of [undefined, 0]) {
      expect(cloneLimitMs(carried)).toBe(OFF_DEADLINE_MS);
      expect(checkpointLimitMs(carried)).toBe(OFF_DEADLINE_MS);
    }
  });
});
