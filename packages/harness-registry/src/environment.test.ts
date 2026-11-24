// The Environment settings' seam (SPI-1149, ADR-0032): what the Workspace DO and the panel get from the stored settings
// (`resolveEnvironment`), what the panel may store (`applyEnvironmentChange`), and the size name a Container starts with
// (`containerInstance`): defaults, an unknown stored size, the idle bounds, and `instance` never omitted.
import { describe, expect, it } from "vitest";

import {
  AGENT_SETTING_KEYS,
  applyEnvironmentChange,
  COMMAND_SETTING_KEYS,
  CONTAINER_PREVIEW_SETTING_KEYS,
  MAX_PREVIEW_PORTS,
  RESERVED_CONTAINER_PORTS,
  BASE_BUILD_SETTING_KEYS,
  builderInstance,
  containerInstance,
  customResources,
  DEFAULT_CHECKPOINT_MINUTES,
  DEFAULT_CLONE_MINUTES,
  DEFAULT_OWNER_ANSWER_MS,
  DOTFILES_SETTING_KEYS,
  EMPTY_ENVIRONMENT,
  ENVIRONMENT_SETTINGS,
  MAX_CONTAINER_BUDGET,
  MAX_RETENTION_DAYS,
  MAX_SETUP_BYTES,
  MAX_SETUP_OUTPUT_KIB,
  MAX_FILE_SETTING_BYTES,
  MAX_GLOBAL_MISE_BYTES,
  MAX_TIMED_MINUTES,
  MAX_TIMED_SECONDS,
  resolveEnvironment,
  RETENTION_SETTING_KEYS,
  MCP_CALL_SETTING_KEYS,
  MCP_SERVER_SETTING_KEYS,
  DEFAULT_MCP_CALL_MS,
  SWEEP_SETTING_KEYS,
  LIFECYCLE_SETTING_KEYS,
  NEXT_USE_SETTING_KEYS,
  OUTSIDE_REQUEST_SETTING_KEYS,
  TEXT_GENERATION_MARGIN_MS,
  fitsEnvironmentSetting,
  DEFAULT_TEXT_GENERATION_SECONDS,
  deadlineMs,
  OFF_DEADLINE_MS,
  offDeadlineMs,
  AGENT_TERMINAL_SCROLLBACK_LINES,
  AGENT_TERMINALS_PER_WORKSPACE,
  cliProcessesPerWorkspace,
  cliProcessesPerWorkspaceOf,
  CLI_RECLAIM_SECONDS,
  CONTAINER_SIZES,
  EXITED_TERMINALS_KEPT,
  OUTSIDE_REQUEST_SECONDS,
  SETTINGS_READ_MS,
  SETUP_OUTPUT_KIB,
  STOP_GRACE_SECONDS,
  TERMINAL_HISTORY_KIB,
} from "./environment.ts";
import type { EnvironmentSettingEntry } from "./fields.ts";
import { DO_VALUE_BYTES, storedBytes } from "./storedValue.ts";
import { cliToolTimeoutSec } from "./mcp.ts";

/** The Base build's settings at their defaults (SPI-1332, ADR-0047 §9). */
const BASE_DEFAULTS = {
  imageSetup: "",
  imageSetupMinutes: 30,
  snapshotMinutes: 5,
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
  repoSkillsListed: 100,
  textGenerationSeconds: 180,
  idleAfterSeconds: 60,
  prWatchWakeMinutes: 10,
  customVcpu: 2,
  customMemoryMib: 8192,
  customDiskMb: 16_000,
  turnLimitMinutes: 0,
  ownerAnswerMinutes: 10,
  globalMiseInstallMinutes: 10,
  terminalBusyHoldMinutes: 30,
  terminalPromptHoldMinutes: 10,
  cloneMinutes: 0,
  checkpointMinutes: 0,
  usageRetentionDays: 0,
  piSessionRetentionDays: 0,
  mcpCallSeconds: 0,
  mcpConnectSeconds: 30,
  mcpListSeconds: 120,
  commandMinutes: 0,
  containerConnectSeconds: 120,
  previewPorts: [3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787],
} as const;

