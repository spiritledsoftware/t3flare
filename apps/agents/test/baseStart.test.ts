// @effect-diagnostics globalTimers:off
// A Workspace's Container start from the Base snapshot (SPI-1333, ADR-0047 §3, §6): what a fresh start starts from
// (`pickBase`, over every state of the Builder's record and both settings), the Builder asked again when its record is
// older than the start's settings, the wait before computer's connect (`waitForBase`, `BaseWaitBackend`), and the fast
// fallback to the Workspace image when the platform refuses the snapshot (`startFromBase`).
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import {
  type BaseBuildRecord,
  type BaseSnapshot,
  EMPTY_ENVIRONMENT,
  resolveEnvironment,
} from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import {
  type BasePick,
  type BaseSettings,
  BaseWaitBackend,
  baseIdOf,
  isSnapshotRefusal,
  launchFrom,
  startSpec,
  pickBase,
  planBase,
  startFromBase,
  waitForBase,
  waitLimitMs,
} from "../src/workspace/baseStart.ts";

const IMAGE = "registry/workspace@sha256:2222";
const OLD_IMAGE = "registry/workspace@sha256:1111";
const KEY = "k".repeat(64);
const OLD_KEY = "o".repeat(64);
const AT = Date.parse("2026-11-22T10:00:00.000Z");

const snapshot = (change: Partial<BaseSnapshot> = {}): BaseSnapshot => ({
  id: "snap-1",
  size: 34_500_000,
  key: KEY,
  imageDigest: IMAGE,
  builtAt: AT,
  tookMs: 60_000,
  ...change,
});

const SETTINGS: BaseSettings = {
  ...resolveEnvironment(EMPTY_ENVIRONMENT),
  revision: 5,
  imageSetup: "apt-get install -y jq\n",
};

const record = (change: Partial<BaseBuildRecord> = {}): BaseBuildRecord => ({
  key: KEY,
  revision: 5,
  state: "ready",
  good: snapshot(),
  at: AT,
  ...change,
});
const building = (good: BaseSnapshot | null, change: Partial<BaseBuildRecord> = {}): BaseBuildRecord =>
  record({ state: "building", phase: "running", since: AT, reason: "the Image setup changed", good, ...change });

