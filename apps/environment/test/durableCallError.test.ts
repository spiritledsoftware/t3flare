// SPI-1305: a Durable agent's Session call that threw (a Workers platform error: the subrequest depth limit, a reset)
// shows its exception in t3, not "did not answer open" alone or the turn-start category text. The adapter puts a
// `ProviderSetupError` naming the exception under its protocol error, and t3's failure text reads through to it
// (`knownProviderFailureMessage`) under t3's open and turn-start errors (U3).
import { ProviderDriverKind, ProviderInstanceId, ProviderThreadId, RunId, ThreadId } from "@t3tools/contracts";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect, it } from "vitest";
import { sessionCallError } from "../src/provider/adapter.ts";

const instanceId = ProviderInstanceId.make("durable");
const depth = new Error("Subrequest depth limit exceeded. This request recursed through Workers too many times.");

/** The error t3's `ProviderTurnStartService` puts a failed `sendTurn` under. */
const turnStartError = (cause: unknown) =>
  new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("piDurable"),
    threadId: ThreadId.make("thread-1"),
    providerThreadId: ProviderThreadId.make("provider-thread-1"),
    runId: RunId.make("run-1"),
    cause,
  });

describe("a Durable Session call that threw (SPI-1305)", () => {
  it("names the exception under t3's turn-start error", () => {
    expect(knownProviderFailureMessage(turnStartError(sessionCallError(instanceId, "submitTurn", depth)))).toBe(
      `The agent's session did not answer submitTurn (cause: ${depth.message}).`,
    );
  });

  it("names the exception under t3's open error", () => {
    // t3's `ProviderSessionOpenError` (apps/server) carries the adapter's error as its `cause`.
    const opened = { _tag: "ProviderSessionOpenError", cause: sessionCallError(instanceId, "open", depth) };
    expect(knownProviderFailureMessage(opened)).toBe(
      `The agent's session did not answer open (cause: ${depth.message}).`,
    );
  });

  it("is read through the setup error alone: a bare protocol error shows nothing", () => {
    const bare = new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("piDurable"),
      detail: "The agent's session did not answer submitTurn",
      cause: depth,
    });
    expect(knownProviderFailureMessage(turnStartError(bare))).toBeUndefined();
  });

  it("redacts a credential in the exception", () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    const thrown = new Error(`fetch failed: Authorization: Bearer ${"b".repeat(40)} with ${key}`);
    const text = knownProviderFailureMessage(turnStartError(sessionCallError(instanceId, "submitTurn", thrown)));
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(key);
    expect(text).not.toContain("b".repeat(40));
  });

  it("names a thrown non-Error by its text", () => {
    expect(knownProviderFailureMessage(turnStartError(sessionCallError(instanceId, "abort", "reset")))).toBe(
      "The agent's session did not answer abort (cause: reset).",
    );
  });
});
