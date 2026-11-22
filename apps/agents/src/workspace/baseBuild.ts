// The Base build (SPI-1332, ADR-0047 §1–§5): one run of the Image setup in the Builder, ending in a Base snapshot or a
// failure the Settings page shows. The Builder is one reserved-name instance of the Workspace DO's class
// (`BUILDERS.base`), which drives this machine over the platform's raw `ctx.container` (no computer Workspace).
//
// The machine is alarm-driven and kept in storage, so a deploy that resets the object loses no build:
//
//   starting → running → snapshotting → proving → ready
//          ↘          ↘              ↘          ↘ failed
//
// - starting: a lease when the Builder counts against the Container budget (retried on the alarm while refused); a
//   Container from the Workspace image with its entrypoint replaced (`sleep infinity`, so computerd never writes a store
//   into it), internet on; once an exec answers, the files are written and the run starts detached.
// - running: the alarm polls the run's exit file. The Image setup's time limit counts from the Container's start (a wait
//   for the budget, or for a canceled build's snapshot, is not in it), and covers the start and the run.
// - snapshotting: `snapshotContainer()` runs in the background (`waitUntil`) and records its result. Past the snapshot's
//   time limit the build is reported failed, but the Container is kept until the result comes, and a late result whose
//   key is still current goes on to the proof: a snapshot given up on early is lost (the platform keeps going).
// - proving: the Container is started again from the candidate with the image's own entrypoint; computerd running and a
//   command succeeding accept it (ADR-0047 §2). A refused start shows in `monitor()` within a second.
//
// A change of key while a build runs cancels it (its Container destroyed, or, mid-snapshot, once the snapshot ends) and
// builds the new key; while a late snapshot of the current key is still being taken, no trigger starts another build.
// The scheduled rebuild fires before the snapshot expires, and one that fails is retried on a backoff. Every step is
// bounded by its time limit, a step that keeps throwing included. Unit tests drive it over a fake container
// (apps/agents/test/baseBuild.test.ts).
//
// A Test base build (SPI-1334, ADR-0047 §8) is the same machine with `test` on, in the second Builder (`BUILDERS.test`,
// its own object, storage and Container, so a test never touches a real build): it runs a proposed Image setup, kept
// in its storage, with the saved rest of the settings. Its proved snapshot is its result alone, never the Base snapshot;
// it has no schedule, no backoff and no pokes, and a new test cancels one under way.
import {
  BASE_BUILD_CAPS,
  type BaseBuildFailure,
  type BaseBuildPhase,
  type BaseBuildRecord,
  type BaseSnapshot,
  builderInstance,
  type ContainerInstance,
  MAX_REBUILD_DAYS,
  type ResolvedEnvironment,
  variableEnv,
} from "@t3flare/harness-registry";

import { SECRET_MARGIN_BYTES } from "@t3flare/sandbox-image/containerSetup";
import { OWNER_HOME } from "@t3flare/sandbox-image/env";
import { globalMiseArgs } from "@t3flare/sandbox-image/globalMise";

import { baseKey, hex, sha256Hex, unhex } from "./baseKey.ts";
import { blankSecrets } from "./containerSetup.ts";
import {
  BUILDER_FILES,
  EXIT_SCRIPT,
  LAUNCH_SCRIPT,
  LAYDOWN_SCRIPT,
  PROOF_SCRIPT,
  RUN_SCRIPT,
  TAIL_SCRIPT,
  WRITE_SCRIPT,
} from "./builderScripts.ts";

/** The platform's Container, as much of it as a build uses (the Builder adapts `ctx.container`; tests fake it). */
export interface BuilderContainer {
  running(): boolean;
  /** Starts from the image (`entrypoint` replaced) or from a snapshot (the image's own entrypoint). Throws when refused. */
  start(options: { readonly from: { readonly image: string } | { readonly snapshot: string }; readonly entrypoint?: ReadonlyArray<string>; readonly instance: ContainerInstance }): void;
  /** Runs `argv`; answers its exit code and stdout. Throws when the exec cannot run or `timeoutMs` passes. */
  exec(argv: ReadonlyArray<string>, options: { readonly stdin?: string; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs: number }): Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
  snapshot(name: string): Promise<{ readonly id: string; readonly size: number }>;
  /** Settles when the running Container stops; rejects at once when a start from a snapshot is refused. */
  monitor(): Promise<void>;
  destroy(): Promise<void>;
}

/** What a build reads from the Environment and the Worker. */
export interface BuilderInputs {
  /** The Environment settings as a Container start gets them: secret Variables opened. */
  readonly settings: ResolvedEnvironment;
  /** `ctx.container.images.WorkspaceContainer`. */
  readonly image: string;
}

