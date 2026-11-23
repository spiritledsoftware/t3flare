// A turn's settings read wait (SPI-1314): what the turn's start carried, else the default.
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS_READ_MS } from "@t3flare/harness-registry";

import { turnReadMs } from "../src/session/turnReadMs.ts";

describe("turnReadMs", () => {
  it("is what the turn's start carried, else the default 5 s", () => {
    expect(turnReadMs({ settingsReadMs: 1000 })).toBe(1000);
    expect(turnReadMs({})).toBe(DEFAULT_SETTINGS_READ_MS);
    expect(DEFAULT_SETTINGS_READ_MS).toBe(5000);
  });
});
