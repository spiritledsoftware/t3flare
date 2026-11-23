// @effect-diagnostics nodeBuiltinImport:off
// SPI-1338: which Stage names stage.ts accepts (stage-names.ts), and which file `stage.ts run` runs (scripts/lib/stageScript.ts).
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_STAGE_NAME_LENGTH, stageNameProblem, stageNames } from "../stage-names.ts";
import { stageScript } from "../scripts/lib/stageScript.ts";

describe("stageNameProblem", () => {
  it("accepts lowercase names of letters, digits and inner dashes", () => {
    for (const stage of ["a", "7", "p1338", "snapspike1", "spi-1338", "a-b-c", "1-2"])
      expect(stageNameProblem(stage)).toBeUndefined();
  });

  it("accepts prod and bump, whose own guards stay in stage.ts", () => {
    expect(stageNameProblem("prod")).toBeUndefined();
    expect(stageNameProblem("bump")).toBeUndefined();
  });

  it("refuses an empty name, capitals, underscores, dots, spaces and an outer dash", () => {
    for (const stage of ["", "P1338", "p_1338", "p.1338", "p 1338", "-p1338", "p1338-", "-"])
      expect(stageNameProblem(stage)).toBeDefined();
  });

  it("bounds the name by Cloudflare's 54-character limit on the Environment Worker, whose previews are on", () => {
    expect(MAX_STAGE_NAME_LENGTH).toBe(54 - "t3flare-environment-".length);
    expect(MAX_STAGE_NAME_LENGTH).toBe(34);
    expect(stageNameProblem("a".repeat(34))).toBeUndefined();
    expect(stageNameProblem("a".repeat(35))).toMatch(/34/);
    const names = stageNames("a".repeat(MAX_STAGE_NAME_LENGTH));
    expect(names.environment.length).toBe(54);
    for (const name of Object.values(names)) expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("stageNames", () => {
  it("names each Worker and the stand-in after the stage", () => {
    expect(stageNames("p1")).toEqual({
      environment: "t3flare-environment-p1",
      agents: "t3flare-agents-p1",
      codemode: "t3flare-codemode-p1",
      mcp: "t3flare-mcp-p1",
      mcpFixture: "t3flare-mcpfixture-p1",
      probe: "t3flare-probe-p1",
      standin: "t3flare-p1-standin",
      authRule: "t3flare-auth-p1",
    });
  });
});

describe("stageScript", () => {
  const where = { scriptsDir: "/repo/apps/environment/scripts", cwd: "/work" };

  it("resolves a bare name in scripts/", () => {
    expect(stageScript("health", where)).toBe(path.join(where.scriptsDir, "health.ts"));
  });

  it("resolves an argument with a path separator against the cwd", () => {
    expect(stageScript("probes/thing", where)).toBe(path.resolve(where.cwd, "probes/thing"));
    expect(stageScript("/tmp/probe.ts", where)).toBe("/tmp/probe.ts");
  });

  it("resolves a name with a subdirectory against the cwd, not in scripts/", () => {
    expect(stageScript("pbatch2/probe", where)).toBe(path.resolve(where.cwd, "pbatch2/probe"));
  });

  it("resolves a ./ path to a non-.ts file against the cwd", () => {
    expect(stageScript("./probe.mjs", where)).toBe(path.resolve(where.cwd, "probe.mjs"));
  });

  it("resolves an argument ending in .ts against the cwd", () => {
    expect(stageScript("probe.ts", where)).toBe(path.resolve(where.cwd, "probe.ts"));
  });
});