export interface BaseBuildDeps {
  readonly container: BuilderContainer;
  readonly storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void; delete(key: string): void };
  readonly inputs: () => Promise<BuilderInputs>;
  /** `ctx.container.images.WorkspaceContainer` alone, without the settings' read: the image watch's (SPI-1333). */
  readonly image: () => string | undefined;
  readonly setAlarm: (at: number) => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Every change of the record (the Environment DO's report sink, for Status). */
  readonly report: (record: BaseBuildRecord) => void;
  /** The Container budget's lease, taken when `builderInBudget` is on. */
  readonly lease: { acquire(budget: number): Promise<{ readonly ok: boolean; readonly reason?: string }>; release(): Promise<void> };
  readonly now: () => number;
  readonly random: (bytes: number) => Uint8Array;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

/** What the run's environment holds over the Variables: `COMMAND_ENV` (then `HOME=/root`, ADR-0047's preamble). */
export interface RunEnv {
  readonly commandEnv: Readonly<Record<string, string>>;
}

/** A build under way or the last one that ended, as kept. */
export interface Build {
  readonly id: string;
  readonly key: string;
  readonly image: string;
  readonly reason: string;
  /** Started by the schedule: a failure is retried on a backoff. */
  readonly scheduled?: boolean;
  readonly phase: BaseBuildPhase | "ready" | "failed" | "canceled";
  readonly startedAt: number;
  readonly phaseAt: number;
  readonly instance: ContainerInstance;
  /** The Image setup's time limit (`imageSetupMinutes`), counted from the Container's first start. */
  readonly setupMs: number;
  /** The Container's start and the Image setup end by then; set at the Container's first start. */
  readonly setupDeadline?: number;
  /** The snapshot's time limit, and the proof's (`snapshotMinutes`). */
  readonly snapshotMs: number;
  /** How much of the output a failure keeps (`setupOutputKiB`). */
  readonly outputBytes: number;
  readonly inBudget: boolean;
  readonly budget: number;
  readonly leased?: boolean;
  readonly leaseAt?: number;
  readonly waitingForBudget?: boolean;
  /** The Container from the image was started, and when. */
  readonly started?: boolean;
  readonly containerAt?: number;
  /** The Container from the candidate was started (`proving`), by which object instance (its `monitor()` handler's). */
  readonly provingStarted?: boolean;
  readonly provingEpoch?: string;
  /** The last error a step threw: a failure past the time limit names it. */
  readonly lastError?: string;
  /**
   * The opened secret Variables' values, blanked in the output a failure keeps; never reported. Cleared once the build is
   * over, kept while it awaits a late snapshot (it may still go on to its proof, and fail there).
   */
  readonly secrets: ReadonlyArray<string>;
  readonly secretsCleared?: boolean;
  readonly snapshot?: { readonly id: string; readonly size: number };
  readonly failure?: BaseBuildFailure;
  /** A snapshot is still being taken after the build failed or was canceled: the Container waits for it. */
  readonly awaitingSnapshot?: boolean;
  readonly endedAt?: number;
}

/** The settings the Builder last read, by their key. */
interface Current {
  readonly key: string;
  /** The settings' revision (SPI-1333): a Workspace's start compares its own with it. Absent in one kept before. */
  readonly revision?: number;
  /** The Workspace image read with them (SPI-1333): a start on another one asks the Builder to read it again. */
  readonly image?: string;
  readonly nothingToBuild: boolean;
  readonly rebuildEveryDays: number;
  readonly at: number;
}

/** The last good Base snapshot as kept: `gone` once a Workspace's start found the platform refused it. */
type KeptSnapshot = BaseSnapshot & { readonly gone?: true };

/** The image watch (SPI-1333): until when, and the image last read. */
interface ImageWatch {
  readonly until: number;
  readonly image: string;
}

/** A snapshot call this instance made, and how it ended. */
interface SnapshotCall {
  readonly build: string;
  /** The object instance that made it: one from before a reset will never record its result. */
  readonly epoch: string;
  readonly result?: { readonly ok: true; readonly id: string; readonly size: number } | { readonly ok: false; readonly error: string };
}

export const BUILDER_KEYS = {
  hmac: "t3flare:builder:hmac",
  current: "t3flare:builder:current",
  build: "t3flare:builder:build",
  good: "t3flare:builder:good",
  snapshot: "t3flare:builder:snapshot",
  refused: "t3flare:builder:refused",
  /** Builds of one key that failed in a row (`{ key, count }`): the retry's backoff. */
  failures: "t3flare:builder:failures",
  /** The proposed Image setup a Test base build runs (SPI-1334), in place of the saved one, and its SHA-256 (hex). */
  proposal: "t3flare:builder:proposal",
  proposalDigest: "t3flare:builder:proposal-digest",
  /** The image watch (`{ until, image }`, SPI-1333): the Workspace image is read on the alarm until then. */
  watch: "t3flare:builder:image-watch",
} as const;

export const DAY_MS = 24 * 60 * 60_000;

/** A Base snapshot older than this counts as gone (ADR-0047 §3): the platform's TTL is 30 days from creation or last restore. */
export const GOOD_FOR_MS = MAX_REBUILD_DAYS * DAY_MS;

/**
 * How long before the snapshot counts as gone the scheduled rebuild fires at the latest. Fixed: room for the longest
 * build the settings allow (120 minutes of Image setup and 15 of snapshot) and its retries, not a policy.
 */
export const EXPIRY_MARGIN_MS = DAY_MS;

/**
 * A failing rebuild's first retry (of the same key, whatever the trigger but a change or a Rebuild); each one after waits
 * twice as long, at most a day. Fixed, by a constraint: a scheduled rebuild fires a day before the snapshot counts as
 * gone (`EXPIRY_MARGIN_MS`), and its first four retries (1 + 2 + 4 + 8 = 15 hours) must land inside that day.
 */
export const SCHEDULE_RETRY_MS = 60 * 60_000;

/** How long the scheduled rebuild waits to read the settings again when the Environment did not answer. Fixed: a retry. */
export const READ_RETRY_MS = 60_000;

/**
 * How often the alarm polls a build. Fixed: a poll is one exec on the Builder's own Container, and nothing an Owner
 * would tune; the time limits are the Owner's.
 */
export const POLL_MS = { starting: 2_000, running: 5_000, snapshotting: 5_000, proving: 2_000 } as const;
/**
 * How long after a trigger the Builder keeps reading the Workspace image on its alarm (SPI-1333), so a deploy's new image
 * is built when it reaches this object, not at some Workspace's start. Fixed by a constraint: a Container application's
 * rollout of a new image to its instances took about 4 minutes on a Stage (SPI-1333's acceptance); this is twice that
 * and more, a bound on a cheap read, not a policy.
 */
export const IMAGE_WATCH_MS = 10 * 60_000;
/** How often the watch reads the image. Fixed: a read of `ctx.container.images`, nothing an Owner would tune. */
export const IMAGE_WATCH_POLL_MS = 30_000;

/**
 * How long a refused lease waits before it asks again. Fixed: a poll of the budget DO, not a limit; the Owner decides
 * whether the Builder waits at all (`builderInBudget`).
 */
export const BUDGET_RETRY_MS = 30_000;
/** A lease is renewed this often while the build holds it (under the budget DO's 10-minute lease). */
const LEASE_RENEW_MS = 5 * 60_000;
/** A probe exec's own bound: a command that answers at once (`true`, `cat`), not the Image setup. */
const PROBE_MS = 30_000;

/** How much of a failed build's output is kept: `setupOutputKiB`, shared with the Container setup (SPI-1330). */
export const outputBytesOf = (settings: ResolvedEnvironment): number => settings.setupOutputKiB * 1024;

/** The wait before the retry after `failures` failures in a row: `SCHEDULE_RETRY_MS`, doubling, at most a day. */
export const retryDelay = (failures: number): number => Math.min(DAY_MS, SCHEDULE_RETRY_MS * 2 ** Math.min(Math.max(1, failures) - 1, 5));

/** A trigger's kind: a Rebuild (the Owner's or `rebuild_base`) runs at once; the rest wait out a failing key's backoff. */
type Trigger = "rebuild" | "automatic" | "scheduled";

const ENDED: ReadonlyArray<Build["phase"]> = ["ready", "failed", "canceled"];
export const isRunning = (build: Build | undefined): build is Build & { readonly phase: BaseBuildPhase } => build !== undefined && !ENDED.includes(build.phase);

/** A build's proved snapshot as a record carries it: the Base snapshot's, or a test's result. */
const goodOf = (build: Build, snapshot: NonNullable<Build["snapshot"]>, builtAt: number): BaseSnapshot => ({
  id: snapshot.id,
  size: snapshot.size,
  key: build.key,
  imageDigest: build.image,
  builtAt,
  tookMs: builtAt - build.startedAt,
});

const NOT_BASE = "t3flare: the test Builder runs only a Test base build";

const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, BASE_BUILD_CAPS.message);

