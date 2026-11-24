// SPI-1364, SPI-1387: the router trace's length and t3's Terminals' history are fixed constants, the history sized for the
// Environment DO's 128 MB isolate; the values copied from stock t3 are pinned to its source.
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  EXITED_TERMINALS_KEPT,
  PORT_PROBE_MS,
  ROUTER_TRACE_ENTRIES,
  STOP_GRACE_SECONDS,
  TERMINAL_HISTORY_KIB,
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
  it("keeps the latest ROUTER_TRACE_ENTRIES, 300", () => {
    expect(ROUTER_TRACE_ENTRIES).toBe(300);
    for (let at = 0; at < 310; at++) traceProtocol("codex", `step-${at}`, "");
    expect(routerTrace()).toHaveLength(300);
    expect(routerTrace()[0]?.argv[0]).toBe("step-10");
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
  it("takes the fixed history size and kept exited Terminals, 1 MiB and 16", () => {
    expect([TERMINAL_HISTORY_KIB, EXITED_TERMINALS_KEPT]).toEqual([1024, 16]);
    expect(terminalManagerOptions(makeTerminalProcesses(), "/logs")).toMatchObject({
      historyByteLimit: 1024 * 1024,
      maxRetainedInactiveSessions: 16,
    });
  });
});

/** One of t3's server sources at the pin, for the values ours copy (docs/upstream-fragility.md U102, U103). */
const t3Source = (relative: string) =>
  readFileSync(path.join(import.meta.dirname, "../../../t3code/apps/server/src", relative), "utf8");

describe("the values copied from stock t3 (SPI-1364)", () => {
  it("stock t3's Terminal history is the 8 MiB and 128 our constants name, and its options are the ones we pass", () => {
    const manager = t3Source("terminal/Manager.ts");
    expect(manager).toContain("const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;");
    expect(manager).toContain("const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;");
    expect(manager).toContain("historyByteLimit?: number;");
    expect(manager).toContain("maxRetainedInactiveSessions?: number;");
  });

  it("the stop grace and the port check wait are t3's port scanner's", () => {
    const scanner = t3Source("preview/PortScanner.ts");
    expect(scanner).toContain(`const STOP_GRACE_MS = ${STOP_GRACE_SECONDS}_000;`);
    expect(scanner).toContain(`const WEB_PROBE_TIMEOUT = Duration.seconds(${PORT_PROBE_MS / 1000});`);
  });
});
