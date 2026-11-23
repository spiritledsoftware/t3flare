// The Environment settings' seam (SPI-1149, ADR-0032): what the Workspace DO and the panel get from the stored settings
// (`resolveEnvironment`), what the panel may store (`applyEnvironmentChange`), and the size name a Container starts with
// (`containerInstance`): defaults, an unknown stored size, the idle bounds, and `instance` never omitted.
import { describe, expect, it } from "vitest";

import {
  AGENT_SETTING_KEYS,
  applyEnvironmentChange,
  BASE_BUILD_SETTING_KEYS,
  builderInstance,
  containerInstance,
  DEFAULT_OWNER_ANSWER_MS,
  DEFAULT_SETTINGS_READ_MS,
  DOTFILES_SETTING_KEYS,
  EMPTY_ENVIRONMENT,
  ENVIRONMENT_SETTINGS,
  MAX_CLI_PROCESSES_PER_WORKSPACE,
  MAX_CLI_RECLAIM_SECONDS,
  MAX_CONTAINER_BUDGET,
  MAX_SETUP_BYTES,
  MAX_TIMED_MINUTES,
  resolveEnvironment,
  SWEEP_SETTING_KEYS,
} from "./environment.ts";
import type { EnvironmentSettingEntry } from "./fields.ts";
import { cliToolTimeoutSec } from "./mcp.ts";

/** The Base build's settings at their defaults (SPI-1332, ADR-0047 §9). */
const BASE_DEFAULTS = {
  imageSetup: "",
  imageSetupMinutes: 30,
  snapshotMinutes: 5,
  builderSize: "sameAsContainer",
  builderInBudget: false,
  rebuildEveryDays: 0,
  whileBuilding: "lastGood",
  whileBuildingNewImage: "wait",
} as const;

/**
 * The tunables made settings (SPI-1312's tickets) at their defaults: each such ticket adds its key here, one line, not to
 * every full object below.
 */
const TUNABLE_DEFAULTS = {
  cliProcessesPerWorkspace: 4,
  cliReclaimSeconds: 30,
  turnLimitMinutes: 120,
  ownerAnswerMinutes: 10,
  globalMiseInstallMinutes: 10,
  settingsReadSeconds: 5,
} as const;

