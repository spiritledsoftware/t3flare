// The two Builders (SPI-1332, SPI-1334; ADR-0047 §1, §8): which one an object is, by its reserved name or the mark it
// kept, and the bound on a Test base build's proposed Image setup. A Workspace is neither.
import { BUILDERS, MAX_SETUP_BYTES } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { builderKindOf, builderMark, proposedSetup } from "../src/workspace/builder.ts";

describe("the Builders", () => {
  it("knows each Builder by its reserved name, and by its mark when the name is not given", () => {
    expect(builderKindOf(BUILDERS.base, undefined)).toBe("base");
    expect(builderKindOf(BUILDERS.test, undefined)).toBe("test");
    expect(builderKindOf(undefined, builderMark("base"))).toBe("base");
    expect(builderKindOf(undefined, builderMark("test"))).toBe("test");
    // The base's mark is SPI-1332's `true`, so a Builder marked before the test Builder existed is still the base.
    expect(builderMark("base")).toBe(true);
  });

  it("takes a Workspace for neither", () => {
    expect(builderKindOf("workspace-1", undefined)).toBeUndefined();
    expect(builderKindOf(undefined, undefined)).toBeUndefined();
    expect(builderKindOf(undefined, "base")).toBeUndefined();
  });

  it("bounds a proposed Image setup as the setting is bounded, in bytes", () => {
    expect(proposedSetup("echo hi\n")).toBe("echo hi\n");
    expect(proposedSetup("x".repeat(MAX_SETUP_BYTES))).toHaveLength(MAX_SETUP_BYTES);
    expect(() => proposedSetup("é".repeat(Math.floor(MAX_SETUP_BYTES / 2) + 1))).toThrow(
      `at most ${MAX_SETUP_BYTES} bytes`,
    );
    expect(() => proposedSetup(42)).toThrow(/text/);
  });
});
