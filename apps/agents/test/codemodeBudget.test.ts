// SPI-1433: a script that uses up code mode's compute budget (`codemode.interruptBudget`) fails naming the setting, its
// value and where to change it. The remote sandbox runs here against pi-codemode's own remote end, in-process.
import { loadQuickJSWasm, serveCodemodeRemote } from "@earendil-works/pi-codemode";
import type { CodemodeResult } from "@earendil-works/pi-codemode/portable";
import { describe, expect, it } from "vitest";

import { computeBudgetText, remoteSandbox } from "../src/extensions/codemode.ts";

const wasm = loadQuickJSWasm();
const sandboxOf = (budget: number) =>
  remoteSandbox(
    {
      getByName: () => ({
        execute: (request, exchange) => serveCodemodeRemote(request, exchange, { wasm, maxInterruptBudget: 300_000 }),
      }),
    },
    "session",
    budget,
  );

const failure = (result: CodemodeResult) => (result.ok ? undefined : result.error);

describe("code mode's compute budget", () => {
  it("names itself, its value and where to change it, as the model's tool result shows it", () => {
    expect(computeBudgetText(100_000)).toBe(
      "Execution stopped at its 100,000-poll Script compute budget; change it under Tools › Code mode › Advanced › Script compute budget (polls).",
    );
  });

  it("names itself when a script run as pi-durable runs it (`start`) uses it up", async () => {
    const sandbox = sandboxOf(1_000);
    const run = sandbox.start("while (true) {}", { startedAt: 0, seed: 1, onCall: () => {} });
    expect(failure(await run.result)).toMatchObject({ kind: "timeout", message: computeBudgetText(1_000) });
    await sandbox.close();
  });

  it("names itself from `execute` too", async () => {
    const sandbox = sandboxOf(1_000);
    expect(failure(await sandbox.execute("while (true) {}"))).toMatchObject({
      kind: "timeout",
      message: computeBudgetText(1_000),
    });
    await sandbox.close();
  });

  it("leaves a script's own deadline and its other failures as pi-codemode words them", async () => {
    const sandbox = sandboxOf(300_000);
    // A call never answered: the script waits past its deadline.
    const waiting = sandbox.start("await tools.wait({})", {
      startedAt: 0,
      seed: 1,
      tools: [{ name: "wait" }],
      timeoutMs: 50,
      onCall: () => {},
    });
    const timedOut = failure(await waiting.result);
    expect(timedOut).toMatchObject({ kind: "timeout" });
    expect(timedOut?.message).not.toContain("Script compute budget");
    expect(failure(await sandbox.execute("throw new Error('boom')"))).toMatchObject({
      kind: "script",
      message: "boom",
    });
    await sandbox.close();
  });
});