describe("resolveEnvironment", () => {
  it("gives the defaults for empty settings: cpu-1 and a 2-minute idle time, at revision 0", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toEqual({
      revision: 0,
      containerSize: "cpu-1",
      containerIdleMinutes: 2,
      containerBudget: 3,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      setupOutputKiB: 32,
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      sweepPurges: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
  });

  it("reads a stored size it no longer offers, or an idle time out of bounds, as the default", () => {
    expect(
      resolveEnvironment({
        revision: 4,
        settings: { containerSize: "mem-8", containerIdleMinutes: 0, containerBudget: 101 },
      }),
    ).toEqual({
      revision: 4,
      containerSize: "cpu-1",
      containerIdleMinutes: 2,
      containerBudget: 3,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      setupOutputKiB: 32,
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      sweepPurges: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
    expect(
      resolveEnvironment({
        revision: 5,
        settings: { containerSize: "standard-3", containerIdleMinutes: 15, containerBudget: 5 },
      }),
    ).toEqual({
      revision: 5,
      containerSize: "standard-3",
      containerIdleMinutes: 15,
      containerBudget: 5,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      setupOutputKiB: 32,
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      sweepPurges: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
  });
});

describe("applyEnvironmentChange", () => {
  it("stores a valid change and bumps the revision", () => {
    const applied = applyEnvironmentChange(EMPTY_ENVIRONMENT, {
      settings: { containerSize: "standard-4", containerIdleMinutes: 10 },
    });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.environment.revision).toBe(1);
    expect(resolveEnvironment(applied.environment)).toEqual({
      revision: 1,
      containerSize: "standard-4",
      containerIdleMinutes: 10,
      containerBudget: 3,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      setupOutputKiB: 32,
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      sweepPurges: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
    const again = applyEnvironmentChange(applied.environment, { settings: { containerIdleMinutes: 5 } });
    if (!again.ok) throw new Error(again.error);
    expect(resolveEnvironment(again.environment)).toEqual({
      revision: 2,
      containerSize: "standard-4",
      containerIdleMinutes: 5,
      containerBudget: 3,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      setupOutputKiB: 32,
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      sweepPurges: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
  });

  it("stores and bumps the revision for the settings that moved only; a save that moves none changes nothing", () => {
    const first = applyEnvironmentChange(EMPTY_ENVIRONMENT, {
      settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 },
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.changed).toEqual(["containerSize"]);
    expect(first.environment).toEqual({ revision: 1, settings: { containerSize: "standard-2" } });
    const same = applyEnvironmentChange(first.environment, {
      settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 3 },
    });
    if (!same.ok) throw new Error(same.error);
    expect(same.changed).toEqual([]);
    expect(same.environment).toBe(first.environment);
  });

  it("keeps the idle time between 1 and 60 whole minutes", () => {
    for (const minutes of [1, 60, 1440, MAX_TIMED_MINUTES])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({
        ok: true,
      });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 1.5, -2, "5"])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerIdleMinutes: minutes } })).toMatchObject({
        ok: false,
      });
  });

  it("keeps the Container budget between 1 and 10 whole Containers", () => {
    for (const budget of [1, 10, 11, MAX_CONTAINER_BUDGET])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({
        ok: true,
      });
    for (const budget of [0, MAX_CONTAINER_BUDGET + 1, 2.5, "3"])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({
        ok: false,
      });
  });

  it("keeps the Grace a whole number of days from 1 (no zero: at once is the Owner's Purge, ADR-0043), and purging a switch", () => {
    for (const days of [1, 7, 3650])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: days } })).toMatchObject({ ok: true });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: 0 } })).toEqual({
      ok: false,
      error: "graceDays: at least 1",
    });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: 1.5 } })).toEqual({
      ok: false,
      error: "graceDays: an integer",
    });
    for (const days of [-1, 3651, "7", null])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: days } })).toMatchObject({ ok: false });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { sweepPurges: false } })).toMatchObject({
      ok: true,
      changed: ["sweepPurges"],
    });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { sweepPurges: "no" } })).toEqual({
      ok: false,
      error: "sweepPurges: true or false",
    });
  });

  it("reads a stored Grace that no longer fits as 7 days, and purging on", () => {
    expect(resolveEnvironment({ revision: 3, settings: { graceDays: 0, sweepPurges: "1" } })).toMatchObject({
      graceDays: 7,
      sweepPurges: true,
    });
    expect(resolveEnvironment({ revision: 3, settings: { graceDays: 30, sweepPurges: false } })).toMatchObject({
      graceDays: 30,
      sweepPurges: false,
    });
  });

  it("refuses a size it does not offer, an unknown setting and an empty change, with the setting named", () => {
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "lite" } })).toEqual({
      ok: false,
      error: "containerSize: one of cpu-1, standard-1, standard-2, standard-3, standard-4",
    });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { secrets: "x" } })).toEqual({
      ok: false,
      error: "secrets: no such setting",
    });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: {} })).toMatchObject({ ok: false });
  });
});

describe("the dotfiles toggles (ADR-0047 §9)", () => {
  it("are both on by default, store a switch, and read a stored value that is not a boolean as on", () => {
    const applied = applyEnvironmentChange(EMPTY_ENVIRONMENT, {
      settings: { terminalsReadBashrc: false, agentsReadDotfiles: false },
    });
    expect(applied).toMatchObject({ ok: true, changed: ["terminalsReadBashrc", "agentsReadDotfiles"] });
    if (!applied.ok) return;
    expect(resolveEnvironment(applied.environment)).toMatchObject({
      terminalsReadBashrc: false,
      agentsReadDotfiles: false,
    });
    expect(
      resolveEnvironment({ revision: 1, settings: { terminalsReadBashrc: "no", agentsReadDotfiles: 0 } }),
    ).toMatchObject({ terminalsReadBashrc: true, agentsReadDotfiles: true });
  });

  it("are Container and CLI settings, not the Sweep's, and render in their own row", () => {
    expect(SWEEP_SETTING_KEYS).not.toContain("terminalsReadBashrc");
    expect(DOTFILES_SETTING_KEYS).toEqual(["terminalsReadBashrc", "agentsReadDotfiles"]);
  });
});

