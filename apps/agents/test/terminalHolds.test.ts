// SPI-1431's seam: an idle stop or a reclaim ends each host's open Terminals with the hold they were past, before the
// stop's awaits, and hands the holds to the stop's log.
import { describe, expect, it } from "vitest";

import type { TerminalHold } from "../src/workspace/containerLaunch.ts";
import { type AppliedHold, endTerminalsPastHolds, stoppedPastHoldClause } from "../src/workspace/terminalHolds.ts";

const HOLD: TerminalHold = { terminalBusyHoldMs: 30 * 60_000, terminalPromptHoldMs: 10 * 60_000 };

/** A host whose open Terminals are none, at the prompt or running a command; it records what each stop named. */
const fakeHost = (open: "none" | "prompt" | "busy") => {
  const stops: Array<AppliedHold | null | undefined> = [];
  return {
    stops,
    appliedHold: (hold: TerminalHold): AppliedHold | undefined =>
      open === "none"
        ? undefined
        : open === "busy"
          ? { kind: "busy", ms: hold.terminalBusyHoldMs }
          : { kind: "prompt", ms: hold.terminalPromptHoldMs },
    containerStopped: (applied?: AppliedHold | null) => void stops.push(applied),
  };
};

const run = (t3: "none" | "prompt" | "busy", agent: "none" | "prompt" | "busy") => {
  const terminals = fakeHost(t3);
  const agentHost = fakeHost(agent);
  const agentStops: Array<AppliedHold | null | undefined> = [];
  const agentTerminals = { containerStopped: (applied?: AppliedHold | null) => void agentStops.push(applied) };
  const applied = endTerminalsPastHolds({ terminals, agentHost, agentTerminals }, HOLD);
  return { applied, t3Stops: terminals.stops, agentHostStops: agentHost.stops, agentStops };
};

describe("endTerminalsPastHolds", () => {
  it("names the busy hold in t3's Terminals and the prompt hold in the agent's, each its own", () => {
    const { applied, t3Stops, agentHostStops, agentStops } = run("busy", "prompt");
    const busy = { kind: "busy", ms: 30 * 60_000 };
    const prompt = { kind: "prompt", ms: 10 * 60_000 };
    expect(applied).toEqual({ terminalHold: busy, agentTerminalHold: prompt });
    expect(t3Stops).toEqual([busy]);
    expect(agentHostStops).toEqual([prompt]);
    // The agent's Terminals take their host's hold as their exit note.
    expect(agentStops).toEqual([prompt]);
  });

  it("names no hold with no Terminal open: the plain stop, and null in the log", () => {
    const { applied, t3Stops, agentHostStops, agentStops } = run("none", "none");
    expect(applied).toEqual({ terminalHold: null, agentTerminalHold: null });
    expect([...t3Stops, ...agentHostStops, ...agentStops]).toEqual([null, null, null]);
    expect(JSON.parse(JSON.stringify(applied))).toEqual({ terminalHold: null, agentTerminalHold: null });
  });
});

describe("stoppedPastHoldClause", () => {
  it("says the Terminals had no input past the hold, never that the hold stopped the Container", () => {
    expect(stoppedPastHoldClause({ kind: "busy", ms: 30 * 60_000 })).toBe(
      " after its Terminals had no input past their 30-minute Terminal hold while a command runs; change it under " +
        "Environment › Advanced › Terminal hold while a command runs (minutes)",
    );
    // A stage's override applies as it is: half a minute.
    expect(stoppedPastHoldClause({ kind: "prompt", ms: 30_000 })).toBe(
      " after its Terminals had no input past their 0.5-minute Terminal hold at the prompt; change it under " +
        "Environment › Advanced › Terminal hold at the prompt (minutes)",
    );
    expect(stoppedPastHoldClause(undefined)).toBe("");
    expect(stoppedPastHoldClause(null)).toBe("");
  });
});
