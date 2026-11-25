// @effect-diagnostics globalDate:off
// The Sweep's Purges of a deleted project and its worktree (ADR-0044 §4, found on the purge Stage): a deleted worktree
// thread is under both Workspaces, so its Session is destroyed once, and only one `sweep.purge` entry counts it, as a
// Purge now's set does (workspaceActions.ts).
import { afterEach, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { isSubrequestLimit, sweep, type PurgeReport } from "../src/agents/deletion.ts";
import { sweptSessionsIn } from "../src/agents/sweptSessions.ts";
import type { WorkspaceRecord } from "../src/agents/workspaces.ts";
import { DAY, record, t3Tables } from "./fixtures/workspaces.ts";

const NOW = 30 * DAY;
const GRACE_MS = 3 * 60_000;

/** A namespace whose objects answer `methods`, each `get` by the name it was asked for. */
const namespace = (methods: (name: string) => Record<string, unknown>) => ({
  idFromName: (name: string) => name,
  get: (name: string) => methods(name),
});

const servicesWith = (
  rows: Array<WorkspaceRecord>,
  destroyedSessions: Array<string>,
  workspaceDestroy: () => Promise<unknown> = async () => undefined,
) => {
  const registry = {
    list: () => rows,
    get: (id: string) => rows.find((row) => row.id === id),
    setState: (id: string, state: WorkspaceRecord["state"]) => {
      const at = rows.findIndex((row) => row.id === id);
      rows[at] = { ...rows[at]!, state };
    },
    setLastError: () => undefined,
    setUnreferencedSince: () => undefined,
    remove: (id: string) =>
      void rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      ),
  };
  // SAFETY: a stand-in for the few registry and namespace methods the Sweep calls, not the whole EnvironmentServices.
  bindEnvironmentServices({
    workspaces: registry,
    agents: {
      SESSIONS: namespace((name) => ({ destroy: async () => void destroyedSessions.push(name) })),
      WORKSPACES: namespace(() => ({ terminalState: async () => ({ keys: [] }), destroy: workspaceDestroy })),
    },
  } as unknown as EnvironmentServices);
};

/** The swept Sessions kept in `swept`, as the Environment DO keeps them in its storage. */
const sweptIn = (swept: Set<string>) => ({
  has: (thread: string) => swept.has(thread),
  add: (thread: string) => void swept.add(thread),
  keepOnly: (threads: ReadonlySet<string>) => {
    for (const thread of swept) if (!threads.has(thread)) swept.delete(thread);
  },
});

/** A deleted project `p1` at `/w/app` with `threads` deleted under it, and its Workspace marked unreferenced. */
const deletedProject = (threads: ReadonlyArray<string>) => {
  const sql = t3Tables();
  const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
  sql.exec(
    "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)",
    deletedAt,
    deletedAt,
  );
  for (const thread of threads)
    sql.exec(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES (?, 'p1', 'a thread', ?, ?)",
      thread,
      deletedAt,
      JSON.stringify({ worktreePath: null }),
    );
  return sql;
};

// The binding outlives each test: unbind it, so the default access finds no services.
// SAFETY: `undefined` is the binding's unset state, which its type does not name.
afterEach(() => bindEnvironmentServices(undefined as unknown as EnvironmentServices));

