// SPI-1389: what the owner-only guard reads of t3's projections: a queued run's message, and whether a delegated task's
// threads (its own and those under it) hold a queued answer to a parked question. Over SQLite with t3's columns.
import { describe, expect, it } from "vitest";

import { ownerOnlyLookupsOf } from "../src/mcp/ownerOnlyLookups.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const ANSWER = "async-answer:runtime-request:codex:t3flare-park:1";

/** t3's runs and subagents projections, with the columns the lookups read. */
const projections = () => {
  const sql = nodeSqlStorage();
  sql.exec(
    "CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT, payload_json TEXT)",
  );
  sql.exec(
    "CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, thread_id TEXT, child_thread_id TEXT)",
  );
  const run = (runId: string, threadId: string, status: string, userMessageId: string) =>
    sql.exec(
      "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?)",
      runId,
      threadId,
      status,
      JSON.stringify({ id: runId, userMessageId }),
    );
  const task = (taskId: string, threadId: string, childThreadId: string | null) =>
    sql.exec("INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?, ?)", taskId, threadId, childThreadId);
  return { sql, run, task };
};

describe("the owner-only guard's lookups (SPI-1389)", () => {
  it("names a queued run's message, and nothing for an unknown run or before t3 made its tables", () => {
    const t3 = projections();
    t3.run("run-1", "thread-a", "queued", ANSWER);
    const lookups = ownerOnlyLookupsOf(t3.sql);
    expect(lookups.queuedMessageOf("run-1")).toBe(ANSWER);
    expect(lookups.queuedMessageOf("run-9")).toBeUndefined();
    expect(ownerOnlyLookupsOf(nodeSqlStorage()).queuedMessageOf("run-1")).toBeUndefined();
  });

  it("finds a queued park answer in a task's thread or a thread under it, and not a sent one or an ordinary message", () => {
    const t3 = projections();
    // parent → task-1 (thread-1) → task-2 (thread-2), and task-3 (thread-3) beside them.
    t3.task("task-1", "parent", "thread-1");
    t3.task("task-2", "thread-1", "thread-2");
    t3.task("task-3", "parent", "thread-3");
    t3.task("task-remote", "parent", null);
    t3.run("run-2", "thread-2", "queued", ANSWER);
    t3.run("run-3", "thread-3", "completed", ANSWER);
    t3.run("run-4", "thread-3", "queued", "message-7");
    const lookups = ownerOnlyLookupsOf(t3.sql);
    expect(lookups.taskHoldsParkAnswer("task-1")).toBe(true);
    expect(lookups.taskHoldsParkAnswer("task-2")).toBe(true);
    expect(lookups.taskHoldsParkAnswer("task-3")).toBe(false);
    expect(lookups.taskHoldsParkAnswer("task-remote")).toBe(false);
    expect(ownerOnlyLookupsOf(nodeSqlStorage()).taskHoldsParkAnswer("task-1")).toBe(false);
  });
});
