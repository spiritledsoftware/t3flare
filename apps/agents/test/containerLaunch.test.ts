// The Workspace DO's read of the Environment settings before a Container start (SPI-1149, ADR-0032), and what the start
// launches with: the Environment's answer within a bounded wait, else the copy it last kept, else the defaults; the size
// name as an `instance` that is never omitted, the idle time, and the budget carried only when it was read fresh.
import { describe, expect, it } from "vitest";

import { EMPTY_ENVIRONMENT, type ResolvedEnvironment, resolveEnvironment } from "@t3flare/harness-registry";

import { launchOf, SECRET_SHOWN, secretValuesOf, shownLaunch, takeEnvironment, withScripts } from "../src/workspace/containerLaunch.ts";

const CPU_1 = { vcpu: 1, memoryMib: 3072, diskMb: 12000 };
/** The registry's defaults: a literal below names only what it changes. */
const DEFAULTS: ResolvedEnvironment = resolveEnvironment(EMPTY_ENVIRONMENT);

const keeper = (initial?: ResolvedEnvironment) => {
  let kept = initial;
  return { kept: () => kept, keep: (value: ResolvedEnvironment) => void (kept = value), now: () => kept };
};
const never = () => new Promise<ResolvedEnvironment>(() => undefined);

describe("takeEnvironment", () => {
  it("takes the Environment's answer and keeps it", async () => {
    const store = keeper({ ...DEFAULTS, revision: 1, containerSize: "standard-1", containerIdleMinutes: 3, containerBudget: 2 });
    const answer: ResolvedEnvironment = { ...DEFAULTS, revision: 2, containerSize: "standard-3", containerIdleMinutes: 9, containerBudget: 5 };
    expect(await takeEnvironment({ read: async () => answer, kept: store.kept, keep: store.keep, waitMs: 50 })).toEqual({ settings: answer, source: "environment" });
    expect(store.now()).toEqual(answer);
  });

  it("falls back to its kept copy when the Environment does not answer in time, or fails", async () => {
    const copy: ResolvedEnvironment = { ...DEFAULTS, revision: 4, containerSize: "standard-2", containerIdleMinutes: 7, containerBudget: 2 };
    const store = keeper(copy);
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    const failing = async (): Promise<ResolvedEnvironment> => {
      throw new Error("the Environment DO reset");
    };
    expect(await takeEnvironment({ read: failing, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: copy, source: "kept" });
    expect(store.now()).toEqual(copy);
  });

  it("starts with the defaults when the Environment does not answer and nothing is kept", async () => {
    const store = keeper();
    expect(await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 })).toEqual({ settings: DEFAULTS, source: "default" });
  });

  it("reads its kept copy against this Worker's schema: an unknown size starts the default, a missing setting its default", async () => {
    // SAFETY: deliberately outside the type: a copy kept by another Worker's version.
    const odd = { revision: 6, containerSize: "standard-9", containerBudget: 2 } as unknown as ResolvedEnvironment;
    const store = keeper(odd);
    const taken = await takeEnvironment({ read: never, kept: store.kept, keep: store.keep, waitMs: 20 });
    expect(taken).toEqual({ settings: { ...DEFAULTS, revision: 6, containerSize: "cpu-1", containerIdleMinutes: 2, containerBudget: 2 }, source: "kept" });
    expect(launchOf(taken).instance).toEqual(CPU_1);
  });

  it("reads an answer from an Environment newer or older than this Worker against this Worker's schema", async () => {
    const store = keeper();
    // SAFETY: deliberately outside the type, as another Worker's version may answer.
    const odd = { revision: 9, containerSize: "standard-9", containerIdleMinutes: 61, containerBudget: 11, misePolicy: "x" } as unknown as ResolvedEnvironment;
    const taken = await takeEnvironment({ read: async () => odd, kept: store.kept, keep: store.keep, waitMs: 50 });
    expect(taken).toEqual({ settings: { ...DEFAULTS, revision: 9 }, source: "environment" });
    expect(store.now()).toEqual({ ...DEFAULTS, revision: 9 });
  });
});

