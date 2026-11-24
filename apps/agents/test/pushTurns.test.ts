// SPI-1377: a Session push names its live turns and those settled since the last push the Environment took (by the
// settle sequence), and a snapshot starts at the oldest open turn's input entry, so neither grows with the thread's
// settled turns.
import { RPC_MESSAGE_BYTES, TOOL_OUTPUT_BYTES, type TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { collectEntries, type EntryPage, entriesStart, pushedTurns, snapshotTurns } from "../src/session/pushTurns.ts";
import { TurnStore, type TurnStorage } from "../src/session/turnStore.ts";

const settled = (startedAt: number, inputEntry: number, settledSeq: number): TurnState => ({
  submissionId: `s${startedAt}`,
  runId: `run-${startedAt}`,
  attemptId: "a",
  status: "answered",
  inputEntry: String(inputEntry),
  startedAt,
  settledAt: startedAt + 1,
  settledSeq,
});

const running = (startedAt: number, inputEntry?: number): TurnState => ({
  submissionId: `s${startedAt}`,
  runId: `run-${startedAt}`,
  attemptId: "a",
  status: inputEntry === undefined ? "queued" : "running",
  ...(inputEntry === undefined ? {} : { inputEntry: String(inputEntry) }),
  startedAt,
});

/** `count` finished turns, ten entries each (the first at `i * 10 + 1`), the i-th settled i+1-th. */
const finished = (count: number): Record<string, TurnState> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i}`, settled(i * 10, i * 10 + 1, i + 1)]));

const memoryKv = (): TurnStorage => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: <T>(options?: { readonly prefix?: string; readonly limit?: number }) =>
      [...map.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ""))
        .sort()
        .slice(0, options?.limit)
        .map((key) => [key, structuredClone(map.get(key)) as T] as [string, T]),
  };
};

describe("a push's turns (SPI-1377)", () => {
  it("are the live turns and those settled after the sequence the last push read", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(Object.keys(pushedTurns(turns, 3))).toEqual(["t3", "t4", "live"]);
  });

  it("are every turn before the first push that keeps a watermark", () => {
    expect(Object.keys(pushedTurns(finished(3), undefined))).toEqual(["t0", "t1", "t2"]);
  });

  it("do not grow with the thread's settled turns", () => {
    // The last push read the sequence after every finished turn settled: only the live turn goes.
    const pushed = (count: number) =>
      pushedTurns({ ...finished(count), live: running(count * 10 + 5, count * 10 + 6) }, count);
    expect(Object.keys(pushed(10))).toEqual(["live"]);
    expect(Object.keys(pushed(5_000))).toEqual(["live"]);
  });

  it("name a turn settled after the read even when the clock went back (the store stamps the sequence)", () => {
    const store = new TurnStore(memoryKv());
    store.put("a", running(1_000, 1));
    store.put("a", { ...running(1_000, 1), status: "answered", settledAt: 2_000 });
    const readSeq = store.lastSettleSeq();
    expect(Object.keys(pushedTurns(store.all(), readSeq))).toEqual([]);
    // The object moved to a machine whose clock is behind: this turn settles "before" the first one did.
    store.put("b", running(500, 5));
    store.put("b", { ...running(500, 5), status: "failed", settledAt: 600 });
    expect(store.get("b")?.settledSeq).toBe(readSeq + 1);
    expect(Object.keys(pushedTurns(store.all(), readSeq))).toEqual(["b"]);
  });
});

describe("a snapshot's turns and start (SPI-1377)", () => {
  it("report the live turns and the asked turns the Session still has", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(Object.keys(snapshotTurns(turns, ["t2", "gone"]))).toEqual(["t2", "live"]);
  });

  it("start at the oldest reported turn's input entry", () => {
    const turns = { ...finished(5), live: running(100, 51) };
    expect(entriesStart("open", snapshotTurns(turns, []))).toBe(51);
    expect(entriesStart("open", snapshotTurns(turns, ["t2"]))).toBe(21);
  });

  it("start at the last entry when no reported turn has an input entry", () => {
    expect(entriesStart("open", snapshotTurns(finished(5), []))).toBe("last");
    expect(entriesStart("open", snapshotTurns({ ...finished(5), queued: running(100) }, []))).toBe("last");
  });

  it("a push's and a diagnostic's start where they say, whatever the turns", () => {
    expect(entriesStart(12, finished(5))).toBe(12);
    expect(entriesStart(undefined, finished(5))).toBeUndefined();
  });

  it("of a thread of many large finished turns, after a reconnect, is far under the RPC limit", async () => {
    // 400 finished turns, each ten full-size tool results: about 1 GB of entries in all.
    const turns: Record<string, TurnState> = finished(400);
    const lastEntry = 400 * 10;
    const result = "x".repeat(TOOL_OUTPUT_BYTES);
    expect(lastEntry * TOOL_OUTPUT_BYTES).toBeGreaterThan(RPC_MESSAGE_BYTES);
    const entryOf = (id: number) => ({
      id,
      kind: "message",
      model: [
        { role: "toolResult", toolCallId: `c${id}`, toolName: "bash", content: [{ type: "text", text: result }] },
      ],
    });
    // The conversation, a page of up to 100 at a time from `fromEntry`, as pi-durable answers `entries`.
    const read = async (fromEntry: number | undefined, cursor: number | undefined): Promise<EntryPage<number>> => {
      const first = cursor ?? fromEntry ?? 1;
      const last = Math.min(lastEntry, first + 99);
      const items = Array.from({ length: last - first + 1 }, (_, i) => entryOf(first + i));
      return { items, next: last < lastEntry ? last + 1 : undefined };
    };
    const snapshotOf = async (live: Record<string, TurnState>) => {
      const all = { ...turns, ...live };
      const reported = snapshotTurns(all, []);
      const start = entriesStart("open", reported);
      const { entries, more } = await collectEntries(read, start === "last" ? lastEntry : start, all, Infinity);
      expect(more).toBe(false);
      return { entries, reported };
    };
    // A reconnect with no turn live: the last entry alone.
    const idle = await snapshotOf({});
    expect(idle.entries.map((entry) => entry.id)).toEqual([String(lastEntry)]);
    // With one live turn three entries from the end: its entries, each placed under it.
    const busy = await snapshotOf({ live: running(5_000, lastEntry - 2) });
    expect(busy.entries.map((entry) => entry.turn)).toEqual(["live", "live", "live"]);
    // Structured clone writes at most 2 bytes per character. The bound is a sixteenth of the RPC limit (2 MiB): room for
    // the live turn's three full-size results (about 1.5 MB) and the turns, and nothing of the 400 finished turns'
    // entries (any one of which would add a quarter MB per entry, ten per turn).
    for (const { entries, reported } of [idle, busy])
      expect(2 * JSON.stringify({ entries, turns: reported }).length).toBeLessThan(RPC_MESSAGE_BYTES / 16);
  });
});