export class BaseBuild {
  readonly #deps: BaseBuildDeps;
  readonly #runEnv: RunEnv;
  /** A Test base build's machine (SPI-1334): a proposed Image setup, its snapshot never the Base snapshot. */
  readonly #test: boolean;
  /** This object instance: a snapshot call or a `monitor()` handler of another one never answers here. */
  readonly #epoch: string;
  /** One tick at a time: the alarm and an RPC may both drive the machine. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: BaseBuildDeps, runEnv: RunEnv, options: { readonly test?: boolean } = {}) {
    this.#test = options.test === true;
    // A test's log lines say so, beside a real build's.
    const log = deps.log;
    this.#deps = this.#test && log !== undefined ? { ...deps, log: (event) => log({ ...event, test: true }) } : deps;
    this.#runEnv = runEnv;
    this.#epoch = hex(deps.random(8));
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  // ── The record ────────────────────────────────────────────────────────────────────────────────────────────────

  /** The last good Base snapshot, unless it is gone: refused by the platform, or older than 29 days. */
  #good(): BaseSnapshot | null {
    const good = this.#deps.storage.get<KeptSnapshot>(BUILDER_KEYS.good);
    if (good === undefined || good.gone === true || this.#deps.now() - good.builtAt > GOOD_FOR_MS) return null;
    const { gone: _gone, ...snapshot } = good;
    return snapshot;
  }

  record(): BaseBuildRecord {
    if (this.#test) return this.#testRecord();
    const { storage, now } = this.#deps;
    const current = storage.get<Current>(BUILDER_KEYS.current);
    const build = storage.get<Build>(BUILDER_KEYS.build);
    const good = this.#good();
    const base = {
      key: current?.key ?? null,
      ...(current?.revision === undefined ? {} : { revision: current.revision }),
      ...(current?.image === undefined ? {} : { imageDigest: current.image }),
      good,
      at: now(),
    };
    if (isRunning(build)) {
      return { ...base, state: "building", phase: build.phase, since: build.startedAt, reason: build.reason, ...(build.waitingForBudget === true ? { waitingForBudget: true } : {}) };
    }
    if (current?.nothingToBuild === true) return { ...base, state: "none", nothingToBuild: true };
    // The last build of these settings failed: shown, beside a good one still for them (a failed scheduled rebuild).
    const failed = build?.phase === "failed" && build.key === current?.key && build.failure !== undefined && (good === null || build.startedAt >= good.builtAt) ? build.failure : undefined;
    if (good !== null && good.key === current?.key) return { ...base, state: "ready", ...(failed === undefined ? {} : { failure: failed }) };
    if (failed !== undefined) return { ...base, state: "failed", failure: failed };
    return { ...base, state: "none" };
  }

  /** The last test's result, kept until the next test: its proved snapshot is `good`, never a Base snapshot. */
  #testRecord(): BaseBuildRecord {
    const { storage, now } = this.#deps;
    const current = storage.get<Current>(BUILDER_KEYS.current);
    const build = storage.get<Build>(BUILDER_KEYS.build);
    const setup = storage.get<string>(BUILDER_KEYS.proposalDigest);
    const base = { test: true as const, key: build?.key ?? null, ...(setup === undefined ? {} : { setup }), good: null, at: now() };
    if (current?.nothingToBuild === true) return { ...base, key: current.key, state: "none", nothingToBuild: true };
    if (isRunning(build)) {
      return { ...base, state: "building", phase: build.phase, since: build.startedAt, reason: build.reason, ...(build.waitingForBudget === true ? { waitingForBudget: true } : {}) };
    }
    if (build?.phase === "ready" && build.snapshot !== undefined) {
      const builtAt = build.endedAt ?? build.phaseAt;
      return { ...base, state: "ready", good: goodOf(build, build.snapshot, builtAt) };
    }
    if (build?.phase === "failed" && build.failure !== undefined) return { ...base, state: "failed", failure: build.failure };
    return { ...base, state: "none" };
  }

