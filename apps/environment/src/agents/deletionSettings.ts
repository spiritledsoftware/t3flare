// The Sweep's settings (ADR-0043 §2–3), apart from `deletion.ts` so the Environment DO's module graph stays small:
// the Grace, whether the Sweep purges, and how long a Workspace may provision, read from the Environment settings at
// each use.
import type { ResolvedEnvironment } from "@t3flare/harness-registry";

export const DAY_MS = 24 * 60 * 60_000;

/** How often the Sweep runs (ADR-0043 §5); a new Environment's first Sweep is one of these after its first look. */
export const SWEEP_EVERY_MS = DAY_MS;

/** The Grace as the Sweep reads it at each use, from the Environment settings as stored now. */
export interface SweepSettings {
  /** The Environment setting `sweepPurges`: off, the Sweep still marks, and purges nothing (ADR-0043 §4). */
  readonly purging: boolean;
  readonly graceMs: number;
  /** The Environment setting `graceDays`, as stored (the page's control shows it even when overridden). */
  readonly graceDays: number;
  /** A Stage's `T3FLARE_SWEEP_GRACE_MS` overrides the Grace's days (the page says so). */
  readonly overridden: boolean;
  /** How old a `provisioning` or `failed` row must be before the Sweep purges it (`provisioningLimitMs`). */
  readonly provisioningMs: number;
}

/** The Environment settings that bound how long a Workspace may stay `provisioning`. */
export type ProvisioningTimes = Pick<
  ResolvedEnvironment,
  "cloneMinutes" | "imageSetupMinutes" | "snapshotMinutes" | "globalMiseInstallMinutes" | "containerSetupMinutes"
>;

/**
 * The longest a Workspace may stay `provisioning` under the settings as stored now (SPI-1359): its clone, after the
 * longest Container start they allow, a wait for a Base build (`waitLimitMs`: the Image setup's limit and twice the
 * snapshot's) and the start's own steps (the Global mise install twice, and the Container setup). A row stays
 * `provisioning` for all of it, so a Sweep that purged it sooner would delete a Workspace whose clone is still running.
 */
export const provisioningLimitMs = (times: ProvisioningTimes): number =>
  (times.cloneMinutes +
    times.imageSetupMinutes +
    2 * times.snapshotMinutes +
    2 * times.globalMiseInstallMinutes +
    times.containerSetupMinutes) *
  60_000;

/** The Sweep's settings from the resolved Environment settings and a Stage's `T3FLARE_SWEEP_GRACE_MS`, if set and positive. */
export const sweepSettingsOf = (
  environment: Pick<ResolvedEnvironment, "sweepPurges" | "graceDays"> & ProvisioningTimes,
  overrideMs: string | undefined,
): SweepSettings => {
  const override = Number(overrideMs);
  const overridden = overrideMs !== undefined && overrideMs !== "" && Number.isFinite(override) && override > 0;
  return {
    purging: environment.sweepPurges,
    graceMs: overridden ? override : environment.graceDays * DAY_MS,
    graceDays: environment.graceDays,
    overridden,
    provisioningMs: provisioningLimitMs(environment),
  };
};
