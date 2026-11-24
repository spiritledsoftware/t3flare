// T-tier (plan §5, D5): every extension switch and setting, every `McpChange` shape, every Environment key and every
// skills op has an expected Change tier; a registry entry or key added without a row here fails the coverage checks.
import { describe, expect, it } from "vitest";

import { EMPTY_ENVIRONMENT, ENVIRONMENT_SETTINGS, type EnvironmentKey, type StoredEnvironment } from "./environment.ts";
import type { FieldSchema } from "./fields.ts";
import {
  applyChange,
  applyMcpChange,
  applyToolsChange,
  EMPTY_HARNESS,
  EXTENSIONS,
  SETTINGS_SERVER,
  type StoredHarness,
  type ToolsChange,
} from "./index.ts";
import { type McpTierChange, type SkillsTierChange, tierOf } from "./tiers.ts";

/**
 * Each extension's switch: `switch` (off to on asked, on to off free), `guard` (both asked), `unchangeable`, or `tools`
 * (no switch: on while any of its tools is not hidden, so its tools' Exposures are its switch).
 */
const SWITCHES: Readonly<Record<string, "switch" | "guard" | "unchangeable" | "tools">> = {
  codemode: "tools",
  "tool-search": "tools",
  "coding-tools": "tools",
  "tool-output": "unchangeable",
  "prompt-suggestions": "unchangeable",
  files: "tools",
  "ask-user": "tools",
  web: "tools",
  todo: "tools",
  context: "tools",
  termctrl: "tools",
  guardian: "guard",
  advisor: "switch",
  skills: "switch",
  permissions: "unchangeable",
  "project-context": "unchangeable",
};

/**
 * Each extension setting's rule: `free`, `down-free`, `up-free`, or `asked` (a Guard's settings and any without a
 * declared tier).
 */
const SETTINGS: Readonly<Record<string, "free" | "down-free" | "up-free" | "asked">> = {
  // SPI-1368: no ceiling, and a larger budget puts more in every prompt.
  "codemode.inlineBudget": "down-free",
  // SPI-1364: a larger budget lets a script spend more of the sandbox's CPU, near the most resetting it.
  "codemode.interruptBudget": "down-free",
  "web.searchModel": "asked",
  // SPI-1321: more output puts more text in front of agents, and web_search spends model requests.
  "web.fetchTimeoutSeconds": "down-free",
  "web.fetchMaxTimeoutSeconds": "down-free",
  "web.fetchMaxKiB": "down-free",
  // SPI-1368: more redirects spend more of a turn's subrequests; a longer title takes more stored history.
  "web.fetchRedirects": "down-free",
  "web.fetchTitleCharacters": "down-free",
  "web.searchResults": "down-free",
  "web.searchesPerCall": "down-free",
  "web.searchSummaryTokens": "down-free",
  "web.searchTimeoutSeconds": "down-free",
  // SPI-1362: more of what the model and the small model read; waits change neither spend nor what is seen.
  "web.searchContextCharacters": "down-free",
  "tool-output.outputKiB": "down-free",
  "tool-output.outputLines": "down-free",
  "context.previewCharacters": "down-free",
  "termctrl.startWaitMs": "free",
  "termctrl.inputWaitMs": "free",
  "termctrl.pollWaitMs": "free",
  "termctrl.scrollbackLines": "down-free",
  "termctrl.scrollbackKiB": "down-free",
  "guardian.batchArgumentCharacters": "asked",
  "prompt-suggestions.excerptCharacters": "down-free",
  "prompt-suggestions.timeoutSeconds": "free",
  "files.lsLimit": "down-free",
  "files.findLimit": "down-free",
  "files.grepLimit": "down-free",
  "project-context.maxFileCharacters": "down-free",
  "context.rolloverOnCompaction": "free",
  "termctrl.backgroundBash": "down-free",
  "termctrl.cols": "free",
  "termctrl.rows": "free",
  "termctrl.quietMs": "free",
  "termctrl.stopGraceSeconds": "free",
  "guardian.model": "asked",
  "guardian.thinkingLevel": "asked",
  "guardian.tools": "asked",
  "guardian.commands": "asked",
  "guardian.policy": "asked",
  "guardian.reviewTimeoutSeconds": "asked",
  "advisor.model": "asked",
  "advisor.reviewEvery": "asked",
  "advisor.thinkingLevel": "asked",
  "advisor.correctiveTurns": "down-free",
  // SPI-1320: more spends model requests and puts more text in front of the agent; a longer cooldown only narrows; the
  // catch-up changes neither spend nor what the agent sees.
  "advisor.reviewTimeoutSeconds": "down-free",
  "advisor.maxFindings": "down-free",
  "advisor.maxNits": "down-free",
  "advisor.maxToolRounds": "down-free",
  "advisor.concernCooldownTurns": "up-free",
  "advisor.catchUpBacklog": "free",
  "advisor.catchUpWaitSeconds": "free",
};

/** Each Environment key: from, to, and the expected tier; `down` is the same key moved the other way. */
const ENVIRONMENT: Readonly<
  Record<
    EnvironmentKey,
    {
      readonly up: readonly [unknown, unknown, "free" | "asked"];
      readonly down: readonly [unknown, unknown, "free" | "asked"];
    }
  >
