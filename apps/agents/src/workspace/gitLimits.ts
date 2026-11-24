// The clone and checkpoint time limits (SPI-1324, ADR-0032's refinement): the Environment DO reads `cloneMinutes` and
// `checkpointMinutes` at each call and carries them as `timeoutMs`; a call that carries none (an older Environment, the
// admin route) gets the setting's default. A copy kept here would not exist yet for a new Workspace's first clone. A
// limit of 0 is off (the default, SPI-1386): computerd's exec still takes a deadline, `OFF_DEADLINE_MS`.
import { DEFAULT_CHECKPOINT_MS, DEFAULT_CLONE_MS, offDeadlineMs } from "@t3flare/harness-registry";

/** How long a clone, or a worktree's clone or checkout, may run in the Container: the carried limit, else the default. */
export const cloneLimitMs = (carried: number | undefined): number => offDeadlineMs(carried ?? DEFAULT_CLONE_MS);

/**
 * How long a checkpoint operation's git, a worktree's seed bundle, or a removed worktree's carry may run in the
 * Container: the carried limit, else the default.
 */
export const checkpointLimitMs = (carried: number | undefined): number =>
  offDeadlineMs(carried ?? DEFAULT_CHECKPOINT_MS);