describe("resolveEnvironment", () => {
  it("gives the defaults for empty settings: standard-3, a 2-minute idle time and no Container budget, at revision 0", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toEqual({
      revision: 0,
      containerSize: "standard-3",
      containerIdleMinutes: 2,
      containerBudget: 0,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
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
      containerSize: "standard-3",
      containerIdleMinutes: 2,
      containerBudget: 0,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
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
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
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
      containerBudget: 0,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
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
      containerBudget: 0,
      variables: [],
      globalMiseConfig: "",
      containerSetup: "",
      containerSetupMinutes: 5,
      containerSetupFailure: "carryOn",
      terminalsReadBashrc: true,
      agentsReadDotfiles: true,
      graceDays: 7,
      ...TUNABLE_DEFAULTS,
      ...BASE_DEFAULTS,
    });
  });

  it("stores and bumps the revision for the settings that moved only; a save that moves none changes nothing", () => {
    const first = applyEnvironmentChange(EMPTY_ENVIRONMENT, {
      settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 0 },
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.changed).toEqual(["containerSize"]);
    expect(first.environment).toEqual({ revision: 1, settings: { containerSize: "standard-2" } });
    const same = applyEnvironmentChange(first.environment, {
      settings: { containerSize: "standard-2", containerIdleMinutes: 2, containerBudget: 0 },
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

  it("keeps the Container budget off (0) or 1 to MAX_CONTAINER_BUDGET whole Containers", () => {
    for (const budget of [0, 1, 10, 11, MAX_CONTAINER_BUDGET])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({
        ok: true,
      });
    for (const budget of [-1, MAX_CONTAINER_BUDGET + 1, 2.5, "3"])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerBudget: budget } })).toMatchObject({
        ok: false,
      });
  });

  it("keeps the Grace a whole number of days from 0, never (at once is the Owner's Purge, ADR-0043)", () => {
    for (const days of [0, 1, 7, 3650])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: days } })).toMatchObject({ ok: true });
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: 1.5 } })).toEqual({
      ok: false,
      error: "graceDays: an integer",
    });
    for (const days of [-1, 3651, "7", null])
      expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { graceDays: days } })).toMatchObject({ ok: false });
  });

  it("reads a stored Grace that no longer fits as 7 days", () => {
    expect(resolveEnvironment({ revision: 3, settings: { graceDays: -1 } })).toMatchObject({ graceDays: 7 });
    expect(resolveEnvironment({ revision: 3, settings: { graceDays: 30 } })).toMatchObject({ graceDays: 30 });
  });

  it("reads purging turned off before SPI-1387 as a Grace of 0, never, until the Grace is set again", () => {
    const off = { revision: 3, settings: { sweepPurges: false, graceDays: 30 } };
    expect(resolveEnvironment(off).graceDays).toBe(0);
    expect(resolveEnvironment({ revision: 3, settings: { sweepPurges: true, graceDays: 30 } }).graceDays).toBe(30);
    // Another setting's change keeps it; the Grace's own replaces it.
    const other = applyEnvironmentChange(off, { settings: { containerIdleMinutes: 5 } });
    if (!other.ok) throw new Error(other.error);
    expect(resolveEnvironment(other.environment).graceDays).toBe(0);
    const grace = applyEnvironmentChange(off, { settings: { graceDays: 14 } });
    if (!grace.ok) throw new Error(grace.error);
    expect(grace.environment.settings).not.toHaveProperty("sweepPurges");
    expect(resolveEnvironment(grace.environment).graceDays).toBe(14);
  });

  it("refuses a size it does not offer, an unknown setting and an empty change, with the setting named", () => {
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { containerSize: "lite" } })).toEqual({
      ok: false,
      error: "containerSize: one of cpu-1, standard-1, standard-2, standard-3, standard-4, custom",
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

  it("starts the custom size as the Owner's resources, down to Cloudflare's minimums and with no maximum of its own", () => {
    const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
    const applied = set({ containerSize: "custom", customVcpu: 0.25, customMemoryMib: 1024, customDiskMb: 4000 });
    if (!applied.ok) throw new Error(applied.error);
    const resolved = resolveEnvironment(applied.environment);
    expect(containerInstance(resolved.containerSize, customResources(resolved))).toEqual({
      vcpu: 0.25,
      memoryMib: 1024,
      diskMb: 4000,
    });
    // The Builder takes the same custom resources.
    expect(builderInstance(resolved)).toEqual({
      vcpu: 0.25,
      memoryMib: 1024,
      diskMb: 4000,
    });
    expect(set({ customVcpu: 1 / 16, customMemoryMib: 256, customDiskMb: 2000 })).toMatchObject({ ok: true });
    expect(set({ customVcpu: 64, customMemoryMib: 262_144, customDiskMb: 400_000 })).toMatchObject({ ok: true });
    expect(set({ customVcpu: 0.05 })).toEqual({ ok: false, error: "customVcpu: at least 0.0625" });
    expect(set({ customMemoryMib: 255 })).toEqual({ ok: false, error: "customMemoryMib: at least 256" });
    expect(set({ customMemoryMib: 1024.5 })).toEqual({ ok: false, error: "customMemoryMib: a whole number" });
    expect(set({ customDiskMb: 1999 })).toEqual({ ok: false, error: "customDiskMb: at least 2000" });
  });

  it("starts the default for a stored name it does not offer, never an omitted instance (which would start lite)", () => {
    for (const name of ["lite", "basic", "mem-8", "custom-1", "", null, 3, { vcpu: 4 }]) {
      expect(
        containerInstance(resolveEnvironment({ revision: 1, settings: { containerSize: name } }).containerSize),
      ).toBe("standard-3");
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

  it("takes as much as one stored value holds, counting a character by its bytes", () => {
    // Past the old 16 KiB.
    expect(MAX_GLOBAL_MISE_BYTES).toBe(MAX_FILE_SETTING_BYTES);
    expect(MAX_FILE_SETTING_BYTES).toBe(Math.floor(DO_VALUE_BYTES / 3));
    expect(set(`[tools]\n${"# a line\n".repeat(20_000)}`)).toMatchObject({ ok: true });
    const tooLong = `globalMiseConfig: is longer than ${MAX_FILE_SETTING_BYTES} bytes of UTF-8`;
    expect(set("€".repeat(MAX_FILE_SETTING_BYTES / 3 + 1))).toEqual({ ok: false, error: tooLong });
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

describe("the CLI agents' processes per Workspace and the reclaim delay (SPI-1318, SPI-1387)", () => {
  it("derives the processes from the Container's memory: (memory - 1 GiB) / 440 MiB, at least one", () => {
    expect(cliProcessesPerWorkspaceOf(CONTAINER_SIZES["cpu-1"].resources.memoryMib)).toBe(4);
    expect(cliProcessesPerWorkspaceOf(CONTAINER_SIZES["standard-1"].resources.memoryMib)).toBe(6);
    expect(cliProcessesPerWorkspaceOf(CONTAINER_SIZES["standard-2"].resources.memoryMib)).toBe(11);
    expect(cliProcessesPerWorkspaceOf(CONTAINER_SIZES["standard-3"].resources.memoryMib)).toBe(16);
    expect(cliProcessesPerWorkspaceOf(CONTAINER_SIZES["standard-4"].resources.memoryMib)).toBe(25);
    // A custom size smaller than the reserve still runs one.
    expect(cliProcessesPerWorkspaceOf(256)).toBe(1);
  });

  it("follows the Container size the settings set, a custom one's memory included", () => {
    // The default size is standard-3 since SPI-1386.
    expect(cliProcessesPerWorkspace(resolveEnvironment(EMPTY_ENVIRONMENT))).toBe(16);
    const of = (settings: Record<string, unknown>) =>
      cliProcessesPerWorkspace(resolveEnvironment({ revision: 1, settings }));
    expect(of({ containerSize: "standard-3" })).toBe(16);
    expect(of({ containerSize: "custom", customMemoryMib: 12_288 })).toBe(25);
  });

  it("waits a fixed 30 seconds before a CLI agent's idle process may be reclaimed", () => {
    expect(CLI_RECLAIM_SECONDS).toBe(30);
  });
});

describe("the Terminals' holds and counts (SPI-1317, SPI-1387)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
  const holds = ["terminalBusyHoldMinutes", "terminalPromptHoldMinutes"] as const;

  it("hold 30 and 10 minutes by default, 1 to MAX_TIMED_MINUTES whole minutes (ADR-0048 §2)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({
      terminalBusyHoldMinutes: 30,
      terminalPromptHoldMinutes: 10,
    });
    for (const key of holds) {
      for (const minutes of [1, 30, MAX_TIMED_MINUTES]) expect(set({ [key]: minutes })).toMatchObject({ ok: true });
      for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5, "30"])
        expect(set({ [key]: minutes })).toMatchObject({ ok: false });
    }
    expect(
      resolveEnvironment({ revision: 1, settings: { terminalBusyHoldMinutes: 0, terminalPromptHoldMinutes: -1 } }),
    ).toMatchObject({ terminalBusyHoldMinutes: 30, terminalPromptHoldMinutes: 10 });
  });

  it("count and keep fixed values", () => {
    expect(AGENT_TERMINALS_PER_WORKSPACE).toBe(8);
    expect(AGENT_TERMINAL_SCROLLBACK_LINES).toBe(1000);
    // SPI-1391: stock t3's, with the history in storage.
    expect(TERMINAL_HISTORY_KIB).toBe(8 * 1024);
    expect(EXITED_TERMINALS_KEPT).toBe(128);
  });

  it("are down-free, in the Containers row, after the idle time, and state their consequence in Owner words", () => {
    for (const key of holds) {
      expect(ENVIRONMENT_SETTINGS[key]).toMatchObject({ tier: "down-free" });
      expect("row" in ENVIRONMENT_SETTINGS[key]).toBe(false);
      expect(AGENT_SETTING_KEYS as ReadonlyArray<string>).not.toContain(key);
      expect(ENVIRONMENT_SETTINGS[key].description).toContain("keep the Container running, and billed, for this long");
    }
    const keys = Object.keys(ENVIRONMENT_SETTINGS);
    expect(keys.slice(keys.indexOf("containerIdleMinutes"), keys.indexOf("containerIdleMinutes") + 3)).toEqual([
      "containerIdleMinutes",
      ...holds,
    ]);
  });
});

describe("the clone and checkpoint time limits (SPI-1324)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
  const keys = ["cloneMinutes", "checkpointMinutes"] as const;

  it("are off by default (SPI-1386), the Workspace DO's fallbacks, or 1 to MAX_TIMED_MINUTES whole minutes", () => {
    expect(DEFAULT_CLONE_MINUTES).toBe(0);
    expect(DEFAULT_CHECKPOINT_MINUTES).toBe(0);
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({ cloneMinutes: 0, checkpointMinutes: 0 });
    for (const key of keys) {
      for (const minutes of [1, 60, MAX_TIMED_MINUTES]) expect(set({ [key]: minutes })).toMatchObject({ ok: true });
      for (const minutes of [-1, MAX_TIMED_MINUTES + 1, 2.5, "15"])
        expect(set({ [key]: minutes })).toMatchObject({ ok: false });
    }
    expect(resolveEnvironment({ revision: 1, settings: { cloneMinutes: 15, checkpointMinutes: -1 } })).toMatchObject({
      cloneMinutes: 15,
      checkpointMinutes: 0,
    });
  });

  it("are down-free, in the Containers row, after the settings read wait", () => {
    for (const key of keys) {
      expect(ENVIRONMENT_SETTINGS[key]).toMatchObject({ tier: "down-free" });
      expect("row" in ENVIRONMENT_SETTINGS[key]).toBe(false);
      expect(AGENT_SETTING_KEYS as ReadonlyArray<string>).not.toContain(key);
    }
    const order = Object.keys(ENVIRONMENT_SETTINGS);
    expect(order.slice(order.indexOf("containerSetupFailure") + 1, order.indexOf("imageSetup"))).toEqual([...keys]);
  });

  it("each state its consequence once, scoped to its own operations, and the checkpoint limit names its operations", () => {
    expect(ENVIRONMENT_SETTINGS.cloneMinutes.description).toContain(
      "A clone or checkout that runs longer than this fails; while it runs it holds the Container.",
    );
    expect(ENVIRONMENT_SETTINGS.checkpointMinutes.description).toContain(
      "A checkpoint, bundle or carry that runs longer than this fails; while it runs it holds the Container.",
    );
    for (const named of ["a turn's checkpoint and its restore", "carrying a removed worktree's commits home"])
      expect(ENVIRONMENT_SETTINGS.checkpointMinutes.description).toContain(named);
  });
});

