// The Turn limit on the Durable agent (SPI-1315): the Environment carries the limit with the turn's start, the Session
// keeps it on the turn's record, and the alarm ends the turn at its start plus that kept limit. A limit lowered while
// a turn runs reaches only the thread's next turn; the deploy's `T3FLARE_TURN_DEADLINE_MS` (tests) wins over both.
import { TURN_DEADLINE_MS, type TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { pastTurnLimit, turnLimitAt, turnLimitEndsAt } from "../src/session/turnLimit.ts";

const MINUTE = 60_000;
const START = 1_000_000;

const turnStarted = (turnLimitMs: number): TurnState => ({ submissionId: "s1", runId: "r1", attemptId: "a1", status: "running", startedAt: START, turnLimitMs });

describe("turnLimitAt", () => {
  it("keeps the limit the turn's start carried", () => {
    expect(turnLimitAt(30 * MINUTE, undefined)).toBe(30 * MINUTE);
    expect(turnLimitAt(10_080 * MINUTE, undefined)).toBe(10_080 * MINUTE);
  });

  it("reads a start that carried none, or none usable, as the default", () => {
    for (const carried of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60"]) expect(turnLimitAt(carried, undefined)).toBe(TURN_DEADLINE_MS);
  });

  it("lets the deploy's override win over what the start carried", () => {
    expect(turnLimitAt(30 * MINUTE, "120000")).toBe(120_000);
    expect(turnLimitAt(undefined, "120000")).toBe(120_000);
    expect(turnLimitAt(30 * MINUTE, "")).toBe(30 * MINUTE);
    expect(turnLimitAt(30 * MINUTE, "nope")).toBe(30 * MINUTE);
  });
});

describe("a running turn's limit", () => {
  it("ends the turn at its start plus the limit it started with", () => {
    const turn = turnStarted(60 * MINUTE);
    expect(turnLimitEndsAt(turn, undefined)).toBe(START + 60 * MINUTE);
    expect(pastTurnLimit(turn, START + 60 * MINUTE - 1, undefined)).toBe(false);
    expect(pastTurnLimit(turn, START + 60 * MINUTE, undefined)).toBe(true);
  });

  it("does not change when the setting is lowered mid-turn: only the thread's next turn carries the new limit", () => {
    // The turn started under 120 minutes; the Owner lowers the setting to 10 at minute 30.
    const running = turnStarted(turnLimitAt(120 * MINUTE, undefined));
    const next = { ...turnStarted(turnLimitAt(10 * MINUTE, undefined)), startedAt: START + 30 * MINUTE };
    expect(pastTurnLimit(running, START + 45 * MINUTE, undefined)).toBe(false);
    expect(turnLimitEndsAt(running, undefined)).toBe(START + 120 * MINUTE);
    expect(turnLimitEndsAt(next, undefined)).toBe(START + 40 * MINUTE);
  });

  it("reads a record from before the setting (no kept limit) as the default, and the deploy's override still wins", () => {
    const { turnLimitMs: _, ...before } = turnStarted(0);
    expect(turnLimitEndsAt(before, undefined)).toBe(START + TURN_DEADLINE_MS);
    expect(turnLimitEndsAt(before, "120000")).toBe(START + 120_000);
    expect(turnLimitEndsAt(turnStarted(60 * MINUTE), "120000")).toBe(START + 120_000);
  });
});
