// @effect-diagnostics globalTimers:off
// A Workspace's Container starts from the Base snapshot (SPI-1333, ADR-0047 §3, §6). At a fresh start the Workspace DO
// asks the Builder (`BUILDERS.base`) for its record and picks what to start from (`pickBase`): the Base snapshot when it is
// ready for the start's settings and made on this Workspace image; while a build runs, as the Owner set
// (`whileBuilding`, `whileBuildingNewImage`); else the Workspace image, exactly as before. The Workspace cannot compute the
// key (its secret Variables enter it under the Builder's own HMAC key), so it trusts the record's key once the Builder has
// read the start's settings revision, and asks it to read them first when it has not (a `missing` report, which also builds
// a key that has no Base snapshot).
//
// Three seams:
// - `pickBase`: pure, over the record, the settings and the image digest.
// - `waitForBase` in `BaseWaitBackend`, before computer's connect: a wait inside the gated start would run against
//   computer's 60 s connect deadline (it starts before `host.start`) and hold up a close of the Workspace.
// - `startFromBase` in the gated start: after a start from the snapshot, the platform's `monitor()` is watched; a refused
//   snapshot (missing or expired) is seen within a second, not at the end of computer's 60 s connect deadline (one budget its attempts share), and the start goes again
//   from the Workspace image, once.
import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import {
  BASE_BUILD_CAPS,
  type BaseBuildRecord,
  type BaseSnapshot,
  type ResolvedEnvironment,
} from "@t3flare/harness-registry";

/** The settings a pick reads. */
export type BaseSettings = Pick<
  ResolvedEnvironment,
  | "revision"
  | "imageSetup"
  | "globalMiseConfig"
  | "whileBuilding"
  | "whileBuildingNewImage"
  | "imageSetupMinutes"
  | "snapshotMinutes"
>;

/**
 * What a fresh start starts from: a Base snapshot; the Workspace image (`missing`: the Builder is told no Base snapshot is
 * for the settings, and decides whether to build); a wait for the build under way; or `ask`, the Builder asked to read the
 * start's settings, then picked again.
 */
export type BasePick =
  | { readonly kind: "base"; readonly base: BaseSnapshot; readonly why: string }
  | { readonly kind: "image"; readonly why: string; readonly missing?: true }
  | { readonly kind: "wait"; readonly why: string }
  | { readonly kind: "ask"; readonly why: string };

/** What a Container started from, kept in its launch (`ContainerLaunch.from`): a running Container keeps it. */
export type LaunchFrom =
  | { readonly base: { readonly snapshotId: string; readonly key: string } }
  | { readonly image: { readonly why: string } };

const image = (why: string, missing = false): BasePick =>
  missing ? { kind: "image", why, missing: true } : { kind: "image", why };

/** The image without asking the Builder: nothing to build, or no image digest to match a Base snapshot against. */
const withoutBuilder = (settings: BaseSettings, imageDigest: string | undefined): BasePick | undefined => {
  if (settings.imageSetup === "" && settings.globalMiseConfig === "")
    return image("no Image setup and no Global mise config");
  if (imageDigest === undefined) return image("no Workspace image digest here");
  return undefined;
};

/**
 * What a fresh start starts from (ADR-0047 §6). `asked`: the Builder already read the start's settings for it (a `missing`
 * report), so it is not asked or told again.
 */