describe("the Turn limit (SPI-1315)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is off by default (SPI-1386: stock t3 has none), or 1 to MAX_TIMED_MINUTES (10,080) whole minutes (ADR-0048)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).turnLimitMinutes).toBe(0);
    for (const minutes of [1, 120, 1440, MAX_TIMED_MINUTES])
      expect(set({ turnLimitMinutes: minutes })).toMatchObject({ ok: true });
    for (const minutes of [-1, MAX_TIMED_MINUTES + 1, 2.5, "120"])
      expect(set({ turnLimitMinutes: minutes })).toMatchObject({ ok: false });
    expect(resolveEnvironment({ revision: 1, settings: { turnLimitMinutes: 120 } }).turnLimitMinutes).toBe(120);
    expect(resolveEnvironment({ revision: 1, settings: { turnLimitMinutes: -1 } }).turnLimitMinutes).toBe(0);
  });

  it("is down-free, in the Agents row (AGENT_SETTING_KEYS), and states its consequence once in Owner words", () => {
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes).toMatchObject({ tier: "down-free" });
    expect("row" in ENVIRONMENT_SETTINGS.turnLimitMinutes).toBe(false);
    expect(AGENT_SETTING_KEYS).toEqual(["turnLimitMinutes", "ownerAnswerMinutes"]);
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes.description).toContain(
      "A turn longer than this is ended (a CLI agent's process with it), and the thread shows it failed. Each minute of a turn can spend model tokens and hold a Container.",
    );
    expect(ENVIRONMENT_SETTINGS.turnLimitMinutes.description).toContain(
      "a running turn keeps the limit it started with",
    );
  });
});

