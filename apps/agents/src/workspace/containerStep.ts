// @effect-diagnostics globalTimers:off
// A step the Workspace DO runs once in each new Container before its first command (ADR-0032's Global mise config
// refinement, ADR-0047 §7): the Global mise lay-down, then the Container setup, in that order (`ContainerSteps`).
//
// - Keyed by the Container's runtime id (computer's connect answers it): a Container that replaced one that died on its
//   own has a new one, so it gets its own run. The outcome is kept in storage, so a new instance of the Workspace DO (a
//   deploy) does not run a finished step again. Without a runtime id the step runs anyway: each step's script is
//   idempotent on a Container's disk.
// - Held: the run counts as a command, so neither the idle stop nor another Workspace's reclaim stops the Container
//   under it, and the idle time counts from its end.
// - Bounded: the Workspace DO waits at most the step's deadline, then kills the exec; final for that Container.
// - Retried: an exec that failed (refused, broken, no answer, the lock held) is tried again at once, then by the next
//   caller or the alarm, at most `MAX_ATTEMPTS` times per Container. Every run is reported by its step.

/** A running exec on the Container (the platform's): its output when it ends, and a kill. */
export interface ContainerExec {
  readonly output: Promise<{ readonly stdout: string; readonly exitCode: number | null }>;
  kill(): void;
}

/**
 * At most this many runs per Container: one, one at once after an exec failure, one more from a later caller. Not a
 * setting: it is t3flare's own robustness against a refused or broken exec, not a choice about the Owner's script.
 */
export const MAX_ATTEMPTS = 3;

/** The one outcome a step tries again. */
export const EXEC_FAILED = "exec-failed";

/** A step's kept outcome for the current Container. */
export interface StepState {
  readonly runtime: string;
  readonly outcome: string;
  readonly attempts: number;
  readonly at: number;
}

/** How one held, bounded exec ended: its output, the deadline, or an exec that could not start or broke. */
export type StepRun = { readonly ended: "output"; readonly stdout: string; readonly exitCode: number | null } | { readonly ended: "deadline" } | { readonly ended: "failed"; readonly error: string };

/** Runs one script on the Container, held while it runs and killed at `deadlineMs`. */
export type RunStep = (argv: ReadonlyArray<string>, stdin: string, deadlineMs: number) => Promise<StepRun>;

export interface ContainerStepDeps<State extends StepState> {
  /** Where the outcome is kept in the Workspace DO's storage. */
  readonly key: string;
  /** Starts a script on the running Container, `stdin` on its stdin; throws when the exec cannot start. */
  readonly exec: (argv: ReadonlyArray<string>, stdin: string) => Promise<ContainerExec>;
  /** Holds the Container as a command does; the answer releases it. */
  readonly hold: () => () => void;
  /** A run has ended: a use of the Container (the idle time counts from now). */
  readonly used: () => Promise<void>;
  readonly storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  /**
   * One attempt on Container `runtime` ("" when unknown), the `attempts` before it: runs its script by `run` (held and
   * bounded) or not at all, reports itself, and answers the state to keep (`EXEC_FAILED` to be tried again).
   */
  readonly attempt: (runtime: string, attempts: number, run: RunStep) => Promise<State>;
}

export class ContainerStep<State extends StepState> {
  readonly #deps: ContainerStepDeps<State>;
  readonly #running = new Map<string, Promise<State>>();

  constructor(deps: ContainerStepDeps<State>) {
    this.#deps = deps;
  }

  /** Whether a run is going on now. */
  inFlight(): boolean {
    return this.#running.size > 0;
  }

  /** The current Container's outcome, as kept. */
  state(): State | undefined {
    return this.#deps.storage.get<State>(this.#deps.key);
  }

  /**
   * The step on Container `runtime` (computer's runtime id), run or joined; resolves when it has ended. A final outcome
   * is not run again; an exec failure is retried once at once and then by a later call, `MAX_ATTEMPTS` in all.
   */
  ensure(runtime: string | undefined): Promise<State> {
    const key = runtime ?? "";
    const running = this.#running.get(key);
    if (running !== undefined) return running;
    const kept = this.state();
    if (runtime !== undefined && kept?.runtime === runtime && (kept.outcome !== EXEC_FAILED || kept.attempts >= MAX_ATTEMPTS)) return Promise.resolve(kept);
    const before = runtime !== undefined && kept?.runtime === runtime ? kept.attempts : 0;
    const promise = (async () => {
      let state = await this.#attempt(key, before);
      // The first exec failed: once more at once (a transient refusal); later ones wait for a later caller or the alarm.
      if (state.outcome === EXEC_FAILED && before === 0) state = await this.#attempt(key, state.attempts);
      return state;
    })().finally(() => this.#running.delete(key));
    this.#running.set(key, promise);
    return promise;
  }

  /** Whether the running Container `runtime` is due a run: none ran for it, or its exec failed with attempts left. */
  due(runtime: string | undefined): boolean {
    if (runtime === undefined || this.#running.has(runtime)) return false;
    const kept = this.state();
    return kept?.runtime !== runtime || (kept.outcome === EXEC_FAILED && kept.attempts < MAX_ATTEMPTS);
  }

  /** The alarm's catch-up (not awaited): the run `due` says is due. Answers whether it started one. */
  catchUp(runtime: string | undefined): boolean {
    if (!this.due(runtime)) return false;
    void this.ensure(runtime).catch(() => undefined);
    return true;
  }

  async #attempt(runtime: string, attemptsBefore: number): Promise<State> {
    const state = await this.#deps.attempt(runtime, attemptsBefore, (argv, stdin, deadlineMs) => this.#run(argv, stdin, deadlineMs));
    // Kept only for a known Container: without a runtime id each call runs the (idempotent) script again.
    if (runtime !== "") this.#deps.storage.put(this.#deps.key, state);
    return state;
  }

  /** One exec, held while it runs and killed at `deadlineMs`; a use of the Container once it ends. */
  async #run(argv: ReadonlyArray<string>, stdin: string, deadlineMs: number): Promise<StepRun> {
    const deps = this.#deps;
    const release = deps.hold();
    let result: StepRun;
    try {
      const exec = await deps.exec(argv, stdin);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        exec.output,
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), deadlineMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (ended === "deadline") {
        exec.kill();
        result = { ended: "deadline" };
      } else {
        result = { ended: "output", stdout: ended.stdout, exitCode: ended.exitCode };
      }
    } catch (cause) {
      result = { ended: "failed", error: String(cause instanceof Error ? cause.message : cause).slice(0, 300) };
    } finally {
      release();
    }
    await deps.used().catch(() => undefined);
    return result;
  }
}

