// @effect-diagnostics globalDate:off
// SPI-1145: an admin call (`/_t3flare/*`) is a request in flight for the idle check, like every other entry point, so a
// long `workspace-call` is not cut short by the idle reset. The forced idle check is the one admin route that is not
// counted: it runs the check itself, and counting it would keep it from ever finding the Environment idle.
import { describe, expect, it } from "vitest";

import * as Idle from "../src/host/idle.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const now = new Date("2026-11-23T12:00:00.000Z");

/** t3's tables the idle check reads, empty: no open work. */
const t3Tables = () => {
  const sql = nodeSqlStorage();
  sql.exec("CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_provider_sessions (session_id TEXT, status TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT, status TEXT, available_at TEXT)");
  sql.exec("CREATE TABLE scheduled_tasks (task_id TEXT, enabled INTEGER, next_run_at TEXT)");
  sql.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)");
  sql.exec(
    "CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, subagent_id TEXT, origin TEXT, child_thread_id TEXT, payload_json TEXT)",
  );
  sql.exec(
    "CREATE TABLE peer_environment_links (environment_id TEXT PRIMARY KEY, last_reached_at TEXT, last_error TEXT)",
  );
  return sql;
};

const idle = () =>
  Object.assign(Idle.activity, { sockets: 0, inFlight: 0, idleSince: now.getTime() - 120_000, unreadableUntil: 0 });

const admin = (method: string, path: string) => new Request(`https://env.example${path}`, { method });

/** A handler that answers only when `finish` is called: an admin call held open. */
const heldOpen = () => {
  let finish!: (response: Response) => void;
  const answer = new Promise<Response>((resolve) => (finish = resolve));
  return { handle: () => answer, finish };
};

describe("admin calls and the idle check", () => {
  it("names the forced idle check as the one admin route not counted", () => {
    expect(Idle.isIdleCheckRoute(admin("POST", "/_t3flare/idle-check"))).toBe(true);
    expect(Idle.isIdleCheckRoute(admin("POST", "/_t3flare/idle-check?force=1"))).toBe(true);
    expect(Idle.isIdleCheckRoute(admin("GET", "/_t3flare/idle-check"))).toBe(false);
    expect(Idle.isIdleCheckRoute(admin("POST", "/_t3flare/agents/workspace-call"))).toBe(false);
    expect(Idle.isIdleCheckRoute(admin("POST", "/_t3flare/restart?mode=abort"))).toBe(false);
  });

  it("keeps the Environment up while an admin call is in flight, and lets it reset once the call ends", async () => {
    const sql = t3Tables();
    idle();
    expect(Idle.idleVerdict(sql, now).reset).toBe(true);

    const call = heldOpen();
    const answered = Idle.countedAdminRequest(admin("POST", "/_t3flare/agents/workspace-call"), call.handle);
    expect(Idle.activity.inFlight).toBe(1);
    expect(Idle.idleVerdict(sql, now, 0)).toEqual({ reset: false, why: "1 requests in flight" });

    call.finish(new Response("ok"));
    expect(await (await answered).text()).toBe("ok");
    expect(Idle.activity.inFlight).toBe(0);
    expect(Idle.idleVerdict(sql, new Date(Date.now()), 0).reset).toBe(true);
  });

  it("ends the count when the admin call throws", async () => {
    idle();
    await expect(
      Idle.countedAdminRequest(admin("POST", "/_t3flare/agents/workspace-call"), () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(Idle.activity.inFlight).toBe(0);
  });

  it("does not count the forced idle check, so it still resets an otherwise idle Environment", async () => {
    const sql = t3Tables();
    idle();
    const verdict = await Idle.countedAdminRequest(admin("POST", "/_t3flare/idle-check?force=1"), async () =>
      Response.json(Idle.idleVerdict(sql, now, 0)),
    );
    expect(await verdict.json()).toMatchObject({ reset: true });
  });
});
