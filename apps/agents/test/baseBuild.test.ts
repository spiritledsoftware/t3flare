// @effect-diagnostics globalTimers:off
// The Base build's state machine (SPI-1332, ADR-0047 §1–§5) over a fake container: each phase, the triggers, a change
// mid-build, the time limits (a late snapshot kept when its key still matches), the budget, and a reset of the object.
import { type BaseBuildRecord, resolveEnvironment, type Variable } from "@t3flare/harness-registry";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BaseBuild,
  type BaseBuildDeps,
  BUDGET_RETRY_MS,
  BUILDER_KEYS,
  type BuilderContainer,
  DAY_MS,
  EXPIRY_MARGIN_MS,
  GOOD_FOR_MS,
  SCHEDULE_RETRY_MS,
} from "../src/workspace/baseBuild.ts";
import { SECRET_MARGIN_BYTES } from "@t3flare/sandbox-image/containerSetup";

import { BUILDER_FILES, EXIT_SCRIPT, LAUNCH_SCRIPT, PROOF_SCRIPT, TAIL_SCRIPT, WRITE_SCRIPT } from "../src/workspace/builderScripts.ts";

const IMAGE = "registry/workspace@sha256:1111";
const DAY = DAY_MS;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** The platform's Container, as a build sees it: a script's exit, its log, snapshots answered by the test. */
class FakeContainer implements BuilderContainer {
  isRunning = false;
  /** The Container answers execs (it booted). */
  booted = true;
  starts: Array<Parameters<BuilderContainer["start"]>[0]> = [];
  files = new Map<string, string>();
  launchEnv: Readonly<Record<string, string>> | undefined;
  launchArgs: ReadonlyArray<string> = [];
  exitCode: number | undefined;
  log = "";
  tailBytes: number | undefined;
  snapshots: Array<{ readonly name: string; readonly answer: Deferred<{ readonly id: string; readonly size: number }> }> = [];
  refusedSnapshots = new Set<string>();
  destroys = 0;
  #monitor: Deferred<void> | undefined;

  running(): boolean {
    return this.isRunning;
  }

  /** Every start throws this (a platform refusal). */
  failStart: string | undefined;

  start(options: Parameters<BuilderContainer["start"]>[0]): void {
    if (this.failStart !== undefined) throw new Error(this.failStart);
    if (this.isRunning) throw new Error("already running");
    this.starts.push(options);
    this.#monitor = deferred<void>();
    this.#monitor.promise.catch(() => undefined);
    if ("snapshot" in options.from && this.refusedSnapshots.has(options.from.snapshot)) {
      const monitor = this.#monitor;
      setTimeout(() => monitor.reject(new Error(`Snapshot "${"snapshot" in options.from ? options.from.snapshot : ""}" was not found.`)), 0);
      return;
    }
    this.isRunning = true;
  }

  async exec(argv: ReadonlyArray<string>, options: { readonly stdin?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs: number }) {
    if (!this.isRunning || !this.booted) throw new Error("the Container is not running");
    const script = argv[2];
    if (argv[0] === "true") return { exitCode: 0, stdout: "" };
    if (script === WRITE_SCRIPT) {
      this.files.set(argv[4]!, options.stdin ?? "");
      return { exitCode: 0, stdout: "" };
    }
    if (script === LAUNCH_SCRIPT) {
      this.launchEnv = options.env;
      this.launchArgs = argv.slice(4);
      return { exitCode: 0, stdout: "launched\n" };
    }
    if (script === EXIT_SCRIPT) return { exitCode: 0, stdout: this.exitCode === undefined ? "" : `${this.exitCode}\n` };
    if (script === TAIL_SCRIPT) {
      // `tail -c N`: the last N bytes of the log.
      this.tailBytes = Number(argv[4]);
      const bytes = new TextEncoder().encode(this.log);
      return { exitCode: 0, stdout: new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - Number(argv[4])))) };
    }
    if (script === PROOF_SCRIPT) {
      const last = this.starts.at(-1);
      return { exitCode: last !== undefined && "snapshot" in last.from ? 0 : 1, stdout: "" };
    }
    throw new Error(`unexpected exec ${argv.join(" ").slice(0, 80)}`);
  }

  snapshot(name: string) {
    const answer = deferred<{ readonly id: string; readonly size: number }>();
    this.snapshots.push({ name, answer });
    return answer.promise;
  }

  monitor(): Promise<void> {
    return this.#monitor?.promise ?? Promise.resolve();
  }

  /** Every destroy throws this. */
  failDestroy: string | undefined;

  async destroy(): Promise<void> {
    if (this.failDestroy !== undefined) throw new Error(this.failDestroy);
    this.destroys++;
    this.isRunning = false;
    this.#monitor?.resolve();
  }
}