export const pickBase = (
  record: BaseBuildRecord | undefined,
  settings: BaseSettings,
  imageDigest: string | undefined,
  options: { readonly asked?: boolean } = {},
): BasePick => {
  const asked = options.asked === true;
  const local = withoutBuilder(settings, imageDigest);
  if (local !== undefined) return local;
  if (record === undefined) return image("the Builder did not answer");
  // The Builder last read another image than this start's (a deploy's rollout reaches each object in its own time).
  const otherImage = record.imageDigest !== undefined && record.imageDigest !== imageDigest;
  // The Builder has not read this start's settings: its key and its ready one are an older revision's.
  const behind = record.revision === undefined || record.revision < settings.revision;
  if (!asked && behind) return { kind: "ask", why: "the Builder has not read these settings yet" };
  if (!asked && otherImage) return { kind: "ask", why: "the Builder has not read this Workspace image yet" };
  const onImage = (snapshot: BaseSnapshot | null): snapshot is BaseSnapshot =>
    snapshot !== null && snapshot.imageDigest === imageDigest;
  const good = record.good;
  /** What a start does while a build runs, or is about to (ADR-0047 §6). */
  const duringBuild = (what: string): BasePick => {
    if (settings.whileBuilding === "image")
      return image(`${what}, and the settings start from the Workspace image meanwhile`);
    if (settings.whileBuilding === "wait") return { kind: "wait", why: `${what}, and the settings wait for it` };
    // A good one on this image: the current settings' own (a Rebuild, a scheduled rebuild) or older ones'.
    if (onImage(good)) return { kind: "base", base: good, why: `the last good Base snapshot, while ${what}` };
    return settings.whileBuildingNewImage === "wait"
      ? {
          kind: "wait",
          why: `${what} with no last good Base snapshot on this Workspace image, and the settings wait for it`,
        }
      : image(`${what} with no last good Base snapshot on this Workspace image`);
  };
  // Asked, and still on another image. Which of the two is newer cannot be told: a build under way is waited for as any
  // is; otherwise this start runs the image this object sees (the Builder's watch builds a newer one when it lands).
  if (otherImage)
    return record.state === "building"
      ? duringBuild("a Base build runs on another Workspace image")
      : image("the Builder reads another Workspace image");
  // Asked, and still behind this start's settings: never ready for them; the while-building settings apply.
  if (behind) return duringBuild("the Builder has not read these settings yet");
  switch (record.state) {
    case "ready":
      if (onImage(good)) return { kind: "base", base: good, why: "the Base snapshot is ready" };
      // An older Builder's record (no image digest): its key is for another image.
      return asked
        ? image("the Base snapshot was made on another Workspace image")
        : { kind: "ask", why: "the Base snapshot was made on another Workspace image" };
    case "building":
      return duringBuild("a Base build runs");
    case "none":
      if (record.nothingToBuild === true) return image("the Builder has nothing to build");
      return image("no Base snapshot for these settings yet", !asked);
    case "failed":
      return image("the last Base build of these settings failed", !asked);
  }
};

/** The Builder as a start asks it: its record, and a `missing` report (which answers the record after it read the settings). */
export interface BaseBuilder {
  readonly record: () => Promise<BaseBuildRecord>;
  readonly missing: () => Promise<BaseBuildRecord>;
}

/** How long a start waits for one answer of the Builder. Fixed: a bound on one call to another object, as `ENVIRONMENT_READ_MS` is. */
export const BUILDER_READ_MS = 5_000;

