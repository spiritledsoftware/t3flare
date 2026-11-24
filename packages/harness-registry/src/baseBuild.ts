// @effect-diagnostics globalDate:off
// The Base build's record (SPI-1332, ADR-0047 §4): what the Builder answers (`builderRecord`), reports to the Environment
// DO on every change, and what the Settings page's Status and the Settings server's `get_status` show. Imported by both
// Workers: the Builder writes it, the Environment DO keeps the last one it was sent and reads it back through
// `baseBuildRecord`, which drops a malformed one (another Worker's version).
import { MAX_SETUP_OUTPUT_KIB } from "./environment.ts";
import { DO_VALUE_BYTES } from "./storedValue.ts";
import { MAX_VARIABLES_BYTES } from "./variables.ts";

/**
 * The reserved names of the Builders (ADR-0047 §1, §8): instances of the Workspace DO's class that are never a Workspace.
 * A Workspace's id never holds a colon, so none can take one of these.
 */
export const BUILDERS = {
  /** The Base build's Builder: its snapshot is what new Containers start from. */
  base: "t3flare:base-builder",
  /** The Test base build's Builder (SPI-1334): a proposed Image setup's result, its snapshot never used. */
  test: "t3flare:test-builder",
} as const;

/** A build's steps, in order (`baseBuild.ts` in the agents Worker). */
export const BASE_BUILD_PHASES = ["starting", "running", "snapshotting", "proving"] as const;
export type BaseBuildPhase = (typeof BASE_BUILD_PHASES)[number];

/** A Base snapshot the Builder made and proved: a start from it ran computerd and a command. */
export interface BaseSnapshot {
  /** The platform's snapshot id (`containerSnapshot: { id }`). */
  readonly id: string;
  /** Its size in bytes: the changes over the Workspace image only. */
  readonly size: number;
  /** What made it (`baseKey`). */
  readonly key: string;
  /** The Workspace image it was made on: a start from it on another image runs the old one. */
  readonly imageDigest: string;
  readonly builtAt: number;
  /** From the build's start to its proof. */
  readonly tookMs: number;
}

/** Why a build failed, with the end of its output (every secret Variable's value blanked). */
export interface BaseBuildFailure {
  readonly at: number;
  readonly phase: BaseBuildPhase;
  /** The Image setup's exit code; null when it did not end on its own (a time limit, a lost Container, a snapshot). */
  readonly exitCode: number | null;
  readonly message: string;
  readonly output: string;
}

export interface BaseBuildRecord {
  /**
   * A Test base build's record (SPI-1334, ADR-0047 §8), from `BUILDERS.test`: `good` is the test's proved snapshot, which
   * no Container ever starts from. A Base build's record never carries it, so neither is ever kept as the other.
   */
  readonly test?: true;
  /** A test's: the SHA-256 (hex) of the Image setup it ran, so a page can tell a result from an edited text's. */
  readonly setup?: string;
  /** The key of the settings the Builder last read (`baseKey`); null before it read any. */
  readonly key: string | null;
  /**
   * The Environment settings' revision `key` was read at (SPI-1333): a Workspace whose start took a newer revision asks
   * the Builder to read them again before it trusts `key`. Absent before the Builder read any, or in an older record.
   */
  readonly revision?: number;
  /**
   * The Workspace image `key` was read on (SPI-1333): a Workspace whose own image differs asks the Builder to read it
   * again, and waits for it as for a build on a new image. Absent before the Builder read any, or in an older record.
   */
  readonly imageDigest?: string;
  /** What the Base snapshot is for `key`: none, being built, ready (`good` is for it), or its last build failed. */
  readonly state: "none" | "building" | "ready" | "failed";
  /** `none` because there is nothing to build: no Image setup and no Global mise config. */
  readonly nothingToBuild?: boolean;
  readonly phase?: BaseBuildPhase;
  /** When the build under way started. */
  readonly since?: number;
  /** What started the build under way. */
  readonly reason?: string;
  /** The build waits for room under the Container budget (`builderInBudget`). */
  readonly waitingForBudget?: boolean;
  /** The last build of `key` failed: `failed`, or `ready` when a good one is still for `key` (a failed rebuild). */
  readonly failure?: BaseBuildFailure;
  /** The last good Base snapshot, for whatever key; one older than 29 days is gone and not shown. */
  readonly good: BaseSnapshot | null;
  /** When the record was made. */
  readonly at: number;
}

/** The most output a record may carry: the most `setupOutputKiB` keeps. */
const MAX_OUTPUT = MAX_SETUP_OUTPUT_KIB * 1024;

/**
 * The most characters (UTF-16 units) of each of a build's free texts, which the Builder cuts to this and
 * `baseBuildRecord` accepts. A named constraint: the Builder keeps its build under way (`Build` in the agents Worker) as
 * one Durable Object value (`DO_VALUE_BYTES`), which stores a string in at most two bytes a unit. That value holds the
 * most output, the secret Variables' values (at most `MAX_VARIABLES_BYTES` of UTF-8, so at most twice that stored, each
 * value's tag within the `NAME=` and NUL that bound counts) and three free texts: its `reason`, its `lastError` and its
 * failure's `message`. What the output and the secrets leave, less 16 KiB for the other fields, is split between the three.
 * A record carries two of them, so it fits too.
 */