const variables: ReadonlyArray<Variable> = [
  { name: "PLAIN", value: "one", secret: false },
  { name: "NPM_TOKEN", value: "s3cr3t-value", secret: true },
];

let clock: number;
let container: FakeContainer;
let store: Map<string, unknown>;
let alarms: Array<number>;
let reports: Array<BaseBuildRecord>;
let waits: Array<Promise<unknown>>;
let leases: { acquired: number; released: number; refuse: boolean };
let settings: Record<string, unknown>;
let failInputs = false;

const settingsNow = () => ({
  ...resolveEnvironment({ revision: 4, settings: { ...settings, variables: undefined } }),
  variables: (settings.variables as ReadonlyArray<Variable> | undefined) ?? variables,
});

let randomCalls = 0;

const deps = (): BaseBuildDeps => ({
  container,
  storage: { get: <T,>(key: string) => store.get(key) as T | undefined, put: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) },
  inputs: async () => ({ settings: settingsNow(), image: IMAGE }),
  setAlarm: async (at) => void alarms.push(at),
  waitUntil: (promise) => void waits.push(promise),
  report: (record) => void reports.push(record),
  lease: {
    acquire: async () => {
      if (leases.refuse) return { ok: false, reason: "the Container budget is full" };
      leases.acquired++;
      return { ok: true };
    },
    release: async () => void leases.released++,
  },
  now: () => clock,
  random: (bytes) => new Uint8Array(bytes).map((_, index) => (index * 7 + bytes + ++randomCalls) % 256),
});

const COMMAND_ENV = { MISE_YES: "1", BASH_ENV: "/usr/local/share/t3flare/command.bash", PLAIN: "command-env-wins" };
const builder = () => new BaseBuild(deps(), { commandEnv: COMMAND_ENV });

/** Lets the background snapshot's handlers run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Runs the alarm `times` times, the clock moved `stepMs` before each. */
const ticks = async (build: BaseBuild, times = 1, stepMs = 5_000) => {
  for (let i = 0; i < times; i++) {
    clock += stepMs;
    await build.alarm();
    await settle();
  }
};

/** Drives a build from a poke to the running phase. */
const toRunning = async (build: BaseBuild, reason = "the Image setup changed") => {
  const record = await build.poke(reason);
  expect(record.state).toBe("building");
  expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "running" });
};

beforeEach(() => {
  clock = Date.parse("2026-11-22T10:00:00.000Z");
  container = new FakeContainer();
  store = new Map();
  alarms = [];
  reports = [];
  waits = [];
  leases = { acquired: 0, released: 0, refuse: false };
  failInputs = false;
  settings = { imageSetup: "apt-get install -y jq\necho marker > /opt/marker\n", globalMiseConfig: "[tools]\nnode = '24'\n", containerSize: "standard-2" };
});