describe("containerInstance", () => {
  it("starts cpu-1 as today's custom size and Cloudflare's named types by their names", () => {
    expect(containerInstance("cpu-1")).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12000 });
    expect(containerInstance("standard-1")).toBe("standard-1");
    expect(containerInstance("standard-2")).toBe("standard-2");
    expect(containerInstance("standard-3")).toBe("standard-3");
    expect(containerInstance("standard-4")).toBe("standard-4");
  });

  it("starts the default for a stored name it does not offer, never an omitted instance (which would start lite)", () => {
    for (const name of ["lite", "basic", "mem-8", "custom-1", "", null, 3, { vcpu: 4 }]) {
      expect(
        containerInstance(resolveEnvironment({ revision: 1, settings: { containerSize: name } }).containerSize),
      ).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12000 });
    }
  });
});

describe("the Global mise config", () => {
  const set = (text: unknown) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { globalMiseConfig: text } });

  it("is empty by default, and a stored value that no longer fits reads as empty", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).globalMiseConfig).toBe("");
    expect(resolveEnvironment({ revision: 2, settings: { globalMiseConfig: "a\u0000b" } }).globalMiseConfig).toBe("");
    expect(resolveEnvironment({ revision: 2, settings: { globalMiseConfig: 42 } }).globalMiseConfig).toBe("");
  });

  it("takes up to 16 KiB of UTF-8 and refuses one byte more, counting a character by its bytes", () => {
    expect(set("x".repeat(16 * 1024))).toMatchObject({ ok: true });
    expect(set("x".repeat(16 * 1024 + 1))).toEqual({
      ok: false,
      error: "globalMiseConfig: is longer than 16 KiB of UTF-8",
    });
    // 5462 three-byte characters are 16 386 bytes, though only 5462 UTF-16 units.
    expect(set("€".repeat(5462))).toEqual({ ok: false, error: "globalMiseConfig: is longer than 16 KiB of UTF-8" });
    expect(set("€".repeat(5461))).toMatchObject({ ok: true });
  });

  it("refuses a NUL and anything not text", () => {
    expect(set('[tools]\nnode = "24"\u0000')).toEqual({
      ok: false,
      error: "globalMiseConfig: contains a NUL character",
    });
    expect(set(7)).toMatchObject({ ok: false });
  });

  it("stores CRLF as LF, so a browser's round trip of the same text is not a change", () => {
    const first = set('[tools]\r\nnode = "24.11.1"\r\n');
    if (!first.ok) throw new Error(first.error);
    expect(resolveEnvironment(first.environment).globalMiseConfig).toBe('[tools]\nnode = "24.11.1"\n');
    const again = applyEnvironmentChange(first.environment, {
      settings: { globalMiseConfig: '[tools]\r\nnode = "24.11.1"\r\n' },
    });
    if (!again.ok) throw new Error(again.error);
    expect(again.changed).toEqual([]);
    expect(again.environment.revision).toBe(1);
  });
});