/** `promise`'s value, or undefined when it fails or does not settle within `ms`. */
const bounded = async <T>(promise: () => Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise(),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A start's pick, the Builder asked to read the settings first when its record is older than them. Each call to the
 * Builder waits at most `boundMs`; one that fails or does not answer starts from the image.
 */
export const planBase = async (
  deps: { readonly builder: BaseBuilder; readonly imageDigest: string | undefined; readonly boundMs: number },
  settings: BaseSettings,
  options: { readonly mayAsk?: boolean } = {},
): Promise<BasePick> => {
  const local = withoutBuilder(settings, deps.imageDigest);
  if (local !== undefined) return local;
  const pick = pickBase(await bounded(deps.builder.record, deps.boundMs), settings, deps.imageDigest, {
    asked: options.mayAsk === false,
  });
  if (pick.kind !== "ask") return pick;
  // The report is serialised behind the Builder's alarm; past the bound, its record (never serialised) says what it began.
  const answered =
    (await bounded(deps.builder.missing, deps.boundMs)) ?? (await bounded(deps.builder.record, deps.boundMs));
  return pickBase(answered, settings, deps.imageDigest, { asked: true });
};

/**
 * How long a start waits for a Base build at most: the build's own limits, the Image setup's (from its Container's start)
 * then the snapshot's and the proof's, each `snapshotMinutes`. The Builder ends a build at them itself.
 */
export const waitLimitMs = (settings: Pick<ResolvedEnvironment, "imageSetupMinutes" | "snapshotMinutes">): number =>
  (settings.imageSetupMinutes + 2 * settings.snapshotMinutes) * 60_000;

/** How often a waiting start reads the Builder's record. Fixed: a poll of another object, not a policy (the limit is the settings'). */
export const BASE_WAIT_POLL_MS = 5_000;

/** Picks until the pick is not a wait, or `limitMs` passes (then the Workspace image). */
export const waitForBase = async (deps: {
  readonly plan: () => Promise<BasePick>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly limitMs: number;
  readonly pollMs: number;
}): Promise<BasePick> => {
  const until = deps.now() + deps.limitMs;
  for (;;) {
    const pick = await deps.plan();
    if (pick.kind !== "wait") return pick;
    const left = until - deps.now();
    if (left <= 0)
      return image(`the Base build did not end within its time limits (${Math.round(deps.limitMs / 60_000)} min)`);
    await deps.sleep(Math.min(deps.pollMs, left));
  }
};

/** The Container's backend with a wait before every connect (`wait` returns at once when there is nothing to wait for). */
export class BaseWaitBackend implements WorkspaceBackend {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly callable?: boolean;
  readonly #inner: WorkspaceBackend;
  readonly #wait: () => Promise<void>;

  constructor(inner: WorkspaceBackend, wait: () => Promise<void>) {
    this.#inner = inner;
    this.#wait = wait;
    this.id = inner.id;
    this.type = inner.type;
    this.description = inner.description ?? "";
    if (inner.callable !== undefined) this.callable = inner.callable;
  }

  async connect(host: Parameters<WorkspaceBackend["connect"]>[0]): Promise<BackendHandle> {
    // A wait that fails starts as if there were none: the gated start picks again, without waiting.
    await this.#wait().catch(() => undefined);
    return this.#inner.connect(host);
  }
}

/**
 * How long after a start from a snapshot the platform's refusal is waited for. Fixed by the platform: `monitor()` rejects
 * about 0.3 s after a start whose snapshot is missing or expired (the SPI-1332 spike). A refusal later than this is still
 * reported, so the next start does not pick the snapshot again.
 */
export const REFUSAL_WATCH_MS = 1_000;

/** An error's message, or the value as text. */
const messageOf = (error: unknown): string => String(error instanceof Error ? error.message : error);

/** Whether `error` is the platform's refusal of a start's snapshot (`Snapshot "<id>" was not found.`). */
export const isSnapshotRefusal = (error: unknown): boolean => /snapshot\b.*\bnot found/i.test(messageOf(error));

export interface BaseStartDeps<Answer extends { readonly outcome: string }> {
  /** computer's start, from `snapshotId` or (undefined) the Workspace image. */
  readonly start: (snapshotId: string | undefined) => Promise<Answer>;
  /** The platform's `monitor()` of the Container just started. */
  readonly monitor: () => Promise<void>;
  readonly destroy: () => Promise<void>;
  /** The platform refused `id`: the Builder is told, the launch recorded from the image. `late`: after the window. */
  readonly refused: (id: string, message: string, late: boolean) => void;
  readonly windowMs: number;
}

/**
 * A start from `snapshotId` (or the image), with the fast fallback: a refusal within `windowMs` destroys the Container,
 * reports it, and starts once more from the Workspace image; never a second snapshot. A Container computer adopted is not
 * watched (nothing was started).
 */
export const startFromBase = async <Answer extends { readonly outcome: string }>(
  deps: BaseStartDeps<Answer>,
  snapshotId: string | undefined,
): Promise<Answer> => {
  if (snapshotId === undefined) return deps.start(undefined);
  const answer = await deps.start(snapshotId);
  if (answer.outcome === "adopted") return answer;
  let watching = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refusal = await new Promise<string | undefined>((resolve) => {
    timer = setTimeout(() => {
      watching = false;
      resolve(undefined);
    }, deps.windowMs);
    deps.monitor().then(
      () => resolve(undefined),
      (error: unknown) => {
        if (!isSnapshotRefusal(error)) return resolve(undefined);
        const message = messageOf(error).slice(0, BASE_BUILD_CAPS.log);
        if (watching) return resolve(message);
        // Past the window: computer is connecting to a Container that never ran. It is told, and the next start differs.
        void deps
          .destroy()
          .catch(() => undefined)
          .then(() => deps.refused(snapshotId, message, true));
      },
    );
  });
  clearTimeout(timer);
  watching = false;
  if (refusal === undefined) return answer;
  await deps.destroy().catch(() => undefined);
  deps.refused(snapshotId, refusal, false);
  return deps.start(undefined);
};

/**
 * The spec computer's start gets (`ContainerLaunchSpec`): the start's own `instance` always (an omitted one starts `lite`),
 * and `containerSnapshot` only when a Base snapshot was picked. Nothing else of computer's spec moves, so `sameLaunch`
 * adopts a running Container as before.
 */
export const startSpec = <Spec extends object, Instance>(
  spec: Spec,
  instance: Instance,
  snapshotId: string | undefined,
) => ({
  ...spec,
  instance,
  ...(snapshotId === undefined ? {} : { containerSnapshot: { id: snapshotId } }),
});

/** The Base snapshot a launch started from, or undefined (the image, or a launch recorded before SPI-1333). */
export const baseIdOf = (from: LaunchFrom | undefined): string | undefined =>
  from !== undefined && "base" in from ? from.base.snapshotId : undefined;

/** What a pick records in the launch: a wait the start did not finish starts from the image. */
export const launchFrom = (pick: BasePick): LaunchFrom =>
  pick.kind === "base"
    ? { base: { snapshotId: pick.base.id, key: pick.base.key } }
    : { image: { why: pick.kind === "wait" ? `${pick.why}; this start did not wait` : pick.why } };