describe("a Base build", () => {
  it("runs the Image setup on the image with sleep as its entrypoint, snapshots it, proves a start from it and records it", async () => {
    const build = builder();
    await toRunning(build);
    expect(container.starts[0]).toEqual({ from: { image: IMAGE }, entrypoint: ["sleep", "infinity"], instance: "standard-2" });
    expect(container.files.get(BUILDER_FILES.setup)).toBe(settings.imageSetup);
    expect(container.files.get(BUILDER_FILES.mise)).toBe(settings.globalMiseConfig);
    // Every Variable (the secret opened), under COMMAND_ENV, then HOME=/root.
    expect(container.launchEnv).toEqual({ PLAIN: "command-env-wins", NPM_TOKEN: "s3cr3t-value", MISE_YES: "1", BASH_ENV: COMMAND_ENV.BASH_ENV, HOME: "/root" });
    expect(container.launchArgs[0]).toBe("4");

    await ticks(build);
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "running" });
    container.exitCode = 0;
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "building", phase: "snapshotting" });
    expect(container.snapshots).toHaveLength(1);

    container.snapshots[0]!.answer.resolve({ id: "snap-1", size: 34_500_000 });
    await settle();
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "building", phase: "proving" });
    // From the candidate, with the image's own entrypoint, at the same size.
    expect(container.starts[1]).toEqual({ from: { snapshot: "snap-1" }, instance: "standard-2" });

    await ticks(build);
    const record = build.record();
    expect(record).toMatchObject({ state: "ready", good: { id: "snap-1", size: 34_500_000, imageDigest: IMAGE, key: record.key } });
    expect(record.good!.tookMs).toBeGreaterThan(0);
    expect(container.isRunning).toBe(false);
    expect(reports.map((each) => each.phase ?? each.state)).toEqual(expect.arrayContaining(["starting", "running", "snapshotting", "proving", "ready"]));
  });

  it("fails on the Image setup's exit with the end of its output, every secret value blanked; a boot does not run it again, a Rebuild does", async () => {
    settings.setupOutputKiB = 4;
    const build = builder();
    await toRunning(build);
    container.log = `${"x".repeat(10_000)}\nusing s3cr3t-value to log in\nerror: nope\n`;
    container.exitCode = 3;
    await ticks(build);
    const record = build.record();
    expect(record.state).toBe("failed");
    expect(record.failure).toMatchObject({ exitCode: 3, phase: "running", message: "the Image setup exited 3" });
    // The kept bytes and a margin of the longest secret, so a secret cut at the window's head is blanked whole.
    expect(container.tailBytes).toBe(4 * 1024 + SECRET_MARGIN_BYTES);
    expect(record.failure!.output).toContain("using *** to log in");
    expect(record.failure!.output).not.toContain("s3cr3t-value");
    expect(container.isRunning).toBe(false);

    expect((await build.poke("the Environment booted")).state).toBe("failed");
    expect(container.starts).toHaveLength(1);
    expect((await build.poke("Rebuild", { force: true })).state).toBe("building");
    expect(container.starts).toHaveLength(2);
  });

  it("keeps setupOutputKiB's default, 32 KiB, of the output", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 1;
    await ticks(build);
    expect(container.tailBytes).toBe(32 * 1024 + SECRET_MARGIN_BYTES);
  });

  it("fails a run past the Image setup's time limit, with no exit code, and destroys the Container", async () => {
    settings.imageSetupMinutes = 1;
    const build = builder();
    await toRunning(build);
    await ticks(build, 1, 61_000);
    expect(build.record()).toMatchObject({ state: "failed", failure: { exitCode: null, message: "the Image setup ran past its time limit (1 min)" } });
    expect(container.isRunning).toBe(false);
  });

  it("reports a snapshot past its time limit failed, keeps the Container for it, and keeps a late result whose key still matches", async () => {
    settings.snapshotMinutes = 1;
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    await ticks(build, 1, 61_000);
    expect(build.record()).toMatchObject({ state: "failed", failure: { phase: "snapshotting", message: "the snapshot took longer than 1 min" } });
    expect(container.isRunning).toBe(true);
    expect(container.destroys).toBe(0);

    container.snapshots[0]!.answer.resolve({ id: "snap-late", size: 10 });
    await settle();
    // Proved at once: the start from it runs computerd by the same alarm's proof.
    await ticks(build);
    expect(container.starts.at(-1)).toEqual({ from: { snapshot: "snap-late" }, instance: "standard-2" });
    expect(build.record()).toMatchObject({ state: "ready", good: { id: "snap-late" } });
    expect(build.record().failure).toBeUndefined();
  });

  it("cancels a build when the settings change mid-build, and builds the new key", async () => {
    const build = builder();
    await toRunning(build);
    const before = build.record().key;
    settings.imageSetup = "apt-get install -y yq\n";
    const record = await build.poke("the Image setup changed");
    expect(record.key).not.toBe(before);
    expect(record.state).toBe("building");
    expect(container.destroys).toBe(1);
    expect(container.starts).toHaveLength(2);
    expect(container.files.get(BUILDER_FILES.setup)).toBe("apt-get install -y yq\n");
  });

  it("lets a canceled build's snapshot finish before the new build takes the Container", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    settings.imageSetup = "echo two\n";
    await build.poke("the Image setup changed");
    // The snapshot is still being taken: nothing destroyed, nothing started.
    expect(container.destroys).toBe(0);
    expect(container.starts).toHaveLength(1);
    await ticks(build);
    expect(container.starts).toHaveLength(1);
    container.snapshots[0]!.answer.resolve({ id: "snap-old", size: 1 });
    await settle();
    container.exitCode = undefined;
    await ticks(build);
    expect(container.destroys).toBe(1);
    expect(container.starts).toHaveLength(2);
    expect(build.record()).toMatchObject({ state: "building", phase: "running" });
    expect(store.get(BUILDER_KEYS.good)).toBeUndefined();
  });

  it("fails when the platform refuses the start from the candidate", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    container.refusedSnapshots.add("snap-gone");
    container.snapshots[0]!.answer.resolve({ id: "snap-gone", size: 1 });
    await settle();
    await ticks(build);
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "failed", failure: { phase: "proving", message: 'a start from the snapshot failed: Snapshot "snap-gone" was not found.' } });
  });

  it("builds nothing with no Image setup and no Global mise config", async () => {
    settings = { imageSetup: "", globalMiseConfig: "" };
    const build = builder();
    expect(await build.poke("the Environment booted")).toMatchObject({ state: "none", nothingToBuild: true });
    expect(container.starts).toHaveLength(0);
  });

  it("answers ready without a build when the good snapshot is for the current key, until it is 29 days old", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    container.snapshots[0]!.answer.resolve({ id: "snap-1", size: 1 });
    await settle();
    await ticks(build, 2);
    expect(build.record().state).toBe("ready");
    expect((await build.poke("the Environment booted")).state).toBe("ready");
    expect(container.starts).toHaveLength(2);
    clock += GOOD_FOR_MS + 1;
    expect(build.record()).toMatchObject({ state: "none", good: null });
    expect((await build.poke("the Environment booted")).state).toBe("building");
  });

  it("builds again when a Workspace's start finds the Base snapshot refused", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    container.snapshots[0]!.answer.resolve({ id: "snap-1", size: 1 });
    await settle();
    await ticks(build, 2);
    expect(build.record().state).toBe("ready");
    container.exitCode = undefined;
    expect(await build.refused("snap-other", "a start failed")).toMatchObject({ state: "ready" });
    expect(await build.refused("snap-1", "a start failed")).toMatchObject({ state: "building", reason: "a start failed", good: null });
  });

  it("rebuilds on the schedule, once per due time", async () => {
    settings.rebuildEveryDays = 7;
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    container.snapshots[0]!.answer.resolve({ id: "snap-1", size: 1 });
    await settle();
    await ticks(build, 2);
    expect(build.record().state).toBe("ready");
    expect(alarms.at(-1)).toBe(build.record().good!.builtAt + 7 * DAY);
    container.exitCode = undefined;
    clock += 7 * DAY;
    await build.alarm();
    expect(build.record()).toMatchObject({ state: "building", reason: "the scheduled rebuild" });
    container.exitCode = 2;
    await ticks(build, 2);
    // The last good one is still for these settings: ready, with the failed rebuild beside it.
    expect(build.record()).toMatchObject({ state: "ready", good: { id: "snap-1" }, failure: { exitCode: 2 } });
    const starts = container.starts.length;
    await ticks(build, 3);
    expect(container.starts).toHaveLength(starts);
  });

  it("waits for room under the Container budget when it counts against it, and gives its place back at the end", async () => {
    settings.builderInBudget = true;
    leases.refuse = true;
    const build = builder();
    expect(await build.poke("Rebuild")).toMatchObject({ state: "building", phase: "starting", waitingForBudget: true });
    expect(container.starts).toHaveLength(0);
    expect(alarms.at(-1)).toBe(clock + BUDGET_RETRY_MS);
    leases.refuse = false;
    await ticks(build, 1, BUDGET_RETRY_MS);
    expect(build.record()).toMatchObject({ state: "building", phase: "running" });
    expect(build.record().waitingForBudget).toBeUndefined();
    container.exitCode = 9;
    await ticks(build);
    expect(leases).toMatchObject({ acquired: 1, released: 1 });
  });

  it("goes on after a reset of the object: the run's exit file is read, a lost snapshot taken again", async () => {
    await toRunning(builder());
    const after = builder();
    container.exitCode = 0;
    await ticks(after);
    expect(after.record()).toMatchObject({ phase: "snapshotting" });
    const again = builder();
    await ticks(again);
    expect(container.snapshots).toHaveLength(2);
    container.snapshots[1]!.answer.resolve({ id: "snap-2", size: 1 });
    await settle();
    await ticks(again, 2);
    expect(again.record()).toMatchObject({ state: "ready", good: { id: "snap-2" } });
  });
});

