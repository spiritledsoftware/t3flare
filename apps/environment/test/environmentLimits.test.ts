// SPI-1364: the router trace's length and t3's Terminals' history are the Owner's Environment settings, read through
// the Environment DO's services, with the defaults where none are bound.
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_PORT_PROBE_MS,
  DEFAULT_PORT_STOP_GRACE_SECONDS,
  MAX_EXITED_TERMINALS_KEPT,
  MAX_TERMINAL_HISTORY_KIB,
} from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import {
  clearRouterTrace,
  ROUTER_TRACE_BYTES,
  routerTrace,
  traceEntryBytes,
  traceProtocol,
} from "../src/agents/processRouter.ts";
import { makeTerminalProcesses, terminalManagerOptions } from "../src/terminal/layer.ts";

afterEach(() => {
  bindEnvironmentServices(undefined as unknown as EnvironmentServices);
  clearRouterTrace();
});

describe("the router trace", () => {
  it("keeps the latest `routerTraceEntries`, 300 by default", () => {
    bindEnvironmentServices({ routerTraceEntries: () => 5 } as unknown as EnvironmentServices);
    for (let at = 0; at < 12; at++) traceProtocol("codex", `step-${at}`, "");
    expect(routerTrace().map((entry) => entry.argv[0])).toEqual(["step-7", "step-8", "step-9", "step-10", "step-11"]);
    bindEnvironmentServices(undefined as unknown as EnvironmentServices);
    clearRouterTrace();
    for (let at = 0; at < 310; at++) traceProtocol("codex", `step-${at}`, "");
    expect(routerTrace()).toHaveLength(300);
  });

  it("keeps an entry's detail whole, and drops the oldest past ROUTER_TRACE_BYTES", () => {
    const long = "e".repeat(100_000);
    traceProtocol("codex", "whole", long);
    expect(routerTrace()[0]?.detail).toBe(long);
    clearRouterTrace();
    const big = "x".repeat(ROUTER_TRACE_BYTES / 2 / 4);
    for (let at = 0; at < 10; at++) traceProtocol("codex", `big-${at}`, big);
    const kept = routerTrace();
    expect(kept.length).toBeLessThan(10);
    expect(kept.at(-1)?.argv[0]).toBe("big-9");
    expect(kept.reduce((total, entry) => total + traceEntryBytes(entry), 0)).toBeLessThanOrEqual(ROUTER_TRACE_BYTES);
  });
});

describe("t3's Terminals' history", () => {
  it("takes the Owner's history size and kept exited Terminals, 1 MiB and 16 by default", () => {
    const processes = makeTerminalProcesses();
    expect(terminalManagerOptions(processes, "/logs")).toMatchObject({
      historyByteLimit: 1024 * 1024,
      maxRetainedInactiveSessions: 16,
    });
    bindEnvironmentServices({
      terminalHistory: () => ({ historyByteLimit: 4096 * 1024, maxRetainedInactiveSessions: 32 }),
    } as unknown as EnvironmentServices);
    expect(terminalManagerOptions(processes, "/logs")).toMatchObject({
      historyByteLimit: 4096 * 1024,
      maxRetainedInactiveSessions: 32,
    });
  });
});

/** One of t3's server sources at the pin, for the values ours copy (docs/upstream-fragility.md U102, U103). */
const t3Source = (relative: string) =>
  readFileSync(path.join(import.meta.dirname, "../../../t3code/apps/server/src", relative), "utf8");

describe("the values copied from stock t3 (SPI-1364)", () => {
  it("the Terminal history maxima are t3's TerminalManager defaults, and its options are the ones we pass", () => {
    const manager = t3Source("terminal/Manager.ts");
    expect(manager).toContain(`const DEFAULT_HISTORY_BYTE_LIMIT = ${MAX_TERMINAL_HISTORY_KIB / 1024} * 1024 * 1024;`);
    expect(manager).toContain(`const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = ${MAX_EXITED_TERMINALS_KEPT};`);
    expect(manager).toContain("historyByteLimit?: number;");
    expect(manager).toContain("maxRetainedInactiveSessions?: number;");
  });

  it("the port stop grace and the port check wait are t3's port scanner's", () => {
    const scanner = t3Source("preview/PortScanner.ts");
    expect(scanner).toContain(`const STOP_GRACE_MS = ${DEFAULT_PORT_STOP_GRACE_SECONDS}_000;`);
    expect(scanner).toContain(`const WEB_PROBE_TIMEOUT = Duration.seconds(${DEFAULT_PORT_PROBE_MS / 1000});`);
  });
});