describe("pickBase", () => {
  it("starts from the image, asking nothing, with no Image setup and no Global mise config", () => {
    expect(pickBase(record(), { ...SETTINGS, imageSetup: "", globalMiseConfig: "" }, IMAGE)).toMatchObject({
      kind: "image",
    });
    expect(pickBase(undefined, { ...SETTINGS, imageSetup: "", globalMiseConfig: "" }, IMAGE)).toMatchObject({
      kind: "image",
    });
    expect(pickBase(undefined, { ...SETTINGS, imageSetup: "", globalMiseConfig: "" }, IMAGE)).not.toHaveProperty(
      "missing",
    );
  });

  it("builds for a Global mise config alone", () => {
    expect(
      pickBase(record(), { ...SETTINGS, imageSetup: "", globalMiseConfig: "[tools]\nnode = '24'\n" }, IMAGE),
    ).toEqual({ kind: "base", base: snapshot(), why: expect.any(String) });
  });

  it("starts from the current Base snapshot when it is ready for the settings and made on this image", () => {
    expect(pickBase(record(), SETTINGS, IMAGE)).toEqual({ kind: "base", base: snapshot(), why: expect.any(String) });
    // A record read at a newer revision (the start's settings are a kept copy) is trusted.
    expect(pickBase(record({ revision: 9 }), SETTINGS, IMAGE)).toMatchObject({ kind: "base" });
  });

  it("starts from the image where there is no image digest or the Builder did not answer", () => {
    expect(pickBase(record(), SETTINGS, undefined)).toMatchObject({ kind: "image" });
    expect(pickBase(undefined, SETTINGS, IMAGE)).toMatchObject({ kind: "image" });
  });

  it("asks the Builder again when its record is older than the start's settings, then trusts its answer", () => {
    expect(pickBase(record({ revision: 4 }), SETTINGS, IMAGE)).toMatchObject({ kind: "ask" });
    const { revision: _revision, ...unread } = record();
    expect(pickBase(unread, SETTINGS, IMAGE)).toMatchObject({ kind: "ask" });
    // Asked once: a record still behind is taken as it is.
    expect(pickBase(record({ revision: 4 }), SETTINGS, IMAGE, { asked: true })).toMatchObject({ kind: "base" });
  });

  it("asks again when the ready one was made on another image (the Builder has not read the deploy), then starts from the image", () => {
    const old = record({ good: snapshot({ imageDigest: OLD_IMAGE }) });
    expect(pickBase(old, SETTINGS, IMAGE)).toMatchObject({ kind: "ask" });
    expect(pickBase(old, SETTINGS, IMAGE, { asked: true })).toMatchObject({ kind: "image" });
  });

  it("starts from the image and reports missing when no Base snapshot is for the settings, unless it already asked", () => {
    expect(pickBase(record({ state: "none", good: null }), SETTINGS, IMAGE)).toMatchObject({
      kind: "image",
      missing: true,
    });
    expect(pickBase(record({ state: "none", good: null }), SETTINGS, IMAGE, { asked: true })).not.toHaveProperty(
      "missing",
    );
    const failed = record({
      state: "failed",
      good: snapshot({ key: OLD_KEY }),
      failure: { at: AT, phase: "running", exitCode: 2, message: "the Image setup exited 2", output: "" },
    });
    expect(pickBase(failed, SETTINGS, IMAGE)).toMatchObject({ kind: "image", missing: true });
    // A Builder that thinks there is nothing to build has read other settings: the image.
    expect(
      pickBase(record({ state: "none", nothingToBuild: true, good: null }), SETTINGS, IMAGE, { asked: true }),
    ).toMatchObject({ kind: "image" });
  });

  it("while a rebuild of the same settings runs (a Rebuild, a scheduled rebuild), each policy holds: wait waits", () => {
    expect(pickBase(building(snapshot()), { ...SETTINGS, whileBuilding: "lastGood" }, IMAGE)).toMatchObject({
      kind: "base",
      base: { id: "snap-1" },
    });
    expect(pickBase(building(snapshot()), { ...SETTINGS, whileBuilding: "wait" }, IMAGE)).toMatchObject({
      kind: "wait",
    });
    expect(pickBase(building(snapshot()), { ...SETTINGS, whileBuilding: "image" }, IMAGE)).toMatchObject({
      kind: "image",
    });
  });

  it("asks when the Builder last read another Workspace image; asked, it waits only for a build under way", () => {
    const other = record({ imageDigest: OLD_IMAGE, good: snapshot({ imageDigest: OLD_IMAGE }) });
    expect(pickBase(other, SETTINGS, IMAGE)).toMatchObject({ kind: "ask" });
    // Building (its watch caught this image): the while-building settings.
    const buildingOther = building(snapshot({ imageDigest: OLD_IMAGE }), { imageDigest: OLD_IMAGE });
    expect(
      pickBase(buildingOther, { ...SETTINGS, whileBuilding: "lastGood", whileBuildingNewImage: "wait" }, IMAGE, {
        asked: true,
      }),
    ).toMatchObject({ kind: "wait" });
    expect(
      pickBase(buildingOther, { ...SETTINGS, whileBuilding: "lastGood", whileBuildingNewImage: "image" }, IMAGE, {
        asked: true,
      }),
    ).toMatchObject({ kind: "image" });
    // Not building: the Builder may be ahead (this object still runs the old image), so nothing is waited for.
    expect(pickBase(other, SETTINGS, IMAGE, { asked: true })).toMatchObject({ kind: "image" });
    expect(pickBase(other, { ...SETTINGS, whileBuilding: "wait" }, IMAGE, { asked: true })).toMatchObject({
      kind: "image",
    });
    // The Builder read this image: its record is trusted.
    expect(pickBase(record({ imageDigest: IMAGE }), SETTINGS, IMAGE)).toMatchObject({ kind: "base" });
  });

  it("never takes a record behind the start's settings as ready for them, even after asking: it counts as building", () => {
    const behind = record({ revision: 4, good: snapshot({ key: OLD_KEY }) });
    expect(pickBase(behind, { ...SETTINGS, whileBuilding: "wait" }, IMAGE, { asked: true })).toMatchObject({
      kind: "wait",
    });
    expect(pickBase(behind, { ...SETTINGS, whileBuilding: "image" }, IMAGE, { asked: true })).toMatchObject({
      kind: "image",
    });
    // The last good one is the Owner's while-building choice, older settings and all.
    expect(pickBase(behind, { ...SETTINGS, whileBuilding: "lastGood" }, IMAGE, { asked: true })).toMatchObject({
      kind: "base",
      why: expect.stringContaining("last good"),
    });
  });

  it("while a build of new settings runs: lastGood starts from the last good one on this image", () => {
    const last = snapshot({ key: OLD_KEY, id: "snap-old" });
    expect(pickBase(building(last), { ...SETTINGS, whileBuilding: "lastGood" }, IMAGE)).toMatchObject({
      kind: "base",
      base: { id: "snap-old" },
    });
    expect(pickBase(building(last), { ...SETTINGS, whileBuilding: "wait" }, IMAGE)).toMatchObject({ kind: "wait" });
    expect(pickBase(building(last), { ...SETTINGS, whileBuilding: "image" }, IMAGE)).toMatchObject({ kind: "image" });
    expect(pickBase(building(last), { ...SETTINGS, whileBuilding: "image" }, IMAGE)).not.toHaveProperty("missing");
  });

  it("while a build runs with the last good one on an older image, or none: whileBuildingNewImage decides for lastGood", () => {
    const older = snapshot({ key: OLD_KEY, imageDigest: OLD_IMAGE });
    for (const good of [older, null]) {
      expect(
        pickBase(building(good), { ...SETTINGS, whileBuilding: "lastGood", whileBuildingNewImage: "wait" }, IMAGE),
      ).toMatchObject({ kind: "wait" });
      expect(
        pickBase(building(good), { ...SETTINGS, whileBuilding: "lastGood", whileBuildingNewImage: "image" }, IMAGE),
      ).toMatchObject({ kind: "image" });
      // The other policies say for themselves.
      expect(
        pickBase(building(good), { ...SETTINGS, whileBuilding: "wait", whileBuildingNewImage: "image" }, IMAGE),
      ).toMatchObject({ kind: "wait" });
      expect(
        pickBase(building(good), { ...SETTINGS, whileBuilding: "image", whileBuildingNewImage: "wait" }, IMAGE),
      ).toMatchObject({ kind: "image" });
    }
  });

  it("never starts a good one made on another image, even one for the same key", () => {
    expect(pickBase(building(snapshot({ imageDigest: OLD_IMAGE })), SETTINGS, IMAGE)).toMatchObject({ kind: "wait" });
  });
});