describe("the CLI agents' processes per Workspace and the reclaim delay (SPI-1318)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("counts 4 processes by default, 1 to MAX_CLI_PROCESSES_PER_WORKSPACE (100, a sanity bound) whole processes", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).cliProcessesPerWorkspace).toBe(4);
    expect(MAX_CLI_PROCESSES_PER_WORKSPACE).toBe(100);
    for (const count of [1, 4, 32, 100]) expect(set({ cliProcessesPerWorkspace: count })).toMatchObject({ ok: true });
    for (const count of [0, 101, 2.5, "4"])
      expect(set({ cliProcessesPerWorkspace: count })).toMatchObject({ ok: false });
  });

  it("waits 30 seconds by default, 0 to MAX_CLI_RECLAIM_SECONDS (660, the CLI idle hold) whole seconds", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).cliReclaimSeconds).toBe(30);
    expect(MAX_CLI_RECLAIM_SECONDS).toBe(660);
    for (const seconds of [0, 30, 660]) expect(set({ cliReclaimSeconds: seconds })).toMatchObject({ ok: true });
    for (const seconds of [-1, 661, 0.5, "30"])
      expect(set({ cliReclaimSeconds: seconds })).toMatchObject({ ok: false });
  });

  it("are down-free and free, in the Agents row, and the count states its memory once in Owner words", () => {
    expect(ENVIRONMENT_SETTINGS.cliProcessesPerWorkspace).toMatchObject({ tier: "down-free" });
    expect(ENVIRONMENT_SETTINGS.cliReclaimSeconds).toMatchObject({ tier: "free" });
    expect(
      "row" in ENVIRONMENT_SETTINGS.cliProcessesPerWorkspace || "row" in ENVIRONMENT_SETTINGS.cliReclaimSeconds,
    ).toBe(false);
    expect(ENVIRONMENT_SETTINGS.cliProcessesPerWorkspace.description).toContain(
      "Each CLI agent's process takes about 150 to 200 MB of the Container's memory; past what the Container size has, commands fail for memory.",
    );
    expect(ENVIRONMENT_SETTINGS.cliReclaimSeconds.description).toContain(
      "ended to free the Container for another Workspace",
    );
    expect(ENVIRONMENT_SETTINGS.cliReclaimSeconds.description).not.toMatch(/reclaim/i);
  });
});

describe("the Turn limit (SPI-1315)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is 120 minutes by default, 1 to MAX_TIMED_MINUTES (10,080) whole minutes (ADR-0048)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).turnLimitMinutes).toBe(120);
    for (const minutes of [1, 120, 1440, MAX_TIMED_MINUTES])
      expect(set({ turnLimitMinutes: minutes })).toMatchObject({ ok: true });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5, "120"])
      expect(set({ turnLimitMinutes: minutes })).toMatchObject({ ok: false });
    expect(resolveEnvironment({ revision: 1, settings: { turnLimitMinutes: 0 } }).turnLimitMinutes).toBe(120);
  });

  it("is down-free, in the Agents row (AGENT_SETTING_KEYS), and states its consequence once in Owner words", () => {
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes).toMatchObject({ tier: "down-free" });
    expect("row" in ENVIRONMENT_SETTINGS.turnLimitMinutes).toBe(false);
    expect(AGENT_SETTING_KEYS).toEqual([
      "turnLimitMinutes",
      "ownerAnswerMinutes",
      "cliProcessesPerWorkspace",
      "cliReclaimSeconds",
    ]);
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes.description).toContain(
      "A turn longer than this is ended (a CLI agent's process with it), and the thread shows it failed. Each minute of a turn can spend model tokens and hold a Container.",
    );
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes.description).toContain(
      "a running turn keeps the limit it started with",
    );
  });
});

describe("the Answer wait (SPI-1316)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is 10 minutes by default, 1 to MAX_TIMED_MINUTES (10,080) whole minutes (ADR-0048 §2)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).ownerAnswerMinutes).toBe(10);
    expect(DEFAULT_OWNER_ANSWER_MS).toBe(600_000);
    for (const minutes of [1, 10, 120, MAX_TIMED_MINUTES])
      expect(set({ ownerAnswerMinutes: minutes })).toMatchObject({ ok: true });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5, "10"])
      expect(set({ ownerAnswerMinutes: minutes })).toMatchObject({ ok: false });
    expect(resolveEnvironment({ revision: 1, settings: { ownerAnswerMinutes: 0 } }).ownerAnswerMinutes).toBe(10);
  });

  it("is down-free, in the Agents row after the Turn limit, and says what a waiting card keeps", () => {
    expect(ENVIRONMENT_SETTINGS.ownerAnswerMinutes).toMatchObject({
      title: "Answer wait (minutes)",
      tier: "down-free",
    });
    expect(AGENT_SETTING_KEYS.indexOf("ownerAnswerMinutes")).toBe(AGENT_SETTING_KEYS.indexOf("turnLimitMinutes") + 1);
    expect(ENVIRONMENT_SETTINGS.ownerAnswerMinutes.description).toContain(
      "An unanswered card is refused after this long. While it waits, the turn stays open and may hold its Container.",
    );
    expect(ENVIRONMENT_SETTINGS.ownerAnswerMinutes.description).toContain("a card already waiting keeps its deadline");
  });

  it("sets a CLI process's MCP tool timeout: two waits plus 300 s (cliToolTimeoutSec)", () => {
    expect(cliToolTimeoutSec(DEFAULT_OWNER_ANSWER_MS)).toBe(1500);
    expect(cliToolTimeoutSec(30 * 60_000)).toBe(3900);
    expect(cliToolTimeoutSec(60_000)).toBe(420);
    expect(cliToolTimeoutSec(1500)).toBe(304);
  });
});

