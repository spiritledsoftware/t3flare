// The Turn limit on the Durable agent (SPI-1315): the Environment carries the limit with the turn's start, the Session
// keeps it on the turn's record, and the alarm ends the turn at its start plus that kept limit. A limit lowered while
// a turn runs reaches only the thread's next turn; the deploy's `T3FLARE_TURN_DEADLINE_MS` (tests) wins over all.
//
// The agents Worker has no workerd harness for a whole SessionDO (sessionEndpoints.workerd.test.ts says why), so the
// Session's sequence runs here through the steps SessionDO calls as they are: `submitTurn`'s record (`turnRecord`),
// `#arm`'s candidates (`turnLimitAlarms`, then `nextAlarm`), and the housekeeping's ends (`turnsPastLimit`).
import { DEFAULT_TURN_LIMIT_MS } from "@t3flare/harness-registry";
import type { TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { nextAlarm } from "../src/session/alarmPlan.ts";
import { turnLimitAlarms, turnLimitAt, turnRecord, turnsPastLimit } from "../src/session/turnLimit.ts";

const MINUTE = 60_000;
const START = 1_000_000;

/** A Session's turns as its storage keeps them, driven as SessionDO drives them. */
const session = (override?: string) => {
  const turns: Record<string, TurnState> = {};
  return {
    turns,
    /** `submitTurn`: the record kept before the submit, with the limit the Environment carried (absent: none). */
    submit: (id: string, at: number, turnLimitMs?: number) => {
      turns[id] = turnRecord({ runId: `run-${id}`, attemptId: `attempt-${id}`, ...(turnLimitMs === undefined ? {} : { turnLimitMs }) }, at, override);
    },
    /** A turn the harness runs. */
    run: (id: string) => {
      turns[id] = { ...turns[id]!, status: "running" };
    },
    /** `#arm` with no push due and no retry: when the alarm next does housekeeping, from the turns' limits alone. */
    alarmAt: (now: number) => nextAlarm(now, { pushDue: false, candidates: turnLimitAlarms(turns, override) }).at,
    /** The alarm's housekeeping at `now`: the turns it ends, each then aborted as `#abortTurn` settles it. */
    housekeep: (now: number) => {
      const ended = turnsPastLimit(turns, now, override);
      for (const id of ended) turns[id] = { ...turns[id]!, status: "aborted", reason: "turn_deadline", settledAt: now };
      return ended;
    },
  };
};

describe("a Session's turn and its Turn limit", () => {
  it("keeps the limit the turn's start carried on its record, and ends the turn at its start plus that limit", () => {
    const s = session();
    s.submit("a", START, 30 * MINUTE);
    expect(s.turns.a).toMatchObject({ status: "queued", startedAt: START, turnLimitMs: 30 * MINUTE });
    s.run("a");
    expect(s.alarmAt(START + MINUTE)).toBe(START + 30 * MINUTE);
    expect(s.housekeep(START + 30 * MINUTE - 1)).toEqual([]);
    expect(s.housekeep(START + 30 * MINUTE)).toEqual(["a"]);
    expect(s.turns.a).toMatchObject({ status: "aborted", reason: "turn_deadline" });
    expect(s.alarmAt(START + 30 * MINUTE)).toBeNull();
  });

  it("does not move a running turn's limit when the setting is lowered mid-turn: only the next turn carries it", () => {
    const s = session();
    s.submit("a", START, 120 * MINUTE);
    s.run("a");
    // At minute 30 the Owner lowers the setting to 10; the thread's next turn (a follow-up) carries 10.
    s.submit("b", START + 30 * MINUTE, 10 * MINUTE);
    expect(s.turns.a?.turnLimitMs).toBe(120 * MINUTE);
    expect(s.alarmAt(START + 31 * MINUTE)).toBe(START + 40 * MINUTE);
    expect(s.housekeep(START + 40 * MINUTE)).toEqual(["b"]);
    expect(s.alarmAt(START + 40 * MINUTE)).toBe(START + 120 * MINUTE);
    expect(s.housekeep(START + 119 * MINUTE)).toEqual([]);
    expect(s.housekeep(START + 120 * MINUTE)).toEqual(["a"]);
  });

  it("reads a record with no kept limit (from before the setting) and a start that carried none as the default", () => {
    const s = session();
    s.turns.old = { submissionId: "s0", runId: "r0", attemptId: "a0", status: "running", startedAt: START };
    s.submit("fresh", START, undefined);
    expect(s.turns.fresh?.turnLimitMs).toBe(DEFAULT_TURN_LIMIT_MS);
    expect(DEFAULT_TURN_LIMIT_MS).toBe(120 * MINUTE);
    expect(s.alarmAt(START + MINUTE)).toBe(START + DEFAULT_TURN_LIMIT_MS);
    expect(s.housekeep(START + DEFAULT_TURN_LIMIT_MS - 1)).toEqual([]);
    expect(s.housekeep(START + DEFAULT_TURN_LIMIT_MS)).toEqual(["old", "fresh"]);
  });

  it("lets the deploy's override win over the carried limit, the kept one and the default", () => {
    const s = session("120000");
    s.submit("a", START, 60 * MINUTE);
    expect(s.turns.a?.turnLimitMs).toBe(120_000);
    s.turns.old = { submissionId: "s0", runId: "r0", attemptId: "a0", status: "running", startedAt: START, turnLimitMs: 60 * MINUTE };
    expect(s.alarmAt(START)).toBe(START + 120_000);
    expect(s.housekeep(START + 120_000)).toEqual(["a", "old"]);
  });
});

describe("turnLimitAt", () => {
  it("reads a carried limit that is not a positive finite number as the default, and an empty or bad override as none", () => {
    for (const carried of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "60"]) expect(turnLimitAt(carried, undefined)).toBe(DEFAULT_TURN_LIMIT_MS);
    expect(turnLimitAt(10_080 * MINUTE, undefined)).toBe(10_080 * MINUTE);
    expect(turnLimitAt(30 * MINUTE, "")).toBe(30 * MINUTE);
    expect(turnLimitAt(30 * MINUTE, "nope")).toBe(30 * MINUTE);
  });
});
