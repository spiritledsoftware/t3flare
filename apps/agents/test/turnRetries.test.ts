// The retries a turn's start carries (SPI-1367): the Durable agent's retries of a failed model request and the kills of
// a stopped command's survivors, kept in the Session's storage so they outlive the turn and a restart of the Session.
import { DEFAULT_RETRY_POLICY } from "@earendil-works/pi-durable";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { DEFAULT_DURABLE_RETRIES, DEFAULT_KILL_ATTEMPTS, retriedSpanMs } from "@t3flare/harness-registry";
import { SHORT_RESET_MS } from "@t3flare/models/failures";
import { describe, expect, it } from "vitest";

import { keepTurnRetries, keptTurnRetries } from "../src/session/turnRetries.ts";

const memoryKv = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
  };
};

describe("a turn's retries", () => {
  it("are the defaults until a turn's start carries them", () => {
    expect(keptTurnRetries(memoryKv())).toEqual({
      durableRetries: DEFAULT_DURABLE_RETRIES,
      killAttempts: DEFAULT_KILL_ATTEMPTS,
    });
    expect([DEFAULT_DURABLE_RETRIES, DEFAULT_KILL_ATTEMPTS]).toEqual([3, 12]);
  });

  it("are what the latest start carried, each kept until one carries it again", () => {
    const kv = memoryKv();
    keepTurnRetries(kv, { durableRetries: 0, killAttempts: 5 });
    expect(keptTurnRetries(kv)).toEqual({ durableRetries: 0, killAttempts: 5 });
    // An Environment before SPI-1367 carries neither: what was kept stays.
    keepTurnRetries(kv, {});
    expect(keptTurnRetries(kv)).toEqual({ durableRetries: 0, killAttempts: 5 });
    keepTurnRetries(kv, { durableRetries: 7 });
    expect(keptTurnRetries(kv)).toEqual({ durableRetries: 7, killAttempts: 5 });
  });

  // Fragility U105: `retriedSpanMs` mirrors pi-durable's private backoff; this pins it to pi-durable's own policy and
  // pi-ai's own wait, so a bump that changes either fails here.
  it("span as long as pi-durable's own retries wait, and its default 3 are models' SHORT_RESET_MS", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(DEFAULT_DURABLE_RETRIES);
    for (const retries of [0, 1, 2, 3, 5, 6, 7, 10, 100]) {
      let span = 0;
      for (let attempt = 1; attempt <= retries; attempt++) span += retryDelayMs(DEFAULT_RETRY_POLICY, attempt);
      expect(retriedSpanMs(retries), String(retries)).toBe(span);
    }
    expect(SHORT_RESET_MS).toBe(retriedSpanMs(DEFAULT_DURABLE_RETRIES));
  });
});
