// What keeps the Workspace DO's running Container from its alarm's idle stop, and from a budget reclaim (ADR-0021,
// ADR-0032 §7): Terminal input within its hold (review F10: output is not use), the Owner's preview input within the
// busy hold (SPI-1448, `previewInput.ts`), CLI processes, and for the idle stop a Container preview's hold (G11).
import type { TerminalHold } from "./containerLaunch.ts";

interface Holder {
  holdsContainer(hold: TerminalHold): boolean;
}

export interface HoldSources {
  /** Commands running now. */
  readonly running: number;
  readonly terminals: Holder;
  readonly agentHost: Holder;
  readonly ownerPreviewInput: Holder;
  readonly processes: {
    holdsContainer(): boolean;
    reclaimable(): ReadonlyArray<unknown>;
    readonly size: number;
  };
  /** A Container preview's carried sockets while someone works (`#previewHold`). */
  readonly previewHold: () => boolean;
}

const inputHolds = (sources: HoldSources, hold: TerminalHold): boolean =>
  sources.terminals.holdsContainer(hold) ||
  sources.agentHost.holdsContainer(hold) ||
  sources.ownerPreviewInput.holdsContainer(hold);

/** Whether the alarm's idle stop leaves the running Container up (it also waits out the Idle time and running commands). */
export const idleStopHeld = (sources: HoldSources, hold: TerminalHold): boolean =>
  inputHolds(sources, hold) || sources.processes.holdsContainer() || sources.previewHold();

/** Whether the Workspace is in use, so a budget reclaim leaves its running Container alone. */
export const reclaimBusy = (sources: HoldSources, hold: TerminalHold): boolean =>
  sources.running > 0 || inputHolds(sources, hold) || sources.processes.reclaimable().length < sources.processes.size;
