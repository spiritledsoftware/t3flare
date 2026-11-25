// The outside request time limit (SPI-1387, ADR-0049 §4): a request to GitHub or a sign-in's vendor that runs past
// `OUTSIDE_REQUEST_SECONDS` fails naming the limit and its value, wherever it is said.
import { OUTSIDE_REQUEST_MS, outsideRequestTimedOut, outsideTimeoutClause } from "@t3flare/harness-registry";
import { outsideRequestTimedOut as mcpOutsideRequestTimedOut } from "@t3flare/mcp/oauth-http";
import { describe, expect, it } from "vitest";

import { refreshClaude } from "../src/credentials/claude.ts";
import { githubReader } from "../src/skills/contents.ts";
import { actionsClient } from "../src/updates/actions.ts";

/** A fetch whose request runs past its time limit: it rejects as `AbortSignal.timeout` does. */
const timesOut = async (): Promise<Response> => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

const NAMED = "did not answer in 30 s, t3flare's fixed outside request time limit";

describe("the outside request time limit", () => {
  it("names itself and its value, and only for a timeout", () => {
    expect(OUTSIDE_REQUEST_MS).toBe(30_000);
    expect(outsideRequestTimedOut()).toBe(NAMED);
    expect(outsideTimeoutClause(new DOMException("x", "TimeoutError"))).toBe(` (it ${NAMED})`);
    expect(outsideTimeoutClause(new TypeError("fetch failed"))).toBe("");
  });

  it("reads the same from the MCP package's own copy, which does not import the registry", () => {
    for (const ms of [OUTSIDE_REQUEST_MS, 10]) expect(mcpOutsideRequestTimedOut(ms)).toBe(outsideRequestTimedOut(ms));
  });

  it("is named when a sign-in's renewal times out", async () => {
    const renewed = await refreshClaude(
      { fetch: timesOut, now: () => 0 },
      { type: "oauth", access: "a", refresh: "r", expires: 0 },
    );
    expect(renewed).toMatchObject({ ok: false, problem: expect.stringContaining(NAMED) });
  });

  it("is named when an Update's request to GitHub times out", async () => {
    const client = actionsClient({
      repo: { owner: "acme", name: "t3flare" },
      token: async () => "t",
      fetch: timesOut,
      timeoutMs: () => OUTSIDE_REQUEST_MS,
    });
    await expect(client.getRun(1)).rejects.toThrow(`GitHub ${NAMED}`);
  });

  it("is named when a skills read from GitHub times out", async () => {
    const reader = githubReader({
      fetch: timesOut,
      access: { token: "t", how: "installation", ownerInstalled: false },
    });
    await expect(reader.commit({ owner: "acme", name: "x" }, null)).rejects.toThrow(`GitHub ${NAMED}`);
  });
});