describe("how long history is kept (SPI-1323)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("keeps usage records and sessions with no t3flare limit by default (SPI-1386), or 1 to MAX_RETENTION_DAYS (3650) whole days", () => {
    expect(MAX_RETENTION_DAYS).toBe(3650);
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({ usageRetentionDays: 0, piSessionRetentionDays: 0 });
    for (const key of RETENTION_SETTING_KEYS) {
      for (const days of [1, 30, 365, 3650]) expect(set({ [key]: days })).toMatchObject({ ok: true });
      expect(set({ [key]: -1 })).toEqual({ ok: false, error: `${key}: at least 0` });
      expect(set({ [key]: 1.5 })).toEqual({ ok: false, error: `${key}: an integer` });
      for (const days of [3651, "92", null]) expect(set({ [key]: days })).toMatchObject({ ok: false });
    }
    expect(
      resolveEnvironment({ revision: 1, settings: { usageRetentionDays: 92, piSessionRetentionDays: 3651 } }),
    ).toMatchObject({ usageRetentionDays: 92, piSessionRetentionDays: 0 });
  });

  it("is up-free, in a History row of its own (RETENTION_SETTING_KEYS), and says what a change keeps and loses", () => {
    expect(RETENTION_SETTING_KEYS).toEqual(["usageRetentionDays", "piSessionRetentionDays"]);
    for (const key of RETENTION_SETTING_KEYS) {
      expect(ENVIRONMENT_SETTINGS[key]).toMatchObject({ tier: "up-free" });
      expect("row" in ENVIRONMENT_SETTINGS[key]).toBe(false);
      expect(SWEEP_SETTING_KEYS).not.toContain(key);
      expect(AGENT_SETTING_KEYS).not.toContain(key);
    }
    expect(ENVIRONMENT_SETTINGS.usageRetentionDays.description).toContain(
      "Shortening this deletes the older records at the next prune; they cannot be restored.",
    );
    expect(ENVIRONMENT_SETTINGS.usageRetentionDays.description).toContain(
      "records older than that are kept but shown nowhere until t3 widens its window",
    );
    expect(ENVIRONMENT_SETTINGS.piSessionRetentionDays.description).toContain(
      "An older one is deleted at the next Pi start, or by Claude Code at its next start; t3 can no longer resume that thread's conversation.",
    );
    expect(ENVIRONMENT_SETTINGS.usageRetentionDays.description).toContain(
      "Empty or 0 is off: they are kept for good, as local t3 keeps them.",
    );
    expect(ENVIRONMENT_SETTINGS.piSessionRetentionDays.description).toContain(
      "Empty or 0 is off: each agent keeps its own way, Pi for good and Claude Code for its own 30 days.",
    );
    for (const key of RETENTION_SETTING_KEYS)
      expect(ENVIRONMENT_SETTINGS[key].description).toContain("At most 3650 (ten years).");
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

  it("sets a CLI process's MCP tool timeout: two waits, the MCP call time limit and 30 s (cliToolTimeoutSec)", () => {
    expect(cliToolTimeoutSec(DEFAULT_OWNER_ANSWER_MS, 270_000)).toBe(1500);
    expect(cliToolTimeoutSec(30 * 60_000, 270_000)).toBe(3900);
    expect(cliToolTimeoutSec(60_000, 270_000)).toBe(420);
    expect(cliToolTimeoutSec(1500, 270_000)).toBe(304);
    // An off call time limit (0, the default, SPI-1386) gives the call the off deadline, a week.
    expect(DEFAULT_MCP_CALL_MS).toBe(0);
    expect(cliToolTimeoutSec(DEFAULT_OWNER_ANSWER_MS, DEFAULT_MCP_CALL_MS)).toBe(1200 + MAX_TIMED_SECONDS + 30);
    // A longer call time limit lengthens the CLI's own timeout with it (SPI-1359).
    expect(cliToolTimeoutSec(DEFAULT_OWNER_ANSWER_MS, 3600_000)).toBe(1200 + 3600 + 30);
  });
});

