// SPI-1364: code mode's compute budget is the Owner's (`codemode.interruptBudget`); the sandbox Worker allows a request up
// to the setting's maximum, which derives from its CPU limit. The sandbox is its own Worker, read here as text.
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

import { MAX_CODEMODE_INTERRUPT_BUDGET } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

const here = path.dirname(new URL(import.meta.url).pathname);

describe("the codemode sandbox Worker's limits", () => {
  it("allows a request up to the compute budget setting's maximum", () => {
    const worker = fs.readFileSync(path.join(here, "../../codemode-sandbox/src/worker.ts"), "utf8");
    const allowed = /maxInterruptBudget = ([\d_]+);/.exec(worker)?.[1];
    expect(Number(allowed?.replaceAll("_", ""))).toBe(MAX_CODEMODE_INTERRUPT_BUDGET);
  });

  it("runs no CPU limit of its own, so a Durable Object's default 30 s is the one the maximum derives from", () => {
    const alchemy = fs.readFileSync(path.join(here, "../../environment/alchemy.run.ts"), "utf8");
    const worker = alchemy.slice(alchemy.indexOf('Cloudflare.Worker("CodemodeSandbox"'));
    expect(worker.slice(0, worker.indexOf("} as never);"))).not.toMatch(/cpu_ms|cpuMs/);
  });
});
