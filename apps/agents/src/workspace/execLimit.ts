// A Workspace command's time limit names itself when hit (SPI-1430, ADR-0049 §4). computerd ends a command at its
// deadline with a kill, which computer reports as `cancelled` (exit 137 or 143): the same status as t3's cancel
// (`runCancels`) or an abort's kill (`killExecs`), which come before the deadline. So a `cancelled` command that ran to
// its deadline was stopped by its limit, and its stderr says which, with its value and where to change it.
import { type SettingRef, deadlineMs, timeLimitHit } from "@t3flare/harness-registry";

import { checkpointLimitMs, cloneLimitMs } from "./gitLimits.ts";

/** The limit behind a command's deadline: its setting, its value in minutes as it was taken, and what it limits. */
export interface ExecLimit {
  readonly ref: SettingRef;
  readonly minutes: number;
  readonly what: "clone" | "checkpoint" | "command";
}

/** A command's deadline and the limit behind it; no limit when it is off (it runs to the off deadline, a week). */
export interface TimedBy {
  readonly timeoutMs: number;
  readonly limit: ExecLimit | undefined;
}

// The Environment carries the clone and checkpoint limits in ms (`bindings.ts`), from whole minutes.
const carried = (ms: number, ref: SettingRef, what: ExecLimit["what"], timeoutMs: number): TimedBy => {
  const minutes = Math.round(ms / 60_000);
  return { timeoutMs, limit: minutes > 0 ? { ref, minutes, what } : undefined };
};

/** A clone's, or a worktree's clone or checkout's, deadline and limit (`cloneMinutes`), as `cloneLimitMs`. */
export const cloneLimit = (ms: number | undefined): TimedBy =>
  carried(ms ?? 0, { environment: "cloneMinutes" }, "clone", cloneLimitMs(ms));

/** A checkpoint operation's, a worktree's bundle's or a carry's deadline and limit (`checkpointMinutes`). */
export const checkpointLimit = (ms: number | undefined): TimedBy =>
  carried(ms ?? 0, { environment: "checkpointMinutes" }, "checkpoint", checkpointLimitMs(ms));

/** A command's deadline and limit when nothing else sets one: `commandMinutes`, as the running Container took it. */
export const commandLimit = (minutes: number): TimedBy => ({
  timeoutMs: deadlineMs(minutes, 60_000),
  limit: minutes > 0 ? { ref: { environment: "commandMinutes" }, minutes, what: "command" } : undefined,
});

/**
 * `result` with its limit named in its stderr when computer ended it at `timeoutMs` (`ms`: how long it ran): after the
 * command's own stderr as a `t3flare:` line, or alone when it wrote none. Any other result is returned as it is.
 */
export const limitNoted = <Result extends { readonly status: string; readonly ms: number; readonly stderr: string }>(
  result: Result,
  timeoutMs: number,
  limit: ExecLimit | undefined,
): Result => {
  if (limit === undefined || result.status !== "cancelled" || result.ms < timeoutMs) return result;
  const note = `the ${limit.what} stopped at ${timeLimitHit(limit.minutes, "minute", limit.ref)}.`;
  const own = result.stderr.trimEnd();
  return { ...result, stderr: own === "" ? note : `${own}\nt3flare: ${note}` };
};