describe("the settings read wait (SPI-1314)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is 5 seconds by default, 1 to MAX_TIMED_MINUTES * 60 whole seconds (ADR-0048 §2)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).settingsReadSeconds).toBe(5);
    expect(DEFAULT_SETTINGS_READ_MS).toBe(5000);
    for (const seconds of [1, 5, 60, MAX_TIMED_MINUTES * 60])
      expect(set({ settingsReadSeconds: seconds })).toMatchObject({ ok: true });
    for (const seconds of [0, MAX_TIMED_MINUTES * 60 + 1, 2.5, "5"])
      expect(set({ settingsReadSeconds: seconds })).toMatchObject({ ok: false });
    expect(resolveEnvironment({ revision: 1, settings: { settingsReadSeconds: 0 } }).settingsReadSeconds).toBe(5);
  });

  it("is free, in the Containers row, and says when it applies", () => {
    expect(ENVIRONMENT_SETTINGS.settingsReadSeconds).toMatchObject({ tier: "free" });
    expect("row" in ENVIRONMENT_SETTINGS.settingsReadSeconds).toBe(false);
    expect(AGENT_SETTING_KEYS).not.toContain("settingsReadSeconds");
    expect(ENVIRONMENT_SETTINGS.settingsReadSeconds.description).toContain(
      "Applies at each thread's next turn. A Container start uses the wait it last kept, so a change can take one more start to apply fully.",
    );
  });
});

describe("the Global mise install time limit (SPI-1313)", () => {
  it("is 10 minutes by default, 1 to MAX_TIMED_MINUTES (10,080) whole minutes (ADR-0048)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).globalMiseInstallMinutes).toBe(10);
    for (const minutes of [1, 10, 11, MAX_TIMED_MINUTES])
      expect(
        applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { globalMiseInstallMinutes: minutes } }),
      ).toMatchObject({ ok: true });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5, "10"])
      expect(
        applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { globalMiseInstallMinutes: minutes } }),
      ).toMatchObject({ ok: false });
  });

  it("sits in the Global mise config's row", () => {
    expect(ENVIRONMENT_SETTINGS.globalMiseInstallMinutes).toMatchObject({ row: "globalMiseConfig", tier: "down-free" });
  });
});