describe("the MCP calls' time limit (SPI-1359)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is off by default: the time limit off or 1 s to a week (ADR-0048 §2)", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({ mcpCallSeconds: 0 });
    for (const seconds of [1, 270, MAX_TIMED_SECONDS])
      expect(set({ mcpCallSeconds: seconds })).toMatchObject({ ok: true });
    for (const seconds of [-1, MAX_TIMED_SECONDS + 1, 2.5, "270"])
      expect(set({ mcpCallSeconds: seconds })).toMatchObject({ ok: false });
  });

  it("is down-free, in an MCP calls row of its own, and states its consequence", () => {
    expect(MCP_CALL_SETTING_KEYS).toEqual(["mcpCallSeconds"]);
    expect(ENVIRONMENT_SETTINGS.mcpCallSeconds).toMatchObject({ tier: "down-free" });
    expect(ENVIRONMENT_SETTINGS.mcpCallSeconds.description).toContain("it may have run on the server");
  });
});

describe("the MCP layer's connect and listing time limits (SPI-1363)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
  const KEYS = ["mcpConnectSeconds", "mcpListSeconds"] as const;

  it("keep their defaults (the connect limit 30 s, SPI-1386), whole numbers from 1 to their maximum, named in the description", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({
      mcpConnectSeconds: 30,
      mcpListSeconds: 120,
    });
    expect(ENVIRONMENT_SETTINGS.mcpConnectSeconds.schema.maximum).toBe(MAX_TIMED_SECONDS);
    expect(ENVIRONMENT_SETTINGS.mcpListSeconds.schema.maximum).toBe(MAX_TIMED_SECONDS);
    for (const key of KEYS) {
      const { maximum } = ENVIRONMENT_SETTINGS[key].schema;
      expect(set({ [key]: maximum })).toMatchObject({ ok: true });
      for (const bad of [0, maximum + 1, 1.5]) expect(set({ [key]: bad })).toMatchObject({ ok: false });
      expect(ENVIRONMENT_SETTINGS[key].description).toContain(`At most ${maximum}`);
      expect(ENVIRONMENT_SETTINGS[key]).toMatchObject({ tier: "down-free" });
    }
    // The longest time limit stays under a JS timer's 2^31 - 1 ms.
    expect(MAX_TIMED_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
  });

  it("are in an MCP servers row of their own, apart from the MCP calls row", () => {
    expect(MCP_SERVER_SETTING_KEYS).toEqual([...KEYS]);
    for (const key of MCP_SERVER_SETTING_KEYS) expect(MCP_CALL_SETTING_KEYS).not.toContain(key);
  });
});

describe("the housekeeping waits and counts (SPI-1366)", () => {
  const KEYS = [...LIFECYCLE_SETTING_KEYS, "textGenerationSeconds"] as const;

  it("keep today's values by default, whole numbers from 1 to their maximum", () => {
    const resolved = resolveEnvironment(EMPTY_ENVIRONMENT);
    expect(Object.fromEntries(KEYS.map((key) => [key, resolved[key]]))).toEqual({
      idleAfterSeconds: 60,
      prWatchWakeMinutes: 10,
      textGenerationSeconds: 180,
    });
    for (const key of KEYS) {
      const schema = ENVIRONMENT_SETTINGS[key].schema;
      expect(fitsEnvironmentSetting(key, 0)).toBe(false);
      expect(fitsEnvironmentSetting(key, 1.5)).toBe(false);
      expect(fitsEnvironmentSetting(key, schema.maximum)).toBe(true);
      expect(fitsEnvironmentSetting(key, schema.maximum + 1)).toBe(false);
      // Each description names its maximum, from the constant (ADR-0048).
      expect(ENVIRONMENT_SETTINGS[key].description).toContain(`At most ${schema.maximum}`);
    }
  });

  it("time t3flare's own waits under the shared sanity maximum", () => {
    expect(ENVIRONMENT_SETTINGS.idleAfterSeconds.schema.maximum).toBe(MAX_TIMED_SECONDS);
    expect(ENVIRONMENT_SETTINGS.prWatchWakeMinutes.schema.maximum).toBe(MAX_TIMED_MINUTES);
    // The Environment's wait for text generation stays under a JS timer's 2^31 - 1 ms at the maximum.
    expect(MAX_TIMED_SECONDS * 1000 + TEXT_GENERATION_MARGIN_MS).toBeLessThan(2 ** 31 - 1);
    expect(DEFAULT_TEXT_GENERATION_SECONDS * 1000 + TEXT_GENERATION_MARGIN_MS).toBe(190_000);
  });

  it("each state a consequence, and each is read at its next use, never at a Container start", () => {
    for (const key of KEYS) {
      expect(ENVIRONMENT_SETTINGS[key].description).toMatch(/Applies (at|to) /);
      expect(ENVIRONMENT_SETTINGS[key]).not.toHaveProperty("row");
    }
    for (const key of [...OUTSIDE_REQUEST_SETTING_KEYS, ...LIFECYCLE_SETTING_KEYS])
      expect(NEXT_USE_SETTING_KEYS).toContain(key);
  });
});