> = {
  containerSize: { up: ["cpu-1", "standard-4", "asked"], down: ["standard-4", "standard-1", "asked"] },
  // SPI-1365: a custom size's resources are asked either way, as the size is (cost one way, a start refused the other).
  customVcpu: { up: [1, 2, "asked"], down: [2, 0.5, "asked"] },
  // SPI-1366: a longer wait or limit holds what waits, and spends; a shorter wake boots more often.
  textGenerationSeconds: { up: [110, 300, "asked"], down: [110, 60, "free"] },
  idleAfterSeconds: { up: [60, 120, "asked"], down: [60, 30, "free"] },
  prWatchWakeMinutes: { up: [10, 20, "free"], down: [10, 5, "asked"] },
  // SPI-1363: a longer wait holds a dead or slow server longer.
  mcpConnectSeconds: { up: [15, 30, "asked"], down: [15, 5, "free"] },
  mcpListSeconds: { up: [120, 300, "asked"], down: [120, 60, "free"] },
  // SPI-1365: more listed puts more in front of the model, so it is asked.
  repoSkillsListed: { up: [100, 200, "asked"], down: [200, 100, "free"] },
  customMemoryMib: { up: [3072, 8192, "asked"], down: [8192, 1024, "asked"] },
  customDiskMb: { up: [12_000, 16_000, "asked"], down: [16_000, 4000, "asked"] },
  containerIdleMinutes: { up: [2, 30, "asked"], down: [30, 2, "free"] },
  // SPI-1317: a longer Terminal hold keeps the Container running, and billed, longer, so it is asked.
  terminalBusyHoldMinutes: { up: [30, 60, "asked"], down: [30, 5, "free"] },
  terminalPromptHoldMinutes: { up: [10, 30, "asked"], down: [10, 5, "free"] },
  containerBudget: { up: [3, 0, "asked"], down: [0, 2, "free"] },
  // SPI-1315: a shorter Turn limit only narrows; a longer one spends model tokens and Container time, so it is asked.
  turnLimitMinutes: { up: [120, 0, "asked"], down: [0, 60, "free"] },
  // SPI-1316: a shorter Answer wait only narrows; a longer one holds a turn, and its Container, longer, so it is asked.
  ownerAnswerMinutes: { up: [10, 30, "asked"], down: [10, 5, "free"] },
  variables: {
    up: [[], [{ name: "A", value: "1", secret: false }], "asked"],
    down: [[{ name: "A", value: "1", secret: false }], [], "asked"],
  },
  globalMiseConfig: { up: ["", "[tools]\nnode = '24'\n", "asked"], down: ["[tools]\nnode = '24'\n", "", "asked"] },
  // A shorter install bound only narrows; a longer one spends Container time, so it is asked.
  globalMiseInstallMinutes: { up: [10, 30, "asked"], down: [10, 5, "free"] },
  // ADR-0047 §9: a lowered Container setup time limit is free; every other Container setup change is asked.
  containerSetup: {
    up: ["", "apt-get install -y ripgrep\n", "asked"],
    down: ["apt-get install -y ripgrep\n", "", "asked"],
  },
  containerSetupMinutes: { up: [5, 10, "asked"], down: [10, 5, "free"] },
  containerSetupFailure: { up: ["carryOn", "refuse", "asked"], down: ["refuse", "carryOn", "asked"] },
  // SPI-1324: a shorter clone or checkpoint limit only narrows; a longer one holds the Container longer, so it is asked.
  cloneMinutes: { up: [15, 0, "asked"], down: [0, 5, "free"] },
  checkpointMinutes: { up: [10, 30, "asked"], down: [10, 3, "free"] },
  // ADR-0047 §9: turning one on puts the Owner's dotfiles (text, hooks) in front of agents, so it is asked.
  terminalsReadBashrc: { up: [false, true, "asked"], down: [true, false, "free"] },
  agentsReadDotfiles: { up: [false, true, "asked"], down: [true, false, "free"] },
  // ADR-0043 §6: shortening the Grace destroys sooner, so it is asked; 0 is never, the longest (SPI-1387).
  graceDays: { up: [7, 30, "free"], down: [7, 1, "asked"] },
  // SPI-1323: a shorter history deletes records and sessions, so it is asked; a longer one is free.
  usageRetentionDays: { up: [92, 0, "free"], down: [0, 30, "asked"] },
  piSessionRetentionDays: { up: [60, 365, "free"], down: [60, 30, "asked"] },
  // SPI-1359: a longer MCP call is asked; a shorter one is free.
  mcpCallSeconds: { up: [270, 0, "asked"], down: [0, 60, "free"] },
  // SPI-1364: a longer command limit or start wait holds the Container longer, so it is asked.
  commandMinutes: { up: [2, 0, "asked"], down: [0, 1, "free"] },
  containerConnectSeconds: { up: [60, 120, "asked"], down: [60, 30, "free"] },
  // SPI-1364: which Container ports a preview browser reaches, asked either way.
  previewPorts: { up: [[3000], [3000, 3002], "asked"], down: [[3000, 3002], [3000], "asked"] },
  // ADR-0047 §9 (SPI-1332): a lowered time limit is free; the script, the Builder's budget and the schedule asked.
  imageSetup: { up: ["", "apt-get install -y jq\n", "asked"], down: ["apt-get install -y jq\n", "", "asked"] },
  imageSetupMinutes: { up: [30, 60, "asked"], down: [30, 10, "free"] },
  snapshotMinutes: { up: [5, 10, "asked"], down: [5, 2, "free"] },
  builderInBudget: { up: [false, true, "asked"], down: [true, false, "asked"] },
  rebuildEveryDays: { up: [0, 7, "asked"], down: [7, 0, "asked"] },
  // ADR-0047 §6 (SPI-1333): what a start does while a Base build runs is the Owner's policy, asked either way.
  whileBuilding: { up: ["lastGood", "wait", "asked"], down: ["wait", "lastGood", "asked"] },
  whileBuildingNewImage: { up: ["wait", "image", "asked"], down: ["image", "wait", "asked"] },
};

