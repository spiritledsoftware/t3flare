// The Workspace DO's hold decisions (`containerHolds.ts`): what keeps the running Container from the alarm's idle stop,
// and from a budget reclaim. SPI-1448: the Owner's preview input holds it there on its own, as Terminal input does.
import { describe, expect, it } from "vitest";

import { type HoldSources, idleStopHeld, reclaimBusy } from "../src/workspace/containerHolds.ts";
import type { TerminalHold } from "../src/workspace/containerLaunch.ts";
import { OwnerPreviewInput } from "../src/workspace/previewInput.ts";

const HOLD: TerminalHold = { terminalBusyHoldMs: 30 * 60_000, terminalPromptHoldMs: 10 * 60_000 };

const none = { holdsContainer: () => false };

/** A Workspace with nothing open but a preview tab: no Terminal, no CLI process, no preview socket or request. */
const workspace = () => {
  let now = 1_000_000_000;
  const ownerPreviewInput = new OwnerPreviewInput({ running: () => true, now: () => now });
  const sources: HoldSources = {
    running: 0,
    terminals: none,
    agentHost: none,
    ownerPreviewInput,
    processes: { holdsContainer: () => false, reclaimable: () => [], size: 0 },
    previewHold: () => false,
  };
  return { sources, ownerPreviewInput, advance: (ms: number) => void (now += ms) };
};

describe("the idle stop and the reclaim", () => {
  it("the Owner's preview input holds the running Container at both, until the busy hold from it passes", () => {
    const { sources, ownerPreviewInput, advance } = workspace();
    expect(idleStopHeld(sources, HOLD)).toBe(false);
    expect(reclaimBusy(sources, HOLD)).toBe(false);
    ownerPreviewInput.note();
    advance(HOLD.terminalBusyHoldMs - 1);
    expect(idleStopHeld(sources, HOLD)).toBe(true);
    expect(reclaimBusy(sources, HOLD)).toBe(true);
    advance(1);
    expect(idleStopHeld(sources, HOLD)).toBe(false);
    expect(reclaimBusy(sources, HOLD)).toBe(false);
  });

  it("an open, untouched preview tab holds at neither", () => {
    const { sources } = workspace();
    expect(idleStopHeld(sources, HOLD)).toBe(false);
    expect(reclaimBusy(sources, HOLD)).toBe(false);
  });

  it("keeps the other holders: Terminals, CLI processes, a Container preview's hold, a running command", () => {
    const { sources } = workspace();
    const holds = { holdsContainer: () => true };
    expect(idleStopHeld({ ...sources, terminals: holds }, HOLD)).toBe(true);
    expect(idleStopHeld({ ...sources, agentHost: holds }, HOLD)).toBe(true);
    expect(idleStopHeld({ ...sources, previewHold: () => true }, HOLD)).toBe(true);
    const cli = { holdsContainer: () => true, reclaimable: () => [], size: 1 };
    expect(idleStopHeld({ ...sources, processes: cli }, HOLD)).toBe(true);
    expect(reclaimBusy({ ...sources, processes: cli }, HOLD)).toBe(true);
    expect(reclaimBusy({ ...sources, running: 1 }, HOLD)).toBe(true);
    expect(reclaimBusy({ ...sources, terminals: holds }, HOLD)).toBe(true);
    // A Container preview's own hold never kept a reclaim off (G11): only its Workspace's work does.
    expect(reclaimBusy({ ...sources, previewHold: () => true }, HOLD)).toBe(false);
  });
});