describe("the Container setup (ADR-0047 §7, §9)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is an empty script, a 5-minute limit and carry on, by default", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
    });
  });

  it("takes a script of up to 256 KiB of UTF-8 and refuses one byte more", () => {
    expect(set({ containerSetup: "x".repeat(256 * 1024) })).toMatchObject({ ok: true });
    expect(set({ containerSetup: "x".repeat(256 * 1024 + 1) })).toEqual({
      ok: false,
      error: "containerSetup: is longer than 256 KiB of UTF-8",
    });
  });

  it("takes a time limit of 1 to MAX_TIMED_MINUTES (10,080) minutes", () => {
    for (const minutes of [1, 60, 61, MAX_TIMED_MINUTES])
      expect(set({ containerSetupMinutes: minutes })).toMatchObject({ ok: true });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5])
      expect(set({ containerSetupMinutes: minutes })).toMatchObject({ ok: false });
  });

  it("keeps 32 KiB of a setup's output by default, 4 to 256", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).setupOutputKiB).toBe(32);
    for (const kib of [4, 256]) expect(set({ setupOutputKiB: kib })).toMatchObject({ ok: true });
    for (const kib of [3, 257, 8.5]) expect(set({ setupOutputKiB: kib })).toMatchObject({ ok: false });
  });

  it("carries on or refuses commands on a failure, nothing else", () => {
    expect(set({ containerSetupFailure: "refuse" })).toMatchObject({ ok: true });
    expect(set({ containerSetupFailure: "stop" })).toEqual({
      ok: false,
      error: "containerSetupFailure: one of carryOn, refuse",
    });
  });
});

describe("the Settings page's rows", () => {
  it("joins each setting with a row to a setting that has a row of its own (a file's or a list's)", () => {
    for (const [key, setting] of Object.entries(
      ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>,
    )) {
      if (setting.row === undefined) continue;
      const owner = (ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>)[setting.row];
      expect(owner, `${key}'s row`).toBeDefined();
      expect(["file", "variables"], `${key}'s row`).toContain(owner!.schema.type);
    }
  });
});

describe("the Base build's settings (SPI-1332, ADR-0047 §9)", () => {
  it("keeps the Image setup a file of at most 256 KiB of UTF-8", () => {
    expect(MAX_SETUP_BYTES).toBe(256 * 1024);
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "apt-get install -y jq\r\n" } }),
    ).toMatchObject({
      ok: true,
      changed: ["imageSetup"],
      environment: { settings: { imageSetup: "apt-get install -y jq\n" } },
    });
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "x".repeat(MAX_SETUP_BYTES) } }),
    ).toMatchObject({ ok: true });
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "x".repeat(MAX_SETUP_BYTES + 1) } }),
    ).toEqual({ ok: false, error: "imageSetup: is longer than 256 KiB of UTF-8" });
  });

  it("bounds the time limits, the scheduled rebuild and the Builder's size", () => {
    for (const minutes of [1, 120, 121, MAX_TIMED_MINUTES])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetupMinutes: minutes } })).toMatchObject({
        ok: true,
      });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetupMinutes: minutes } })).toMatchObject({
        ok: false,
      });
    for (const minutes of [1, 15, 16, MAX_TIMED_MINUTES])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { snapshotMinutes: minutes } })).toMatchObject({
        ok: true,
      });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { snapshotMinutes: minutes } })).toMatchObject({
        ok: false,
      });
    // 0 is off; 29 is the most, under the platform's 30-day expiry.
    for (const days of [1, 29])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { rebuildEveryDays: days } })).toMatchObject({
        ok: true,
      });
    for (const days of [-1, 30])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { rebuildEveryDays: days } })).toMatchObject({
        ok: false,
      });
    for (const size of ["standard-4", "cpu-1"])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { builderSize: size } })).toMatchObject({
        ok: true,
      });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { builderSize: "lite" } })).toMatchObject({
      ok: false,
    });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { builderInBudget: true } })).toMatchObject({
      ok: true,
      changed: ["builderInBudget"],
    });
  });

  it("starts the Builder at the Container size unless the Owner gave it one", () => {
    const settings = (stored: Record<string, unknown>) => resolveEnvironment({ revision: 1, settings: stored });
    expect(builderInstance(settings({ containerSize: "standard-3" }))).toBe("standard-3");
    expect(builderInstance(settings({}))).toEqual(containerInstance("cpu-1"));
    expect(builderInstance(settings({ containerSize: "standard-1", builderSize: "standard-4" }))).toBe("standard-4");
  });

  it("names the settings a Base build reads", () => {
    expect(BASE_BUILD_SETTING_KEYS).toEqual([
      "imageSetup",
      "imageSetupMinutes",
      "snapshotMinutes",
      "builderSize",
      "builderInBudget",
      "rebuildEveryDays",
    ]);
  });
});
