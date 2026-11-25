// The MCP host names the time limit a server ran past (SPI-1432, ADR-0049 §4): the engine tags its `TimedOut` with the
// limit and its value, and the host says which limit, how long, and where on the Settings page to change it. A fixed
// limit is named as fixed. A `TimedOut` without the tag, from an engine before SPI-1432, reads as it did.
import { applyMcpChange, EMPTY_HARNESS, OFF_DEADLINE_MS, type StoredHarness } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { McpHost, type McpEngineBinding } from "../src/mcp/host.ts";

const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
  };
};

const APP = "ui://time/app.html";

const TOOLS = [
  { name: "note", description: "note", inputSchema: { type: "object", properties: {} } },
  {
    name: "clock",
    description: "clock",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: APP } },
  },
];

const harness = (): StoredHarness => {
  const added = applyMcpChange(EMPTY_HARNESS, {
    op: "add",
    server: "fs",
    url: "https://fs.example/mcp",
    auth: { kind: "none" },
  });
  if (!added.ok) throw new Error(added.error);
  return added.harness;
};

/** A host whose engine lists `TOOLS`, or fails its discovery with `discoverError`, and fails every request with `error`. */
const setup = (options: { error?: unknown; discoverError?: unknown; callTimeoutMs?: number } = {}) => {
  const engine: McpEngineBinding = {
    discover: async () =>
      (options.discoverError === undefined
        ? {
            kind: "discovered",
            era: "modern",
            protocolVersion: "2026-06-18",
            capabilities: { tools: {} },
            tools: TOOLS,
            prompts: [],
            problems: [],
            fetchedAt: 0,
            state: {},
          }
        : { kind: "failed", error: options.discoverError, state: {} }) as never,
    request: async () => ({ kind: "failed", error: options.error, state: {} }) as never,
  };
  return new McpHost({
    kv: memory(),
    engine,
    settings: harness,
    now: () => 1_000_000,
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: () => options.callTimeoutMs! }),
  });
};

const timedOut = (fields: Readonly<Record<string, unknown>> = {}) => ({
  _tag: "TimedOut",
  message: "The server did not answer in time",
  ...fields,
});

const CALL_PLACE = "Environment › Advanced › MCP call time limit (seconds)";
const MAY_HAVE_RUN = "It may have run upstream; do not repeat a change without checking.";

const call = async (host: McpHost) => {
  await host.list("fs");
  return host.call({ server: "fs", tool: "note", args: {}, judged: "write" });
};

const read = async (host: McpHost) => {
  await host.list("fs");
  return host.readAppResource({ server: "fs", uri: APP });
};

describe("an MCP time limit, hit, names itself (SPI-1432)", () => {
  it("a tool call past the MCP call time limit: its value and where to change it", async () => {
    const host = setup({ error: timedOut({ limit: "call", ms: 60_000 }), callTimeoutMs: 60_000 });
    expect(await call(host)).toEqual({
      kind: "unavailable",
      mayHaveRun: true,
      message: `The MCP call failed: fs did not answer within its 60-second time limit; change it under ${CALL_PLACE}. ${MAY_HAVE_RUN}`,
    });
  });

  it("a tool call past the off deadline while the call time limit is off: that deadline, which no setting raises", async () => {
    const host = setup({ error: timedOut({ limit: "call", ms: OFF_DEADLINE_MS }), callTimeoutMs: 0 });
    expect(await call(host)).toMatchObject({
      message: `The MCP call failed: fs did not answer in 604,800 s, the most t3flare lets an MCP call run while the MCP call time limit is off. ${MAY_HAVE_RUN}`,
    });
  });

  it("a call whose connection outlives the connect time limit names that limit", async () => {
    const host = setup({ error: timedOut({ limit: "connect", ms: 30_000 }) });
    expect(await call(host)).toMatchObject({
      message: `The MCP call failed: fs did not answer its connection within its 30-second time limit; change it under Environment › Advanced › MCP server connect time limit (seconds). ${MAY_HAVE_RUN}`,
    });
  });

  it("another request while the call time limit is set: the call time limit", async () => {
    const host = setup({ error: timedOut({ limit: "call", ms: 60_000 }), callTimeoutMs: 60_000 });
    expect(await read(host)).toEqual({
      kind: "refused",
      message: `The read failed: fs did not answer within its 60-second time limit; change it under ${CALL_PLACE}.`,
    });
  });

  it("another request while the call time limit is off: t3flare's fixed MCP request time limit", async () => {
    const host = setup({ error: timedOut({ limit: "request", ms: 270_000 }), callTimeoutMs: 0 });
    expect(await read(host)).toEqual({
      kind: "refused",
      message: "The read failed: fs did not answer in 270 s, t3flare's fixed MCP request time limit.",
    });
  });

  it("a discovery past the connect time limit stores an inventory error that names it", async () => {
    const inventory = await setup({ discoverError: timedOut({ limit: "connect", ms: 30_000 }) }).list("fs");
    expect(inventory).toMatchObject({
      status: "failed",
      error:
        "fs did not answer its connection within its 30-second time limit; change it under Environment › Advanced › MCP server connect time limit (seconds)",
    });
  });

  it("a listing past the listing time limit stores an inventory error that names it", async () => {
    const walk = await setup({
      discoverError: { _tag: "TimedOut", message: "Listing tools took over 120 s", limit: "list", ms: 120_000 },
    }).list("fs");
    expect(walk).toMatchObject({
      error:
        "Listing tools took over its 120-second time limit; change it under Environment › Advanced › MCP server listing time limit (seconds)",
    });
    const page = await setup({ discoverError: timedOut({ limit: "list", ms: 120_000 }) }).list("fs");
    expect(page).toMatchObject({
      error:
        "Listing fs took over its 120-second time limit; change it under Environment › Advanced › MCP server listing time limit (seconds)",
    });
  });

  it("a TimedOut without the tag, from an engine before SPI-1432, reads as it did", async () => {
    expect(await call(setup({ error: timedOut() }))).toMatchObject({
      message: `The MCP call failed (TimedOut: The server did not answer in time). ${MAY_HAVE_RUN}`,
    });
    expect(await read(setup({ error: timedOut() }))).toMatchObject({
      message: "The read failed (TimedOut: The server did not answer in time).",
    });
    expect(
      await setup({ discoverError: { _tag: "TimedOut", message: "Listing tools took over 120 s" } }).list("fs"),
    ).toMatchObject({
      error: "TimedOut: Listing tools took over 120 s",
    });
  });
});
