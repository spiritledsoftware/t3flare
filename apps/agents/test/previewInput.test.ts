// SPI-1448: the Owner's input in a preview tab is Workspace input, as Terminal typing is (ADR-0021, ADR-0031): the
// Environment notes it on the tab's Workspace DO, where it holds the running Container for the busy hold from the last
// input, as Terminal input does, and joins the last input a Container preview's hold reads. Noting it on a stopped
// Container is a no-op: it starts nothing, and a later Container never inherits it.
import { describe, expect, it } from "vitest";

import type { TerminalHold } from "../src/workspace/containerLaunch.ts";
import { OwnerPreviewInput, someoneWorks } from "../src/workspace/previewInput.ts";

const CAP = 30 * 60_000;
/** The Terminals' default holds (SPI-1317): the busy one is the 30 minutes from the last input. */
const HOLD: TerminalHold = { terminalBusyHoldMs: CAP, terminalPromptHoldMs: 10 * 60_000 };

const clock = (start: number) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

const works = (input: OwnerPreviewInput, now: number) =>
  someoneWorks({ now, cap: CAP, running: 0, lastInputs: [0, input.lastInput], processesHold: () => false });

describe("OwnerPreviewInput", () => {
  it("the Owner's input in a preview tab extends the hold, until the cap passes", () => {
    const time = clock(10 * CAP);
    const input = new OwnerPreviewInput({ running: () => true, now: time.now });
    expect(works(input, time.now())).toBe(false);
    expect(input.note()).toBe(true);
    time.advance(CAP - 1);
    expect(works(input, time.now())).toBe(true);
    time.advance(1);
    expect(works(input, time.now())).toBe(false);
  });

  it("an open, untouched tab holds nothing", () => {
    const time = clock(10 * CAP);
    const input = new OwnerPreviewInput({ running: () => true, now: time.now });
    expect(input.lastInput).toBe(0);
    expect(works(input, time.now())).toBe(false);
  });

  it("input on a stopped Container is a no-op: nothing is noted, so a later Container is not held by it", () => {
    let running = false;
    const time = clock(10 * CAP);
    const input = new OwnerPreviewInput({ running: () => running, now: time.now });
    expect(input.note()).toBe(false);
    running = true;
    expect(input.lastInput).toBe(0);
    expect(works(input, time.now())).toBe(false);
    expect(input.holdsContainer(HOLD)).toBe(false);
  });
});

describe("OwnerPreviewInput.holdsContainer (the idle stop and the reclaim, as Terminal input holds)", () => {
  it("Owner clicks in a static preview with no socket and no requests: the Container is held as by Terminal input", () => {
    // Nothing else is open: no Container preview socket or request (`#previewHolds` 0), no Terminal, no CLI process.
    // The input alone holds, for the busy hold from the last input, as a Terminal's typing does.
    const time = clock(10 * CAP);
    const input = new OwnerPreviewInput({ running: () => true, now: time.now });
    expect(input.holdsContainer(HOLD)).toBe(false);
    input.note();
    time.advance(HOLD.terminalBusyHoldMs - 1);
    expect(input.holdsContainer(HOLD)).toBe(true);
    input.note();
    time.advance(HOLD.terminalBusyHoldMs - 1);
    expect(input.holdsContainer(HOLD)).toBe(true);
    time.advance(1);
    expect(input.holdsContainer(HOLD)).toBe(false);
  });

  it("an open, untouched tab holds nothing", () => {
    const input = new OwnerPreviewInput({ running: () => true, now: () => 10 * CAP });
    expect(input.holdsContainer(HOLD)).toBe(false);
  });

  it("holds only a running Container, and a stopped one's input never holds the next", () => {
    let running = true;
    const time = clock(10 * CAP);
    const input = new OwnerPreviewInput({ running: () => running, now: time.now });
    input.note();
    running = false;
    expect(input.holdsContainer(HOLD)).toBe(false);
    input.containerStopped();
    running = true;
    expect(input.lastInput).toBe(0);
    expect(input.holdsContainer(HOLD)).toBe(false);
  });
});

describe("someoneWorks", () => {
  it("is the latest input of any source within the cap, a running command, or a CLI process's hold", () => {
    const base = { now: 10 * CAP, cap: CAP, running: 0, processesHold: () => false };
    expect(someoneWorks({ ...base, lastInputs: [0, 0] })).toBe(false);
    expect(someoneWorks({ ...base, lastInputs: [0, 10 * CAP - 5] })).toBe(true);
    expect(someoneWorks({ ...base, lastInputs: [9 * CAP] })).toBe(false);
    expect(someoneWorks({ ...base, running: 1, lastInputs: [] })).toBe(true);
    expect(someoneWorks({ ...base, processesHold: (cap) => cap === CAP, lastInputs: [] })).toBe(true);
  });
});