describe("planBase", () => {
  const builder = (records: ReadonlyArray<BaseBuildRecord | Error | "never">) => {
    const calls: Array<string> = [];
    const answer = (call: string) => {
      calls.push(call);
      const next = records[calls.length - 1];
      if (next === "never") return new Promise<BaseBuildRecord>(() => undefined);
      if (next instanceof Error || next === undefined) return Promise.reject(next ?? new Error("no more"));
      return Promise.resolve(next);
    };
    return { calls, builder: { record: () => answer("record"), missing: () => answer("missing") } };
  };

  it("reads the record once when it is current", async () => {
    const { calls, builder: deps } = builder([record()]);
    expect(await planBase({ builder: deps, imageDigest: IMAGE, boundMs: 50 }, SETTINGS)).toMatchObject({
      kind: "base",
    });
    expect(calls).toEqual(["record"]);
  });

  it("asks the Builder to read the settings (a missing report) when its record is older, and picks from its answer", async () => {
    const { calls, builder: deps } = builder([record({ revision: 3 }), building(snapshot({ key: OLD_KEY }))]);
    expect(await planBase({ builder: deps, imageDigest: IMAGE, boundMs: 50 }, SETTINGS)).toMatchObject({
      kind: "base",
      base: { key: OLD_KEY },
    });
    expect(calls).toEqual(["record", "missing"]);
  });

  it("reads the record again when the missing report does not answer in time (a tick or an alarm ahead of it)", async () => {
    const { calls, builder: deps } = builder([record({ revision: 3 }), "never", building(null)]);
    expect(await planBase({ builder: deps, imageDigest: IMAGE, boundMs: 20 }, SETTINGS)).toMatchObject({
      kind: "wait",
    });
    expect(calls).toEqual(["record", "missing", "record"]);
  });

  it("asks nothing when told not to (a wait's later polls, a running Container's re-plan)", async () => {
    const { calls, builder: deps } = builder([record({ revision: 3 })]);
    expect(
      await planBase({ builder: deps, imageDigest: IMAGE, boundMs: 20 }, SETTINGS, { mayAsk: false }),
    ).toMatchObject({ kind: "base" });
    expect(calls).toEqual(["record"]);
  });

  it("starts from the image when the Builder fails or does not answer in time", async () => {
    expect(
      await planBase({ builder: builder([new Error("reset")]).builder, imageDigest: IMAGE, boundMs: 20 }, SETTINGS),
    ).toMatchObject({ kind: "image" });
    expect(
      await planBase({ builder: builder(["never"]).builder, imageDigest: IMAGE, boundMs: 20 }, SETTINGS),
    ).toMatchObject({ kind: "image" });
    expect(
      await planBase(
        { builder: builder([record({ revision: 3 }), "never", "never"]).builder, imageDigest: IMAGE, boundMs: 20 },
        SETTINGS,
      ),
    ).toMatchObject({ kind: "image" });
  });

  it("asks nothing with nothing to build", async () => {
    const { calls, builder: deps } = builder([]);
    expect(
      await planBase({ builder: deps, imageDigest: IMAGE, boundMs: 20 }, { ...SETTINGS, imageSetup: "" }),
    ).toMatchObject({ kind: "image" });
    expect(calls).toEqual([]);
  });
});