describe("the settings read wait (SPI-1314, SPI-1387)", () => {
  it("is a fixed 5 seconds", () => {
    expect(SETTINGS_READ_MS).toBe(5000);
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

  it("takes a script past the old 256 KiB, up to MAX_SETUP_BYTES of UTF-8", () => {
    expect(set({ containerSetup: "x".repeat(1024 * 1024) })).toMatchObject({ ok: true });
    expect(set({ containerSetup: "x".repeat(MAX_SETUP_BYTES + 1) })).toEqual({
      ok: false,
      error: `containerSetup: is longer than ${MAX_SETUP_BYTES} bytes of UTF-8`,
    });
  });

  it("takes a time limit of 1 to MAX_TIMED_MINUTES (10,080) minutes", () => {
    for (const minutes of [1, 60, 61, MAX_TIMED_MINUTES])
      expect(set({ containerSetupMinutes: minutes })).toMatchObject({ ok: true });
    for (const minutes of [0, MAX_TIMED_MINUTES + 1, 2.5])
      expect(set({ containerSetupMinutes: minutes })).toMatchObject({ ok: false });
  });

  it("keeps a fixed 32 KiB of a setup's output, under a third of one Durable Object value", () => {
    expect(SETUP_OUTPUT_KIB).toBe(32);
    expect(MAX_SETUP_OUTPUT_KIB).toBe(Math.floor(DO_VALUE_BYTES / 3 / 1024));
    expect(SETUP_OUTPUT_KIB).toBeLessThan(MAX_SETUP_OUTPUT_KIB);
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
  it("keeps the Image setup a file, bounded by the one stored value the Environment settings are", () => {
    expect(MAX_SETUP_BYTES).toBe(MAX_FILE_SETTING_BYTES);
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "apt-get install -y jq\r\n" } }),
    ).toMatchObject({
      ok: true,
      changed: ["imageSetup"],
      environment: { settings: { imageSetup: "apt-get install -y jq\n" } },
    });
    // Past the old 256 KiB.
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "x".repeat(1024 * 1024) } }),
    ).toMatchObject({ ok: true });
    expect(
      applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: "x".repeat(MAX_SETUP_BYTES + 1) } }),
    ).toEqual({ ok: false, error: `imageSetup: is longer than ${MAX_SETUP_BYTES} bytes of UTF-8` });
  });

  it("refuses a change whose settings together would not fit one stored value, naming the bound", () => {
    const big = "x".repeat(1_000_000);
    const first = applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { imageSetup: big, containerSetup: big } });
    if (!first.ok) throw new Error(first.error);
    expect(storedBytes(first.environment)).toBeLessThanOrEqual(DO_VALUE_BYTES);
    const over = applyEnvironmentChange(first.environment, { settings: { globalMiseConfig: big } });
    expect(over).toMatchObject({ ok: false });
    expect(over.ok ? "" : over.error).toMatch(
      new RegExp(
        `^the Environment settings would take \\d+ bytes stored, past the ${DO_VALUE_BYTES} one Durable Object value holds$`,
      ),
    );
  });

  it("bounds the time limits and the scheduled rebuild", () => {
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
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { builderInBudget: true } })).toMatchObject({
      ok: true,
      changed: ["builderInBudget"],
    });
  });

  it("starts the Builder at the Container size, a Builder size stored before SPI-1387 ignored", () => {
    const settings = (stored: Record<string, unknown>) => resolveEnvironment({ revision: 1, settings: stored });
    expect(builderInstance(settings({ containerSize: "standard-3" }))).toBe("standard-3");
    expect(builderInstance(settings({}))).toBe("standard-3");
    expect(builderInstance(settings({ containerSize: "cpu-1" }))).toEqual(containerInstance("cpu-1"));
    expect(builderInstance(settings({ containerSize: "standard-1", builderSize: "standard-4" }))).toBe("standard-1");
  });

  it("names the settings a Base build reads", () => {
    expect(BASE_BUILD_SETTING_KEYS).toEqual([
      "imageSetup",
      "imageSetupMinutes",
      "snapshotMinutes",
      "builderInBudget",
      "rebuildEveryDays",
    ]);
  });
});

