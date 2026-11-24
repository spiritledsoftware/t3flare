// SPI-1373: the Session's turns, one key per turn with an index of the live ones, so a change costs O(live turns) however
// long the thread runs, and an existing Session's single-value map moves over on the first read.
import type { ProxyRecord, TurnState } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { TurnStore, type TurnStorage } from "../src/session/turnStore.ts";

/** An in-memory KV, as `ctx.storage.kv` answers, counting each key read and written and each listing. */
const countingKv = () => {
  const map = new Map<string, unknown>();
  const counts = { gets: 0, puts: 0, deletes: 0, lists: 0, listed: 0 };
  const kv: TurnStorage = {
    get: <T>(key: string) => {
      counts.gets++;
      return structuredClone(map.get(key)) as T | undefined;
    },
    put: <T>(key: string, value: T) => {
      counts.puts++;
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => {
      counts.deletes++;
      return map.delete(key);
    },
    list: <T>(options?: { readonly prefix?: string; readonly limit?: number }) => {
      counts.lists++;
      const keys = [...map.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).sort();
      const out = keys.slice(0, options?.limit ?? keys.length).map((key) => {
        counts.listed++;
        return [key, structuredClone(map.get(key)) as T] as [string, T];
      });
      return out;
    },
  };
  const reset = () => Object.assign(counts, { gets: 0, puts: 0, deletes: 0, lists: 0, listed: 0 });
  return { kv, map, counts, reset };
};

const turn = (status: TurnState["status"], startedAt: number, inputEntry?: number): TurnState => ({
  submissionId: "",
  runId: `run-${startedAt}`,
  attemptId: "a",
  status,
  startedAt,
  ...(inputEntry === undefined ? {} : { inputEntry: String(inputEntry) }),
});

const MANY = 5_000;

/** A store holding `MANY` answered turns, then the counters cleared. */
const longThread = () => {
  const memory = countingKv();
  const store = new TurnStore(memory.kv);
  for (let i = 0; i < MANY; i++) store.put(`t${i}`, turn("answered", i, i * 10));
  memory.reset();
  return { ...memory, store };
};

describe("TurnStore", () => {
  it("keeps each turn under its own key, and lists them all", () => {
    const { store, map } = longThread();
    expect(map.get("t3flare:turn:t42")).toEqual({ ...turn("answered", 42, 420), settledSeq: 43 });
    expect(Object.keys(store.all())).toHaveLength(MANY);
    expect(store.get("t7")).toEqual({ ...turn("answered", 7, 70), settledSeq: 8 });
    expect(store.get("missing")).toBeUndefined();
  });

  it("starts, settles and notes a turn's model record in O(live turns), not O(all turns)", () => {
    const { store, counts, reset } = longThread();
    store.put("new", turn("queued", MANY));
    store.put("new", { ...turn("running", MANY), submissionId: "s1" });
    store.noteModel((record) => ({ ...record, requests: record.requests + 1 }));
    expect(store.live()).toEqual([["new", { ...turn("running", MANY), submissionId: "s1" }]]);
    expect(store.liveTurn()).toBe("new");
    store.put("new", { ...turn("answered", MANY), submissionId: "s1" });
    expect(store.live()).toEqual([]);
    expect(counts.lists).toBe(0);
    expect(counts.gets + counts.puts + counts.deletes).toBeLessThan(30);
    reset();
    expect(store.any()).toBe(true);
    expect(counts.listed).toBeLessThanOrEqual(1);
  });

  it("notes the model record on the live turn started first, and joins it to its turn", () => {
    const { kv } = countingKv();
    const store = new TurnStore(kv);
    store.put("later", turn("queued", 20));
    store.put("first", turn("running", 10));
    store.put("done", turn("answered", 5));
    store.noteModel((record) => ({ ...record, requests: record.requests + 1 }));
    store.noteModel((record) => ({ ...record, requests: record.requests + 1 }));
    const all = store.withModels(store.all());
    expect(all["first"]?.proxy).toEqual({ requests: 2 } satisfies ProxyRecord);
    expect(all["later"]?.proxy).toBeUndefined();
    expect(all["done"]).toEqual({ ...turn("answered", 5), settledSeq: 1 });
    expect(store.liveTurn()).toBe("first");
  });

  it("adds the model records of the named turns only, one read each, with no listing (SPI-1377)", () => {
    const { kv, counts, reset } = countingKv();
    const store = new TurnStore(kv);
    store.put("done", turn("answered", 5));
    store.put("first", turn("running", 10));
    store.noteModel((record) => ({ ...record, requests: record.requests + 1 }));
    reset();
    const named = store.withModels({ first: turn("running", 10) });
    expect(named).toEqual({ first: { ...turn("running", 10), proxy: { requests: 1 } } });
    expect(counts).toMatchObject({ gets: 1, lists: 0 });
  });

  it("lists every turn in start order, so the first running one is the turn `liveTurn` names", () => {
    const { kv } = countingKv();
    const store = new TurnStore(kv);
    store.put("z-first", turn("running", 10));
    store.put("a-second", turn("running", 20));
    store.put("m-done", turn("answered", 5));
    expect(Object.keys(store.all())).toEqual(["m-done", "z-first", "a-second"]);
    expect(Object.keys(store.withModels(store.all()))).toEqual(["m-done", "z-first", "a-second"]);
    const running = Object.entries(store.all()).find(([, state]) => state.status === "running")?.[0];
    expect(running).toBe(store.liveTurn());
    expect(store.busy()).toBe(true);
  });

  it("updates a recorded turn by a patch, keeps the live index in step, and leaves one the patch declines", () => {
    const { kv } = countingKv();
    const store = new TurnStore(kv);
    expect(store.update("missing", (state) => state)).toBeUndefined();
    store.put("t", turn("running", 1));
    expect(store.update("t", () => undefined)).toEqual(turn("running", 1));
    expect(store.update("t", (state) => ({ ...state, status: "aborted" }))?.status).toBe("aborted");
    expect(store.get("t")?.status).toBe("aborted");
    expect(store.busy()).toBe(false);
  });

  it("does nothing to model records when no turn is live", () => {
    const { kv, map } = countingKv();
    const store = new TurnStore(kv);
    store.put("done", turn("answered", 1));
    store.noteModel((record) => ({ ...record, requests: 1 }));
    expect([...map.keys()].some((key) => key.startsWith("t3flare:turn-model:"))).toBe(false);
  });

  it("drops named turns and their model records, and clears them all", () => {
    const { kv, map } = countingKv();
    const store = new TurnStore(kv);
    store.put("a", turn("running", 1));
    store.noteModel((record) => ({ ...record, requests: 1 }));
    store.put("a", turn("answered", 1));
    store.put("b", turn("queued", 2));
    store.put("c", turn("answered", 3));
    store.drop(["a", "b"]);
    expect(Object.keys(store.all())).toEqual(["c"]);
    expect(store.live()).toEqual([]);
    expect(map.has("t3flare:turn-model:a")).toBe(false);
    store.put("d", turn("running", 4));
    expect(store.clear()).toBe(2);
    expect(store.any()).toBe(false);
    expect(store.live()).toEqual([]);
  });

  it("moves an existing Session's single-value maps over on the first read, once", () => {
    const { kv, map, counts, reset } = countingKv();
    const old: Record<string, TurnState> = {};
    for (let i = 0; i < MANY; i++) old[`t${i}`] = turn("answered", i, i);
    old["live"] = turn("running", MANY);
    map.set("t3flare:turns", old);
    map.set("t3flare:proxy", { t1: { requests: 3 }, live: { requests: 1 } } satisfies Record<string, ProxyRecord>);
    const store = new TurnStore(kv);
    expect(store.liveTurn()).toBe("live");
    expect(map.has("t3flare:turns")).toBe(false);
    expect(map.has("t3flare:proxy")).toBe(false);
    const all = store.withModels(store.all());
    expect(Object.keys(all)).toHaveLength(MANY + 1);
    expect(all["t1"]?.proxy).toEqual({ requests: 3 });
    expect(all["live"]?.proxy).toEqual({ requests: 1 });
    reset();
    // A later instance (a restart) finds nothing to move: the old key's one read is all it costs.
    const again = new TurnStore(kv);
    again.put("live", turn("answered", MANY));
    expect(again.live()).toEqual([]);
    expect(counts.lists).toBe(0);
    expect(counts.gets + counts.puts).toBeLessThan(10);
  });
});
