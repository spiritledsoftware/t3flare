// The Workspace DO's clone and checkpoint time limits (SPI-1324): the limit the Environment DO carries, else the
// setting's default, for a call that carries none (an older Environment, the admin route).
import { DEFAULT_CHECKPOINT_MINUTES, DEFAULT_CLONE_MINUTES } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { checkpointLimitMs, cloneLimitMs } from "../src/workspace/gitLimits.ts";

describe("the Workspace DO's git time limits (SPI-1324)", () => {
  it("use the carried limit", () => {
    expect(cloneLimitMs(3_600_000)).toBe(3_600_000);
    expect(checkpointLimitMs(180_000)).toBe(180_000);
  });

  it("use the default constant for a call without timeoutMs", () => {
    expect(cloneLimitMs(undefined)).toBe(DEFAULT_CLONE_MINUTES * 60_000);
    expect(checkpointLimitMs(undefined)).toBe(DEFAULT_CHECKPOINT_MINUTES * 60_000);
    expect(cloneLimitMs(undefined)).toBe(900_000);
    expect(checkpointLimitMs(undefined)).toBe(600_000);
  });
});