describe("the Workspace's command limits, Terminals, previews and what it keeps (SPI-1364)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
  const grouped = [...COMMAND_SETTING_KEYS, ...CONTAINER_PREVIEW_SETTING_KEYS];

  it("each new setting is in exactly one row group, none joins another row, and none is an agent or Sweep setting", () => {
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const key of grouped) {
      expect("row" in ENVIRONMENT_SETTINGS[key], key).toBe(false);
      expect(AGENT_SETTING_KEYS as ReadonlyArray<string>).not.toContain(key);
      expect(SWEEP_SETTING_KEYS as ReadonlyArray<string>).not.toContain(key);
      expect(RETENTION_SETTING_KEYS as ReadonlyArray<string>).not.toContain(key);
    }
  });

  it("names the preview ports as applying at their next use, not at a Container start", () => {
    expect(NEXT_USE_SETTING_KEYS as ReadonlyArray<string>).toContain("previewPorts");
  });

  it("the integers take their bounds and refuse a value past them, and a stored one out of bounds reads as the default", () => {
    for (const key of grouped) {
      const schema = ENVIRONMENT_SETTINGS[key].schema;
      if (schema.type !== "integer") continue;
      for (const value of [schema.minimum, schema.default, schema.maximum])
        expect(set({ [key]: value }), key).toMatchObject({ ok: true });
      for (const value of [schema.minimum - 1, schema.maximum + 1, 1.5, String(schema.default)])
        expect(set({ [key]: value }), key).toMatchObject({ ok: false });
      expect(resolveEnvironment({ revision: 1, settings: { [key]: schema.maximum + 1 } })[key], key).toBe(
        schema.default,
      );
    }
  });

  it("every time limit's maximum fits a JS timer (2^31 - 1 ms)", () => {
    const ms: Readonly<Record<string, number>> = {
      commandMinutes: 60_000,
      containerConnectSeconds: 1000,
    };
    for (const [key, unit] of Object.entries(ms)) {
      const schema = ENVIRONMENT_SETTINGS[key as keyof typeof ENVIRONMENT_SETTINGS].schema;
      if (schema.type !== "integer") throw new Error(key);
      // The skills wait's exec deadline adds a margin (skillSetTake.ts); it stays under too.
      expect(schema.maximum * unit + 60_000, key).toBeLessThan(2 ** 31 - 1);
    }
  });

  it("the preview ports are a list of at most MAX_PREVIEW_PORTS (Browser Run's eight hosts), never t3flare's own", () => {
    expect(MAX_PREVIEW_PORTS).toBe(8);
    expect(RESERVED_CONTAINER_PORTS).toEqual([8080, 17_781]);
    const stored = (value: unknown) => {
      const answer = set({ previewPorts: value });
      return answer.ok ? answer.environment.settings.previewPorts : answer.error;
    };
    // Typed as text on the page: read as numbers, sorted, each once.
    expect(stored("5173, 3000 3002,3000")).toEqual([3000, 3002, 5173]);
    expect(stored([4200])).toEqual([4200]);
    expect(stored("3000, 8080")).toBe("previewPorts: not 8080, which t3flare uses itself");
    expect(stored("17781")).toBe("previewPorts: not 17781, which t3flare uses itself");
    expect(stored("1 2 3 4 5 6 7 8 9")).toBe("previewPorts: at most 8 ports");
    expect(stored("")).toBe("previewPorts: a list of at least one port");
    expect(stored("3000, http")).toBe("previewPorts: ports from 1 to 65535, not http");
    expect(stored("70000")).toBe("previewPorts: ports from 1 to 65535, not 70000");
    expect(resolveEnvironment({ revision: 1, settings: { previewPorts: [8080] } }).previewPorts).toEqual([
      3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787,
    ]);
  });

  it("each states its consequence and when it applies", () => {
    for (const key of grouped) {
      const description = ENVIRONMENT_SETTINGS[key].description;
      expect(description, key).toMatch(/Applies (at|to|when|from)/);
    }
    expect(ENVIRONMENT_SETTINGS.commandMinutes.description).toContain(
      "A command that runs longer than this is ended and fails; while it runs it holds the Container.",
    );
    expect(ENVIRONMENT_SETTINGS.previewPorts.description).toContain("At most 8, and never 8080 or 17781");
  });
});

describe("local parity by default (SPI-1386)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });
  /** The guardrails a new Environment has off (0 or an empty field: no limit), each opted into with a value. */
  const OFF_BY_DEFAULT = [
    "containerBudget",
    "turnLimitMinutes",
    "cloneMinutes",
    "checkpointMinutes",
    "usageRetentionDays",
    "piSessionRetentionDays",
    "mcpCallSeconds",
    "commandMinutes",
  ] as const;

  it("resolves a new Environment to the Owner-approved defaults", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT)).toMatchObject({
      containerSize: "standard-3",
      // The custom size's fields follow the default size.
      customVcpu: 2,
      customMemoryMib: 8192,
      customDiskMb: 16_000,
      containerBudget: 0,
      turnLimitMinutes: 0,
      cloneMinutes: 0,
      checkpointMinutes: 0,
      usageRetentionDays: 0,
      piSessionRetentionDays: 0,
      mcpCallSeconds: 0,
      commandMinutes: 0,
      mcpConnectSeconds: 30,
      textGenerationSeconds: 180,
      containerConnectSeconds: 120,
      // Kept on (the Owner's decision): the Terminal holds and the setup scripts' time limits.
      terminalBusyHoldMinutes: 30,
      terminalPromptHoldMinutes: 10,
      globalMiseInstallMinutes: 10,
      containerSetupMinutes: 5,
      imageSetupMinutes: 30,
    });
    expect(DEFAULT_TEXT_GENERATION_SECONDS).toBe(180);
  });

  it("takes 0 as off for each guardrail that has it, and any value from its least to its maximum as a limit", () => {
    for (const key of OFF_BY_DEFAULT) {
      const schema = ENVIRONMENT_SETTINGS[key].schema;
      expect(schema, key).toMatchObject({ type: "integer", minimum: 0, off: true, default: 0 });
      expect(set({ [key]: 0 }), key).toMatchObject({ ok: true, changed: [] });
      expect(applyEnvironmentChange({ revision: 1, settings: { [key]: 5 } }, { settings: { [key]: 0 } }), key).toEqual({
        ok: true,
        environment: { revision: 2, settings: { [key]: 0 } },
        changed: [key],
      });
      expect(set({ [key]: 1 }), key).toMatchObject({ ok: true });
      expect(set({ [key]: schema.maximum }), key).toMatchObject({ ok: true });
      for (const bad of [-1, schema.maximum + 1, 1.5, "5", null])
        expect(set({ [key]: bad }), `${key} ${String(bad)}`).toMatchObject({ ok: false });
      expect(fitsEnvironmentSetting(key, 0), key).toBe(true);
      expect(ENVIRONMENT_SETTINGS[key].description, key).toContain("Empty or 0 is off");
    }
  });

  it("makes an off time limit the off deadline in one place, a set one its value in ms", () => {
    expect(OFF_DEADLINE_MS).toBe(MAX_TIMED_MINUTES * 60_000);
    expect(OFF_DEADLINE_MS).toBeLessThan(2 ** 31 - 1);
    expect(offDeadlineMs(0)).toBe(OFF_DEADLINE_MS);
    expect(offDeadlineMs(5_000)).toBe(5_000);
    expect(deadlineMs(0, 60_000)).toBe(OFF_DEADLINE_MS);
    expect(deadlineMs(2, 60_000)).toBe(120_000);
    expect(deadlineMs(270, 1000)).toBe(270_000);
  });

  it("keeps a value an Environment stored: only the defaults move", () => {
    const stored = {
      containerSize: "cpu-1",
      customVcpu: 1,
      containerBudget: 3,
      turnLimitMinutes: 120,
      cloneMinutes: 15,
      checkpointMinutes: 10,
      usageRetentionDays: 92,
      piSessionRetentionDays: 60,
      mcpCallSeconds: 270,
      commandMinutes: 2,
      mcpConnectSeconds: 15,
      textGenerationSeconds: 110,
      containerConnectSeconds: 60,
    };
    expect(resolveEnvironment({ revision: 9, settings: stored })).toMatchObject(stored);
  });
});

