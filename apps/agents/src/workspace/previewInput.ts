// SPI-1448 (ADR-0021, ADR-0031): the Owner's input in a preview tab (mouse, keys, wheel, inserted text) is Workspace
// input, as Terminal typing is. The Environment notes it here, at most every 30 s per Workspace
// (`apps/environment/src/preview/previewInput.ts`), and it joins the last input a Container preview's hold reads
// (`someoneWorks`). Noting it while the Container is stopped is a no-op: it starts nothing, and the next Container never
// inherits an input made before it ran.

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
