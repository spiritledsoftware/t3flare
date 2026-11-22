// The Container setup's report (ADR-0047 §7): what a Workspace DO sends the Environment DO after each run, and the line
// the Settings page's Status shows for it.
import { describe, expect, it } from "vitest";

import { type ContainerSetupReport, containerSetupReport, describeContainerSetup, MAX_SETUP_OUTPUT_BYTES } from "./containerSetup.ts";

const REPORT: ContainerSetupReport = {
  workspace: "/w/app",
  runtime: "r1",
  revision: 7,
  sha256: "b".repeat(64),
  bytes: 30,
  source: "environment",
  outcome: "failed",
  exitCode: 2,
  timedOut: false,
  output: "+ apt-get install ripgrep\nE: Unable to locate package\n",
  ms: 1500,
  at: Date.UTC(2026, 10, 22, 12, 0, 0),
};

describe("containerSetupReport", () => {
  it("takes a well-formed report as it is", () => {
    expect(containerSetupReport(REPORT)).toEqual(REPORT);
    expect(containerSetupReport({ ...REPORT, workspace: null, exitCode: null, outcome: "exec-failed" })).toMatchObject({ workspace: null, exitCode: null });
  });

  it("refuses one with a field out of shape, or an output over 32 KB", () => {
    expect(containerSetupReport({ ...REPORT, outcome: "maybe" })).toBeUndefined();
    expect(containerSetupReport({ ...REPORT, sha256: "x" })).toBeUndefined();
    expect(containerSetupReport({ ...REPORT, exitCode: 1.5 })).toBeUndefined();
    expect(containerSetupReport({ ...REPORT, output: "x".repeat(MAX_SETUP_OUTPUT_BYTES + 1) })).toBeUndefined();
    expect(containerSetupReport({ ...REPORT, output: "x".repeat(MAX_SETUP_OUTPUT_BYTES) })).toBeDefined();
    expect(containerSetupReport("nope")).toBeUndefined();
  });
});

describe("describeContainerSetup", () => {
  it("names the Workspace, the revision, how it ended and when", () => {
    expect(describeContainerSetup(REPORT)).toBe("/w/app at revision 7: exit 2 after 1.5 s, 2026-11-22T12:00:00.000Z");
    expect(describeContainerSetup({ ...REPORT, outcome: "ok", exitCode: 0 })).toBe("/w/app at revision 7: exit 0 after 1.5 s, 2026-11-22T12:00:00.000Z");
    expect(describeContainerSetup({ ...REPORT, outcome: "failed", exitCode: 124, timedOut: true, ms: 300_000 })).toBe("/w/app at revision 7: stopped at its time limit after 300 s, 2026-11-22T12:00:00.000Z");
    expect(describeContainerSetup({ ...REPORT, outcome: "none", exitCode: null, ms: 0, bytes: 0 })).toBe("/w/app at revision 7: no Container setup, 2026-11-22T12:00:00.000Z");
    expect(describeContainerSetup({ ...REPORT, outcome: "exec-failed", exitCode: null })).toBe("/w/app at revision 7: not run (the Container's exec failed; tried again), 2026-11-22T12:00:00.000Z");
    expect(describeContainerSetup({ ...REPORT, workspace: null, outcome: "deadline", exitCode: null })).toBe("a Workspace at revision 7: no answer within the deadline, 2026-11-22T12:00:00.000Z");
  });
});
