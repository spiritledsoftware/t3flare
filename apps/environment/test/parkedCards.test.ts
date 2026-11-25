// SPI-1389: a parked card's record, kept in the Environment DO's SQLite so it outlives the CLI process, its Container
// and the Environment's own reset; and the one-time allowance the Owner's answer leaves for the repeated call.
import { describe, expect, it } from "vitest";

import { argsHashOf } from "../src/mcp/canonical.ts";
import { parkedCards, type ParkedCard } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const NOTE = { tool: "fixture/fixture_note", argsHash: "h1" };
const card = (over: Partial<ParkedCard> = {}): ParkedCard => ({
  id: "runtime-request:claudeAgent:t3flare-park:p1",
  thread: "thread-1",
  kind: "tool",
  title: "Allow fixture: fixture_note?",
  call: NOTE,
  parkedAt: 1000,
  ...over,
});

describe("the parked cards (SPI-1389)", () => {
  it("keeps a parked card across a new store over the same SQLite (an Environment reset)", () => {
    const sql = nodeSqlStorage();
    parkedCards(sql).park(card({ nativeSession: "s-1" }));
    expect(parkedCards(sql).get(card().id)).toEqual(card({ nativeSession: "s-1" }));
    expect(parkedCards(sql).get("other")).toBeUndefined();
  });

  it("an allow leaves one allowance for the same call on the thread, taken once", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    expect(store.answer(card().id, "accept")).toEqual(card());
    expect(store.get(card().id)).toBeUndefined();
    // Another argument hash, tool, kind or thread does not match, and does not use it up.
    expect(store.take("thread-1", "tool", { ...NOTE, argsHash: "h2" })).toBeUndefined();
    expect(store.take("thread-1", "tool", { ...NOTE, tool: "fixture/other" })).toBeUndefined();
    expect(store.take("thread-1", "native", NOTE)).toBeUndefined();
    expect(store.take("thread-2", "tool", NOTE)).toBeUndefined();
    expect(store.take("thread-1", "tool", NOTE)).toEqual({ forSession: false });
    expect(store.take("thread-1", "tool", NOTE)).toBeUndefined();
  });

  it("allow for the session says so; a decline, or a card with no call, leaves none; a second answer finds nothing", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    store.park(card({ id: "p2", call: { ...NOTE, argsHash: "h2" } }));
    const { call: _call, ...uncalled } = card({ id: "p3", kind: "native" });
    store.park(uncalled);
    store.answer(card().id, "acceptForSession");
    expect(store.answer("p2", "decline")).toMatchObject({ id: "p2" });
    expect(store.answer("p2", "accept")).toBeUndefined();
    expect(store.answer("p3", "accept")).toMatchObject({ id: "p3" });
    expect(store.take("thread-1", "tool", { ...NOTE, argsHash: "h2" })).toBeUndefined();
    expect(store.take("thread-1", "tool", NOTE)).toEqual({ forSession: true });
  });

  it("drops a thread's unused allowances, and discards a card never shown", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card());
    store.park(card({ id: "p3", thread: "thread-3" }));
    store.answer(card().id, "accept");
    store.answer("p3", "accept");
    store.dropAllowances("thread-1");
    expect(store.take("thread-1", "tool", NOTE)).toBeUndefined();
    expect(store.take("thread-3", "tool", NOTE)).toEqual({ forSession: false });
    store.park(card({ id: "p4" }));
    store.discard("p4");
    expect(store.get("p4")).toBeUndefined();
  });

  it("names the CLI sessions parked cards wait on, once each, for session pruning to keep", () => {
    const store = parkedCards(nodeSqlStorage());
    store.park(card({ nativeSession: "s-1" }));
    store.park(card({ id: "p2", nativeSession: "s-1" }));
    store.park(card({ id: "p3", nativeSession: "s-2" }));
    store.park(card({ id: "p4" }));
    expect([...store.nativeSessions()].sort()).toEqual(["s-1", "s-2"]);
    store.answer(card().id, "decline");
    store.answer("p2", "decline");
    expect(store.nativeSessions()).toEqual(["s-2"]);
  });

  it("hashes arguments by their canonical JSON: key order does not matter, values do", async () => {
    expect(await argsHashOf({ a: 1, b: [2, 3] })).toBe(await argsHashOf({ b: [2, 3], a: 1 }));
    expect(await argsHashOf({ a: 1 })).not.toBe(await argsHashOf({ a: 2 }));
    expect(await argsHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