  #report(): void {
    this.#deps.report(this.record());
  }

  // ── Triggers ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Reads the settings and builds their key when it has no Base snapshot (ADR-0047 §5): a settings change, an
   * Environment boot, a start that found none. A build of another key under way is canceled. A key whose last build
   * failed in the Image setup is not run again on its own (it would fail the same way), unless its Base snapshot once
   * worked and is gone (expired or refused): `force` (Rebuild) runs it.
   */
  poke(reason: string, options: { readonly force?: boolean } = {}): Promise<BaseBuildRecord> {
    if (this.#test) return Promise.reject(new Error(NOT_BASE));
    return this.#serial(async () => {
      await this.#settleLate();
      await this.#poke(reason, options.force === true ? "rebuild" : "automatic");
      await this.#tick();
      return this.record();
    });
  }

  /**
   * A Workspace's start found no Base snapshot for its settings (SPI-1333): the settings and the image are read, a build
   * begun when none is for their key, and the record answered at once; the build's first step runs on the alarm, so the
   * start is never held by it.
   */
  missing(reason: string): Promise<BaseBuildRecord> {
    if (this.#test) return Promise.reject(new Error(NOT_BASE));
    return this.#serial(async () => {
      await this.#settleLate();
      await this.#poke(reason, "automatic");
      await this.#deps.setAlarm(this.#deps.now());
      return this.record();
    });
  }

  /** A Workspace's start found the Base snapshot `id` refused (missing or expired): it is gone, and built again. */
  refused(id: string, reason: string): Promise<BaseBuildRecord> {
    if (this.#test) return Promise.reject(new Error(NOT_BASE));
    return this.#serial(async () => {
      const kept = this.#deps.storage.get<KeptSnapshot>(BUILDER_KEYS.good);
      if (kept?.id === id) this.#deps.storage.put<KeptSnapshot>(BUILDER_KEYS.good, { ...kept, gone: true });
      await this.#settleLate();
      await this.#poke(reason, "automatic");
      await this.#tick();
      return this.record();
    });
  }

  /**
   * A Test base build (SPI-1334): runs `imageSetup` in place of the saved one, with the saved rest of the settings read as
   * a Base build reads them. A test under way is canceled; one that ended is replaced. Never waits on a failing key's
   * backoff, nor skips a script that failed: the caller asked for this run.
   */
  test(imageSetup: string, reason: string): Promise<BaseBuildRecord> {
    if (!this.#test) return Promise.reject(new Error("t3flare: only the test Builder runs a Test base build"));
    return this.#serial(async () => {
      const { storage } = this.#deps;
      await this.#settleLate();
      const inputs = await this.#inputs(imageSetup);
      const current = await this.#currentOf(inputs);
      storage.put(BUILDER_KEYS.proposal, imageSetup);
      storage.put(BUILDER_KEYS.proposalDigest, await sha256Hex(imageSetup));
      storage.put(BUILDER_KEYS.current, current);
      const build = storage.get<Build>(BUILDER_KEYS.build);
      if (isRunning(build)) await this.#end(build, "canceled");
      if (current.nothingToBuild) {
        this.#report();
        return this.record();
      }
      this.#begin(inputs, current.key, reason, false);
      await this.#tick();
      return this.record();
    });
  }

  /** The alarm: the next step of the build under way, or the scheduled rebuild. */
  alarm(): Promise<void> {
    return this.#serial(() => this.#tick());
  }

  /** The inputs a build reads: a test's with its proposed Image setup (`proposal`, else the one it kept) in place of the saved one. */
  async #inputs(proposal?: string): Promise<BuilderInputs> {
    const inputs = await this.#deps.inputs();
    if (!this.#test) return inputs;
    const imageSetup = proposal ?? this.#deps.storage.get<string>(BUILDER_KEYS.proposal) ?? "";
    return { ...inputs, settings: { ...inputs.settings, imageSetup } };
  }

  async #currentOf(inputs: BuilderInputs): Promise<Current> {
    const { settings, image } = inputs;
    const key = await baseKey(
      {
        imageDigest: image,
        imageSetup: settings.imageSetup,
        globalMiseConfig: settings.globalMiseConfig,
        // As a Container start gets them (`variableEnv`): a name withheld from commands reaches no Image setup either.
        variables: Object.entries(variableEnv(settings.variables)).map(([name, value]) => ({ name, value, secret: settings.variables.some((variable) => variable.name === name && variable.secret) })),
      },
      this.#hmacKey(),
    );
    // A test has no schedule.
    return { key, revision: settings.revision, image, nothingToBuild: settings.imageSetup === "" && settings.globalMiseConfig === "", rebuildEveryDays: this.#test ? 0 : settings.rebuildEveryDays, at: this.#deps.now() };
  }

  #hmacKey(): Uint8Array {
    const { storage, random } = this.#deps;
    let kept = storage.get<string>(BUILDER_KEYS.hmac);
    if (kept === undefined) {
      kept = hex(random(32));
      storage.put(BUILDER_KEYS.hmac, kept);
    }
    return unhex(kept);
  }

  /** A late snapshot that has ended is proved or let go before a trigger looks at the record. */
  async #settleLate(): Promise<void> {
    const build = this.#deps.storage.get<Build>(BUILDER_KEYS.build);
    if (build?.awaitingSnapshot !== true) return;
    try {
      await this.#lateSnapshot(build);
    } catch (error) {
      // The proof it went on to threw (a destroy the platform refused): the next alarm drives it, bounded by its limit.
      this.#deps.log?.({ t3flare: "base-build-tick-failed", build: build.id, phase: "proving", error: errorText(error).slice(0, BASE_BUILD_CAPS.log) });
      await this.#deps.setAlarm(this.#deps.now() + POLL_MS.proving);
    }
  }

  /** The key's failures in a row. */
  #failures(key: string): number {
    const kept = this.#deps.storage.get<{ readonly key: string; readonly count: number }>(BUILDER_KEYS.failures);
    return kept?.key === key ? kept.count : 0;
  }

  async #poke(reason: string, trigger: Trigger): Promise<void> {
    const force = trigger !== "automatic";
    const { storage } = this.#deps;
    const inputs = await this.#inputs();
    const current = await this.#currentOf(inputs);
    storage.put(BUILDER_KEYS.current, current);
    // Every trigger watches the image a while: a deploy's new image may reach this object after its boot's poke.
    storage.put(BUILDER_KEYS.watch, { until: this.#deps.now() + IMAGE_WATCH_MS, image: inputs.image });
    const build = storage.get<Build>(BUILDER_KEYS.build);
    if (isRunning(build)) {
      // The same key under way: it goes on (a Rebuild of it included).
      if (build.key === current.key && !current.nothingToBuild) return this.#report();
      await this.#end(build, "canceled");
    }
    if (current.nothingToBuild) return this.#report();
    const last = storage.get<Build>(BUILDER_KEYS.build);
    // A late snapshot of these settings is still being taken: it is kept, and no trigger starts another build.
    if (last?.awaitingSnapshot === true && last.key === current.key) return this.#report();
    const good = this.#good();
    if (!force && good !== null && good.key === current.key) return this.#report();
    // The script failed for this key: not run again on its own, unless a Base snapshot of the key once worked and is gone.
    const scriptFailed = last?.phase === "failed" && last.key === current.key && typeof last.failure?.exitCode === "number";
    const workedOnce = storage.get<KeptSnapshot>(BUILDER_KEYS.good)?.key === current.key;
    if (!force && scriptFailed && !workedOnce) return this.#report();
    // A key that keeps failing waits out its backoff, whatever the trigger (the schedule included), but a Rebuild: a
    // change of key is a new key, never waited on.
    if (trigger !== "rebuild" && last?.phase === "failed" && last.key === current.key && this.#deps.now() < (last.endedAt ?? last.startedAt) + retryDelay(this.#failures(current.key))) {
      return this.#report();
    }
    this.#begin(inputs, current.key, reason, trigger === "scheduled");
  }

  #begin(inputs: BuilderInputs, key: string, reason: string, scheduled: boolean): void {
    const { storage, now, random } = this.#deps;
    const { settings, image } = inputs;
    const at = now();
    const build: Build = {
      id: hex(random(8)),
      key,
      image,
      reason,
      ...(scheduled ? { scheduled: true } : {}),
      phase: "starting",
      startedAt: at,
      phaseAt: at,
      instance: builderInstance(settings),
      setupMs: settings.imageSetupMinutes * 60_000,
      snapshotMs: settings.snapshotMinutes * 60_000,
      outputBytes: outputBytesOf(settings),
      inBudget: settings.builderInBudget,
      budget: settings.containerBudget,
      secrets: settings.variables.filter((variable) => variable.secret).map((variable) => variable.value),
    };
    storage.put(BUILDER_KEYS.build, build);
    this.#deps.log?.({ t3flare: "base-build", build: build.id, phase: "starting", reason, key: key.slice(0, 12) });
    this.#report();
  }

  // ── The machine ───────────────────────────────────────────────────────────────────────────────────────────────

  async #tick(): Promise<void> {
    const { storage, now, setAlarm } = this.#deps;
    await this.#settleLate();
    const live = storage.get<Build>(BUILDER_KEYS.build);
    if (!isRunning(live)) {
      if (this.#imageMoved()) {
        try {
          await this.#poke("the Workspace image changed", "automatic");
        } catch (error) {
          this.#deps.log?.({ t3flare: "base-build-watch-failed", error: errorText(error).slice(0, BASE_BUILD_CAPS.log) });
          return setAlarm(now() + READ_RETRY_MS);
        }
        if (isRunning(storage.get<Build>(BUILDER_KEYS.build))) return this.#tick();
      }
      if (await this.#armSchedule(live)) {
        try {
          await this.#poke("the scheduled rebuild", "scheduled");
        } catch (error) {
          this.#deps.log?.({ t3flare: "base-build-schedule-failed", error: errorText(error).slice(0, BASE_BUILD_CAPS.log) });
          return setAlarm(now() + READ_RETRY_MS);
        }
        if (isRunning(storage.get<Build>(BUILDER_KEYS.build))) return this.#tick();
        // It started nothing (nothing to build, a backoff): the watch's poll or the backoff's end, whichever comes first.
        const next = [this.#watching() ? now() + IMAGE_WATCH_POLL_MS : undefined, this.#backoffEnd()].filter((at): at is number => at !== undefined);
        if (next.length > 0) await setAlarm(Math.min(...next));
        return;
      }
      if (live?.awaitingSnapshot === true) {
        // Its Container still runs (the snapshot is taken on it): it keeps its place under the budget.
        await this.#renewLease(live);
        await setAlarm(now() + POLL_MS.snapshotting);
      } else if (this.#watching()) await setAlarm(now() + IMAGE_WATCH_POLL_MS);
      return;
    }
    try {
      switch (live.phase) {
        case "starting":
          return await this.#starting(live);
        case "running":
          return await this.#running(live);
        case "snapshotting":
          return await this.#snapshotting(live);
        case "proving":
          return await this.#proving(live);
      }
    } catch (error) {
      const message = errorText(error);
      this.#deps.log?.({ t3flare: "base-build-tick-failed", build: live.id, phase: live.phase, error: message.slice(0, BASE_BUILD_CAPS.log) });
      const now_ = storage.get<Build>(BUILDER_KEYS.build);
      if (!isRunning(now_) || now_.id !== live.id) return setAlarm(now() + POLL_MS.starting);
      const kept = this.#save(now_, { lastError: message });
      // A step that keeps throwing ends at its time limit, never building forever.
      const deadline = this.#deadlineOf(kept);
      if (deadline !== undefined && now() > deadline) return this.#fail(kept, null, `the ${kept.phase} step kept failing until its time limit: ${message}`);
      await setAlarm(now() + POLL_MS.starting);
    }
  }

  /** When a failing key's backoff ends, if it is still ahead (`retryDelay`). */
  #backoffEnd(): number | undefined {
    const { storage, now } = this.#deps;
    const last = storage.get<Build>(BUILDER_KEYS.build);
    const current = storage.get<Current>(BUILDER_KEYS.current);
    if (last?.phase !== "failed" || last.key !== current?.key) return undefined;
    const at = (last.endedAt ?? last.startedAt) + retryDelay(this.#failures(last.key));
    return at > now() ? at : undefined;
  }

  /** The image watch is on (SPI-1333); one past its bound is dropped. */
  #watching(): boolean {
    const watch = this.#deps.storage.get<ImageWatch>(BUILDER_KEYS.watch);
    if (watch === undefined) return false;
    if (this.#deps.now() <= watch.until) return true;
    this.#deps.storage.delete(BUILDER_KEYS.watch);
    return false;
  }

  /** While watching: the Workspace image moved since the last read (a deploy's rollout reached this object). */
  #imageMoved(): boolean {
    if (!this.#watching()) return false;
    const watch = this.#deps.storage.get<ImageWatch>(BUILDER_KEYS.watch)!;
    const image = this.#deps.image();
    if (image === undefined || image === watch.image) return false;
    this.#deps.log?.({ t3flare: "base-build-image-moved", image: image.slice(-24) });
    return true;
  }

  /** When the step under way must have ended: the Image setup's limit, or the snapshot's (and the proof's). */
  #deadlineOf(build: Build): number | undefined {
    return build.phase === "starting" || build.phase === "running" ? build.setupDeadline : build.phaseAt + build.snapshotMs;
  }

  /**
   * The scheduled rebuild (ADR-0047 §5): whether it is due now; when not, the alarm is set for when it is. It is due
   * this many days after the last good one, and at the latest a day before that one expires; a failed attempt is retried
   * on a backoff. The schedule is armed from the last good one after every build, failed ones included.
   */
  async #armSchedule(last: Build | undefined): Promise<boolean> {
    const { storage, now, setAlarm } = this.#deps;
    const current = storage.get<Current>(BUILDER_KEYS.current);
    const good = this.#good();
    if (current === undefined || current.rebuildEveryDays <= 0 || good === null || last?.awaitingSnapshot === true) return false;
    const due = Math.min(good.builtAt + current.rebuildEveryDays * DAY_MS, good.builtAt + GOOD_FOR_MS - EXPIRY_MARGIN_MS);
    let at = due;
    // Tried since it fell due, and it did not end ready: again after a backoff.
    if (last !== undefined && last.startedAt >= due && last.phase !== "ready") at = (last.endedAt ?? last.startedAt) + retryDelay(this.#failures(last.key));
    if (now() < at) {
      await setAlarm(at);
      return false;
    }
    return true;
  }

  #save(build: Build, change: Partial<Build>): Build {
    const next = { ...build, ...change } as Build;
    this.#deps.storage.put(BUILDER_KEYS.build, next);
    return next;
  }

  #phase(build: Build, phase: Build["phase"], change: Partial<Build> = {}): Build {
    const next = this.#save(build, { ...change, phase, phaseAt: this.#deps.now() });
    this.#deps.log?.({ t3flare: "base-build", build: build.id, phase });
    this.#report();
    return next;
  }

  /** A snapshot is being taken now, by this instance (one a reset left behind will never answer). */
  #snapshotInFlight(): SnapshotCall | undefined {
    const call = this.#deps.storage.get<SnapshotCall>(BUILDER_KEYS.snapshot);
    return call !== undefined && call.result === undefined && call.epoch === this.#epoch ? call : undefined;
  }

  async #renewLease(build: Build): Promise<Build> {
    if (!build.inBudget || build.leased !== true || this.#deps.now() - (build.leaseAt ?? 0) < LEASE_RENEW_MS) return build;
    await this.#deps.lease.acquire(build.budget).catch(() => undefined);
    return this.#save(build, { leaseAt: this.#deps.now() });
  }

  async #starting(build: Build): Promise<void> {
    const { container, now, setAlarm } = this.#deps;
    // A canceled build's snapshot is still being taken on this Container: the new build waits for it.
    if (this.#snapshotInFlight() !== undefined) return setAlarm(now() + POLL_MS.snapshotting);
    if (build.inBudget && build.leased !== true) {
      const lease = await this.#deps.lease.acquire(build.budget).catch((error: unknown) => ({ ok: false, reason: String(error) }));
      if (!lease.ok) {
        if (build.waitingForBudget !== true) {
          this.#save(build, { waitingForBudget: true });
          this.#report();
        }
        return setAlarm(now() + BUDGET_RETRY_MS);
      }
      build = this.#save(build, { leased: true, leaseAt: now(), waitingForBudget: false });
      this.#report();
    }
    build = await this.#renewLease(build);
    // A Container a reset (or the platform) lost after its start, past a probe's time to come up: started again.
    if (build.started === true && !container.running() && now() - (build.containerAt ?? 0) > PROBE_MS) build = this.#save(build, { started: false });
    if (build.started !== true) {
      // The Image setup's clock starts at the Container's first start, and is kept before the start, which may throw.
      build = this.#save(build, { setupDeadline: build.setupDeadline ?? now() + build.setupMs });
      if (now() > build.setupDeadline!) return this.#fail(build, null, this.#startLimit(build));
      // A Container left from a canceled build, or from before a reset.
      if (container.running()) await container.destroy().catch(() => undefined);
      container.start({ from: { image: build.image }, entrypoint: ["sleep", "infinity"], instance: build.instance });
      build = this.#save(build, { started: true, containerAt: now() });
    }
    if (now() > build.setupDeadline!) return this.#fail(build, null, this.#startLimit(build));
    const ready = await container.exec(["true"], { timeoutMs: PROBE_MS }).then(
      (answer) => answer.exitCode === 0,
      () => false,
    );
    if (!ready) return setAlarm(now() + POLL_MS.starting);
    // The settings again, now that the Container is up: one that moved since the build began is a new key.
    const inputs = await this.#inputs();
    const current = await this.#currentOf(inputs);
    if (current.key !== build.key) {
      this.#deps.storage.put(BUILDER_KEYS.current, current);
      await this.#end(build, "canceled");
      if (!current.nothingToBuild) this.#begin(inputs, current.key, build.reason, false);
      return setAlarm(now() + POLL_MS.starting);
    }
    const { settings } = inputs;
    const write = async (path: string, text: string) => {
      const answer = await container.exec(["bash", "-c", WRITE_SCRIPT, "t3flare-builder", path], { stdin: text, timeoutMs: PROBE_MS });
      if (answer.exitCode !== 0) throw new Error(`writing ${path} exited ${String(answer.exitCode)}`);
    };
    await write(BUILDER_FILES.setup, settings.imageSetup);
    await write(BUILDER_FILES.mise, settings.globalMiseConfig);
    await write(BUILDER_FILES.laydown, LAYDOWN_SCRIPT);
    await write(BUILDER_FILES.run, RUN_SCRIPT);
    const mise = await sha256Hex(settings.globalMiseConfig);
    // Every Variable, then COMMAND_ENV, then HOME=/root (ADR-0047's preamble): what a Container's commands get.
    const env = { ...variableEnv(settings.variables), ...this.#runEnv.commandEnv, HOME: OWNER_HOME };
    // The lay-down's install has the Container start's time limit (`globalMiseInstallMinutes`), which is not part of the
    // Base key: a changed limit builds nothing again.
    const args = globalMiseArgs({ revision: settings.revision, sha256: mise, source: "environment", mode: "lay-down", minutes: settings.globalMiseInstallMinutes });
    const launched = await container.exec(["bash", "-c", LAUNCH_SCRIPT, "t3flare-builder", ...args], { env, timeoutMs: PROBE_MS });
    if (launched.exitCode !== 0) throw new Error(`the run's launch exited ${String(launched.exitCode)}`);
    this.#phase(build, "running");
    await setAlarm(now() + POLL_MS.running);
  }

  #startLimit(build: Build): string {
    return `the Builder's Container did not start within the Image setup's time limit (${Math.round(build.setupMs / 60_000)} min)${build.lastError === undefined ? "" : `: ${build.lastError}`}`;
  }

  async #running(build: Build): Promise<void> {
    const { container, now, setAlarm } = this.#deps;
    build = await this.#renewLease(build);
    const answer = await container.exec(["bash", "-c", EXIT_SCRIPT], { timeoutMs: PROBE_MS }).catch(() => undefined);
    const code = answer === undefined ? Number.NaN : Number.parseInt(answer.stdout.trim(), 10);
    if (Number.isInteger(code)) {
      if (code !== 0) return this.#fail(build, code, `the Image setup exited ${code}`);
      this.#snapshot(this.#phase(build, "snapshotting"));
      return setAlarm(now() + POLL_MS.snapshotting);
    }
    if (answer === undefined && !container.running()) return this.#fail(build, null, "the Builder's Container stopped while the Image setup ran");
    if (build.setupDeadline !== undefined && now() > build.setupDeadline) return this.#fail(build, null, `the Image setup ran past its time limit (${Math.round(build.setupMs / 60_000)} min)`);
    await setAlarm(now() + POLL_MS.running);
  }

  /** Takes the snapshot in the background and records how it ended; the alarm reads it (`#snapshotting`). */
  #snapshot(build: Build): void {
    const { storage, container } = this.#deps;
    const call: SnapshotCall = { build: build.id, epoch: this.#epoch };
    storage.put(BUILDER_KEYS.snapshot, call);
    const done = (result: NonNullable<SnapshotCall["result"]>) => {
      if (storage.get<SnapshotCall>(BUILDER_KEYS.snapshot)?.build === build.id) storage.put(BUILDER_KEYS.snapshot, { ...call, result });
      void this.#deps.setAlarm(this.#deps.now()).catch(() => undefined);
    };
    this.#deps.waitUntil(
      container.snapshot(`t3flare-${this.#test ? "test" : "base"}-${build.key.slice(0, 12)}-${build.id}`).then(
        (snapshot) => done({ ok: true, id: snapshot.id, size: snapshot.size }),
        (error: unknown) => done({ ok: false, error: errorText(error) }),
      ),
    );
  }

  async #snapshotting(build: Build): Promise<void> {
    const { storage, container, now, setAlarm } = this.#deps;
    build = await this.#renewLease(build);
    const call = storage.get<SnapshotCall>(BUILDER_KEYS.snapshot);
    if (call?.build === build.id && call.result !== undefined) {
      if (!call.result.ok) {
        storage.delete(BUILDER_KEYS.snapshot);
        return this.#fail(build, null, `the snapshot failed: ${call.result.error}`);
      }
      // Kept in the build before the call is let go, so a failure after this never loses the snapshot's id.
      await this.#prove(build, { id: call.result.id, size: call.result.size });
      storage.delete(BUILDER_KEYS.snapshot);
      return;
    }
    if (this.#snapshotInFlight() === undefined) {
      // A reset lost the call (its result will never come here): taken again while the Container still runs.
      if (!container.running()) return this.#fail(build, null, "the Builder's Container stopped before its snapshot was taken");
      this.#snapshot(build);
      return setAlarm(now() + POLL_MS.snapshotting);
    }
    if (now() - build.phaseAt > build.snapshotMs) {
      // Reported failed, but never abandoned: the Container waits for the result, kept if its key is still current.
      return this.#fail(build, null, `the snapshot took longer than ${Math.round(build.snapshotMs / 60_000)} min`, { awaitingSnapshot: true });
    }
    await setAlarm(now() + POLL_MS.snapshotting);
  }

  /** A snapshot that ended after its build failed or was canceled: proved if its key is still current, else let go. */
  async #lateSnapshot(build: Build): Promise<void> {
    const { storage, container } = this.#deps;
    const call = storage.get<SnapshotCall>(BUILDER_KEYS.snapshot);
    if (call?.build === build.id && call.result === undefined && call.epoch === this.#epoch) return;
    storage.delete(BUILDER_KEYS.snapshot);
    const result = call?.build === build.id ? call.result : undefined;
    const current = storage.get<Current>(BUILDER_KEYS.current);
    const someoneElse = isRunning(storage.get<Build>(BUILDER_KEYS.build)) && storage.get<Build>(BUILDER_KEYS.build)?.id !== build.id;
    if (result?.ok === true && build.phase === "failed" && current?.key === build.key && !someoneElse) {
      this.#deps.log?.({ t3flare: "base-build-late-snapshot", build: build.id });
      // The failure goes: the build goes on to its proof.
      const { failure: _failure, ...kept } = build;
      return this.#prove(this.#save(kept as Build, { awaitingSnapshot: false }), { id: result.id, size: result.size });
    }
    this.#save(build, { awaitingSnapshot: false, secrets: [], secretsCleared: true });
    if (!someoneElse && container.running()) await container.destroy().catch(() => undefined);
    if (!someoneElse) await this.#release(build);
  }

  /** The candidate is taken: the proof starts from it (`#proving`). */
  async #prove(build: Build, snapshot: { readonly id: string; readonly size: number }): Promise<void> {
    this.#deps.storage.delete(BUILDER_KEYS.refused);
    await this.#proving(this.#phase(build, "proving", { snapshot, provingStarted: false }));
  }

  /** Records a refused start from the candidate when `monitor()` rejects (within a second of the start). */
  #watchProof(build: Build): void {
    const { storage, container, now, setAlarm } = this.#deps;
    container.monitor().catch((error: unknown) => {
      const kept = storage.get<Build>(BUILDER_KEYS.build);
      if (kept?.id === build.id && kept.phase === "proving") {
        storage.put(BUILDER_KEYS.refused, { build: build.id, message: errorText(error) });
        void setAlarm(now()).catch(() => undefined);
      }
    });
  }

  async #proving(build: Build): Promise<void> {
    const { container, storage, now, setAlarm } = this.#deps;
    build = await this.#renewLease(build);
    if (build.provingStarted !== true && build.snapshot !== undefined) {
      if (container.running()) await container.destroy();
      container.start({ from: { snapshot: build.snapshot.id }, instance: build.instance });
      const proving = this.#save(build, { provingStarted: true, provingEpoch: this.#epoch, containerAt: now() });
      this.#watchProof(proving);
      return setAlarm(now() + POLL_MS.proving);
    }
    const refused = storage.get<{ readonly build: string; readonly message: string }>(BUILDER_KEYS.refused);
    if (refused?.build === build.id) {
      storage.delete(BUILDER_KEYS.refused);
      return this.#fail(build, null, `a start from the snapshot failed: ${refused.message}`);
    }
    if (build.provingEpoch !== this.#epoch) {
      // A reset took the `monitor()` handler with the old instance: a start that is not running is not waited for.
      if (!container.running()) return this.#fail(build, null, "a start from the snapshot was not running after the Builder was reset");
      this.#watchProof(this.#save(build, { provingEpoch: this.#epoch }));
    }
    const proved = await container.exec(["bash", "-c", PROOF_SCRIPT], { timeoutMs: PROBE_MS }).then(
      (answer) => answer.exitCode === 0,
      () => false,
    );
    if (proved && build.snapshot !== undefined) {
      const at = now();
      const good = goodOf(build, build.snapshot, at);
      // A test's snapshot is its result alone (kept in its build): never the Base snapshot.
      if (!this.#test) storage.put(BUILDER_KEYS.good, good);
      this.#deps.log?.({ t3flare: "base-build-ready", build: build.id, size: good.size, tookMs: good.tookMs });
      return this.#end(build, "ready");
    }
    if (now() - build.phaseAt > build.snapshotMs) return this.#fail(build, null, `a start from the snapshot did not run computerd within ${Math.round(build.snapshotMs / 60_000)} min`);
    await setAlarm(now() + POLL_MS.proving);
  }

  async #fail(build: Build, exitCode: number | null, message: string, change: Partial<Build> = {}): Promise<void> {
    const { container, now } = this.#deps;
    let output = "";
    // The secrets are cleared only once a build is over; a build that has none of them kept shows no output at all.
    if (container.running() && build.secretsCleared !== true) {
      // The kept bytes and the Container setup's margin, so a secret the window cuts at its head is still blanked whole:
      // the same window and blanking as a Container setup's report (`blankSecrets`).
      const tail = await container.exec(["bash", "-c", TAIL_SCRIPT, "t3flare-builder", String(build.outputBytes + SECRET_MARGIN_BYTES)], { timeoutMs: PROBE_MS }).catch(() => undefined);
      output = blankSecrets(tail?.stdout ?? "", build.secrets, build.outputBytes);
    }
    const failure: BaseBuildFailure = { at: now(), phase: build.phase as BaseBuildPhase, exitCode, message: message.slice(0, BASE_BUILD_CAPS.message), output };
    this.#deps.log?.({ t3flare: "base-build-failed", build: build.id, phase: build.phase, exitCode, message: message.slice(0, BASE_BUILD_CAPS.log) });
    await this.#end(this.#save(build, { ...change, failure }), "failed");
  }

  /**
   * Ends `build`: its opened secrets cleared, its Container destroyed (unless a snapshot is still being taken on it), its
   * lease released, and the schedule armed from the last good Base snapshot.
   */
  async #end(build: Build, phase: "ready" | "failed" | "canceled"): Promise<void> {
    const { container, storage, now, setAlarm } = this.#deps;
    const snapshotting = build.awaitingSnapshot === true || (build.phase === "snapshotting" && this.#snapshotInFlight()?.build === build.id);
    const ended = this.#save(build, { phase, endedAt: now(), ...(snapshotting ? { awaitingSnapshot: true } : { secrets: [], secretsCleared: true }) });
    if (phase === "ready") storage.delete(BUILDER_KEYS.failures);
    else if (phase === "failed") storage.put(BUILDER_KEYS.failures, { key: build.key, count: this.#failures(build.key) + 1 });
    if (!snapshotting) {
      if (container.running()) await container.destroy().catch(() => undefined);
      await this.#release(ended);
    }
    this.#deps.log?.({ t3flare: "base-build", build: build.id, phase });
    this.#report();
    if (snapshotting) await setAlarm(now() + POLL_MS.snapshotting);
    else if (await this.#armSchedule(ended)) await setAlarm(now());
    else if (this.#watching()) await setAlarm(now() + IMAGE_WATCH_POLL_MS);
  }

  async #release(build: Build): Promise<void> {
    if (build.leased !== true) return;
    await this.#deps.lease.release().catch(() => undefined);
    this.#save(build, { leased: false });
  }
}