/** Drives a fresh build to ready with the snapshot `id`. */
const toReady = async (build: BaseBuild, id: string, reason = "the Image setup changed") => {
  container.exitCode = undefined;
  await build.poke(reason, { force: true });
  container.exitCode = 0;
  await ticks(build);
  container.snapshots.at(-1)!.answer.resolve({ id, size: 1 });
  await settle();
  await ticks(build, 2);
  expect(build.record()).toMatchObject({ state: "ready", good: { id } });
  container.exitCode = undefined;
};

describe("a Base build (review fixes)", () => {
  it("keeps a late snapshot of the current key through a Workspace's report and a Rebuild", async () => {
    settings.snapshotMinutes = 1;
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    await ticks(build, 1, 61_000);
    expect(build.record()).toMatchObject({ state: "failed", failure: { phase: "snapshotting" } });
    expect(await build.poke("a start found no Base snapshot for its settings")).toMatchObject({ state: "failed" });
    await build.poke("the Owner's Rebuild", { force: true });
    expect(container.starts).toHaveLength(1);
    expect(container.destroys).toBe(0);
    container.snapshots[0]!.answer.resolve({ id: "snap-late", size: 10 });
    await settle();
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "ready", good: { id: "snap-late" } });
    expect(container.snapshots).toHaveLength(1);
  });

  it("blanks a secret the output's window cuts at its head", async () => {
    const secret = "ABCDEFGHIJKLMNOP";
    settings.variables = [{ name: "LONG_SECRET", value: secret, secret: true }];
    settings.setupOutputKiB = 4;
    const build = builder();
    await toRunning(build);
    // The kept window's first byte falls on the secret's "I": its tail "IJKLMNOP" would be left without the margin.
    const filler = "y".repeat(4 * 1024 - 8);
    container.log = `start\n${secret}${filler}`;
    container.exitCode = 1;
    await ticks(build);
    const output = build.record().failure!.output;
    expect(output).not.toContain("MNOP");
    // Blanked whole across the cut, the blank kept (`blankSecrets`).
    expect(output.startsWith("***")).toBe(true);
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(4 * 1024);
  });

  it("fires a 29-day schedule before the snapshot expires", async () => {
    settings.rebuildEveryDays = 29;
    const build = builder();
    await toReady(build, "snap-1");
    const builtAt = build.record().good!.builtAt;
    expect(alarms.at(-1)).toBe(builtAt + GOOD_FOR_MS - EXPIRY_MARGIN_MS);
    clock = builtAt + GOOD_FOR_MS - EXPIRY_MARGIN_MS;
    await build.alarm();
    expect(build.record()).toMatchObject({ state: "building", reason: "the scheduled rebuild" });
  });

  it("retries a failed scheduled rebuild on a backoff, and re-arms the schedule after a failed Rebuild", async () => {
    settings.rebuildEveryDays = 7;
    const build = builder();
    await toReady(build, "snap-1");
    const builtAt = build.record().good!.builtAt;
    // A Rebuild that fails still leaves the schedule armed from the last good one.
    await build.poke("the Owner's Rebuild", { force: true });
    container.exitCode = 4;
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "ready", failure: { exitCode: 4 } });
    expect(alarms.at(-1)).toBe(builtAt + 7 * DAY);
    clock = builtAt + 7 * DAY;
    container.exitCode = undefined;
    await build.alarm();
    expect(build.record()).toMatchObject({ state: "building", reason: "the scheduled rebuild" });
    container.exitCode = 4;
    await ticks(build);
    const failedAt = clock;
    // The second failure of this key in a row (the Owner's Rebuild was the first): two hours.
    expect(alarms.at(-1)).toBe(failedAt + 2 * SCHEDULE_RETRY_MS);
    const starts = container.starts.length;
    container.exitCode = undefined;
    clock = failedAt + 2 * SCHEDULE_RETRY_MS;
    await build.alarm();
    expect(container.starts.length).toBe(starts + 1);
    // A third waits twice as long again.
    container.exitCode = 4;
    await ticks(build);
    expect(alarms.at(-1)).toBe(clock + 4 * SCHEDULE_RETRY_MS);
  });

  it("builds again when the good snapshot expires, even after its Image setup failed a rebuild", async () => {
    const build = builder();
    await toReady(build, "snap-1");
    await build.poke("the Owner's Rebuild", { force: true });
    container.exitCode = 4;
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "ready", failure: { exitCode: 4 } });
    container.exitCode = undefined;
    clock += GOOD_FOR_MS + 1;
    expect(await build.poke("the Environment booted")).toMatchObject({ state: "building" });
  });

  it("starts the Image setup's clock when the Container starts, not while it waits for the budget", async () => {
    settings.builderInBudget = true;
    settings.imageSetupMinutes = 1;
    leases.refuse = true;
    const build = builder();
    await build.poke("Rebuild");
    await ticks(build, 1, 2 * 60_000);
    expect(build.record()).toMatchObject({ state: "building", waitingForBudget: true });
    leases.refuse = false;
    await ticks(build, 1, BUDGET_RETRY_MS);
    expect(build.record()).toMatchObject({ state: "building", phase: "running" });
    await ticks(build, 1, 30_000);
    expect(build.record().state).toBe("building");
  });

  it("fails a start the platform keeps refusing once the Image setup's limit passes, never building forever", async () => {
    settings.imageSetupMinutes = 1;
    container.failStart = "no capacity";
    const build = builder();
    await build.poke("Rebuild");
    expect(build.record()).toMatchObject({ state: "building", phase: "starting" });
    await ticks(build, 1, 61_000);
    expect(build.record()).toMatchObject({ state: "failed", failure: { phase: "starting" } });
    expect(build.record().failure!.message).toContain("no capacity");
  });

  it("re-arms the alarm when the scheduled rebuild cannot read the settings", async () => {
    settings.rebuildEveryDays = 7;
    const build = new BaseBuild({ ...deps(), inputs: async () => (failInputs ? Promise.reject(new Error("the Environment did not answer")) : { settings: settingsNow(), image: IMAGE }) }, { commandEnv: COMMAND_ENV });
    await toReady(build, "snap-1");
    clock += 7 * DAY;
    failInputs = true;
    await expect(build.alarm()).resolves.toBeUndefined();
    expect(alarms.at(-1)).toBeGreaterThan(clock);
  });

  it("keeps no opened secret value once a build ends", async () => {
    const build = builder();
    await toRunning(build);
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ secrets: ["s3cr3t-value"] });
    container.exitCode = 5;
    await ticks(build);
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "failed", secrets: [] });
    await toReady(build, "snap-1");
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "ready", secrets: [] });
  });

  it("fails fast when a reset finds the proof's start refused, and restarts a starting Container a reset lost", async () => {
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    container.refusedSnapshots.add("snap-gone");
    container.snapshots[0]!.answer.resolve({ id: "snap-gone", size: 1 });
    await settle();
    // The reset: a new instance, the old one's monitor handler gone.
    store.delete(BUILDER_KEYS.refused);
    const after = builder();
    await ticks(after, 1, 1_000);
    await ticks(after, 1, 1_000);
    expect(after.record()).toMatchObject({ state: "failed", failure: { phase: "proving" } });

    container = new FakeContainer();
    const fresh = builder();
    container.booted = false;
    await fresh.poke("the Image setup changed", { force: true });
    expect(container.starts).toHaveLength(1);
    container.isRunning = false;
    container.booted = true;
    // Past a probe's time to come up (30 s), not at the first poll.
    await ticks(builder(), 1, 2_000);
    expect(container.starts).toHaveLength(1);
    await ticks(builder(), 1, 31_000);
    expect(container.starts).toHaveLength(2);
  });
});

