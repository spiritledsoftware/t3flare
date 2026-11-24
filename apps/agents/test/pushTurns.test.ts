// SPI-1377: a Session push names its live turns and those settled since the last push the Environment took, and a
// snapshot starts at the oldest open turn's input entry, so neither grows with the thread's settled turns.
import { RPC_MESSAGE_BYTES, TOOL_OUTPUT_BYTES, type TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { pushedTurns, snapshotStart, snapshotTurns } from "../src/session/pushTurns.ts";
import { pushedEntry, turnOfEntry } from "../src/session/state.ts";

const settled = (startedAt: number, inputEntry: number, settledAt: number): TurnState => ({
  submissionId: `s${startedAt}`,
  runId: `run-${startedAt}`,
  attemptId: "a",
  status: "answered",
  inputEntry: String(inputEntry),
  startedAt,
  settledAt,
});

const running = (startedAt: number, inputEntry?: number): TurnState => ({
  submissionId: `s${startedAt}`,
  runId: `run-${startedAt}`,
  attemptId: "a",
  status: inputEntry === undefined ? "queued" : "running",
  ...(inputEntry === undefined ? {} : { inputEntry: String(inputEntry) }),
  startedAt,
});

/** `count` finished turns, ten entries each, settled at their start plus one. */
const finished = (count: number): Record<string, TurnState> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, settled(i * 10, i * 10 + 1, i * 10 + 1)]));

describe("a push's turns (SPI-1377)", () => {
  it("are the live turns and those settled at or after the watermark", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(Object.keys(pushedTurns(turns, 31))).toEqual(["t3", "t4", "live"]);
  });

  it("are every turn before the first push that keeps a watermark", () => {
    expect(Object.keys(pushedTurns(finished(3), undefined))).toEqual(["t0", "t1", "t2"]);
  });

  it("do not grow with the thread's settled turns", () => {
    // The watermark is the last push's read time, after every finished turn settled: only the live turn goes.
    const pushed = (count: number) =>
      pushedTurns({ ...finished(count), live: running(count * 10 + 5, count * 10 + 6) }, count * 10);
    expect(Object.keys(pushed(10))).toEqual(["live"]);
    expect(Object.keys(pushed(5_000))).toEqual(["live"]);
  });
});

describe("a snapshot's turns and start (SPI-1377)", () => {
  it("report the live turns and the asked turns the Session still has", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(Object.keys(snapshotTurns(turns, ["t2", "gone"]))).toEqual(["t2", "live"]);
  });

  it("start at the oldest reported turn's input entry", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(snapshotStart(snapshotTurns(turns, []))).toBe(51);
    expect(snapshotStart(snapshotTurns(turns, ["t2"]))).toBe(21);
  });

  it("start at the last entry when no reported turn has an input entry", () => {
    expect(snapshotStart(snapshotTurns(finished(5), []))).toBeUndefined();
    expect(snapshotStart(snapshotTurns({ ...finished(5), queued: running(100) }, []))).toBeUndefined();
  });

  it("of a thread of many large finished turns, after a reconnect, is far under the RPC limit", () => {
    // 400 finished turns, each a prompt and nine full-size tool results: about 200 MB of entries in all.
    const turns: Record<string, TurnState> = finished(400);
    const result = "x".repeat(TOOL_OUTPUT_BYTES);
    const entryOf = (id: number) => ({
      id,
      kind: "message",
      model: [
        { role: "toolResult", toolCallId: `c${id}`, toolName: "bash", content: [{ type: "text", text: result }] },
      ],
    });
    const lastEntry = 400 * 10;
    const whole = lastEntry * (TOOL_OUTPUT_BYTES + 100);
    expect(whole).toBeGreaterThan(RPC_MESSAGE_BYTES);
    // A reconnect: the adapter has no turn open, then one live turn.
    for (const live of [{}, { live: running(5_000, lastEntry - 2) }]) {
      const reported = snapshotTurns({ ...turns, ...live }, []);
      const from = snapshotStart(reported) ?? lastEntry;
      const entries = [];
      for (let id = from; id <= lastEntry; id++) entries.push(pushedEntry(entryOf(id), turnOfEntry(id, turns)));
      const size = 2 * JSON.stringify({ entries, turns: reported }).length;
      expect(size).toBeLessThan(RPC_MESSAGE_BYTES / 16);
    }
  });
});