describe("waitForBase", () => {
  it("polls until the pick is no longer a wait", async () => {
    let clock = 0;
    const picks: Array<BasePick> = [
      { kind: "wait", why: "w" },
      { kind: "wait", why: "w" },
      { kind: "base", base: snapshot(), why: "ready" },
    ];
    const sleeps: Array<number> = [];
    const pick = await waitForBase({
      plan: async () => picks.shift()!,
      now: () => clock,
      sleep: async (ms) => void ((clock += ms), sleeps.push(ms)),
      limitMs: 60_000,
      pollMs: 5_000,
    });
    expect(pick).toMatchObject({ kind: "base" });
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it("gives up at its limit and starts from the image", async () => {
    let clock = 0;
    const pick = await waitForBase({
      plan: async () => ({ kind: "wait", why: "w" }),
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      limitMs: 35 * 60_000,
      pollMs: 5 * 60_000,
    });
    expect(pick).toMatchObject({ kind: "image" });
    expect(clock).toBe(35 * 60_000);
    // ADR-0049 §4: it names its value and the two settings it is made of, where each is changed.
    expect(JSON.stringify(pick)).toContain(
      "(35 min: the Image setup time limit, under Environment › Image setup › Image setup time limit (minutes), and twice the Snapshot time limit, under Environment › Advanced › Snapshot time limit (minutes))",
    );
  });

  it("is bounded by the build's own limits: the Image setup's, then the snapshot's and its proof's", () => {
    expect(waitLimitMs({ ...SETTINGS, imageSetupMinutes: 30, snapshotMinutes: 5 })).toBe(40 * 60_000);
  });
});

describe("BaseWaitBackend", () => {
  const inner = (log: Array<string>): WorkspaceBackend =>
    ({
      id: "container",
      type: "container",
      description: "the Container",
      connect: async () => {
        log.push("connect");
        return { runtimeId: "rt-1" } as unknown as BackendHandle;
      },
    }) as WorkspaceBackend;

  it("waits before computer's connect, so its connect deadline starts after the wait", async () => {
    const log: Array<string> = [];
    let release!: () => void;
    const backend = new BaseWaitBackend(
      inner(log),
      () => new Promise<void>((resolve) => (release = () => (log.push("waited"), resolve()))),
    );
    const connecting = backend.connect({} as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toEqual([]);
    release();
    await connecting;
    expect(log).toEqual(["waited", "connect"]);
    expect(backend.id).toBe("container");
  });

  it("connects anyway when the wait fails", async () => {
    const log: Array<string> = [];
    const backend = new BaseWaitBackend(inner(log), async () => {
      throw new Error("the Environment reset");
    });
    await backend.connect({} as never);
    expect(log).toEqual(["connect"]);
  });
});

describe("startFromBase", () => {
  type Answer = { readonly runtimeId: string; readonly outcome: "launched" | "adopted" | "relaunched" };

  const harness = (options: { refuse?: "now" | "late" | "other"; outcome?: Answer["outcome"] } = {}) => {
    const starts: Array<string | undefined> = [];
    const events: Array<string> = [];
    let reject: ((error: Error) => void) | undefined;
    const deps = {
      start: async (snapshotId: string | undefined): Promise<Answer> => {
        starts.push(snapshotId);
        return {
          runtimeId: `rt-${starts.length}`,
          outcome: starts.length === 1 ? (options.outcome ?? "launched") : "launched",
        };
      },
      monitor: () =>
        new Promise<void>((_, no) => {
          reject = no;
          if (options.refuse === "now") setTimeout(() => no(new Error('Snapshot "snap-1" was not found.')), 2);
          if (options.refuse === "other") setTimeout(() => no(new Error("the Container exited with code 137")), 2);
        }),
      destroy: async () => void events.push("destroy"),
      refused: (id: string, message: string, late: boolean) =>
        void events.push(`refused ${id} ${late ? "late" : "now"}: ${message}`),
      windowMs: 30,
    };
    return { deps, starts, events, lateRefusal: () => reject?.(new Error('Snapshot "snap-1" was not found.')) };
  };

  it("starts from the image with no snapshot, and watches nothing", async () => {
    const { deps, starts, events } = harness({ refuse: "now" });
    expect(await startFromBase(deps, undefined)).toMatchObject({ runtimeId: "rt-1" });
    expect(starts).toEqual([undefined]);
    expect(events).toEqual([]);
  });

  it("starts from the snapshot and, the platform not refusing it within the window, keeps that start", async () => {
    const { deps, starts, events } = harness();
    expect(await startFromBase(deps, "snap-1")).toEqual({ runtimeId: "rt-1", outcome: "launched" });
    expect(starts).toEqual(["snap-1"]);
    expect(events).toEqual([]);
  });

  it("on a refusal within the window: destroys, reports it, and starts once from the image, never looping", async () => {
    const { deps, starts, events } = harness({ refuse: "now" });
    expect(await startFromBase(deps, "snap-1")).toEqual({ runtimeId: "rt-2", outcome: "launched" });
    expect(starts).toEqual(["snap-1", undefined]);
    expect(events).toEqual(["destroy", 'refused snap-1 now: Snapshot "snap-1" was not found.']);
  });

  it("leaves a Container's other early exit to computer", async () => {
    const { deps, starts, events } = harness({ refuse: "other" });
    expect(await startFromBase(deps, "snap-1")).toMatchObject({ runtimeId: "rt-1" });
    expect(starts).toEqual(["snap-1"]);
    expect(events).toEqual([]);
  });

  it("reports a refusal that comes after the window, so the next start does not pick the snapshot again", async () => {
    const { deps, starts, events, lateRefusal } = harness();
    expect(await startFromBase(deps, "snap-1")).toMatchObject({ runtimeId: "rt-1" });
    lateRefusal();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toEqual(["snap-1"]);
    expect(events).toEqual(["destroy", 'refused snap-1 late: Snapshot "snap-1" was not found.']);
  });

  it("watches nothing when computer adopted a running Container", async () => {
    const { deps, starts, events } = harness({ refuse: "now", outcome: "adopted" });
    expect(await startFromBase(deps, "snap-1")).toMatchObject({ outcome: "adopted" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toEqual(["snap-1"]);
    expect(events).toEqual([]);
  });

  it("knows the platform's refusal by its message", () => {
    expect(isSnapshotRefusal(new Error('Snapshot "abc" was not found.'))).toBe(true);
    expect(isSnapshotRefusal("container exited")).toBe(false);
  });
});

describe("a start's launch", () => {
  it("hands computer's start the snapshot only for a picked base, and the start's own instance always", () => {
    const spec = {
      env: { RPC_TOKEN: "t" },
      enableInternet: true,
      name: "WorkspaceContainer",
      instance: "standard-1" as const,
    };
    expect(startSpec(spec, "standard-2", "snap-1")).toEqual({
      ...spec,
      instance: "standard-2",
      containerSnapshot: { id: "snap-1" },
    });
    const plain = startSpec(spec, { vcpu: 1, memoryMib: 3072, diskMb: 12_000 }, undefined);
    expect(plain).toEqual({ ...spec, instance: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } });
    expect(plain).not.toHaveProperty("containerSnapshot");
  });

  it("names the Base snapshot a launch started from, if any", () => {
    expect(baseIdOf({ base: { snapshotId: "snap-1", key: KEY } })).toBe("snap-1");
    expect(baseIdOf({ image: { why: "no Image setup" } })).toBeUndefined();
    expect(baseIdOf(undefined)).toBeUndefined();
  });

  it("records what a Container started from", () => {
    expect(launchFrom({ kind: "base", base: snapshot(), why: "ready" })).toEqual({
      base: { snapshotId: "snap-1", key: KEY },
    });
    expect(launchFrom({ kind: "image", why: "no Image setup" })).toEqual({ image: { why: "no Image setup" } });
    expect(launchFrom({ kind: "wait", why: "a build runs" })).toEqual({
      image: { why: "a build runs; this start did not wait" },
    });
  });
});
