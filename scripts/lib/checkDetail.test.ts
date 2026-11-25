// @effect-diagnostics nodeBuiltinImport:off
// A failed check's report detail (SPI-1293), on real `pnpm run check` failures: `node --test`, so the root scripts need
// no test dependency. Each fixture is a check run on a scratch commit with one deliberate failure, its checkout path
// replaced by /repo.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { t3ErrorsHeading, T3_NOT_FAILING_LABEL } from "../../apps/environment/scripts/lib/typecheckFilter.ts";
import { checkDetail, FIRST_ERROR_LINES, LONG_DETAIL_CHARS } from "./checkDetail.ts";
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
/** More than LONG_DETAIL_CHARS of other output, as a long check's later task groups print it. */
const filler = "[@t3flare/environment#test] ~/apps/environment$ vitest run ⊘ cache disabled\n".repeat(400);

void describe("checkDetail", () => {
  void it("keeps a type error followed by more than the tail's length of other output", () => {
    const output = fixture("check-typecheck-failure.txt") + filler;
    assert.ok(output.length > LONG_DETAIL_CHARS * 1.5);
    const detail = checkDetail(output, LONG_DETAIL_CHARS);
    assert.ok(detail.length <= LONG_DETAIL_CHARS);
    assert.match(
      detail,
      /── \[@t3flare\/environment#typecheck\] ──\nsrc\/runtime\.ts\(62,14\): error TS2322: Type 'string' is not assignable to type 'number'\./,
    );
    assert.ok(detail.endsWith(output.slice(-1000)), "the tail stays");
  });

  void it("keeps a lint error", () => {
    const detail = checkDetail(fixture("check-lint-failure.txt") + filler, LONG_DETAIL_CHARS);
    assert.match(
      detail,
      /── \[t3flare#lint:scripts\] ──\nscripts\/lib\/worktreeSetup\.test\.ts:247:1: error typescript\(no-floating-promises\)/,
    );
  });

  void it("keeps a failed test", () => {
    const detail = checkDetail(fixture("check-test-failure.txt") + filler, LONG_DETAIL_CHARS);
    assert.match(detail, /── \[@t3flare\/skills#test\] ──\n {5}× fails on purpose/);
    assert.match(detail, / FAIL {2}src\/listing\.test\.ts > scratch > fails on purpose/);
    assert.match(detail, /AssertionError: expected 1 to be 2/);
  });

  void it("does not take a tool's command line for an error", () => {
    const detail = checkDetail(fixture("check-lint-failure.txt") + filler, LONG_DETAIL_CHARS);
    assert.doesNotMatch(detail.split("── tail ──")[0]!, /oxlint --type-aware/);
  });

  void it("leaves out t3's errors the typecheck reports as not failing", () => {
    const t3Errors = Array.from(
      { length: 70 },
      (_, i) =>
        `../../t3code/apps/server/src/a.ts(${i},1): error TS2345: Argument of type 'X' is not assignable.\n  Type 'X' is not assignable to type 'Y'.`,
    );
    const output = [
      "── [@t3flare/agents#typecheck] ──",
      "70 error(s) in t3's own files, which only this program's configuration sees (fragility U10); not failing:",
      ...t3Errors,
      "",
      "── [@t3flare/environment#typecheck] ──",
      "src/runtime.ts(62,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      filler,
    ].join("\n");
    const head = checkDetail(output, LONG_DETAIL_CHARS).split("\n\n── tail ──\n")[0]!;
    assert.match(head, /── \[@t3flare\/environment#typecheck\] ──\nsrc\/runtime\.ts\(62,14\): error TS2322/);
    assert.doesNotMatch(head, /t3code/);
  });

  void it("leaves out t3's errors under their not-failing label, with or without the heading over them", () => {
    const t3Error =
      `${T3_NOT_FAILING_LABEL}../../t3code/apps/server/src/a.ts(1,1): error TS2345: Argument of type 'X' is not ` +
      "assignable.\n  Type 'X' is not assignable to type 'Y'.";
    const output = [
      "── [@t3flare/environment#typecheck] ──",
      "src/runtime.ts(62,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      "",
      t3ErrorsHeading(2),
      t3Error,
      t3Error,
      "",
      // A log cut above the heading still shows the label.
      t3Error,
      filler,
    ].join("\n");
    const head = checkDetail(output, LONG_DETAIL_CHARS).split("\n\n── tail ──\n")[0]!;
    assert.match(head, /src\/runtime\.ts\(62,14\): error TS2322/);
    assert.doesNotMatch(head, /t3code/);
  });

  void it("is the whole output when it fits", () => {
    const output = fixture("check-typecheck-failure.txt");
    assert.equal(checkDetail(output, LONG_DETAIL_CHARS), output);
  });

  void it("leads with at most FIRST_ERROR_LINES errors, in at most half the detail", () => {
    const errors = Array.from({ length: 200 }, (_, i) => `src/a.ts(${i},1): error TS2322: ${"x".repeat(300)}`);
    const detail = checkDetail(errors.join("\n") + "\n" + filler, LONG_DETAIL_CHARS);
    const head = detail.split("\n\n── tail ──\n")[0]!;
    assert.ok(head.length <= LONG_DETAIL_CHARS / 2);
    assert.ok((head.match(/error TS2322/g) ?? []).length <= FIRST_ERROR_LINES);
    assert.ok(detail.length <= LONG_DETAIL_CHARS);
  });

  void it("is the tail when no line names an error", () => {
    assert.equal(checkDetail(filler, 1000), filler.slice(-1000));
  });
});
