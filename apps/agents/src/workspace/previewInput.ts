// SPI-1448 (A7, refines ADR-0021 and ADR-0031; fragility U113): the Owner's input in a preview tab (mouse, keys, wheel,
// inserted text) is Workspace input, as Terminal typing is. The Environment notes it on the tab's Workspace DO
// (`noteOwnerPreviewInput`, at most every 30 s per Workspace: `apps/environment/src/preview/previewInput.ts`). Here it
// holds the running Container on its own, at the idle stop and the reclaim (`containerHolds.ts`), for the Terminals'
// busy hold from the last input (`terminalBusyHoldMs`, 30 minutes by default), whether or not a Container preview has a
// socket open or is making requests; and it joins the last input a Container preview's hold reads (`someoneWorks`).
// An untouched tab notes nothing, so it holds nothing. The input belongs to the Container it was made on: noting it
// while none runs is a no-op (it never starts one), and it is forgotten when that Container stops or a new one starts,
// whether the DO stopped it or it exited by itself.

import type { TerminalHold } from "./containerLaunch.ts";

export interface OwnerPreviewInputDeps {
  readonly running: () => boolean;
  readonly now: () => number;
}

/** When the Owner last worked in one of the Workspace's preview tabs on the running Container; 0 for never. */
export class OwnerPreviewInput {
  readonly #deps: OwnerPreviewInputDeps;
  #lastInput = 0;

  constructor(deps: OwnerPreviewInputDeps) {
    this.#deps = deps;
  }

  /** The last input on the running Container; 0 when none, or when no Container runs. */
  get lastInput(): number {
    this.#forgetUnlessRunning();
    return this.#lastInput;
  }

  /** Notes the Owner's preview input now; false, noting nothing, when no Container runs. */
  note(): boolean {
    if (!this.#forgetUnlessRunning()) return false;
    this.#lastInput = this.#deps.now();
    return true;
  }

  /** Whether the input holds the running Container now: for `terminalBusyHoldMs` from it, as Terminal typing does. */
  holdsContainer(hold: TerminalHold): boolean {
    const last = this.lastInput;
    return last > 0 && this.#deps.now() - last < hold.terminalBusyHoldMs;
  }

  /** A new Container started: no input made on an earlier one holds it. */
  containerStarted(): void {
    this.#lastInput = 0;
  }

  /** The DO stopped the Container. */
  containerStopped(): void {
    this.#lastInput = 0;
  }

  /** Whether a Container runs; seeing none, forgets the input (a Container that exited by itself never told the DO). */
  #forgetUnlessRunning(): boolean {
    if (this.#deps.running()) return true;
    this.#lastInput = 0;
    return false;
  }
}

export interface SomeoneWorksInput {
  readonly now: number;
  /** The busy hold of a foreground terminal (`terminalBusyHoldMs`, SPI-1317). */
  readonly cap: number;
  /** Commands running now. */
  readonly running: number;
  /** Each source's last input or command: t3's Terminals, the agent's, CLI processes, commands, preview tabs. */
  readonly lastInputs: ReadonlyArray<number>;
  /** Whether a CLI process holds the Container within `cap` (in a turn, or input within it). */
  readonly processesHold: (cap: number) => boolean;
}

/**
 * G11 (review M5): whether someone works in the Workspace now: a command runs, any source had input within the cap, or a
 * CLI process holds. A Container preview's requests and carried sockets keep the Container only while this holds.
 */
export const someoneWorks = (input: SomeoneWorksInput): boolean =>
  input.running > 0 || input.now - Math.max(0, ...input.lastInputs) < input.cap || input.processesHold(input.cap);