describe("the Sweep's Purge of a deleted project with a worktree thread", () => {
  it("destroys the worktree thread's Session once, and counts it in one sweep.purge entry", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec(
      "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)",
      deletedAt,
      deletedAt,
    );
    sql.exec(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES ('t1', 'p1', 'wt thread', ?, ?)",
      deletedAt,
      JSON.stringify({ worktreePath: "/w/.wt/app/t3-1" }),
    );
    const marked = NOW - 5 * 60_000;
    const rows = [
      record({ id: "app", unreferencedSince: marked }),
      record({ id: ".wt/app/t3-1", kind: "worktree", parent: "app", branch: "t3-1", unreferencedSince: marked }),
    ];
    const destroyedSessions: Array<string> = [];
    servicesWith(rows, destroyedSessions);
    const entries: Array<PurgeReport> = [];
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      undefined,
      { get: () => NOW - DAY, set: () => undefined },
      (purged) => void entries.push(purged),
    );
    expect(report.ok).toBe(true);
    expect(entries.map((entry) => entry.id).toSorted()).toEqual([".wt/app/t3-1", "app"]);
    expect(destroyedSessions).toEqual(["thread:t1"]);
    expect(entries.flatMap((entry) => entry.sessionsDestroyed)).toEqual(["t1"]);
  });

  it("leaves a Session an earlier run already destroyed, and records the ones it destroys", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec(
      "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)",
      deletedAt,
      deletedAt,
    );
    for (const [thread, worktree] of [
      ["t1", "/w/.wt/app/t3-1"],
      ["t2", null],
    ] as const) {
      sql.exec(
        "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES (?, 'p1', 'a thread', ?, ?)",
        thread,
        deletedAt,
        JSON.stringify({ worktreePath: worktree }),
      );
    }
    const marked = NOW - 5 * 60_000;
    const rows = [
      record({ id: "app", unreferencedSince: marked }),
      record({ id: ".wt/app/t3-1", kind: "worktree", parent: "app", branch: "t3-1", unreferencedSince: marked }),
    ];
    const destroyedSessions: Array<string> = [];
    servicesWith(rows, destroyedSessions);
    // t1's Session went in an earlier run (its date comes a few seconds before its Workspaces').
    const swept = new Set(["t1"]);
    const entries: Array<PurgeReport> = [];
    await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
      (purged) => void entries.push(purged),
    );
    expect(destroyedSessions).toEqual(["thread:t2"]);
    expect(entries.flatMap((entry) => entry.sessionsDestroyed)).toEqual(["t2"]);
    expect([...swept].toSorted()).toEqual(["t1", "t2"]);
  });

  it("counts a failed purge's Sessions in the run's Session pass, not lost to its record", async () => {
    const sql = t3Tables();
    const deletedAt = new Date(NOW - 10 * 60_000).toISOString();
    sql.exec(
      "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, deleted_at) VALUES ('p1', 'app', '/w/app', ?, ?)",
      deletedAt,
      deletedAt,
    );
    sql.exec(
      "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, deleted_at, payload_json) VALUES ('t2', 'p1', 'a thread', ?, ?)",
      deletedAt,
      JSON.stringify({ worktreePath: null }),
    );
    const rows = [record({ id: "app", unreferencedSince: NOW - 5 * 60_000 })];
    // The Workspace DO's destroy fails after its Sessions went: the row stays `deleting`.
    servicesWith(rows, [], async () => Promise.reject(new Error("Workspace DO unreachable")));
    const swept = new Set<string>();
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect(rows[0]?.state).toBe("deleting");
    expect(report.sessions).toEqual(["t2"]);
  });

  it("destroys every deleted thread's Session that is due in one run, past fifty (SPI-1366: no count per run)", async () => {
    const threads = Array.from({ length: 60 }, (_, n) => `t${n}`);
    const sql = deletedProject(threads);
    // The Workspace is kept (purging off for it is not this test's): its Sessions go by the Session pass.
    const rows = [record({ id: "app" })];
    const destroyedSessions: Array<string> = [];
    servicesWith(rows, destroyedSessions);
    const swept = new Set<string>();
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect(new Set(report.sessions)).toEqual(new Set(threads));
    expect(swept.size).toBe(60);
  });

  it("forgets a swept thread t3 no longer holds, and keeps the rest (SPI-1366: no count of swept threads)", async () => {
    const sql = deletedProject(["t1"]);
    servicesWith([record({ id: "app" })], []);
    // t1's Session went in an earlier run; t0's thread is gone from t3's projection, so nothing can ask for it again.
    const swept = new Set(["t0", "t1"]);
    await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect([...swept]).toEqual(["t1"]);
  });

  it("forgets nothing on a dry run", async () => {
    const sql = deletedProject([]);
    servicesWith([record({ id: "app" })], []);
    const swept = new Set(["t0"]);
    await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: true },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect([...swept]).toEqual(["t0"]);
  });

  it("keeps one key a swept thread, moves an old list into them, and forgets with no delete inside the list's cursor", () => {
    const map = new Map<string, unknown>([["t3flare:swept-sessions", ["t0", "t1"]]]);
    let listing = false;
    const kv = {
      get: <T>(key: string) => map.get(key) as T | undefined,
      put: <T>(key: string, value: T) => void map.set(key, value),
      delete: (key: string) => {
        // workerd's list is a live cursor over storage: a write inside it is what this guards against.
        if (listing) throw new Error("deleted inside the list's cursor");
        return map.delete(key);
      },
      *list<T>(options: { readonly prefix: string }): Iterable<[string, T]> {
        listing = true;
        try {
          for (const [key, value] of [...map].toSorted(([a], [b]) => a.localeCompare(b)))
            if (key.startsWith(options.prefix)) yield [key, value as T];
        } finally {
          listing = false;
        }
      },
    };
    const swept = sweptSessionsIn(kv);
    expect(swept.has("t0")).toBe(true);
    expect(map.has("t3flare:swept-sessions")).toBe(false);
    swept.add("t2");
    swept.keepOnly(new Set(["t1"]));
    expect([...map.keys()]).toEqual(["t3flare:swept-session:t1"]);
  });

  it("stops its Session pass at Workers' subrequest limit and comes back a minute later, not a day (SPI-1366)", async () => {
    const threads = Array.from({ length: 10 }, (_, n) => `t${n}`);
    const sql = deletedProject(threads);
    const destroyedSessions: Array<string> = [];
    let budgetRead = false;
    bindEnvironmentServices({
      workspaces: {
        list: () => [record({ id: "app" })],
        get: () => undefined,
        setUnreferencedSince: () => undefined,
        setState: () => undefined,
        setLastError: () => undefined,
      },
      agents: {
        SESSIONS: namespace((name) => ({
          destroy: async () => {
            if (destroyedSessions.length >= 3) throw new Error("Too many subrequests.");
            destroyedSessions.push(name);
          },
        })),
        WORKSPACES: namespace(() => ({ terminalState: async () => ({ keys: [] }) })),
        CONTAINER_BUDGET: namespace(() => ({ state: async () => ((budgetRead = true), { leases: [] }) })),
      },
    } as unknown as EnvironmentServices);
    const swept = new Set<string>();
    const report = await sweep(
      sql,
      { purging: true, graceMs: GRACE_MS, graceDays: 7, overridden: true, provisioningMs: 80 * 60_000, dry: false },
      NOW,
      sweptIn(swept),
      { get: () => NOW - DAY, set: () => undefined },
    );
    expect(report.ok).toBe(true);
    expect(report.sessions).toHaveLength(3);
    expect(swept.size).toBe(3);
    // The rest wait for the next pass, a minute out; the cost guard, another subrequest, waits for it too.
    expect(Date.parse(report.nextDue)).toBe(NOW + 60_000);
    expect(budgetRead).toBe(false);
  });
});

