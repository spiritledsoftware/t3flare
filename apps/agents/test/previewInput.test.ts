// SPI-1448: the Owner's preview input on the Workspace DO (module header of `previewInput.ts`; fragility U113).
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

/** An input over a fake clock and a Container whose running state the test sets. */
const setup = (running = true) => {
  const time = clock(10 * CAP);
  const container = { running };
  const input = new OwnerPreviewInput({ running: () => container.running, now: time.now });
  return { time, container, input };
};

const works = (input: OwnerPreviewInput, now: number) =>
  someoneWorks({ now, cap: CAP, running: 0, lastInputs: [0, input.lastInput], processesHold: () => false });

describe("OwnerPreviewInput", () => {
  it("Owner clicks in a static preview with no socket and no requests: the Container is held as by Terminal input", () => {
    // Nothing else is open: no Container preview socket or request, no Terminal, no CLI process. The input alone holds,
    // for the busy hold from the last input, as a Terminal's typing does; it also extends a Container preview's hold.
    const { time, input } = setup();
    input.note();
    time.advance(CAP - 1);
    expect(input.holdsContainer(HOLD)).toBe(true);
    expect(works(input, time.now())).toBe(true);
    input.note();
    time.advance(CAP - 1);
    expect(input.holdsContainer(HOLD)).toBe(true);
    time.advance(1);
    expect(input.holdsContainer(HOLD)).toBe(false);
    expect(works(input, time.now())).toBe(false);
  });

  it("an open, untouched tab holds nothing", () => {
    const { time, input } = setup();
    expect(input.lastInput).toBe(0);
    expect(input.holdsContainer(HOLD)).toBe(false);
    expect(works(input, time.now())).toBe(false);
  });

  it("input on a stopped Container is a no-op: nothing is noted, and a later Container is not held by it", () => {
    const { container, input } = setup(false);
    expect(input.note()).toBe(false);
    container.running = true;
    input.containerStarted();
    expect(input.lastInput).toBe(0);
    expect(input.holdsContainer(HOLD)).toBe(false);
  });

  it("a Container that exits by itself (no stopContainer) leaves no input to hold the next one", () => {
    const { time, container, input } = setup();
    input.note();
    container.running = false; // a crash, an OOM, the platform's sleep: the DO's stop never ran
    time.advance(60_000);
    container.running = true; // an agent's command starts a new Container within the busy hold
    input.containerStarted();
    expect(input.holdsContainer(HOLD)).toBe(false);
    expect(works(input, time.now())).toBe(false);
  });

  it("forgets the input once it sees the Container not running, even before the next start is noted", () => {
    const { container, input } = setup();
    input.note();
    container.running = false;
    expect(input.holdsContainer(HOLD)).toBe(false);
    container.running = true;
    expect(input.holdsContainer(HOLD)).toBe(false);
  });

  it("an explicit stop forgets it too", () => {
    const { input } = setup();
    input.note();
    input.containerStopped();
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
