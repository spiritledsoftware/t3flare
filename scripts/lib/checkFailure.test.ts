// @effect-diagnostics nodeBuiltinImport:off
// The block a failed `pnpm run check` ends with (SPI-1346), on real runs: each `check-run-<case>.txt` is
// `pnpm run check`'s output on a scratch change with one deliberate failure, and `check-run-<case>.details.txt` the
// `vp run --last-details` that followed it, the checkout path replaced by /repo. In `killed`, a scratch `node --test`
// file SIGKILLed its runner.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { failureReport, FAILURE_LINES, parseLastDetails } from "./checkFailure.ts";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
const run = (name: string) => ({
  log: fixture(`check-run-${name}.txt`),
  details: fixture(`check-run-${name}.details.txt`),
});
/** How many tasks vp's summary counts as failed: `• 16 failed`. */
const failedCount = (details: string) => Number(/• (\d+) failed/.exec(details)![1]);

void describe("parseLastDetails", () => {
  void it("reads every task with its exit code, in vp's order", () => {
    const tasks = parseLastDetails(run("lint").details);
    assert.equal(tasks.length, 27);
    assert.deepEqual(tasks[0], { name: "@t3flare/codemode-sandbox#lint", exitCode: 0 });
    assert.deepEqual(tasks[11], { name: "@t3flare/skills#lint", exitCode: 1 });
    assert.deepEqual(tasks[14], { name: "t3flare#check:patches", exitCode: 137 });
  });

  void it("is empty for output that is not a summary", () => {
    assert.deepEqual(parseLastDetails("error: no previous run\n"), []);
  });
});

void describe("failureReport", () => {
  void it("names a failing lint task, its error, and the tasks vp stopped", () => {
    const { log, details } = run("lint");
    const report = failureReport(log, details, 1);
    const lines = report.split("\n");
    assert.equal(lines[0], "check FAILED (vp exit 1): first failing task: @t3flare/skills#lint (exit 1)");
    assert.match(lines[1]!, /^ {2}src\/scratch\.ts:2:1: error typescript\(no-floating-promises\)/);
    const stopped = /^stopped by vp when it failed \(not failures\): (\d+) tasks \(exit 137\): (.+)$/m.exec(report);
    assert.ok(stopped, report);
    assert.equal(Number(stopped[1]) + 1, failedCount(details));
    assert.match(stopped[2]!, /^@t3flare\/sandbox-image#typecheck, @t3flare\/environment#lint, /);
    assert.doesNotMatch(stopped[2]!, /skills#lint/);
    assert.doesNotMatch(report, /other failed tasks/);
    assert.doesNotMatch(report, /^ {2}(---|vp run:|\[ELIFECYCLE\])/m, "vp's and pnpm's closing lines are no task's");
  });

  void it("names a failing check:fmt and the file it would change", () => {
    const report = failureReport(run("fmt").log, run("fmt").details, 1);
    assert.match(report, /^check FAILED \(vp exit 1\): first failing task: t3flare#check:fmt \(exit 1\)\n/);
    assert.match(report, /^ {2}packages\/skills\/src\/scratch\.ts/m);
    assert.match(report, /^ {2}Format issues found in above 1 files/m);
    assert.match(report, /^stopped by vp when it failed \(not failures\): 15 tasks \(exit 137\): /m);
  });

  void it("names a failing test and its assertion", () => {
    const report = failureReport(run("test").log, run("test").details, 1);
    assert.match(report, /^check FAILED \(vp exit 1\): first failing task: @t3flare\/skills#test \(exit 1\)\n/);
    assert.match(report, /^ {5}× fails on purpose/m);
    assert.match(report, /^ {2}AssertionError: expected 1 to be 2/m);
    assert.match(report, /^stopped by vp when it failed \(not failures\): 15 tasks \(exit 137\): /m);
  });

  void it("blames no task when every task that did not pass was killed", () => {
    const { log, details } = run("killed");
    const report = failureReport(log, details, 1);
    assert.match(report, /^check FAILED \(vp exit 1\): no task failed by itself; 16 tasks were killed \(exit 137\)/);
    assert.match(report, /out of memory/);
    assert.doesNotMatch(report, /first failing task/);
  });

  void it("lists other tasks that failed by themselves", () => {
    const details = run("lint").details.replace(
      /(\[17\] @t3flare\/mcp#lint: .*)\(exit code: 137\)/,
      "$1(exit code: 2)",
    );
    const report = failureReport(run("lint").log, details, 1);
    assert.match(report, /^other failed tasks: @t3flare\/mcp#lint \(exit 2\)$/m);
    assert.match(report, /^stopped by vp when it failed \(not failures\): 14 tasks \(exit 137\): /m);
  });

  void it("names no task when vp's details could not be read", () => {
    const report = failureReport(run("test").log, { unreadable: "spawnSync vp ENOBUFS" }, 1);
    assert.equal(
      report,
      "check FAILED (vp exit 1): vp's details of the run could not be read (spawnSync vp ENOBUFS), " +
        "so no task is named; " +
        "find the failure in the log above, or run `vp run --last-details`",
    );
  });

  void it("names no task when vp's details list no failure, as stale or unreadable details do", () => {
    const passed = run("lint").details.replaceAll(/✗ \(exit code: \d+\)/g, "✓");
    for (const details of [passed, "error: no previous run\n"]) {
      const report = failureReport(run("test").log, details, 2);
      assert.match(report, /^check FAILED \(vp exit 2\): /);
      assert.doesNotMatch(report, /#/, "no task named");
    }
    assert.match(failureReport("", passed, 2), /every task in vp's details of the last run passed/);
    assert.match(failureReport("", passed, 2), /may be from an earlier run/);
    assert.match(failureReport("", "error: no previous run\n", 2), /vp's details of the run list no task/);
  });

  void it("leaves out t3's errors the typecheck reports as not failing", () => {
    const log = [
      "── [@t3flare/environment#typecheck] ──",
      "src/runtime.ts(62,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      "",
      "1 error(s) in t3's own files, which only this program's configuration sees (fragility U10); not failing:",
      "[t3, not failing] ../../t3code/apps/server/src/a.ts(1,1): error TS2345: Argument of type 'X' is not assignable.",
      "  Type 'X' is not assignable to type 'Y'.",
      "",
    ].join("\n");
    const details =
      "  [1] @t3flare/environment#typecheck: ~/apps/environment$ node scripts/typecheck.ts ✗ (exit code: 1)\n";
    const report = failureReport(log, details, 1);
    assert.match(report, /src\/runtime\.ts\(62,14\): error TS2322/);
    assert.doesNotMatch(report, /t3code|t3's own files/);
  });

  void it("shows at most FAILURE_LINES lines of a long section, its errors first", () => {
    const passing = Array.from({ length: 100 }, (_, i) => `  ✓ passes ${i}`);
    const log = ["── [@t3flare/a#test] ──", ...passing, "   × fails here", "AssertionError: no", ...passing].join("\n");
    const details = "  [1] @t3flare/a#test: ~/a$ vitest run ✗ (exit code: 1)\n";
    const shown = failureReport(log, details, 1).split("\n").slice(1);
    assert.ok(shown.length <= FAILURE_LINES + 1);
    assert.deepEqual(shown.slice(0, 2), ["     × fails here", "  AssertionError: no"]);
  });
});
