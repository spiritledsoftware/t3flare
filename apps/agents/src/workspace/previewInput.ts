// SPI-1448 (ADR-0021, ADR-0031): the Owner's input in a preview tab (mouse, keys, wheel, inserted text) is Workspace
// input, as Terminal typing is. The Environment notes it here, at most every 30 s per Workspace
// (`apps/environment/src/preview/previewInput.ts`). It holds the running Container on its own, for the Terminals' busy
// hold from the last input (`holdsContainer`, as `TerminalHost`'s does), whether or not a Container preview has a socket
// open or is making requests; and it joins the last input a Container preview's hold reads (`someoneWorks`). Noting it
// while the Container is stopped is a no-op: it starts nothing, and the next Container never inherits an input made
// before it ran.

import type { TerminalHold } from "./containerLaunch.ts";

export interface OwnerPreviewInputDeps {
  readonly running: () => boolean;
  readonly now: () => number;
}

/** When the Owner last worked in one of the Workspace's preview tabs while its Container ran; 0 for never. */
export class OwnerPreviewInput {
  readonly #deps: OwnerPreviewInputDeps;
  #lastInput = 0;

  constructor(deps: OwnerPreviewInputDeps) {
    this.#deps = deps;
  }

  get lastInput(): number {
    return this.#lastInput;
  }

  /** Notes the Owner's preview input now; false, noting nothing, when the Container is not running. */
  note(): boolean {
    if (!this.#deps.running()) return false;
    this.#lastInput = this.#deps.now();
    return true;
  }

  /**
   * Whether the Owner's preview input holds the Container now (the idle stop, the reclaim): while it runs, for
   * `terminalBusyHoldMs` from the last input, as a Terminal's typing holds it. An untouched tab holds nothing.
   */
  holdsContainer(hold: TerminalHold): boolean {
    return this.#lastInput > 0 && this.#deps.running() && this.#deps.now() - this.#lastInput < hold.terminalBusyHoldMs;
  }

  /** The Container stopped: its input never holds the next one. */
  containerStopped(): void {
    this.#lastInput = 0;
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
