// The Terminal holds when the Container stops past them (SPI-1431). An idle stop or a budget reclaim under open
// Terminals names in each the hold its Terminals were past: the busy hold while one ran a command, else the prompt
// hold, with the value applied (`#terminalHold`: the stage's override wins) and where to change it (ADR-0049 §4). The
// alarm's idle stop also waits out the Idle time, which can be the later of the two, so the sentence says only that the
// Terminals had no input past their hold, never that the hold stopped the Container.
import { holdHit, type SettingRef } from "@t3flare/harness-registry";

import type { TerminalHold } from "./containerLaunch.ts";

/** The hold open Terminals get now (`TerminalHost.appliedHold`): which, and its value in ms as applied. */
export interface AppliedHold {
  readonly kind: "busy" | "prompt";
  readonly ms: number;
}

const HOLD_SETTINGS: Readonly<Record<AppliedHold["kind"], SettingRef>> = {
  busy: { environment: "terminalBusyHoldMinutes" },
  prompt: { environment: "terminalPromptHoldMinutes" },
};

/**
 * What follows "the Workspace's Container stopped" when its Terminals were past a hold: " after its Terminals had no
 * input past their 30-minute Terminal hold while a command runs; change it under …". Nothing for a stop past no hold
 * (a close, a destroy, an explicit stop, a stop with no Terminal open).
 */
export const stoppedPastHoldClause = (applied: AppliedHold | null | undefined): string => {
  if (applied === undefined || applied === null) return "";
  const hold = holdHit(applied.ms / 60_000, "minute", HOLD_SETTINGS[applied.kind]);
  return ` after its Terminals had no input past their ${hold}`;
};

/** A host of Terminals as a stop past the holds ends them (`TerminalHost`). */
interface HoldingHost {
  appliedHold(hold: TerminalHold): AppliedHold | undefined;
  containerStopped(applied?: AppliedHold | null): void;
}

/** The holds t3's and the agent's open Terminals were past at a stop: each null with no Terminal of its host open. */
export interface AppliedHolds {
  readonly terminalHold: AppliedHold | null;
  readonly agentTerminalHold: AppliedHold | null;
}

/**
 * An idle stop or a reclaim, once decided (no Terminal holds the Container): each host's open Terminals end now, each
 * naming the hold it was past (`hold`, as applied). This runs before the stop's awaits: a shell exiting during them
 * would otherwise end its Terminal with its own exit, and the hold would go unnamed. The agent's Terminals take their
 * host's hold as their exit note. Returns the holds for the stop's log.
 */
export const endTerminalsPastHolds = (
  hosts: {
    readonly terminals: HoldingHost;
    readonly agentHost: HoldingHost;
    readonly agentTerminals: { containerStopped(applied?: AppliedHold | null): void };
  },
  hold: TerminalHold,
): AppliedHolds => {
  const applied: AppliedHolds = {
    terminalHold: hosts.terminals.appliedHold(hold) ?? null,
    agentTerminalHold: hosts.agentHost.appliedHold(hold) ?? null,
  };
  hosts.terminals.containerStopped(applied.terminalHold);
  hosts.agentHost.containerStopped(applied.agentTerminalHold);
  hosts.agentTerminals.containerStopped(applied.agentTerminalHold);
  return applied;
};
