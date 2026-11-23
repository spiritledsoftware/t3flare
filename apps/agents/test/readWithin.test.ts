// A read bounded by a wait (SPI-1314): its answer within the wait, undefined past it, a failure as the read's own, and
// no timer left pending once the read has answered.
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_TIMED_MINUTES } from "@t3flare/harness-registry";

import { readWithin } from "../src/readWithin.ts";

describe("readWithin", () => {
  afterEach(() => vi.useRealTimers());

  it("answers undefined once the wait is past, and the read's answer within it", async () => {
    vi.useFakeTimers();
    let answer: unknown = "unset";
    void readWithin(new Promise(() => undefined), 1000).then((value) => (answer = value));
    await vi.advanceTimersByTimeAsync(999);
    expect(answer).toBe("unset");
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBeUndefined();
  });

  it("leaves no timer pending when the read wins or fails", async () => {
    vi.useFakeTimers();
    expect(await readWithin(Promise.resolve("answer"), MAX_TIMED_MINUTES * 60_000)).toBe("answer");
    expect(vi.getTimerCount()).toBe(0);
    await expect(readWithin(Promise.reject(new Error("busy")), 1000)).rejects.toThrow("busy");
    expect(vi.getTimerCount()).toBe(0);
  });
});
