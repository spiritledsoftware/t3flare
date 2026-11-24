// The Container setup, once per Container (ADR-0047 §7): the Owner's script the Workspace DO runs on each new
// Container after the Global mise lay-down and before its first command, through the wrapper
// (`@t3flare/sandbox-image/containerSetup`), the second of its once-per-Container steps (`containerStep.ts`: keyed,
// held, bounded, retried). It is reported to the Environment DO with the end of its output, every secret Variable's
// value blanked; on a failure the Container carries on, or refuses its commands, as the Owner set.
import {
  changeItUnder,
  type ContainerSetupFailure,
  type ContainerSetupOutcome,
  type ContainerSetupReport,
  limitValue,
  MAX_SETUP_OUTPUT_BYTES,
  type SettingsSource,
} from "@t3flare/harness-registry";
import {
  containerSetupArgv,
  containerSetupDeadlineMs,
  parseContainerSetupAnswer,
  SECRET_MARGIN_BYTES,
} from "@t3flare/sandbox-image/containerSetup";

import { type ContainerExec, ContainerStep, isFinal, type RunStep } from "./containerStep.ts";

/** What a Container start runs: the script, its digest, and the Owner's time limit and failure policy. */
export interface ContainerSetupLaunch {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision: number;
  readonly source: SettingsSource;
  readonly minutes: number;
  readonly failure: ContainerSetupFailure;
  /** How much of the end of its output the report keeps (`setupOutputKiB`, in bytes). */
  readonly outputBytes: number;
}

export interface ContainerSetupDeps {
  /** Starts the wrapper on the running Container, `stdin` on its stdin; throws when the exec cannot start. */
  readonly exec: (argv: ReadonlyArray<string>, stdin: string) => Promise<ContainerExec>;
  /** The launch of the Container now running; undefined for a launch recorded before the Container setup. */
  readonly launch: () => ContainerSetupLaunch | undefined;
  /** The values of the secret Variables the running Container started with: blanked in the reported output. */
  readonly secrets: () => ReadonlyArray<string>;
  readonly hold: () => () => void;
  readonly used: () => Promise<void>;
  readonly report: (report: ContainerSetupReport) => void;
  readonly storage: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  readonly workspace: () => string | null;
  readonly now: () => number;
  /** How long to wait for the whole exec at a time limit of `minutes` (the wrapper's own bounds and a margin). */
  readonly deadlineMs?: (minutes: number) => number;
  readonly log?: (event: Record<string, unknown>) => void;
}

/** The kept outcome of the current Container's setup. */
export const CONTAINER_SETUP_KEY = "t3flare:container-setup";

export interface ContainerSetupState {
  readonly runtime: string;
  readonly outcome: ContainerSetupOutcome;
  readonly attempts: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly at: number;
}

/** What a secret Variable's value reads as in the reported output. */
const BLANK = "***";

const utf8 = new TextEncoder();

/** `text`'s last `maxBytes` of UTF-8, never a character cut in two. */
const lastBytes = (text: string, maxBytes: number): string => {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // A continuation byte (10xxxxxx) starts no character: step past the rest of the one the cut split.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
};

/**
 * The last `keptBytes` of the wrapper's `window` with every value of `secrets` blanked. The cut is taken on the raw
 * window, never on blanked text (blanking shrinks it): everything before its last `keptBytes` is dropped. The wrapper
 * answers `SECRET_MARGIN_BYTES` more than is kept, at least any one value's length, so a copy the window's own start
 * split lies wholly in the dropped head; a value that crosses the cut is blanked whole, its blank kept. Copies that
 * overlap (of one value or of two) are blanked as one, so no part of either shows.
 */
