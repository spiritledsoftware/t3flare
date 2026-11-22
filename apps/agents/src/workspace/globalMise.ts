// The Global mise config's lay-down, once per Container (SPI-1150, ADR-0032's Global mise config refinement): the
// Workspace DO runs the script (`@t3flare/sandbox-image/globalMise`) on each new Container before its first command,
// the first of its once-per-Container steps (`containerStep.ts`: keyed, held, bounded, retried), and reports how it
// ended. The script bounds its lock, install and checks; the Workspace DO waits for their sum and a margin
// (`GLOBAL_MISE_DEADLINE_MS`), then kills the exec and treats it as not laid, final for that Container. Without a
// runtime id the script runs anyway: it is idempotent on a Container's disk (it answers again for the same revision and
// text).
import type { GlobalMiseOutcome, GlobalMiseReport, SettingsSource } from "@t3flare/harness-registry";
import { type GlobalMiseAnswer, globalMiseArgv, parseGlobalMiseAnswer } from "@t3flare/sandbox-image/globalMise";

import { type ContainerExec, ContainerStep, MAX_ATTEMPTS, type RunStep } from "./containerStep.ts";

export { MAX_ATTEMPTS };

/** What a Container start lays down: the text of its launch, with its digest. */
export interface GlobalMiseLaunch {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision: number;
  readonly source: SettingsSource;
}

/** A running exec on the Container (the platform's): its output when it ends, and a kill. */
export type GlobalMiseExec = ContainerExec;

export interface GlobalMiseDeps {
  /** Starts the script on the running Container, `stdin` on its stdin; throws when the exec cannot start. */
  readonly exec: (argv: ReadonlyArray<string>, stdin: string) => Promise<GlobalMiseExec>;
  /** The launch of the Container now running, read after its connect; undefined before any (a launch from before SPI-1150 has no text). */
  readonly launch: () => GlobalMiseLaunch | undefined;
  /** Holds the Container as a command does; the answer releases it. */
  readonly hold: () => () => void;
  /** The run has ended: a use of the Container (the idle time counts from now). */
  readonly used: () => Promise<void>;
  readonly report: (report: GlobalMiseReport) => void;
  readonly storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  readonly workspace: () => string | null;
  readonly now: () => number;
  readonly deadlineMs: number;
  readonly log?: (event: Record<string, unknown>) => void;
}

/** The kept outcome of the current Container's lay-down. */
export const GLOBAL_MISE_KEY = "t3flare:global-mise";

export interface GlobalMiseState {
  readonly runtime: string;
  readonly outcome: GlobalMiseOutcome;
  readonly attempts: number;
  readonly answer?: GlobalMiseAnswer;
  readonly at: number;
}

/** The launch with no text: what a Container gets when nothing is laid down. */
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class GlobalMise {
  readonly #step: ContainerStep<GlobalMiseState>;

  constructor(deps: GlobalMiseDeps) {
    this.#step = new ContainerStep<GlobalMiseState>({
      key: GLOBAL_MISE_KEY,
      exec: deps.exec,
      hold: deps.hold,
      used: deps.used,
      storage: deps.storage,
      attempt: (runtime, attempts, run) => layDown(deps, runtime, attempts, run),
      failed: (runtime, attempts) => ({ runtime, outcome: "exec-failed", attempts, at: deps.now() }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  /** Whether a lay-down runs now (an active command waits for it where it is sent, `ContainerStepsBackend`). */
  inFlight(): boolean {
    return this.#step.inFlight();
  }

  /** The current Container's outcome, as kept. */
  state(): GlobalMiseState | undefined {
    return this.#step.state();
  }

  /**
   * The lay-down of the Container `runtime` (computer's runtime id), run or joined; resolves when it has ended. A final
   * outcome is not run again; an exec failure is retried once at once and then by a later call, `MAX_ATTEMPTS` in all.
   */
  ensure(runtime: string | undefined): Promise<GlobalMiseState> {
    return this.#step.ensure(runtime);
  }

  /** Whether the running Container is due a lay-down (`ContainerStep.due`). */
  due(runtime: string | undefined): boolean {
    return this.#step.due(runtime);
  }

  /**
   * The alarm's catch-up (not awaited): the running Container's lay-down when none ran for it (only passive reads
   * reached it), or when its exec failed with attempts left. Answers whether it started one.
   */
  catchUp(runtime: string | undefined): boolean {
    return this.#step.catchUp(runtime);
  }
}

/** One lay-down attempt (`ContainerStepDeps.attempt`). */
const layDown = async (
  deps: GlobalMiseDeps,
  runtime: string,
  attemptsBefore: number,
  run: RunStep,
): Promise<GlobalMiseState> => {
  const known = deps.launch();
  // A launch from before SPI-1150 (no Global mise config recorded) runs the script with no text: it lays nothing down.
  const launch = known ?? { text: "", bytes: 0, sha256: EMPTY_SHA, revision: 0, source: "default" as const };
  const started = deps.now();
  // No text in a known launch on a known Container: nothing to lay down, nothing run (its disk has no global file);
  // reported all the same, so Status stops showing an older start's file once the owner clears it.
  if (known !== undefined && known.text === "" && runtime !== "") {
    deps.report({ workspace: deps.workspace(), runtime, revision: known.revision, sha256: known.sha256, bytes: 0, source: known.source, outcome: "none", install: null, timedOut: false, ms: 0, at: started });
    return { runtime, outcome: "none", attempts: attemptsBefore + 1, at: started };
  }
  const result = await run(globalMiseArgv(launch.revision, launch.sha256, launch.source), launch.text, deps.deadlineMs);
  let outcome: GlobalMiseOutcome = "exec-failed";
  let answer: GlobalMiseAnswer | undefined;
  let error: string | undefined;
  if (result.ended === "deadline") outcome = "deadline";
  else if (result.ended === "failed") error = result.error;
  else {
    answer = parseGlobalMiseAnswer(result.stdout);
    outcome = answer === undefined || answer.locked === true ? "exec-failed" : answer.laid ? "laid" : "not-laid";
    if (answer === undefined) error = `no answer (exit ${String(result.exitCode)})`;
  }
  const at = deps.now();
  const state: GlobalMiseState = { runtime, outcome, attempts: attemptsBefore + 1, ...(answer === undefined ? {} : { answer }), at };
  const report: GlobalMiseReport = {
    workspace: deps.workspace(),
    runtime: runtime === "" ? "unknown" : runtime,
    revision: launch.revision,
    sha256: launch.sha256,
    bytes: launch.bytes,
    source: launch.source,
    outcome,
    install: answer?.install ?? null,
    timedOut: answer?.timedOut ?? outcome === "deadline",
    ms: Math.max(0, at - started),
    at,
  };
  deps.log?.({ t3flare: "global-mise", ...report, attempt: state.attempts, ...(error === undefined ? {} : { error }) });
  deps.report(report);
  return state;
};
