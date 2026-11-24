// SPI-1377: the adapter's snapshot names the turns it has open, never asks for the whole thread, and ends a turn the
// Session no longer has as lost (the lost-turn guard), on a gap as on a silent turn.
import type { SessionState, TurnState } from "@t3flare/session-protocol";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { diff, makeDifferState, type DifferState, type TurnContext } from "../src/provider/differ.ts";
import { goneTurns, snapshotRequest, withLostTurns } from "../src/provider/snapshotTurns.ts";
import recorded from "./fixtures/session-chat.json" with { type: "json" };

const state = recorded as unknown as SessionState;
const now = DateTime.makeUnsafe("2026-11-10T21:20:00.000Z");

const differWith = (turns: Readonly<Record<string, TurnState>>): DifferState => {
  const differ = makeDifferState("thread:test");
  Object.entries(turns).forEach(([providerTurnId, turn], index) => {
    differ.turns.set(providerTurnId, {
      providerTurnId,
      threadId: "thread-1",
      runId: turn.runId,
      rootNodeId: `node:${index}`,
      providerThreadId: "provider-thread-1",
      runOrdinal: index + 1,
      providerTurnOrdinal: index + 1,
      startedAt: now,
      providerTurn: {
        id: providerTurnId,
        providerThreadId: "provider-thread-1",
        nodeId: `node:${index}`,
        runAttemptId: turn.attemptId,
        nativeTurnRef: null,
        ordinal: index + 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
      contextWindow: 400_000,
      providerSessionId: "provider-session-1",
    } as unknown as TurnContext);
  });
  return differ;
};

const terminals = (events: ReturnType<typeof diff>) =>
  events.flatMap((event) =>
    event.type === "turn.terminal"
      ? [{ turn: (event as unknown as { providerTurnId: string }).providerTurnId, status: event.status }]
      : [],
  );

describe("the adapter's snapshot (SPI-1377)", () => {
  it("names the open turns, never an unbounded whole-thread read", () => {
    expect(snapshotRequest(new Map([["a", 1]]).keys())).toEqual({ turns: ["a"] });
    // After an Environment restart the adapter has none open: the Session answers its live turns from its last entry.
    expect(snapshotRequest([])).toEqual({ turns: [] });
  });

  it("finds the asked turns the Session no longer has", () => {
    const [first, ...rest] = Object.keys(state.turns);
    const without = { ...state, turns: Object.fromEntries(Object.entries(state.turns).filter(([id]) => id !== first)) };
    expect(goneTurns(without, [first!, ...rest])).toEqual([first]);
    expect(goneTurns(state, [first!, ...rest])).toEqual([]);
  });

  it("ends a turn that disappeared during a gap as lost, and settles the others as the Session has them", () => {
    const [first, ...rest] = Object.entries(state.turns);
    const [lostId, lostTurn] = first!;
    const differ = differWith({ [lostId]: { ...lostTurn, status: "running" } });
    // A push named the turn while it ran, then the Session lost it; the gap's snapshot no longer has it.
    diff(differ, { ...state, entries: [], turns: { [lostId]: { ...lostTurn, status: "running" } } }, now);
    const snapshot = { ...state, turns: Object.fromEntries(rest) };
    const gone = goneTurns(snapshot, differ.turns.keys());
    expect(gone).toEqual([lostId]);
    const events = diff(
      differ,
      withLostTurns(snapshot, gone, (id) => differ.turns.get(id)!.runId),
      now,
    );
    expect(terminals(events)).toEqual([{ turn: lostId, status: "failed" }]);
    const failure = JSON.stringify(events);
    expect(failure).toContain("The agent's session lost this turn.");
  });

  it("leaves a snapshot that has every asked turn as it is", () => {
    expect(withLostTurns(state, [], () => "")).toBe(state);
  });
});