/**
 * Services whose Durable Object calls (a Session's or Workspace's `destroy`, a Workspace's `terminalState`, the budget's
 * `state`) fail with Workers' subrequest error once `limit` of them ran in one invocation; `invocation()` starts the next.
 */
const limitedServices = (rows: Array<WorkspaceRecord>, limit: number) => {
  let calls = 0;
  const destroyedSessions: Array<string> = [];
  const marks: Array<string> = [];
  let budgetReads = 0;
  const call = async <T>(run: () => T): Promise<T> => {
    // The message community reports give for Durable Object calls past the limit (SPI-1379).
    if (calls >= limit) throw new Error("Error: Too many API requests by single worker invocation.");
    calls += 1;
    return run();
  };
  bindEnvironmentServices({
    workspaces: {
      list: () => rows,
      get: (id: string) => rows.find((row) => row.id === id),
      setState: (id: string, state: WorkspaceRecord["state"], fields: { readonly sessionsPurged?: number } = {}) => {
        const at = rows.findIndex((row) => row.id === id);
        rows[at] = {
          ...rows[at]!,
          state,
          ...(fields.sessionsPurged === undefined ? {} : { sessionsPurged: fields.sessionsPurged }),
        };
      },
      setLastError: () => undefined,
      setUnreferencedSince: (id: string, at: number | null) => void (at === null || marks.push(id)),
      remove: (id: string) =>
        void rows.splice(
          rows.findIndex((row) => row.id === id),
          1,
        ),
    },
    agents: {
      SESSIONS: namespace((name) => ({ destroy: () => call(() => void destroyedSessions.push(name)) })),
      WORKSPACES: namespace(() => ({
        terminalState: () => call(() => ({ keys: [] })),
        destroy: () => call(() => undefined),
      })),
      CONTAINER_BUDGET: namespace(() => ({ state: () => call(() => ((budgetReads += 1), { leases: [] })) })),
    },
  } as unknown as EnvironmentServices);
  return {
    destroyedSessions,
    marks,
    budgetReads: () => budgetReads,
    invocation: () => void (calls = 0),
  };
};

const SWEEP_ON = {
  purging: true,
  graceMs: GRACE_MS,
  graceDays: 7,
  overridden: true,
  provisioningMs: 80 * 60_000,
  dry: false,
} as const;

