// The retries a turn's start carries (SPI-1367): the Durable agent's retries of a failed model request and the kills of
// a stopped command's survivors, kept in the Session's storage so they outlive the turn and a restart of the Session.
import { DEFAULT_DURABLE_RETRIES, DEFAULT_KILL_ATTEMPTS } from "@t3flare/harness-registry";
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
});
