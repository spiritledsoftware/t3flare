// The panel's Status line for a Global mise lay-down (SPI-1150, ADR-0032's Global mise config refinement).
import { describe, expect, it } from "vitest";

import { describeGlobalMise, globalMiseReport, type GlobalMiseReport } from "./globalMise.ts";

const report = (fields: Partial<GlobalMiseReport>): GlobalMiseReport => ({
  workspace: "app",
  runtime: "r1",
  revision: 2,
  sha256: "a".repeat(64),
  bytes: 10,
  source: "environment",
  outcome: "laid",
  install: 0,
  timedOut: false,
  ms: 5,
  at: Date.UTC(2026, 10, 14),
  ...fields,
});

describe("describeGlobalMise", () => {
  it("says why a file was not laid down", () => {
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 1 }))).toContain(
      "not laid down (mise install exit 1)",
    );
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 0 }))).toContain(
      "not laid down (git or gh did not run under it)",
    );
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 124, timedOut: true }))).toContain(
      "not laid down (timed out)",
    );
  });

  it("reads a run with no text (no install) as no Global mise config, never as git or gh failing", () => {
    expect(describeGlobalMise(report({ outcome: "not-laid", install: null, bytes: 0 }))).toBe(
      "app at revision 2: no Global mise config, 2026-11-14T00:00:00.000Z",
    );
    expect(describeGlobalMise(report({ outcome: "none", install: null, bytes: 0 }))).toContain("no Global mise config");
  });

  it("says when the dotfiles' own mise config is mise's global config, and when t3flare pointed mise back at its own (ADR-0047 §10)", () => {
    expect(describeGlobalMise(report({ outcome: "laid", dotfiles: true }))).toBe(
      "app at revision 2: no Global mise config; the dotfiles' ~/.config/mise/config.toml is mise's global config, 2026-11-14T00:00:00.000Z",
    );
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 0, dotfiles: true }))).toContain(
      "no Global mise config; the dotfiles' ~/.config/mise/config.toml is not used (git or gh did not run under it), so mise uses t3flare's own",
    );
    expect(describeGlobalMise(report({ outcome: "not-laid", install: 124, timedOut: true, dotfiles: true }))).toContain(
      "is not used (timed out)",
    );
  });

  it("takes a report's dotfiles field only as a boolean", () => {
    const base = report({});
    expect(globalMiseReport({ ...base, dotfiles: true })).toEqual({ ...base, dotfiles: true });
    expect(globalMiseReport(base)).toEqual(base);
    expect(globalMiseReport({ ...base, dotfiles: "yes" })).toBeUndefined();
  });
});
