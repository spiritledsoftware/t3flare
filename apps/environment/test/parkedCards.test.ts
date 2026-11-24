// SPI-1389: a parked card's record, kept in the Environment DO's SQLite so it outlives the CLI process, its Container
// and the Environment's own reset; and the one-time allowance the Owner's answer leaves for the repeated call.
import { describe, expect, it } from "vitest";

import { argsHashOf, parkedCards, type ParkedCard } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const card = (over: Partial<ParkedCard> = {}): ParkedCard => ({
  id: "runtime-request:claudeAgent:t3flare-park:p1",
  thread: "thread-1",
  kind: "tool",
  tool: "fixture/fixture_note",
  argsHash: "h1",
  title: "Allow fixture: fixture_note?",
  parkedAt: 1000,
  ...over,
});

describe("the parked cards (SPI-1389)", () => {
  it("keeps a parked card across a new store over the same SQLite (an Environment reset)", () => {
    const sql = nodeSqlStorage();
    parkedCards(sql).park(card({ changeId: "change-1" }));
    expect(parkedCards(sql).get(card().id)).toEqual(card({ changeId: "change-1" }));
    expect(parkedCards(sql).get("other")).toBeUndefined();
    expect(parkedCards(sql).threads()).toEqual(["thread-1"]);
  });

  it("an allow leaves one allowance for the same tool and arguments on the thread, taken once", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    expect(store.answer(card().id, "accept")).toEqual(card());
    expect(store.get(card().id)).toBeUndefined();
    expect(store.threads()).toEqual([]);
    // Another argument hash, tool, kind or thread does not match, and does not use it up.
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h2")).toBeUndefined();
    expect(store.take("thread-1", "tool", "fixture/other", "h1")).toBeUndefined();
    expect(store.take("thread-1", "native", "fixture/fixture_note", "h1")).toBeUndefined();
    expect(store.take("thread-2", "tool", "fixture/fixture_note", "h1")).toBeUndefined();
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h1")).toEqual({ forSession: false });
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h1")).toBeUndefined();
  });

  it("allow for the session says so; a decline leaves none; a second answer finds nothing", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    store.park(card({ id: "p2", argsHash: "h2" }));
    store.answer(card().id, "acceptForSession");
    expect(store.answer("p2", "decline")).toMatchObject({ id: "p2" });
    expect(store.answer("p2", "accept")).toBeUndefined();
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h2")).toBeUndefined();
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h1")).toEqual({ forSession: true });
  });

  it("drops a thread's unused allowances when its answer turn ends", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    store.park(card({ id: "p3", thread: "thread-3" }));
    store.answer(card().id, "accept");
    store.answer("p3", "accept");
    store.dropAllowances("thread-1");
    expect(store.take("thread-1", "tool", "fixture/fixture_note", "h1")).toBeUndefined();
    expect(store.take("thread-3", "tool", "fixture/fixture_note", "h1")).toEqual({ forSession: false });
  });

  it("hashes arguments by their canonical JSON: key order does not matter, values do", async () => {
    expect(await argsHashOf({ a: 1, b: [2, 3] })).toBe(await argsHashOf({ b: [2, 3], a: 1 }));
    expect(await argsHashOf({ a: 1 })).not.toBe(await argsHashOf({ a: 2 }));
    expect(await argsHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