describe("the Sweep's purge loop at Workers' subrequest limit (SPI-1379)", () => {
  it("records the Sessions a failed purge destroyed, stops there, and comes back a minute later", async () => {
    const threads = Array.from({ length: 10 }, (_, n) => `t${n}`);
    const sql = deletedProject(threads);
    const rows = [record({ id: "app", unreferencedSince: NOW - 5 * 60_000 })];
    // One subrequest goes to the Workspace's open Terminals; four Sessions go before the limit.
    const services = limitedServices(rows, 5);
    const swept = new Set<string>();
    const report = await sweep(sql, SWEEP_ON, NOW, sweptIn(swept), { get: () => NOW - DAY, set: () => undefined });
    expect(report.ok).toBe(true);
    expect(rows[0]?.state).toBe("deleting");
    expect(report.purged).toMatchObject([{ id: "app", destroyed: false, sessionsDestroyed: ["t0", "t1", "t2", "t3"] }]);
    expect([...swept]).toEqual(["t0", "t1", "t2", "t3"]);
    // Counted once, in the run's Sessions, and no other destroy tried past the limit.
    expect(report.sessions).toEqual(["t0", "t1", "t2", "t3"]);
    expect(services.destroyedSessions).toHaveLength(4);
    expect(Date.parse(report.nextDue)).toBe(NOW + 60_000);
  });

  it("reads no budget once the purge loop hit the limit, though no Session is due", async () => {
    const sql = deletedProject(["t0", "t1"]);
    const rows = [record({ id: "app", unreferencedSince: NOW - 5 * 60_000 })];
    // The Terminals read and both Sessions: the Workspace's own destroy is past the limit.
    const services = limitedServices(rows, 3);
    const report = await sweep(sql, SWEEP_ON, NOW, sweptIn(new Set()), { get: () => NOW - DAY, set: () => undefined });
    expect(report.ok).toBe(true);
    expect(report.purged).toMatchObject([{ id: "app", destroyed: false }]);
    expect(report.costGuard).toEqual([]);
    expect(services.budgetReads()).toBe(0);
  });

  it("purges no other Workspace past the limit, and still writes the run's marks", async () => {
    const sql = deletedProject(["t0"]);
    const rows = [
      record({ id: "app", unreferencedSince: NOW - 5 * 60_000 }),
      record({ id: "other", state: "deleting" }),
      record({ id: "loose" }),
    ];
    // Both `ready` rows' Terminals reads: the first Session's destroy is past the limit.
    const services = limitedServices(rows, 2);
    const report = await sweep(sql, SWEEP_ON, NOW, sweptIn(new Set()), { get: () => NOW - DAY, set: () => undefined });
    expect(report.purged.map((purged) => purged.id)).toEqual(["app"]);
    expect(rows.find((row) => row.id === "other")?.state).toBe("deleting");
    expect(services.marks).toEqual(["loose"]);
  });

  it("finishes a Workspace with more deleted Sessions than one invocation's limit across several Sweeps", async () => {
    const threads = Array.from({ length: 25 }, (_, n) => `t${n}`);
    const sql = deletedProject(threads);
    const rows = [record({ id: "app", unreferencedSince: NOW - 5 * 60_000 })];
    const services = limitedServices(rows, 10);
    const swept = new Set<string>();
    const progress: Array<number> = [];
    const entries: Array<PurgeReport> = [];
    for (let run = 0; run < 5 && rows.length > 0; run++) {
      services.invocation();
      await sweep(
        sql,
        SWEEP_ON,
        NOW + run * 60_000,
        sweptIn(swept),
        { get: () => NOW - DAY, set: () => undefined },
        (purged) => void entries.push(purged),
      );
      progress.push(swept.size);
    }
    expect(rows).toEqual([]);
    // Each Sweep recorded what it destroyed; none destroyed a Session twice.
    expect(progress).toEqual([9, 19, 25]);
    expect(services.destroyedSessions).toHaveLength(25);
    expect(new Set(services.destroyedSessions).size).toBe(25);
    // One `sweep.purge` entry, counting every Session destroyed for the Workspace, the earlier Sweeps' too (ADR-0044 §4).
    expect(entries.map((entry) => [entry.id, entry.sessions])).toEqual([["app", 25]]);
  });
});

describe("isSubrequestLimit", () => {
  it("matches the documented message, and the one reported for binding and Durable Object calls", () => {
    expect(isSubrequestLimit(new Error("Error: Too many subrequests."))).toBe(true);
    expect(isSubrequestLimit(new Error("Error: Too many API requests by single worker invocation."))).toBe(true);
    expect(isSubrequestLimit("Workspace DO unreachable")).toBe(false);
  });
});