/** A command refused because its Container's setup failed and the Owner set failures to refuse (ADR-0047 §7). */
// @effect-diagnostics-next-line extendsNativeError:off -- crosses computer's RPC as a plain Error, its message whole.
export class ContainerRefused extends Error {
  override readonly name = "ContainerRefused";
}

/** Whether `state` is final for its Container: any outcome but an exec failure, or one out of attempts. */
export const isFinal = (state: StepState): boolean => state.outcome !== EXEC_FAILED || state.attempts >= MAX_ATTEMPTS;

/** One step of `ContainerSteps`: what it is doing while it runs, and when its outcome refuses the Container's commands. */
export interface SequencedStep<State extends StepState> {
  readonly step: Pick<ContainerStep<State>, "ensure" | "due" | "inFlight">;
  /** What a command cut off before it started waited for (computer-env's message). */
  readonly doing: string;
  /**
   * Why the Container's commands are refused after `state`, or undefined to carry on. `state` is undefined when the step
   * was not judged: its run threw, or a step before it is not final yet.
   */
  readonly refusal?: (state: State | undefined) => string | undefined;
}

/** A step as `ContainerSteps` runs it, whatever its state's type. */
export interface Sequenced {
  readonly doing: string;
  readonly due: (runtime: string | undefined) => boolean;
  readonly inFlight: () => boolean;
  /** Runs or joins the step: whether it is final, and why it refuses the Container's commands. */
  readonly run: (runtime: string | undefined) => Promise<{ readonly final: boolean; readonly refused?: string }>;
  /** Why the Container's commands are refused when the step is not judged. */
  readonly unjudged: () => string | undefined;
}

/** `entry` as `ContainerSteps` runs it. */
export const sequenced = <State extends StepState>({ step, doing, refusal }: SequencedStep<State>): Sequenced => ({
  doing,
  due: (runtime) => step.due(runtime),
  inFlight: () => step.inFlight(),
  run: async (runtime) => {
    const state = await step.ensure(runtime).catch(() => undefined);
    const refused = refusal?.(state);
    return { final: state !== undefined && isFinal(state), ...(refused === undefined ? {} : { refused }) };
  },
  unjudged: () => refusal?.(undefined),
});

/**
 * The steps every new Container runs before its first command, in order: each only once the one before is final (the
 * Container setup never runs before the Global mise lay-down has laid down, refused, or run out of attempts).
 */
export class ContainerSteps {
  readonly #steps: ReadonlyArray<Sequenced>;

  constructor(steps: ReadonlyArray<Sequenced>) {
    this.#steps = steps;
  }

  /**
   * Every step on Container `runtime`, in order, run or joined, each only once the one before is final. Rejects with
   * `ContainerRefused` when a step's outcome refuses the Container's commands, or when a step that would refuse on a
   * failure was not judged (held behind a step not yet final, or its run threw).
   */
  async ensure(runtime: string | undefined): Promise<void> {
    for (const [index, step] of this.#steps.entries()) {
      const { final, refused } = await step.run(runtime);
      if (refused !== undefined) throw new ContainerRefused(refused);
      if (final) continue;
      // Not final: the steps after it wait for a later caller or the alarm; one that refuses when not judged refuses.
      for (const later of this.#steps.slice(index + 1)) {
        const why = later.unjudged();
        if (why !== undefined) throw new ContainerRefused(why);
      }
      return;
    }
  }

  /** The alarm's catch-up (not awaited): the steps, when one is due on the running Container. Answers whether it started. */
  catchUp(runtime: string | undefined): boolean {
    if (this.#steps.some((step) => step.inFlight())) return false;
    if (!this.#steps.some((step) => step.due(runtime))) return false;
    void this.ensure(runtime).catch(() => undefined);
    return true;
  }

  /** What the steps are doing now, or undefined when none runs. */
  doing(): string | undefined {
    return this.#steps.find((step) => step.inFlight())?.doing;
  }
}