describe("launchOf", () => {
  it("launches with the Variables it took, fresh or kept: a running Container keeps them (SPI-1152)", () => {
    const variables = [{ name: "NODE_ENV", value: "test", secret: false }];
    expect(launchOf({ settings: { ...DEFAULTS, variables }, source: "environment" }).variables).toEqual({ NODE_ENV: "test" });
    expect(launchOf({ settings: { ...DEFAULTS, variables }, source: "kept" }).variables).toEqual({ NODE_ENV: "test" });
  });

  it("launches with a secret Variable's opened value, and shows it only as set (ADR-0046)", async () => {
    const variables = [
      { name: "NODE_ENV", value: "test", secret: false },
      { name: "NPM_TOKEN", value: "npm_live", secret: true },
    ];
    const taken = { settings: { ...DEFAULTS, variables }, source: "environment" as const };
    const launch = launchOf(taken);
    expect(launch.variables).toEqual({ NODE_ENV: "test", NPM_TOKEN: "npm_live" });
    expect(launch.secretVariables).toEqual(["NPM_TOKEN"]);
    const shown = shownLaunch(await withScripts(launch, taken));
    expect(shown.variables).toEqual({ NODE_ENV: "test", NPM_TOKEN: SECRET_SHOWN });
    expect(JSON.stringify(shown)).not.toContain("npm_live");
  });

  it("launches a named size by its name and cpu-1 as its resources, with the idle time in milliseconds", () => {
    expect(launchOf({ settings: { ...DEFAULTS, revision: 3, containerSize: "standard-4", containerIdleMinutes: 10, containerBudget: 4 }, source: "environment" })).toEqual({
      size: "standard-4",
      instance: "standard-4",
      idleMs: 600_000,
      budget: 4,
      revision: 3,
      variables: {},
    });
    expect(launchOf({ settings: DEFAULTS, source: "environment" })).toEqual({ size: "cpu-1", instance: CPU_1, idleMs: 120_000, budget: 3, revision: 0, variables: {} });
  });

  it("carries no budget unless it was read fresh: a kept copy or the defaults never overwrite the owner's", () => {
    const copy: ResolvedEnvironment = { ...DEFAULTS, revision: 4, containerSize: "standard-2", containerIdleMinutes: 7, containerBudget: 1 };
    expect(launchOf({ settings: copy, source: "kept" }).budget).toBeUndefined();
    expect(launchOf({ settings: DEFAULTS, source: "default" }).budget).toBeUndefined();
    expect(launchOf({ settings: copy, source: "kept" }).instance).toBe("standard-2");
  });
});

describe("the launch's Global mise config", () => {
  const taken = { settings: { ...DEFAULTS, revision: 7, containerSize: "cpu-1" as const, containerIdleMinutes: 2, containerBudget: 3, globalMiseConfig: '[tools]\nnode = "24.11.1"\n' }, source: "kept" as const };

  it("carries the start's text, its size and SHA-256, its revision and where the settings came from", async () => {
    const launch = await withScripts(launchOf(taken), taken);
    expect(launch.globalMise).toEqual({ text: '[tools]\nnode = "24.11.1"\n', bytes: 25, sha256: "0eb09ceb981ac62b1ed4ebb30295ad081a471bb40b9ebda4eb48fcf45aae8cf3", revision: 7, source: "kept" });
  });

  it("is shown by its digest only, never its text", async () => {
    const shown = shownLaunch(await withScripts(launchOf(taken), taken));
    expect(shown.globalMise).toEqual({ bytes: 25, sha256: "0eb09ceb981ac62b1ed4ebb30295ad081a471bb40b9ebda4eb48fcf45aae8cf3", revision: 7, source: "kept" });
    expect(JSON.stringify(shown)).not.toContain("24.11.1");
  });
});

describe("the launch's Container setup (ADR-0047 §7)", () => {
  const taken = { settings: { ...DEFAULTS, revision: 8, containerSetup: "apt-get install -y ripgrep\n", containerSetupMinutes: 12, containerSetupFailure: "refuse" as const, setupOutputKiB: 64 }, source: "environment" as const };
  const SHA = "65de07bbb8dacf17ecd6ba438aa4087ef6d70a6a2f2f4987df5ab9b46833c0db";

  it("carries the start's script, its size and SHA-256, its revision, time limit and failure policy", async () => {
    const launch = await withScripts(launchOf(taken), taken);
    expect(launch.containerSetup).toEqual({ text: "apt-get install -y ripgrep\n", bytes: 27, sha256: SHA, revision: 8, source: "environment", minutes: 12, failure: "refuse", outputBytes: 64 * 1024 });
  });

  it("is shown by its digest only, never its text", async () => {
    const shown = shownLaunch(await withScripts(launchOf(taken), taken));
    expect(shown.containerSetup).toEqual({ bytes: 27, sha256: SHA, revision: 8, source: "environment", minutes: 12, failure: "refuse", outputBytes: 64 * 1024 });
    expect(JSON.stringify(shown)).not.toContain("ripgrep");
  });
});

describe("secretValuesOf", () => {
  it("answers the values of the Variables the launch names secret, nothing for a launch with none", () => {
    const variables = [
      { name: "NPM_TOKEN", value: "npm_abc", secret: true },
      { name: "NODE_ENV", value: "test", secret: false },
    ];
    const launch = launchOf({ settings: { ...DEFAULTS, variables }, source: "environment" });
    expect(secretValuesOf(launch)).toEqual(["npm_abc"]);
    // A name the launch calls secret but no longer carries opens nothing.
    expect(secretValuesOf({ ...launch, secretVariables: ["NPM_TOKEN", "GONE"] })).toEqual(["npm_abc"]);
    expect(secretValuesOf({ ...launch, secretVariables: [] })).toEqual([]);
    expect(secretValuesOf(undefined)).toEqual([]);
  });
});