describe("a Base build (review cycle 2)", () => {
  it("keeps the secrets while a late snapshot is awaited, and blanks the output when its proof then fails", async () => {
    settings.snapshotMinutes = 1;
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    await ticks(build, 1, 61_000);
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "failed", awaitingSnapshot: true, secrets: ["s3cr3t-value"] });
    container.log = "t3flare: running the Image setup\nlogging in with s3cr3t-value\n";
    container.failDestroy = "the Container would not stop";
    container.snapshots[0]!.answer.resolve({ id: "snap-late", size: 1 });
    await settle();
    // The proof cannot replace the Container: bounded by the snapshot's limit, never escaping the alarm.
    await expect(build.alarm()).resolves.toBeUndefined();
    expect(build.record()).toMatchObject({ state: "building", phase: "proving" });
    await ticks(build, 1, 61_000);
    const record = build.record();
    expect(record).toMatchObject({ state: "failed", failure: { phase: "proving" } });
    expect(record.failure!.output).toContain("logging in with ***");
    expect(record.failure!.output).not.toContain("s3cr3t-value");
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ secrets: [] });
  });

  it("backs off a once-worked key's failing rebuilds whatever the trigger, but runs a Rebuild at once", async () => {
    const build = builder();
    await toReady(build, "snap-1");
    clock += GOOD_FOR_MS + 1;
    // Gone, and its script now fails: a boot builds it (it worked once).
    container.exitCode = 4;
    expect(await build.poke("the Environment booted")).toMatchObject({ state: "building" });
    await ticks(build);
    expect(build.record()).toMatchObject({ state: "failed", failure: { exitCode: 4 } });
    const starts = container.starts.length;
    expect(await build.poke("the Environment booted")).toMatchObject({ state: "failed" });
    expect(await build.poke("a start found no Base snapshot for its settings")).toMatchObject({ state: "failed" });
    expect(container.starts).toHaveLength(starts);
    clock += SCHEDULE_RETRY_MS;
    expect(await build.poke("a start found no Base snapshot for its settings")).toMatchObject({ state: "building" });
    await ticks(build);
    // The second failure in a row waits two hours; the Owner's Rebuild does not wait.
    clock += SCHEDULE_RETRY_MS;
    expect(await build.poke("the Environment booted")).toMatchObject({ state: "failed" });
    expect(await build.poke("the Owner's Rebuild", { force: true })).toMatchObject({ state: "building" });
  });

  it("renews the lease while a failed build's Container waits for its snapshot", async () => {
    settings.builderInBudget = true;
    settings.snapshotMinutes = 1;
    const build = builder();
    await toRunning(build);
    container.exitCode = 0;
    await ticks(build);
    await ticks(build, 1, 61_000);
    expect(store.get(BUILDER_KEYS.build)).toMatchObject({ phase: "failed", awaitingSnapshot: true, leased: true });
    const acquired = leases.acquired;
    await ticks(build, 1, 5 * 60_000 + 1);
    expect(leases.acquired).toBe(acquired + 1);
    expect(leases.released).toBe(0);
  });
});


