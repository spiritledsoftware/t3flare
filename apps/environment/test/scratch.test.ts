// The scratch registry (parity G7): an entry lasts until t3 removes its directory, however long the run takes.
import { afterEach, describe, expect, it } from "vitest";

import {
  bindScratchCheckout,
  clearScratches,
  dropScratchDir,
  isScratchDir,
  makeScratchDir,
  scratchProjectOf,
} from "../src/agents/scratch.ts";

afterEach(clearScratches);

describe("scratch directories", () => {
  it("are forgotten only when t3 removes them, not after a time", () => {
    let n = 0;
    const dir = makeScratchDir("/w/.wt", "review-guide-", () => `a${++n}`)!;
    expect(bindScratchCheckout(`${dir}/checkout`, "demo")).toEqual({ ok: true });
    // Later makes (the old sweep ran on each) leave it in place.
    for (let i = 0; i < 5; i++) makeScratchDir("/w/.wt", "review-guide-", () => `b${++n}`);
    expect(isScratchDir(dir)).toBe(true);
    expect(scratchProjectOf(`${dir}/checkout`)).toBe("demo");
    dropScratchDir(dir);
    expect(isScratchDir(dir)).toBe(false);
    expect(scratchProjectOf(`${dir}/checkout`)).toBeUndefined();
  });
});
