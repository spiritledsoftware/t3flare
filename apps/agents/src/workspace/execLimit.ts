// The Workspace's time limits on its Container commands (SPI-1324, SPI-1364, SPI-1430).
//
// The clone and checkpoint time limits: the Environment DO reads `cloneMinutes` and `checkpointMinutes` at each call and
// carries them as `timeoutMs`; a call that carries none (an older Environment, the admin route) gets the setting's
// default. A copy kept here would not exist yet for a new Workspace's first clone. A limit of 0 is off (the default,
// SPI-1386): computerd's exec still takes a deadline, `OFF_DEADLINE_MS`.
//
// Each names itself when hit (ADR-0049 §4). computerd ends a command at its deadline with a kill, which computer
// reports as `cancelled` (its name for an exit of 129, 130, 137 or 143): the same status as t3's cancel (`runCancels`),
// an abort's kill (`killExecs`), an OOM kill or a stop, all of which come before the deadline. So a `cancelled` command
// that ran to its deadline, timed from its spawn as computerd times it, was stopped by its limit, and its stderr says
// which, with its value and where to change it.
import {
  DEFAULT_CHECKPOINT_MS,
  DEFAULT_CLONE_MS,
  deadlineMs,
  offDeadlineMs,
  type SettingRef,
  timeLimitHit,
} from "@t3flare/harness-registry";

/** The limit behind a command's deadline: its setting, its value in minutes as it was taken, and what it limits. */
export interface ExecLimit {
  readonly ref: SettingRef;
  readonly minutes: number;
  readonly what: string;
}

/** A command's deadline and the limit behind it; no limit when it is off (it runs to the off deadline, a week). */
export interface TimedBy {
  readonly timeoutMs: number;
  readonly limit: ExecLimit | undefined;
}

// One value, `ms` (whole minutes, as the Environment carries them), gives both the deadline and the limit.
const carried = (ms: number, ref: SettingRef, what: string): TimedBy => {
  const minutes = Math.round(ms / 60_000);
  return { timeoutMs: offDeadlineMs(ms), limit: minutes > 0 ? { ref, minutes, what } : undefined };
};

/**
 * A clone's deadline and limit (`cloneMinutes`): the carried limit, else the default. A worktree's clone and checkout
 * take it too, `what` naming which.
 */
export const cloneLimit = (ms: number | undefined, what = "clone"): TimedBy =>
  carried(ms ?? DEFAULT_CLONE_MS, { environment: "cloneMinutes" }, what);

/**
 * A checkpoint operation's, a worktree's seed bundle's or a removed worktree's carry's deadline and limit
 * (`checkpointMinutes`): the carried limit, else the default.
 */
export const checkpointLimit = (ms: number | undefined): TimedBy =>
  carried(ms ?? DEFAULT_CHECKPOINT_MS, { environment: "checkpointMinutes" }, "checkpoint");

/** A command's deadline and limit when nothing else sets one: `commandMinutes`, as the running Container took it. */
export const commandLimit = (minutes: number): TimedBy => ({
  timeoutMs: deadlineMs(minutes, 60_000),
  limit: minutes > 0 ? { ref: { environment: "commandMinutes" }, minutes, what: "command" } : undefined,
});

/**
 * How much earlier than its spawn's answer arrives computerd may start a command's clock: the answer's trip back. A
 * kill this close to the deadline is the deadline's. t3flare's own allowance, not a setting: one second is far past an
 * RPC's trip and far below any limit, which is whole minutes.
 */
export const SPAWN_SLACK_MS = 1_000;

/**
 * `spawn` (computer's exec, which answers once the command is spawned, after the Container's start and the files' push),
 * with how long the command has run since: computerd's deadline counts from the spawn, never from the call.
 */
export const spawnTimed = async <Handle>(
  spawn: () => Promise<Handle>,
  now: () => number,
): Promise<{ readonly handle: Handle; readonly ranMs: () => number }> => {
  const handle = await spawn();
  const spawned = now();
  return { handle, ranMs: () => now() - spawned };
};

/**
 * `result` with its limit named in its stderr when computer ended it at `timeoutMs` (`ms`: how long it ran since its
 * spawn): after the command's own stderr as a `t3flare:` line, or alone when it wrote none. A command's note ends
 * without a full stop: an agent's file tool adds " (on the Container)" after it (`container-files.ts`). Any other
 * result is returned as it is.
 */
export const limitNoted = <Result extends { readonly status: string; readonly ms: number; readonly stderr: string }>(
  result: Result,
  timeoutMs: number,
  limit: ExecLimit | undefined,
): Result => {
  if (limit === undefined || result.status !== "cancelled" || result.ms < timeoutMs - SPAWN_SLACK_MS) return result;
  const note = `the ${limit.what} stopped at ${timeLimitHit(limit.minutes, "minute", limit.ref)}${limit.what === "command" ? "" : "."}`;
  const own = result.stderr.trimEnd();
  return { ...result, stderr: own === "" ? note : `${own}\nt3flare: ${note}` };
};
