// T-caller (plan §5, D3), M3 (SPI-1198): the Settings server's caller is derived by the Environment and fails closed.
// A Durable thread's modes come from the adapter's record, written at `open` and `submitTurn` and cleared at
// unregister; a write from a mode-less thread is refused while its reads run. Where the thread came from is not read:
// Linked work writes as the owner's own thread does (ADR-0035's SPI-1356 refinement).
import { describe, expect, it } from "vitest";

import { harnessStore } from "../src/harness/store.ts";
import { McpHost } from "../src/mcp/host.ts";
import {
  DURABLE_AGENT,
  durableModeRecord,
  durableModes,
  forgetDurableModes,
  noteDurableModes,
} from "../src/provider/threadCaller.ts";
import { settingsChanges } from "../src/settings/changes.ts";
import type { OwnCaller } from "../src/settings/caller.ts";
import { NO_MODES_REFUSAL, settingsCall } from "../src/settings/server.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

describe("the Durable mode record", () => {
  it("follows open and submitTurn, and is cleared at unregister by its own session only", () => {
    const session = {};
    noteDurableModes("thread-m", { runtimeMode: "approval-required", interactionMode: "default" }, session);
    expect(durableModes("thread-m")).toEqual({ runtimeMode: "approval-required", interactionMode: "default" });
    // The next turn's modes replace the open's.
    noteDurableModes("thread-m", { runtimeMode: "full-access", interactionMode: "plan" }, session);
    expect(durableModes("thread-m")).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
    // A newer session for the thread took over: the old one's unregister leaves the new record.
    const newer = {};
    noteDurableModes("thread-m", { runtimeMode: "auto-accept-edits", interactionMode: "default" }, newer);
    forgetDurableModes("thread-m", session);
    expect(durableModes("thread-m")?.runtimeMode).toBe("auto-accept-edits");
    forgetDurableModes("thread-m", newer);
    expect(durableModes("thread-m")).toBeUndefined();
  });
});

describe("the adapter's part of the record (durableModeRecord, as makePiDurableAdapter wires it)", () => {
  it("notes each thread at open and each submitTurn, and forgets all of them, and only them, at unregister", () => {
    // As the adapter's openSession: one record per provider session; `open` (register) and `submitTurn` note; the
    // scope's finalizer (unregister) forgets.
    const first = durableModeRecord();
    first.note("thread-a", { runtimeMode: "approval-required", interactionMode: "default" });
    first.note("thread-b", { runtimeMode: "full-access", interactionMode: "default" });
    first.note("thread-a", { runtimeMode: "full-access", interactionMode: "plan" });
    expect(durableModes("thread-a")).toEqual({ runtimeMode: "full-access", interactionMode: "plan" });
    const second = durableModeRecord();
    second.note("thread-b", { runtimeMode: "auto-accept-edits", interactionMode: "default" });
    first.forgetAll();
    expect(durableModes("thread-a")).toBeUndefined();
    expect(durableModes("thread-b")).toEqual({ runtimeMode: "auto-accept-edits", interactionMode: "default" });
    second.forgetAll();
    expect(durableModes("thread-b")).toBeUndefined();
  });
});

describe("a Settings server write from t3flare's own agent", () => {
  const setup = () => {
    const map = new Map<string, unknown>();
    const kv = {
      get: <T>(key: string) => map.get(key) as T | undefined,
      put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
      delete: (key: string) => map.delete(key),
    };
    const store = harnessStore(kv);
    const host: McpHost = new McpHost({
      kv,
      engine: undefined,
      settings: () => store.load(),
      settingsServer: (input) =>
        settingsCall(
          {
            ops: { store, mcp: host, now: () => 0 },
            modes: (caller) => (caller.thread === undefined ? undefined : durableModes(caller.thread)),
            changes: settingsChanges(nodeSqlStorage(), () => 0),
            origin: () => undefined,
          },
          input,
        ),
    });
    const caller = (thread: string): OwnCaller => ({ door: "own", thread, agent: DURABLE_AGENT });
    const call = (thread: string, tool: string, args: Record<string, unknown>) =>
      host.call({ server: "settings", tool, args, caller: caller(thread) });
    return { store, call };
  };
  // Each a free change (it lowers the idle time or the budget), at the revision the one before left.
  const write = (revision: number) => ({
    expectedRevision: revision,
    settings: revision === 0 ? { containerIdleMinutes: 1 } : { containerBudget: 3 - revision },
  });
  const text = (answer: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) =>
    answer.kind === "result" ? answer.text : answer.message;

  it("a thread with no mode record: its reads run and its write is refused; with one it runs", async () => {
    const run = setup();
    expect(await run.call("own", "get_settings", { entity: "environment" })).toMatchObject({
      kind: "result",
      isError: false,
    });
    expect(text(await run.call("own", "change_environment", write(0)))).toBe(NO_MODES_REFUSAL);
    const owner = {};
    noteDurableModes("own", { runtimeMode: "full-access", interactionMode: "default" }, owner);
    expect(await run.call("own", "change_environment", write(0))).toMatchObject({ kind: "result", isError: false });
    forgetDurableModes("own", owner);
    expect(run.store.loadEnvironment().revision).toBe(1);
  });

  it("Linked work, and a thread t3's projection has no row for, write as the owner's own thread (SPI-1356)", async () => {
    const run = setup();
    const owner = {};
    const threads = ["linked", "child-of-linked", "missing"];
    for (const thread of threads)
      noteDurableModes(thread, { runtimeMode: "full-access", interactionMode: "default" }, owner);
    try {
      for (const [index, thread] of threads.entries())
        expect(await run.call(thread, "change_environment", write(index))).toMatchObject({
          kind: "result",
          isError: false,
        });
    } finally {
      for (const thread of threads) forgetDurableModes(thread, owner);
    }
    expect(run.store.loadEnvironment().revision).toBe(3);
  });
});
