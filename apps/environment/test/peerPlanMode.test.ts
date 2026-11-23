// SPI-1278: F6 of `acceptance.ts --peer` proves the link's `approval-required/plan` reaches the thread, whatever the
// model chooses to try. Plan mode's enforcement itself is `apps/agents/test/permissions.test.ts`'s.
import { describe, expect, it } from "vitest";

import { planModeChecks } from "../scripts/lib/peerAcceptance.ts";

const plan = { interactionMode: "plan", runtimeMode: "approval-required" };
/** The provider's items carry a `nativeItemRef`; t3's own "Preparing workspace" item carries none. */
const ref = { nativeItemRef: { driver: "piDurable", nativeId: "call-1" } };
const preparing = { type: "command_execution", status: "completed", input: "Preparing workspace", nativeItemRef: null };
const failed = (projection: unknown) =>
  planModeChecks(projection)
    .checks.filter(([, ok]) => !ok)
    .map(([name]) => name);

describe("F6's checks on a plan-mode thread", () => {
  it("pass when the model obeys Plan mode and calls no tool, after t3 prepared the workspace", () => {
    const projection = { thread: plan, turnItems: [preparing, { type: "assistant_message", status: "completed" }], runtimeRequests: [] };
    expect(planModeChecks(projection).bashAttempted).toBe(false);
    expect(failed(projection)).toEqual([]);
  });

  it("pass when the model's bash waits for approval", () => {
    const projection = {
      thread: plan,
      turnItems: [
        preparing,
        { type: "file_change", status: "failed", ...ref },
        { type: "command_execution", status: "running", ...ref },
      ],
      runtimeRequests: [{ kind: "command", status: "pending" }],
    };
    expect(planModeChecks(projection).bashAttempted).toBe(true);
    expect(failed(projection)).toEqual([]);
  });

  it("pass when the model's bash was refused or denied: it fails with no exit code", () => {
    const projection = { thread: plan, turnItems: [preparing, { type: "command_execution", status: "failed", output: "refused", ...ref }], runtimeRequests: [] };
    expect(planModeChecks(projection).bashAttempted).toBe(true);
    expect(failed(projection)).toEqual([]);
  });

  it("fail when a command of the model's ran, even beside another command's pending approval", () => {
    const projection = {
      thread: plan,
      turnItems: [
        { type: "command_execution", status: "completed", ...ref },
        { type: "command_execution", status: "running", ...ref },
      ],
      runtimeRequests: [{ kind: "command", status: "pending" }],
    };
    expect(failed(projection)).toEqual(["F6: no command runs without asking"]);
  });

  it("fail when a command ran after an approval: F6 answers none, so none can have run", () => {
    const projection = { thread: plan, turnItems: [{ type: "command_execution", status: "completed", ...ref }], runtimeRequests: [{ kind: "command", status: "resolved" }] };
    expect(failed(projection)).toEqual(["F6: no command runs without asking"]);
  });

  it("fail when a command of the model's ran and exited non-zero", () => {
    const projection = { thread: plan, turnItems: [{ type: "command_execution", status: "failed", exitCode: 2, ...ref }], runtimeRequests: [] };
    expect(failed(projection)).toEqual(["F6: no command runs without asking"]);
  });

  it("fail when a write completes", () => {
    expect(failed({ thread: plan, turnItems: [{ type: "file_change", status: "completed", ...ref }], runtimeRequests: [] })).toEqual(["F6: write is refused in plan"]);
  });

  it("fail when the thread is not in plan or not at approval-required", () => {
    expect(failed({ thread: { interactionMode: "default", runtimeMode: "full-access" }, turnItems: [] })).toEqual([
      "F6: the thread runs in plan",
      "F6: the thread runs at approval-required",
    ]);
    expect(failed(undefined)).toEqual(["F6: the thread runs in plan", "F6: the thread runs at approval-required"]);
  });
});