export const blankSecrets = (window: string, secrets: ReadonlyArray<string>, keptBytes: number): string => {
  const values = [...new Set(secrets)].filter((value) => value !== "");
  const kept = lastBytes(window, keptBytes);
  if (values.length === 0) return kept;
  const cut = window.length - kept.length;
  // Every copy of every value, overlapping ones included, as [start, end) ranges; ranges that overlap merge into one, so
  // no part of any value shows between two blanks.
  const ranges: Array<[number, number]> = [];
  for (const value of values)
    for (let at = window.indexOf(value); at !== -1; at = window.indexOf(value, at + 1))
      ranges.push([at, at + value.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // Text only from the cut on; a blanked range that crosses the cut is blanked whole.
  let shown = "";
  let at = cut;
  for (const [start, end] of merged) {
    if (end <= cut) continue;
    if (start > at) shown += window.slice(at, start);
    shown += BLANK;
    at = end;
  }
  shown += window.slice(at);
  // A blank longer than a short value it replaced can grow the text past what is kept.
  return lastBytes(shown, keptBytes);
};

export class ContainerSetup {
  readonly #deps: ContainerSetupDeps;
  readonly #step: ContainerStep<ContainerSetupState>;

  constructor(deps: ContainerSetupDeps) {
    this.#deps = deps;
    this.#step = new ContainerStep<ContainerSetupState>({
      key: CONTAINER_SETUP_KEY,
      exec: deps.exec,
      hold: deps.hold,
      used: deps.used,
      storage: deps.storage,
      attempt: (runtime, attempts, run) => this.#attempt(runtime, attempts, run),
      failed: (runtime, attempts) => ({
        runtime,
        outcome: "exec-failed",
        attempts,
        exitCode: null,
        timedOut: false,
        at: deps.now(),
      }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
  }

  inFlight(): boolean {
    return this.#step.inFlight();
  }

  state(): ContainerSetupState | undefined {
    return this.#step.state();
  }

  ensure(runtime: string | undefined): Promise<ContainerSetupState> {
    return this.#step.ensure(runtime);
  }

  due(runtime: string | undefined): boolean {
    return this.#step.due(runtime);
  }

  /** Whether a failure refuses the running Container's commands: the Owner set refuse, and there is a script to run. */
  refuses(): boolean {
    const launch = this.#deps.launch();
    return launch?.failure === "refuse" && launch.text !== "";
  }

  /**
   * Why the running Container's commands are refused after `state`, or undefined: only when `refuses()` and the setup
   * did not end well (a non-zero exit, its time limit, no answer, an exec that failed), or was not judged at all
   * (`state` undefined: its run threw, or the Global mise lay-down before it is not final yet).
   */
  refusal(
    state: Pick<ContainerSetupState, "outcome" | "exitCode" | "timedOut" | "attempts"> | undefined,
  ): string | undefined {
    if (!this.refuses()) return undefined;
    // What happens next: a setup not final yet (or not judged) is tried again by the next command; a final one only by
    // a new Container.
    const next =
      state === undefined || !isFinal(state) ? "The next command tries it again" : "A new Container runs it again";
    const tail = `and the Environment settings refuse commands in a Container whose setup failed. ${next}; Status on the Settings page shows its output.`;
    if (state === undefined)
      return `Refused: this Container's Container setup has not run (the Container's steps before it did not finish), ${tail}`;
    if (state.outcome === "ok" || state.outcome === "none") return undefined;
    // ADR-0049 §4: the time limit names its value and where to change it (a contextual setting).
    const minutes = this.#deps.launch()?.minutes;
    const how = state.timedOut
      ? `stopped at its ${minutes === undefined ? "" : `${limitValue(minutes, "minute")} `}time limit${changeItUnder({ environment: "containerSetupMinutes" })}`
      : state.exitCode !== null
        ? `exit ${state.exitCode}`
        : state.outcome === "deadline"
          ? "no answer within the deadline"
          : "the Container's exec failed";
    return `Refused: this Container's Container setup failed (${how}), ${tail}`;
  }

  async #attempt(runtime: string, attemptsBefore: number, run: RunStep): Promise<ContainerSetupState> {
    const deps = this.#deps;
    const known = deps.launch();
    const started = deps.now();
    const reportOf = (
      state: ContainerSetupState,
      launch: Pick<ContainerSetupLaunch, "revision" | "sha256" | "bytes" | "source">,
      output: string,
    ): ContainerSetupReport => ({
      workspace: deps.workspace(),
      runtime: runtime === "" ? "unknown" : runtime,
      revision: launch.revision,
      sha256: launch.sha256,
      bytes: launch.bytes,
      source: launch.source,
      outcome: state.outcome,
      exitCode: state.exitCode,
      timedOut: state.timedOut,
      ...(known === undefined ? {} : { limitMinutes: known.minutes }),
      output,
      failure: known?.failure ?? "carryOn",
      ms: Math.max(0, state.at - started),
      at: state.at,
    });
    // No script: nothing run, reported all the same, so Status stops showing an older one. A launch from before the
    // Container setup runs nothing and reports nothing: its revision would replace another Workspace's real report.
    if (known === undefined || known.text === "") {
      const state: ContainerSetupState = {
        runtime,
        outcome: "none",
        attempts: attemptsBefore + 1,
        exitCode: null,
        timedOut: false,
        at: started,
      };
      if (known !== undefined) deps.report(reportOf(state, known, ""));
      return state;
    }
    // Never more than a report may carry, whatever an older or newer launch recorded.
    const outputBytes = Math.min(known.outputBytes, MAX_SETUP_OUTPUT_BYTES);
    const result = await run(
      containerSetupArgv(known.sha256, known.minutes * 60, outputBytes + SECRET_MARGIN_BYTES),
      known.text,
      (deps.deadlineMs ?? containerSetupDeadlineMs)(known.minutes),
    );
    let outcome: ContainerSetupOutcome = "exec-failed";
    let exitCode: number | null = null;
    let timedOut = false;
    let output = "";
    let error: string | undefined;
    if (result.ended === "deadline") outcome = "deadline";
    else if (result.ended === "failed") error = result.error;
    else {
      const parsed = parseContainerSetupAnswer(result.stdout);
      if (parsed === undefined) error = `no answer (exit ${String(result.exitCode)})`;
      else if (parsed.answer.locked !== true) {
        exitCode = parsed.answer.exitCode;
        timedOut = parsed.answer.timedOut;
        outcome = exitCode === 0 ? "ok" : "failed";
        output = blankSecrets(parsed.output, deps.secrets(), outputBytes);
      }
    }
    const state: ContainerSetupState = {
      runtime,
      outcome,
      attempts: attemptsBefore + 1,
      exitCode,
      timedOut,
      at: deps.now(),
    };
    const report = reportOf(state, known, output);
    const { output: _output, ...logged } = report;
    deps.log?.({
      t3flare: "container-setup",
      ...logged,
      attempt: state.attempts,
      ...(error === undefined ? {} : { error }),
    });
    deps.report(report);
    return state;
  }
}
