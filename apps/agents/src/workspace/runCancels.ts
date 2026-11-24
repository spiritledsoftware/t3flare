// t3's git commands, ended when t3 gives up on them (SPI-1364). t3 times each git command itself (GitVcsDriverCore's
// `timeoutMs`: 30 s, 5 minutes for a fetch, none for a push) by interrupting its own wait; the spawner sees only that
// interruption, so the Environment asks the Workspace to end the command's exec by its run id (`cancelRun`).
// A run also carries the Environment's epoch, its boot count (SPI-1382): the t3 that awaits a run lives in one boot of the
// Environment DO, so a run begun under an older epoch has lost its canceller and its reader, and is ended.
import { MAX_TIMED_MINUTES } from "@t3flare/harness-registry";

/** What of computer's exec handle a cancel uses. */
export interface KillableRun {
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** t3's own grace after TERM before KILL (`forceKillAfter: "1 second"`, GitVcsDriverCore), so git can drop its locks. */
export const CANCEL_KILL_AFTER_MS = 1_000;

/**
 * The deadline of a git run t3 can cancel (it carries a run id). t3 ends it, at its own timeout or never (a push), and a
 * run whose Environment restarted is ended by its epoch (`dropBefore`), so this is only a backstop for a run neither
 * ends: the shared sanity maximum (ADR-0048 §2), not the Owner's `commandMinutes`, which would cut t3's 5-minute fetch
 * and its pushes.
 */
export const CANCELLABLE_RUN_MS = MAX_TIMED_MINUTES * 60_000;

/**
 * A git run's deadline: its own `timeoutMs`; else, when t3 can cancel it, `CANCELLABLE_RUN_MS`; else the Owner's
 * command time limit (`commandMs`).
 */
export const gitDeadlineMs = (
  run: { readonly timeoutMs?: number; readonly runId?: string },
  commandMs: number,
): number => run.timeoutMs ?? (run.runId === undefined ? commandMs : CANCELLABLE_RUN_MS);

/**
 * How long a cancel for a run that has not begun is remembered. It covers only the order two RPCs arrive in: the router
 * sends the run before it can cancel it, so its cancel waits here at most until the run's own RPC arrives. A cancel for
 * a run that has begun is kept until the run ends, however long its Container takes to start.
 */
export const EARLY_CANCEL_MS = 60_000;

type Entry = { readonly cancelled: boolean; readonly run?: KillableRun; readonly runEpoch?: number };

/** A run ended because the Environment restarted after it began (SPI-1382). */
export interface DroppedRun {
  readonly id: string;
  /** The Environment epoch the run began under. */
  readonly runEpoch: number;
  /** The newer epoch that ended it. */
  readonly environmentEpoch: number;
}

export class RunCancels {
  readonly #runs = new Map<string, Entry>();
  readonly #early = new Map<string, number>();
  readonly #now: () => number;
  readonly #later: (run: () => void, ms: number) => void;
  readonly #dropped: (run: DroppedRun) => void;

  /** `dropped` hears of each run `dropBefore` ends, whichever call taught the newer epoch (the Workspace logs it). */
  constructor(deps: {
    readonly now: () => number;
    readonly later: (run: () => void, ms: number) => void;
    readonly dropped?: (run: DroppedRun) => void;
  }) {
    this.#now = deps.now;
    this.#later = deps.later;
    this.#dropped = deps.dropped ?? (() => undefined);
  }

  /**
   * Run `id`'s RPC arrived, under Environment epoch `epoch` when it carries one; whether it was cancelled already (then
   * it need not run).
   */
  begin(id: string, epoch?: number): boolean {
    const cancelled = this.#early.delete(id);
    this.#runs.set(id, { cancelled, ...(epoch === undefined ? {} : { runEpoch: epoch }) });
    return cancelled;
  }

  /**
   * Run `id`'s exec started: ended at once when it was cancelled meanwhile, else kept until `end`. An id no `begin` opened
   * (an `exec` called with a run id of its own) is not kept: only a run between `begin` and `end` can be cancelled.
   */
  started(id: string, run: KillableRun): void {
    const entry = this.#runs.get(id);
    if (entry === undefined) return;
    if (entry.cancelled) {
      this.#end(run);
      return;
    }
    this.#runs.set(id, { ...entry, run });
  }

  /** Run `id`'s RPC answered: nothing more to cancel. */
  end(id: string): void {
    this.#runs.delete(id);
  }

  /** Ends run `id` (TERM, then KILL after `CANCEL_KILL_AFTER_MS`), now or as it starts; whether it had begun. */
  cancel(id: string): boolean {
    const entry = this.#runs.get(id);
    if (entry === undefined) {
      const now = this.#now();
      for (const [early, at] of this.#early) if (now - at >= EARLY_CANCEL_MS) this.#early.delete(early);
      this.#early.set(id, now);
      return false;
    }
    if (entry.run !== undefined) this.#end(entry.run);
    this.#runs.set(id, { cancelled: true });
    return true;
  }

  /** Whether a run that carries an Environment epoch is open and not yet ended. */
  hasEpochRun(): boolean {
    for (const entry of this.#runs.values()) if (!entry.cancelled && entry.runEpoch !== undefined) return true;
    return false;
  }

  /**
   * The Environment is at epoch `epoch`: every open run begun under an older one is ended as a cancel ends it (now, or as
   * it starts), since nothing is left to cancel it or read its answer. Runs of `epoch` and runs with no epoch stay.
   */
  dropBefore(epoch: number): ReadonlyArray<DroppedRun> {
    const dropped: Array<DroppedRun> = [];
    for (const [id, entry] of this.#runs) {
      if (entry.cancelled || entry.runEpoch === undefined || entry.runEpoch >= epoch) continue;
      this.cancel(id);
      const run = { id, runEpoch: entry.runEpoch, environmentEpoch: epoch };
      this.#dropped(run);
      dropped.push(run);
    }
    return dropped;
  }

  #end(run: KillableRun): void {
    void run.kill("SIGTERM").catch(() => undefined);
    this.#later(() => void run.kill("SIGKILL").catch(() => undefined), CANCEL_KILL_AFTER_MS);
  }
}

/**
 * The Workspace's alarm (SPI-1382): while a run that carries an epoch is open, asks the Environment for its epoch
 * (`environmentEpoch`) and ends the runs begun under an older one. An Environment that does not answer drops nothing:
 * the next alarm asks again. Asks nothing while no such run is open, so it never wakes an idle Environment for nothing.
 */
export const dropOrphanedRuns = async (
  cancels: RunCancels,
  environmentEpoch: () => Promise<number>,
): Promise<ReadonlyArray<DroppedRun>> => {
  if (!cancels.hasEpochRun()) return [];
  const epoch = await environmentEpoch().catch(() => undefined);
  return epoch === undefined ? [] : cancels.dropBefore(epoch);
};
