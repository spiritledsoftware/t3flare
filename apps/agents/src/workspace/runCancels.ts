// t3's git commands, ended when t3 gives up on them (SPI-1364). t3 times each git command itself (GitVcsDriverCore's
// `timeoutMs`: 30 s, 5 minutes for a fetch, none for a push) by interrupting its own wait; the spawner sees only that
// interruption, so the Environment asks the Workspace to end the command's exec by its run id (`cancelRun`).
import { MAX_TIMED_MINUTES } from "@t3flare/harness-registry";

/** What of computer's exec handle a cancel uses. */
export interface KillableRun {
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/** t3's own grace after TERM before KILL (`forceKillAfter: "1 second"`, GitVcsDriverCore), so git can drop its locks. */
export const CANCEL_KILL_AFTER_MS = 1_000;

/**
 * The deadline of a git run t3 can cancel (it carries a run id). t3 ends it, at its own timeout or never (a push), so
 * this is only a backstop for a run whose cancel can never come (the Environment restarted while it ran): the shared
 * sanity maximum (ADR-0048 §2), not the Owner's `commandMinutes`, which would cut t3's 5-minute fetch and its pushes.
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

type Entry = { readonly cancelled: boolean; readonly run?: KillableRun };

export class RunCancels {
  readonly #runs = new Map<string, Entry>();
  readonly #early = new Map<string, number>();
  readonly #now: () => number;
  readonly #later: (run: () => void, ms: number) => void;

  constructor(deps: { readonly now: () => number; readonly later: (run: () => void, ms: number) => void }) {
    this.#now = deps.now;
    this.#later = deps.later;
  }

  /** Run `id`'s RPC arrived; whether it was cancelled already (then it need not run). */
  begin(id: string): boolean {
    const cancelled = this.#early.delete(id);
    this.#runs.set(id, { cancelled });
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
    this.#runs.set(id, { cancelled: false, run });
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

  #end(run: KillableRun): void {
    void run.kill("SIGTERM").catch(() => undefined);
    this.#later(() => void run.kill("SIGKILL").catch(() => undefined), CANCEL_KILL_AFTER_MS);
  }
}
