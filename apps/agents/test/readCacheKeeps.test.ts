// SPI-1364: a passive git read's answer is kept only when its run ended by itself. computer names an exec's status
// from its exit (0 completed, 129/130/137/143 cancelled, else failed), so a read killed by its timeout or by t3's cancel
// (`cancelRun`) is never kept and replayed to later polls.
import { describe, expect, it } from "vitest";

import { keepsAnswer } from "../src/workspace/readCache.ts";

describe("keepsAnswer", () => {
  it("keeps a read that ran to its end, git's failure included, never a killed one", () => {
    expect(keepsAnswer("completed")).toBe(true);
    expect(keepsAnswer("failed")).toBe(true);
    expect(keepsAnswer("cancelled")).toBe(false);
  });
});
