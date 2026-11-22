// The Base build's record as both Workers read it (SPI-1332, ADR-0047 §4): the Builder answers it, the Environment DO
// keeps the last one it was sent (`baseBuildRecord` drops a malformed one) and Status says it in a line.
import { describe, expect, it } from "vitest";

import { type BaseBuildRecord, baseBuildRecord, BUILDERS, describeBaseBuild, buildDurationText, snapshotSizeText } from "./baseBuild.ts";

const AT = Date.parse("2026-11-22T10:00:00.000Z");
const KEY = "a".repeat(64);

const good = { id: "snap-1", size: 34_500_000, key: KEY, imageDigest: "sha256:img", builtAt: AT, tookMs: 72_000 };

describe("baseBuildRecord", () => {
  it("keeps each state's record", () => {
    const records: ReadonlyArray<BaseBuildRecord> = [
      { key: null, state: "none", good: null, at: AT },
      { key: KEY, state: "none", nothingToBuild: true, good: null, at: AT },
      { key: KEY, state: "building", phase: "running", since: AT, reason: "the Image setup changed", good, at: AT },
      { key: KEY, state: "building", phase: "starting", since: AT, reason: "Rebuild", waitingForBudget: true, good: null, at: AT },
      { key: KEY, state: "ready", good, at: AT },
      { key: KEY, state: "failed", failure: { at: AT, phase: "running", exitCode: 3, message: "the Image setup exited 3", output: "boom\n" }, good: null, at: AT },
    ];
    for (const record of records) expect(baseBuildRecord(record)).toEqual(record);
  });

  it("drops what is not a record, or holds more output than any setting keeps", () => {
    for (const value of [null, "ready", [], { key: KEY, state: "maybe", good: null, at: AT }, { key: 3, state: "none", good: null, at: AT }, { key: KEY, state: "ready", good: { id: 1 }, at: AT }]) {
      expect(baseBuildRecord(value)).toBeUndefined();
    }
    expect(baseBuildRecord({ key: KEY, state: "failed", failure: { at: AT, phase: "running", exitCode: 1, message: "x", output: "y".repeat(256 * 1024 + 1) }, good: null, at: AT })).toBeUndefined();
  });
});

describe("describeBaseBuild", () => {
  it("says each state in a line", () => {
    expect(describeBaseBuild({ key: null, state: "none", good: null, at: AT })).toBe("none yet");
    expect(describeBaseBuild({ key: KEY, state: "none", nothingToBuild: true, good: null, at: AT })).toBe("none: no Image setup and no Global mise config, so Containers start from the Workspace image");
    expect(describeBaseBuild({ key: KEY, state: "building", phase: "snapshotting", since: AT, reason: "Rebuild", good: null, at: AT })).toBe("building since 2026-11-22T10:00:00.000Z (snapshotting; Rebuild)");
    expect(describeBaseBuild({ key: KEY, state: "building", phase: "starting", since: AT, reason: "Rebuild", waitingForBudget: true, good: null, at: AT })).toBe("building since 2026-11-22T10:00:00.000Z (waiting for room under the Container budget; Rebuild)");
    expect(describeBaseBuild({ key: KEY, state: "ready", good, at: AT })).toBe("ready: built 2026-11-22T10:00:00.000Z, 34.5 MB, took 1 min 12 s");
    expect(describeBaseBuild({ key: KEY, state: "ready", good, failure: { at: AT, phase: "running", exitCode: 2, message: "the Image setup exited 2", output: "" }, at: AT })).toBe(
      "ready: built 2026-11-22T10:00:00.000Z, 34.5 MB, took 1 min 12 s; a rebuild failed 2026-11-22T10:00:00.000Z (exit 2): the Image setup exited 2",
    );
    expect(describeBaseBuild({ key: KEY, state: "failed", failure: { at: AT, phase: "running", exitCode: 3, message: "the Image setup exited 3", output: "" }, good: null, at: AT })).toBe(
      "failed 2026-11-22T10:00:00.000Z (exit 3): the Image setup exited 3",
    );
    expect(describeBaseBuild({ key: KEY, state: "failed", failure: { at: AT, phase: "snapshotting", exitCode: null, message: "the snapshot took longer than 5 min", output: "" }, good, at: AT })).toBe(
      "failed 2026-11-22T10:00:00.000Z: the snapshot took longer than 5 min; the last good one (built 2026-11-22T10:00:00.000Z) is for older settings",
    );
  });

  it("names sizes and durations as a person reads them", () => {
    expect(snapshotSizeText(900)).toBe("900 B");
    expect(snapshotSizeText(34_500_000)).toBe("34.5 MB");
    expect(snapshotSizeText(2_100_000_000)).toBe("2.1 GB");
    expect(buildDurationText(14_000)).toBe("14 s");
    expect(buildDurationText(3_725_000)).toBe("62 min 5 s");
  });

  it("names a Builder for each kind of build, never a Workspace's id", () => {
    expect(BUILDERS.base).not.toBe(BUILDERS.test);
    for (const name of Object.values(BUILDERS)) expect(name).toMatch(/^t3flare:/);
  });
});
