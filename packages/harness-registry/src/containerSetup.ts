// @effect-diagnostics globalDate:off
// The Container setup as the Workspace DO reports it and the Settings page's Status shows it (ADR-0047 §7): one report
// per run, sent to the Environment DO, which keeps the last across all Workspaces. The Settings server's `get_status`
// reads the same. Imported by both Workers.
import { CONTAINER_SETUP_FAILURES, type ContainerSetupFailure, MAX_SETUP_OUTPUT_KIB } from "./environment.ts";
import { SETTINGS_SOURCES, type SettingsSource } from "./globalMise.ts";

/** The most output a report may carry, in bytes of UTF-8: `setupOutputKiB`'s bound. A report keeps its launch's setting. */
export const MAX_SETUP_OUTPUT_BYTES = MAX_SETUP_OUTPUT_KIB * 1024;

/** The Status key of the last Container setup's output: the Settings page shows it as a block of lines. */
export const CONTAINER_SETUP_OUTPUT_STATUS = "last Container setup output";

/**
 * How one run ended: `ok` (exit 0), `failed` (a non-zero exit, its time limit included), `none` (the start had no
 * Container setup: nothing run), `exec-failed` (the platform's exec refused or broke, or no answer came back; retried)
 * or `deadline` (the Workspace DO stopped waiting; final for that Container).
 */
export const CONTAINER_SETUP_OUTCOMES = ["ok", "failed", "none", "exec-failed", "deadline"] as const;
export type ContainerSetupOutcome = (typeof CONTAINER_SETUP_OUTCOMES)[number];

export interface ContainerSetupReport {
  /** The Workspace's id (t3's path), or null when the Workspace DO does not know it. */
  readonly workspace: string | null;
  /** The Container's runtime id the run was for. */
  readonly runtime: string;
  readonly revision: number;
  /** The script's SHA-256 and size: never its text. */
  readonly sha256: string;
  readonly bytes: number;
  readonly source: SettingsSource;
  readonly outcome: ContainerSetupOutcome;
  /** The script's exit, or null when it did not end (or never ran). */
  readonly exitCode: number | null;
  /** Its time limit stopped it (exit 124, or 137 after the KILL). */
  readonly timedOut: boolean;
  /** The last `setupOutputKiB` of its stdout and stderr, every secret Variable's value blanked. */
  readonly output: string;
  /** What a failure did to that Container: the policy its launch carried. */
  readonly failure: ContainerSetupFailure;
  readonly ms: number;
  readonly at: number;
}

const utf8 = new TextEncoder();

/** `value` as a report, or undefined when it is not one (the Environment DO takes it from another Worker). */
export const containerSetupReport = (value: unknown): ContainerSetupReport | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  const shortText = (field: unknown, max: number) => typeof field === "string" && field.length <= max;
  const count = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0;
  const ok =
    (report.workspace === null || shortText(report.workspace, 1024)) &&
    shortText(report.runtime, 200) &&
    count(report.revision) &&
    typeof report.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(report.sha256) &&
    count(report.bytes) &&
    (SETTINGS_SOURCES as ReadonlyArray<unknown>).includes(report.source) &&
    (CONTAINER_SETUP_OUTCOMES as ReadonlyArray<unknown>).includes(report.outcome) &&
    (report.exitCode === null || (typeof report.exitCode === "number" && Number.isInteger(report.exitCode))) &&
    typeof report.timedOut === "boolean" &&
    typeof report.output === "string" &&
    utf8.encode(report.output).length <= MAX_SETUP_OUTPUT_BYTES &&
    (CONTAINER_SETUP_FAILURES as ReadonlyArray<unknown>).includes(report.failure) &&
    count(report.ms) &&
    count(report.at);
  if (!ok) return undefined;
  return {
    workspace: report.workspace as string | null,
    runtime: report.runtime as string,
    revision: report.revision as number,
    sha256: report.sha256 as string,
    bytes: report.bytes as number,
    source: report.source as SettingsSource,
    outcome: report.outcome as ContainerSetupOutcome,
    exitCode: report.exitCode as number | null,
    timedOut: report.timedOut as boolean,
    output: report.output as string,
    failure: report.failure as ContainerSetupFailure,
    ms: report.ms as number,
    at: report.at as number,
  };
};

/** A run's length for Status: tenths of a second under a minute's worth, whole seconds after. */
const seconds = (ms: number) => (ms < 60_000 ? String(Math.round(ms / 100) / 10) : String(Math.round(ms / 1000)));

/** One line for the Settings page's Status: whether it failed first, and when a failure refuses its Container's commands. */
export const describeContainerSetup = (report: ContainerSetupReport): string => {
  let what: string;
  if (report.outcome === "none") what = "no Container setup";
  else if (report.outcome === "exec-failed") what = "not run (the Container's exec failed; tried again)";
  else if (report.outcome === "deadline") what = "failed, no answer within the deadline";
  else if (report.timedOut) what = `failed, stopped at its time limit after ${seconds(report.ms)} s`;
  else
    what = `${report.outcome === "ok" ? "ran" : "failed"}, exit ${String(report.exitCode)} after ${seconds(report.ms)} s`;
  const refused = report.failure === "refuse" && report.outcome !== "ok" && report.outcome !== "none";
  if (refused) what = `${what}; its Container refuses commands`;
  return `${report.workspace ?? "a Workspace"} at revision ${report.revision}: ${what}, ${new Date(report.at).toISOString()}`;
};