describe("the values that became named constants (SPI-1387, ADR-0049 §3)", () => {
  const REMOVED = [
    "terminalsPerWorkspace",
    "agentTerminalsPerWorkspace",
    "agentTerminalScrollbackLines",
    "cliProcessesPerWorkspace",
    "cliReclaimSeconds",
    "settingsReadSeconds",
    "setupOutputKiB",
    "builderSize",
    "baseRetryMinutes",
    "sweepPurges",
    "outsideRequestSeconds",
    "skillsDirectoryEntries",
    "skillsLinkEntries",
    "promptsDirectoryEntries",
    "mcpResultKiB",
    "mcpPausesPerCall",
    "mcpLogEntries",
    "mcpProgressPerSecond",
    "mcpLegacyRecheckHours",
    "cliMcpStartSeconds",
    "mcpSignInMinutes",
    "githubRetrySeconds",
    "remoteRetryMinutes",
    "safeModeAfterFailures",
    "browserProfileSaveSeconds",
    "htmlBrowserKeepAliveSeconds",
    "pageTokenHours",
    "clientsPerKey",
    "connectPublishLogKept",
    "durableRetries",
    "cliRetries",
    "killAttempts",
    "traceKiB",
    "traceFiles",
    "tempFilesHours",
    "gitReadsKept",
    "routerTraceEntries",
    "reclaimProtectionSeconds",
    "skillsWaitSeconds",
    "abortGraceSeconds",
    "portStopGraceSeconds",
    "firstPromptSeconds",
    "terminalHistoryKiB",
    "exitedTerminalsKept",
    "portProbeMs",
  ];

  it("are no longer settings", () => {
    for (const key of REMOVED) expect(Object.keys(ENVIRONMENT_SETTINGS), key).not.toContain(key);
  });

  it("ignores a value stored for one on resolve, and a change beside it is not refused", () => {
    // Purging on (`sweepPurges: true`) folds into the Grace as it stands; off is read above.
    const stored = {
      revision: 3,
      settings: Object.fromEntries(REMOVED.map((key) => [key, key === "sweepPurges" ? true : 1])),
    };
    const resolved: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
    for (const key of REMOVED) expect(resolved, key).not.toHaveProperty(key);
    expect(resolveEnvironment(stored)).toEqual({ ...resolveEnvironment(EMPTY_ENVIRONMENT), revision: 3 });
    const changed = applyEnvironmentChange(stored, { settings: { containerIdleMinutes: 5 } });
    expect(changed).toMatchObject({ ok: true, changed: ["containerIdleMinutes"] });
  });

  it("refuses a change that sets one, naming it", () => {
    expect(applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings: { sweepPurges: false } })).toEqual({
      ok: false,
      error: "sweepPurges: no such setting",
    });
  });

  it("keep the values the Owner approved", () => {
    expect(OUTSIDE_REQUEST_SECONDS).toBe(30);
    expect(STOP_GRACE_SECONDS).toBe(3);
  });
});

describe("the Grace (ADR-0043, SPI-1387)", () => {
  const set = (settings: Record<string, unknown>) => applyEnvironmentChange(EMPTY_ENVIRONMENT, { settings });

  it("is 7 days by default, 0 (never purge) to MAX_GRACE_DAYS, and its description says 0 is never", () => {
    expect(resolveEnvironment(EMPTY_ENVIRONMENT).graceDays).toBe(7);
    for (const days of [0, 1, 3650]) expect(set({ graceDays: days })).toMatchObject({ ok: true });
    for (const days of [-1, 3651, 1.5]) expect(set({ graceDays: days })).toMatchObject({ ok: false });
    expect(ENVIRONMENT_SETTINGS.graceDays.description).toContain("0 is never");
  });
});