export const BASE_BUILD_TEXT_CHARACTERS = Math.floor(
  (DO_VALUE_BYTES - 2 * MAX_OUTPUT - 2 * MAX_VARIABLES_BYTES - 16 * 1024) / 3 / 2,
);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

const isSnapshot = (value: unknown): value is BaseSnapshot =>
  isObject(value) &&
  isText(value.id, 512) &&
  isTime(value.size) &&
  isText(value.key, 128) &&
  isText(value.imageDigest, 512) &&
  isTime(value.builtAt) &&
  isTime(value.tookMs);

const isFailure = (value: unknown): value is BaseBuildFailure =>
  isObject(value) &&
  isTime(value.at) &&
  (BASE_BUILD_PHASES as ReadonlyArray<unknown>).includes(value.phase) &&
  (value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
  isText(value.message, BASE_BUILD_TEXT_CHARACTERS) &&
  isText(value.output, MAX_OUTPUT);

/** `value` as a record, or undefined when it is not one. */
export const baseBuildRecord = (value: unknown): BaseBuildRecord | undefined => {
  if (!isObject(value)) return undefined;
  const ok =
    (value.test === undefined || value.test === true) &&
    (value.setup === undefined || (typeof value.setup === "string" && /^[0-9a-f]{64}$/.test(value.setup))) &&
    (value.key === null || isText(value.key, 128)) &&
    (value.revision === undefined || (isTime(value.revision) && Number.isInteger(value.revision))) &&
    (value.imageDigest === undefined || isText(value.imageDigest, 512)) &&
    ["none", "building", "ready", "failed"].includes(value.state as string) &&
    (value.nothingToBuild === undefined || typeof value.nothingToBuild === "boolean") &&
    (value.phase === undefined || (BASE_BUILD_PHASES as ReadonlyArray<unknown>).includes(value.phase)) &&
    (value.since === undefined || isTime(value.since)) &&
    (value.reason === undefined || isText(value.reason, BASE_BUILD_TEXT_CHARACTERS)) &&
    (value.waitingForBudget === undefined || typeof value.waitingForBudget === "boolean") &&
    (value.failure === undefined || isFailure(value.failure)) &&
    (value.good === null || isSnapshot(value.good)) &&
    isTime(value.at);
  // SAFETY: every field was checked above.
  return ok ? (value as unknown as BaseBuildRecord) : undefined;
};

/** Bytes as a person reads them, in powers of 1000 (the platform's snapshot sizes). */
export const snapshotSizeText = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
};

/** A duration in minutes and seconds. */
export const buildDurationText = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

const iso = (at: number) => new Date(at).toISOString();

/** A failure as one line: when, its exit code, and why. */
const failureText = (failure: BaseBuildFailure): string =>
  `failed ${iso(failure.at)}${failure.exitCode === null ? "" : ` (exit ${failure.exitCode})`}: ${failure.message}`;

/** The record as Status's one line; the failed build's output is shown apart from it. */
export const describeBaseBuild = (record: BaseBuildRecord): string => {
  switch (record.state) {
    case "none":
      return record.nothingToBuild === true
        ? "none: no Image setup and no Global mise config, so Containers start from the Workspace image"
        : "none yet";
    case "building": {
      const step =
        record.waitingForBudget === true ? "waiting for room under the Container budget" : (record.phase ?? "starting");
      return `building since ${iso(record.since ?? record.at)} (${step}${record.reason === undefined ? "" : `; ${record.reason}`})`;
    }
    case "ready": {
      const ready =
        record.good === null
          ? "ready"
          : `ready: built ${iso(record.good.builtAt)}, ${snapshotSizeText(record.good.size)}, took ${buildDurationText(record.good.tookMs)}`;
      // A rebuild of the same settings that failed (a scheduled one): the good one stays in use.
      return record.failure === undefined
        ? ready
        : `${ready}; a rebuild failed ${iso(record.failure.at)}${record.failure.exitCode === null ? "" : ` (exit ${record.failure.exitCode})`}: ${record.failure.message}`;
    }
    case "failed": {
      const failure = record.failure;
      const what = failure === undefined ? "failed" : failureText(failure);
      return record.good === null
        ? what
        : `${what}; the last good one (built ${iso(record.good.builtAt)}) is for older settings`;
    }
  }
};

/** A Test base build's record (SPI-1334) as one line: its result is never used, so a pass says only what it made. */
export const describeTestBaseBuild = (record: BaseBuildRecord): string => {
  switch (record.state) {
    case "none":
      return record.nothingToBuild === true
        ? "nothing to build: the proposed Image setup is empty and there is no Global mise config"
        : "no test yet";
    case "building": {
      const step =
        record.waitingForBudget === true ? "waiting for room under the Container budget" : (record.phase ?? "starting");
      return `testing since ${iso(record.since ?? record.at)} (${step})`;
    }
    case "ready":
      return record.good === null
        ? "passed"
        : `passed ${iso(record.good.builtAt)}: ${snapshotSizeText(record.good.size)}, took ${buildDurationText(record.good.tookMs)}`;
    case "failed":
      return record.failure === undefined ? "failed" : failureText(record.failure);
  }
};