/** Two values of `schema` with `low` below `high` where that has a meaning (a boolean's false, a smaller integer). */
const twoValues = (schema: FieldSchema): readonly [unknown, unknown] => {
  switch (schema.type) {
    case "boolean":
      return [false, true];
    case "integer":
    case "number":
      return [schema.minimum, schema.minimum + 1];
    case "enum":
      return [schema.values[0], schema.values[1]];
    case "text":
    case "file":
      return ["", "x"];
  }
};

const withExtension = (extension: string, enabled?: boolean, settings?: Record<string, unknown>): StoredHarness => {
  const applied = applyChange(EMPTY_HARNESS, {
    extension,
    ...(enabled === undefined ? {} : { enabled }),
    ...(settings === undefined ? {} : { settings }),
  });
  if (!applied.ok) throw new Error(applied.error);
  return applied.harness;
};

const tier = (input: Parameters<typeof tierOf>[0]) => tierOf(input).tier;

describe("tierOf: extensions", () => {
  it("covers every extension switch and every extension setting in the registry", () => {
    expect(Object.keys(SWITCHES).sort()).toEqual(EXTENSIONS.map((entry) => entry.id).sort());
    expect(Object.keys(SETTINGS).sort()).toEqual(
      EXTENSIONS.flatMap((entry) => Object.keys(entry.settings).map((key) => `${entry.id}.${key}`)).sort(),
    );
  });

  it("each switch: off to on asked; on to off free, asked for a Guard; an unchangeable switch stays refused", () => {
    for (const entry of EXTENSIONS) {
      const rule = SWITCHES[entry.id]!;
      if (rule === "unchangeable" || rule === "tools") {
        expect(applyChange(EMPTY_HARNESS, { extension: entry.id, enabled: false }).ok, entry.id).toBe(false);
        continue;
      }
      expect(
        tier({
          entity: "extension",
          stored: withExtension(entry.id, false),
          change: { extension: entry.id, enabled: true },
        }),
        entry.id,
      ).toBe("asked");
      expect(
        tier({
          entity: "extension",
          stored: withExtension(entry.id, true),
          change: { extension: entry.id, enabled: false },
        }),
        entry.id,
      ).toBe(rule === "guard" ? "asked" : "free");
    }
  });

  it("an extension with tools has no switch: its tools' Exposures turn it on and off", () => {
    for (const entry of EXTENSIONS.filter((each) => SWITCHES[each.id] === "tools")) {
      expect(entry.tools?.length, entry.id).toBeGreaterThan(0);
      expect(applyChange(EMPTY_HARNESS, { extension: entry.id, enabled: false })).toEqual({
        ok: false,
        error: `${entry.id}: on while any of its tools is not hidden; set its tools' Exposure instead`,
      });
    }
  });

  it("each setting follows its rule in both directions", () => {
    for (const entry of EXTENSIONS) {
      for (const [key, setting] of Object.entries(entry.settings)) {
        const name = `${entry.id}.${key}`;
        const [low, high] = twoValues(setting.schema);
        const up = tier({
          entity: "extension",
          stored: withExtension(entry.id, undefined, { [key]: low }),
          change: { extension: entry.id, settings: { [key]: high } },
        });
        const down = tier({
          entity: "extension",
          stored: withExtension(entry.id, undefined, { [key]: high }),
          change: { extension: entry.id, settings: { [key]: low } },
        });
        const rule = SETTINGS[name];
        expect([name, up, down]).toEqual([
          name,
          rule === "free" || rule === "up-free" ? "free" : "asked",
          rule === "free" || rule === "down-free" ? "free" : "asked",
        ]);
      }
    }
  });

  it("a setting with no declared tier is asked; a Guard's settings are asked whatever their own rule", () => {
    for (const entry of EXTENSIONS) {
      for (const [key, setting] of Object.entries(entry.settings)) {
        if (setting.tier === undefined || entry.guard === true)
          expect(SETTINGS[`${entry.id}.${key}`], `${entry.id}.${key}`).toBe("asked");
      }
    }
    expect(EXTENSIONS.filter((entry) => entry.guard === true).map((entry) => entry.id)).toEqual([
      "guardian",
      "permissions",
    ]);
  });

  it("the Guardian's and the Advisor's review bounds from their defaults (SPI-1320)", () => {
    const from = (extension: string, settings: Record<string, unknown>) =>
      tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension, settings } });
    expect(from("guardian", { reviewTimeoutSeconds: 30 })).toBe("asked");
    expect(from("guardian", { reviewTimeoutSeconds: 300 })).toBe("asked");
    expect(from("advisor", { maxToolRounds: 4 })).toBe("free");
    expect(from("advisor", { maxToolRounds: 12 })).toBe("asked");
    expect(from("advisor", { concernCooldownTurns: 5 })).toBe("free");
    expect(from("advisor", { concernCooldownTurns: 1 })).toBe("asked");
    for (const settings of [
      { catchUpBacklog: 1 },
      { catchUpBacklog: 9 },
      { catchUpWaitSeconds: 0 },
      { catchUpWaitSeconds: 600 },
    ])
      expect(from("advisor", settings)).toBe("free");
  });

  it("a change that moves nothing is unchanged; several parts are asked when any is", () => {
    expect(
      tier({
        entity: "extension",
        stored: EMPTY_HARNESS,
        change: { extension: "codemode", enabled: true, settings: { inlineBudget: 2_000 } },
      }),
    ).toBe("unchanged");
    expect(
      tier({
        entity: "extension",
        stored: EMPTY_HARNESS,
        change: { extension: "termctrl", settings: { cols: 200, backgroundBash: false } },
      }),
    ).toBe("free");
    expect(
      tierOf({
        entity: "extension",
        stored: EMPTY_HARNESS,
        change: { extension: "termctrl", settings: { backgroundBash: true, cols: 200 } },
      }),
    ).toEqual({
      tier: "free",
      reasons: ["termctrl.cols: 120 to 200 (free in either direction)"],
    });
    expect(
      tierOf({
        entity: "extension",
        stored: withExtension("termctrl", undefined, { backgroundBash: false }),
        change: { extension: "termctrl", settings: { backgroundBash: true, cols: 200 } },
      }),
    ).toEqual({
      tier: "asked",
      reasons: ["termctrl.backgroundBash: false to true (turned up)"],
    });
  });

  it("an unknown extension or setting is asked (fails closed)", () => {
    expect(tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "nope", enabled: false } })).toBe(
      "asked",
    );
    expect(
      tier({ entity: "extension", stored: EMPTY_HARNESS, change: { extension: "codemode", settings: { nope: 1 } } }),
    ).toBe("asked");
  });

  it("a switch that is not true or false is asked, whatever is stored (it would resolve to the default)", () => {
    const off = applyChange(EMPTY_HARNESS, { extension: "advisor", enabled: false });
    if (!off.ok) throw new Error(off.error);
    for (const enabled of [null, "false", 0]) {
      expect(
        tier({
          entity: "extension",
          stored: off.harness,
          change: { extension: "advisor", enabled: enabled as unknown as boolean },
        }),
      ).toBe("asked");
    }
  });
});

