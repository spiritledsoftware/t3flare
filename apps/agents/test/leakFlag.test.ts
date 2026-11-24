// SPI-1360: a credential leak's flag keeps every hit path that fits its one Durable Object value, and says how many more.
import { DO_VALUE_BYTES, storedValueProblem } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { leakFlag } from "../src/workspace/leakFlag.ts";

const hit = (at: number) => ({ name: "GITHUB_TOKEN", path: `/workspace/repo/${"d".repeat(200)}/file-${at}` });

describe("the leak flag", () => {
  it("keeps every path when they fit, and the names once each", () => {
    const flag = leakFlag([hit(0), hit(1), { name: "OTHER", path: "/a" }], 7);
    expect(flag).toEqual({ at: 7, names: ["GITHUB_TOKEN", "OTHER"], paths: [hit(0).path, hit(1).path, "/a"] });
  });

  it("cuts the paths where they would pass the value, and counts the rest", () => {
    const hits = Array.from({ length: 20_000 }, (_, at) => hit(at));
    const flag = leakFlag(hits, 7);
    expect(storedValueProblem("the flag", flag)).toBeUndefined();
    expect(flag.paths.length).toBeLessThan(hits.length);
    expect(flag.paths.length).toBeGreaterThan(1000);
    expect(flag.paths).toEqual(hits.slice(0, flag.paths.length).map((one) => one.path));
    expect(flag.more).toBe(hits.length - flag.paths.length);
    expect(3 * JSON.stringify(flag).length).toBeGreaterThan(DO_VALUE_BYTES / 2);
  });
});