describe("tierOf: tools", () => {
  const tools = (stored: StoredHarness, change: ToolsChange) => tierOf({ entity: "tools", stored, change });
  const withTools = (change: ToolsChange): StoredHarness => {
    const applied = applyToolsChange(EMPTY_HARNESS, change);
    if (!applied.ok) throw new Error(applied.error);
    return applied.harness;
  };

  it("narrowing a tool is free; widening it is asked, deferred and direct ranking alike", () => {
    expect(tools(EMPTY_HARNESS, { tools: { ask_user: "hidden" } })).toEqual({
      tier: "free",
      reasons: ["ask_user: Exposure direct to hidden"],
    });
    expect(tools(EMPTY_HARNESS, { tools: { read: "codemode" } }).tier).toBe("free");
    expect(tools(EMPTY_HARNESS, { tools: { read: "deferred" } }).tier).toBe("free");
    expect(tools(withTools({ tools: { read: "deferred" } }), { tools: { read: "direct" } }).tier).toBe("free");
    expect(tools(EMPTY_HARNESS, { tools: { web_search: "direct" } })).toEqual({
      tier: "asked",
      reasons: ["web_search: Exposure hidden to direct"],
    });
    expect(tools(withTools({ tools: { codemode: "hidden" } }), { tools: { codemode: "direct" } }).tier).toBe("asked");
    expect(tools(withTools({ tools: { bash: "codemode" } }), { tools: { bash: null } })).toEqual({
      tier: "asked",
      reasons: ["bash: Exposure codemode to direct"],
    });
  });

  it("judges t3's tools by their Exposure before and after, a tool's own or the card's", () => {
    expect(tools(EMPTY_HARNESS, { t3: { tools: { t3_thread_read: "codemode" } } })).toEqual({
      tier: "free",
      reasons: ["t3-code/t3_thread_read (t3's hint unknown): Exposure direct to codemode"],
    });
    expect(
      tools(withTools({ t3: { exposure: "hidden" } }), { t3: { tools: { t3_thread_read: "deferred" } } }).tier,
    ).toBe("asked");
    expect(tools(EMPTY_HARNESS, { t3: { exposure: "deferred" } }).tier).toBe("free");
  });

  it("hiding code mode or tool search is asked: the tools set to them fall back to a wider Exposure", () => {
    expect(tools(EMPTY_HARNESS, { tools: { codemode: "hidden" } })).toEqual({
      tier: "asked",
      reasons: ["codemode hidden: a tool set to codemode is offered deferred or direct instead"],
    });
    expect(tools(EMPTY_HARNESS, { tools: { tool_search: "hidden" } })).toEqual({
      tier: "asked",
      reasons: ["tool_search hidden: a deferred tool is offered direct instead"],
    });
  });

  it("a t3 tool's own Exposure cleared is judged with t3's hint, and as asking for direct when it is unknown", () => {
    const hidden = withTools({ t3: { exposure: "hidden", tools: { t3_x: "hidden" } } });
    const hinted = (asks: boolean | undefined) =>
      tierOf({ entity: "tools", stored: hidden, change: { t3: { tools: { t3_x: null } } }, asksForDirect: () => asks });
    expect(hinted(true)).toEqual({ tier: "asked", reasons: ["t3-code/t3_x: Exposure hidden to direct"] });
    expect(hinted(undefined).reasons).toEqual(["t3-code/t3_x (t3's hint unknown): Exposure hidden to direct"]);
    expect(hinted(undefined).tier).toBe("asked");
    // Back to a default it already had: it stays, and the stored change applies (free), as an MCP tool's does.
    expect(hinted(false)).toEqual({ tier: "free", reasons: ["t3-code/t3_x: Exposure hidden to hidden"] });
    // Unknown, a narrowing judged at its worst case is still a move (so it applies), never `unchanged`.
    const set = withTools({ t3: { exposure: "codemode", tools: { t3_x: "direct" } } });
    expect(tierOf({ entity: "tools", stored: set, change: { t3: { tools: { t3_x: null } } } })).toEqual({
      tier: "free",
      reasons: ["t3-code/t3_x (t3's hint unknown): Exposure direct to direct"],
    });
  });

  it("a preset is judged by every tool it moves; a change that moves nothing is unchanged", () => {
    expect(tools(EMPTY_HARNESS, { preset: "core" }).tier).toBe("unchanged");
    expect(tools(EMPTY_HARNESS, { tools: { read: "direct" } }).tier).toBe("unchanged");
    expect(tools(EMPTY_HARNESS, { preset: "codemode-only" }).tier).toBe("free");
    // Deferred to direct ranks alike; only the Settings server's own entry moving makes it asked.
    expect(tools(withTools({ preset: "codemode-only" }), { preset: "everything" }).reasons).toEqual([
      "settings (tools without their own): Exposure deferred to direct (the Settings server's own entry)",
    ]);
    expect(tools(withTools({ tools: { read: "codemode" } }), { preset: "core" }).tier).toBe("asked");
  });

  it("a preset is judged by the MCP servers' tools it moves too, the Settings server's own entry always asked", () => {
    const fixture = {
      kind: "direct" as const,
      url: "https://fixture.example/mcp",
      enabled: true,
      exposure: "direct" as const,
    };
    const withServer: StoredHarness = { ...EMPTY_HARNESS, mcp: { servers: { fixture } } };
    expect(tools(withServer, { preset: "core" })).toEqual({
      tier: "free",
      reasons: ["fixture (tools without their own): Exposure direct to deferred"],
    });
    expect(tools(withServer, { preset: "everything" })).toEqual({
      tier: "asked",
      reasons: ["settings (tools without their own): Exposure deferred to direct (the Settings server's own entry)"],
    });
  });

  it("a preset that rewrites the Settings server's own entry without moving a tool's Exposure is asked", () => {
    const settings = {
      kind: "settings" as const,
      enabled: true,
      exposure: "deferred" as const,
      writes: true,
      toolExposure: { get_settings: "deferred" as const },
    };
    expect(tools({ ...EMPTY_HARNESS, mcp: { servers: { settings } } }, { preset: "core" })).toEqual({
      tier: "asked",
      reasons: ["settings: its own entry rewritten (the Settings server's own entry)"],
    });
  });

  it("a malformed change is asked (fails closed)", () => {
    expect(tools(EMPTY_HARNESS, { tools: { nope: "direct" } }).tier).toBe("asked");
    expect(tools(EMPTY_HARNESS, { tools: { codemode: "deferred" } }).tier).toBe("asked");
  });
});

describe("tierOf: the MCP server set", () => {
  const withDirect = (setting: Record<string, unknown> = {}): StoredHarness => {
    const added = applyMcpChange(EMPTY_HARNESS, {
      op: "add",
      server: "fixture",
      url: "https://fixture.example/mcp",
      auth: { kind: "none" },
    });
    if (!added.ok) throw new Error(added.error);
    return {
      ...added.harness,
      mcp: {
        servers: { ...added.harness.mcp!.servers, fixture: { ...added.harness.mcp!.servers.fixture!, ...setting } },
      },
    };
  };
  /** The Settings server's entry as it is implied (plan D2). */
  const withSettings: StoredHarness = EMPTY_HARNESS;
  /** A Direct server stored under the reserved name before it was reserved: ignored, and not the Settings server. */
  const withStaleDirect: StoredHarness = {
    ...EMPTY_HARNESS,
    mcp: {
      servers: {
        [SETTINGS_SERVER]: { kind: "direct", url: "https://x.example/mcp", enabled: true, exposure: "deferred" },
      },
    },
  };
  const mcp = (stored: StoredHarness, change: McpTierChange, hint?: "read" | "write") =>
    tier({ entity: "mcp", stored, change, hintedClass: () => hint });
  const ops = new Set<string>();
  const covered = (change: McpTierChange) => {
    ops.add(change.op);
    return change;
  };

  it("enabled: off to on asked, on to off free", () => {
    expect(mcp(withDirect({ enabled: false }), covered({ op: "server", server: "fixture", enabled: true }))).toBe(
      "asked",
    );
    expect(mcp(withDirect(), { op: "server", server: "fixture", enabled: false })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", enabled: true })).toBe("unchanged");
    expect(
      mcp(withDirect({ enabled: false }), { op: "server", server: "fixture", enabled: null as unknown as boolean }),
    ).toBe("asked");
  });

  it("a name inherited from Object.prototype is not a server in the set (asked)", () => {
    for (const server of ["constructor", "toString", "__proto__"]) {
      expect(mcp(withDirect(), { op: "server", server, enabled: false })).toBe("asked");
      expect(applyMcpChange(withDirect(), { op: "server", server, enabled: false })).toEqual({
        ok: false,
        error: `${server}: no such server`,
      });
    }
  });

  it("a tool named after an Object.prototype key is a tool like any other (SPI-1198 review)", () => {
    for (const tool of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      // On a hidden server, a tool of that name made direct widens: asked, never compared against the prototype's value.
      expect(
        mcp(withDirect({ exposure: "hidden", toolExposure: {} }), {
          op: "server",
          server: "fixture",
          toolExposure: { [tool]: "direct" },
        }),
        tool,
      ).toBe("asked");
      expect(
        mcp(withDirect({ exposure: "hidden" }), {
          op: "server",
          server: "fixture",
          toolExposure: { [tool]: "direct" },
        }),
        tool,
      ).toBe("asked");
      // Its class from the prototype is no class: to read is asked, back to an unknown hint is unchanged.
      expect(mcp(withDirect({ classes: {} }), { op: "class", server: "fixture", tool, class: "read" }), tool).toBe(
        "asked",
      );
      expect(mcp(withDirect({ classes: {} }), { op: "class", server: "fixture", tool, class: null }), tool).toBe(
        "unchanged",
      );
    }
    // Stored as an own key, never as the object's prototype.
    const stored = applyMcpChange(withDirect(), {
      op: "server",
      server: "fixture",
      toolExposure: JSON.parse('{"__proto__":"direct"}') as Record<string, "direct">,
    });
    if (!stored.ok) throw new Error(stored.error);
    const exposures = stored.harness.mcp!.servers.fixture!.toolExposure!;
    expect(Object.hasOwn(exposures, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(exposures)).toBe(Object.prototype);
  });

  it("Exposure up asked, down and sideways free, server-wide and per tool against the tool's effective Exposure", () => {
    expect(mcp(withDirect({ exposure: "codemode" }), { op: "server", server: "fixture", exposure: "deferred" })).toBe(
      "asked",
    );
    expect(mcp(withDirect({ exposure: "hidden" }), { op: "server", server: "fixture", exposure: "codemode" })).toBe(
      "asked",
    );
    expect(mcp(withDirect(), { op: "server", server: "fixture", exposure: "codemode" })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", exposure: "direct" })).toBe("free");
    expect(mcp(withDirect({ exposure: "direct" }), { op: "server", server: "fixture", exposure: "deferred" })).toBe(
      "free",
    );
    // A tool with no Exposure of its own follows the server's (deferred).
    expect(mcp(withDirect(), { op: "server", server: "fixture", toolExposure: { search: "hidden" } })).toBe("free");
    expect(mcp(withDirect(), { op: "server", server: "fixture", toolExposure: { search: "direct" } })).toBe("free");
    expect(
      mcp(withDirect({ toolExposure: { search: "hidden" } }), {
        op: "server",
        server: "fixture",
        toolExposure: { search: "codemode" },
      }),
    ).toBe("asked");
    // null returns the tool to the server's Exposure: compared the same way.
    expect(
      mcp(withDirect({ toolExposure: { search: "hidden" } }), {
        op: "server",
        server: "fixture",
        toolExposure: { search: null },
      }),
    ).toBe("asked");
    expect(
      mcp(withDirect({ exposure: "hidden", toolExposure: { search: "direct" } }), {
        op: "server",
        server: "fixture",
        toolExposure: { search: null },
      }),
    ).toBe("free");
    // The tool's after is the server's new Exposure when both move in one change.
    expect(
      mcp(withDirect({ toolExposure: { search: "codemode" } }), {
        op: "server",
        server: "fixture",
        exposure: "hidden",
        toolExposure: { search: null },
      }),
    ).toBe("free");
    expect(
      mcp(withDirect({ toolExposure: { search: "codemode" } }), {
        op: "server",
        server: "fixture",
        exposure: "hidden",
        toolExposure: { search: "direct", other: "hidden" },
      }),
    ).toBe("asked");
  });

  it("class: to read asked, to write free, to null by the tool's own hint (unknown asked)", () => {
    expect(mcp(withDirect(), covered({ op: "class", server: "fixture", tool: "search", class: "read" }))).toBe("asked");
    expect(mcp(withDirect(), { op: "class", server: "fixture", tool: "search", class: "write" })).toBe("free");
    expect(
      mcp(
        withDirect({ classes: { search: "write" } }),
        { op: "class", server: "fixture", tool: "search", class: null },
        "read",
      ),
    ).toBe("asked");
    expect(
      mcp(
        withDirect({ classes: { search: "write" } }),
        { op: "class", server: "fixture", tool: "search", class: null },
        "write",
      ),
    ).toBe("free");
    expect(
      mcp(
        withDirect({ classes: { search: "read" } }),
        { op: "class", server: "fixture", tool: "search", class: null },
        "write",
      ),
    ).toBe("free");
    expect(
      mcp(
        withDirect({ classes: { search: "read" } }),
        { op: "class", server: "fixture", tool: "search", class: null },
        "read",
      ),
    ).toBe("free");
    expect(
      mcp(withDirect({ classes: { search: "write" } }), {
        op: "class",
        server: "fixture",
        tool: "search",
        class: null,
      }),
    ).toBe("asked");
    expect(
      mcp(withDirect({ classes: { search: "read" } }), { op: "class", server: "fixture", tool: "search", class: null }),
    ).toBe("asked");
    expect(mcp(withDirect(), { op: "class", server: "fixture", tool: "search", class: null }, "read")).toBe(
      "unchanged",
    );
  });

  it("add and remove are asked; a header add, a header value and a sign-in need the page", () => {
    expect(
      tierOf({
        entity: "mcp",
        stored: EMPTY_HARNESS,
        change: covered({ op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "none" } }),
      }),
    ).toEqual({ tier: "asked", reasons: ["x: a new server"] });
    expect(
      tierOf({
        entity: "mcp",
        stored: EMPTY_HARNESS,
        change: { op: "add", server: "x", url: "https://x.example/mcp", auth: { kind: "oauth" } },
      }).needsPage,
    ).toBeUndefined();
    expect(
      tierOf({
        entity: "mcp",
        stored: EMPTY_HARNESS,
        change: {
          op: "add",
          server: "x",
          url: "https://x.example/mcp",
          auth: { kind: "header", header: "Authorization" },
        },
      }),
    ).toMatchObject({ tier: "asked", needsPage: "secret" });
    expect(
      tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "remove", server: "fixture" }) }),
    ).toMatchObject({ tier: "asked" });
    expect(
      tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "header-value", server: "fixture" }) }),
    ).toMatchObject({ tier: "asked", needsPage: "secret" });
    expect(
      tierOf({ entity: "mcp", stored: withDirect(), change: covered({ op: "sign-in", server: "fixture" }) }),
    ).toMatchObject({ tier: "asked", needsPage: "sign-in" });
  });

  it("every change to the Settings server's own entry is asked, narrowing included", () => {
    for (const change of [
      { op: "server", server: SETTINGS_SERVER, enabled: false },
      { op: "server", server: SETTINGS_SERVER, exposure: "hidden" },
      { op: "server", server: SETTINGS_SERVER, toolExposure: { change_mcp: "hidden" } },
      { op: "server", server: SETTINGS_SERVER, writes: false },
      { op: "class", server: SETTINGS_SERVER, tool: "change_mcp", class: "write" },
    ] as const) {
      expect(mcp(withSettings, change), JSON.stringify(change)).toBe("asked");
      // A stale Direct server under the name is ignored: the change still reaches the Settings server's entry.
      expect(mcp(withStaleDirect, change), JSON.stringify(change)).toBe("asked");
    }
  });

  it("the writes switch is the Settings server's alone", () => {
    expect(mcp(withDirect(), { op: "server", server: "fixture", writes: false })).toBe("asked");
    expect(applyMcpChange(withDirect(), { op: "server", server: "fixture", writes: false })).toMatchObject({
      ok: false,
    });
  });

  it("every move of a Settings server limit is asked, in either direction (SPI-1322)", () => {
    const tier = (stored: StoredHarness, limits: Record<string, unknown>) =>
      tierOf({ entity: "mcp", stored, change: covered({ op: "server", server: SETTINGS_SERVER, limits }) });
    expect(tier(withSettings, { askedPerHour: 12 })).toMatchObject({
      tier: "asked",
      reasons: [
        "settings.limits.askedPerHour: off to 12 (every change to it is asked) (the Settings server's own entry)",
      ],
    });
    expect(tier(withSettings, { askedPerHour: 1 }).tier).toBe("asked");
    expect(tier(withSettings, { strikeLockMinutes: 600 }).tier).toBe("asked");
    // At its value, a limit moves nothing: a form's save of every limit as it stands is unchanged.
    expect(tier(withSettings, { askedPerHour: 0 }).tier).toBe("unchanged");
    const raised = applyMcpChange(withSettings, {
      op: "server",
      server: SETTINGS_SERVER,
      limits: { askedPerHour: 12 },
    });
    if (!raised.ok) throw new Error(raised.error);
    expect(tier(raised.harness, { askedPerHour: 12, strikes: 0 }).tier).toBe("unchanged");
    expect(tier(raised.harness, { askedPerHour: 6 }).tier).toBe("asked");
    // Turned off, asked too.
    expect(tier(raised.harness, { askedPerHour: 0 }).tier).toBe("asked");
    // A key this registry does not know is asked (fails closed); a Direct server has no limits.
    expect(tier(withSettings, { nope: 1 }).tier).toBe("asked");
    expect(mcp(withDirect(), { op: "server", server: "fixture", limits: { strikes: 1 } })).toBe("asked");
  });

  it("an unknown server is asked; every MCP change shape is covered", () => {
    expect(mcp(EMPTY_HARNESS, { op: "server", server: "nope", enabled: false })).toBe("asked");
    expect([...ops].sort()).toEqual(["add", "class", "header-value", "remove", "server", "sign-in"]);
  });
});

describe("tierOf: the Environment settings", () => {
  const stored = (key: EnvironmentKey, value: unknown): StoredEnvironment => ({
    revision: 1,
    settings: { ...EMPTY_ENVIRONMENT.settings, [key]: value as never },
  });

  it("covers every key, each in both directions", () => {
    expect(Object.keys(ENVIRONMENT).sort()).toEqual(Object.keys(ENVIRONMENT_SETTINGS).sort());
    for (const [key, { up, down }] of Object.entries(ENVIRONMENT) as Array<
      [EnvironmentKey, (typeof ENVIRONMENT)[EnvironmentKey]]
    >) {
      for (const [from, to, expected] of [up, down]) {
        expect([
          key,
          from,
          tier({ entity: "environment", stored: stored(key, from), change: { settings: { [key]: to } } }),
        ]).toEqual([key, from, expected]);
      }
    }
  });

  it("off (0) ranks above every limit (SPI-1386): turning a guardrail off widens, turning it on narrows", () => {
    // down-free: a limit set from off is free; turning one off is asked.
    expect(
      tierOf({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { turnLimitMinutes: 60 } } }),
    ).toEqual({ tier: "free", reasons: ["turnLimitMinutes: off to 60 (turned down)"] });
    expect(
      tierOf({
        entity: "environment",
        stored: stored("containerBudget", 3),
        change: { settings: { containerBudget: 0 } },
      }),
    ).toEqual({ tier: "asked", reasons: ["containerBudget: 3 to off (turned up)"] });
    // up-free: keeping history for good is free; setting a retention from off deletes, so it is asked.
    expect(
      tier({
        entity: "environment",
        stored: stored("usageRetentionDays", 30),
        change: { settings: { usageRetentionDays: 0 } },
      }),
    ).toBe("free");
    expect(
      tier({
        entity: "environment",
        stored: EMPTY_ENVIRONMENT,
        change: { settings: { piSessionRetentionDays: 3650 } },
      }),
    ).toBe("asked");
  });

  it("up-free: a number raised is free, lowered is asked, with the reason in words", () => {
    expect(
      tierOf({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { graceDays: 8 } } }),
    ).toEqual({ tier: "free", reasons: ["graceDays: 7 to 8 (turned up)"] });
    expect(
      tierOf({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { graceDays: 6 } } }),
    ).toEqual({ tier: "asked", reasons: ["graceDays: 7 to 6 (turned down)"] });
    // 0 is never (SPI-1386's off, SPI-1387): keeping everything is free, and purging again from never is asked.
    expect(
      tierOf({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { graceDays: 0 } } }),
    ).toEqual({ tier: "free", reasons: ["graceDays: 7 to off (turned up)"] });
    expect(
      tierOf({
        entity: "environment",
        stored: { revision: 1, settings: { graceDays: 0 } },
        change: { settings: { graceDays: 30 } },
      }),
    ).toEqual({ tier: "asked", reasons: ["graceDays: off to 30 (turned down)"] });
  });

  it("a multi-key change is asked when any key is; nothing moved is unchanged", () => {
    expect(
      tier({
        entity: "environment",
        stored: stored("containerBudget", 3),
        change: { settings: { containerIdleMinutes: 1, containerBudget: 2 } },
      }),
    ).toBe("free");
    expect(
      tierOf({
        entity: "environment",
        stored: stored("containerBudget", 3),
        change: { settings: { containerIdleMinutes: 1, containerBudget: 4 } },
      }),
    ).toEqual({ tier: "asked", reasons: ["containerBudget: 3 to 4 (turned up)"] });
    expect(
      tier({
        entity: "environment",
        stored: EMPTY_ENVIRONMENT,
        change: { settings: { containerIdleMinutes: 2, containerSize: "standard-3" } },
      }),
    ).toBe("unchanged");
    expect(tier({ entity: "environment", stored: EMPTY_ENVIRONMENT, change: { settings: { nope: 1 } } })).toBe("asked");
  });
});

describe("tierOf: the Environment skills", () => {
  it("install, update, enable and remove are asked; disable is free", () => {
    const cases: ReadonlyArray<readonly [SkillsTierChange, "free" | "asked"]> = [
      [{ op: "install" }, "asked"],
      [{ op: "update", name: "a" }, "asked"],
      [{ op: "enable", name: "a", enabled: true }, "asked"],
      [{ op: "enable", name: "a", enabled: false }, "free"],
      [{ op: "remove", name: "a" }, "asked"],
    ];
    for (const [change, expected] of cases)
      expect(tier({ entity: "skills", change }), JSON.stringify(change)).toBe(expected);
  });

  it("an install or update needs the page, which alone shows its SKILL.md text (SPI-1199 review); the rest do not", () => {
    expect(tierOf({ entity: "skills", change: { op: "install" } }).needsPage).toBe("skills");
    expect(tierOf({ entity: "skills", change: { op: "update", name: "a" } }).needsPage).toBe("skills");
    for (const change of [
      { op: "remove", name: "a" },
      { op: "enable", name: "a", enabled: true },
      { op: "enable", name: "a", enabled: false },
    ] as const) {
      expect(tierOf({ entity: "skills", change }).needsPage).toBeUndefined();
    }
  });
});
