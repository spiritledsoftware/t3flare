// Disclosure (ADR-0049 §6, SPI-1385): every setting of the one schema declares where the Settings page shows it, each
// contextual condition names something that exists, and a limit's message says where to change a setting the page does
// not show at once.
import { describe, expect, it } from "vitest";

import {
  conditionHolds,
  type Disclosure,
  disclosureReport,
  ENVIRONMENT_SETTINGS,
  type EnvironmentSettingEntry,
  EXTENSIONS,
  changeThemUnder,
  limitHit,
  limitValue,
  SETTINGS_SERVER_LIMITS,
  settingPlace,
  timeLimitHit,
} from "./index.ts";

const environment = ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>;

/** Every setting of the one schema, by a dotted name: `environment.x`, `<extension>.x`, `settingsServer.x`. */
const everySetting = (): ReadonlyArray<readonly [string, Disclosure]> => [
  ...Object.entries(environment).map(([key, entry]) => [`environment.${key}`, entry.disclosure] as const),
  ...EXTENSIONS.flatMap((extension) =>
    Object.entries(extension.settings).map(([key, entry]) => [`${extension.id}.${key}`, entry.disclosure] as const),
  ),
  ...Object.entries(SETTINGS_SERVER_LIMITS).map(([key, entry]) => [`settingsServer.${key}`, entry.disclosure] as const),
];

const levelOf = (disclosure: Disclosure) => (typeof disclosure === "string" ? disclosure : "contextual");

describe("every setting's disclosure", () => {
  it("is declared, as visible, contextual or advanced", () => {
    for (const [name, disclosure] of everySetting())
      expect(["visible", "contextual", "advanced"], name).toContain(levelOf(disclosure));
  });

  it("names, when contextual, a setting, an extension or a tool that exists", () => {
    for (const [key, entry] of Object.entries(environment)) {
      if (typeof entry.disclosure === "string") continue;
      const condition = entry.disclosure.contextual;
      if ("equals" in condition) {
        for (const other of condition.settings) {
          const schema = environment[other]?.schema;
          expect(schema?.type, key).toBe("enum");
          if (schema?.type === "enum") expect(schema.values, key).toContain(condition.equals);
        }
      } else if ("filled" in condition) {
        expect(["file", "text"], key).toContain(environment[condition.filled]?.schema.type);
      } else {
        // An Environment setting has no extension or tool to follow.
        expect.fail(`${key}: an Environment setting's condition is another setting's value`);
      }
    }
    for (const extension of EXTENSIONS) {
      for (const [key, entry] of Object.entries(extension.settings)) {
        if (typeof entry.disclosure === "string") continue;
        const condition = entry.disclosure.contextual;
        const name = `${extension.id}.${key}`;
        if ("extensionOn" in condition) {
          // A switch of its own: not a tools extension (on with its tools) and not always on.
          expect(extension.tools, name).toBeUndefined();
          expect(extension.default, name).not.toBe("always");
        } else if ("toolOn" in condition) {
          expect(extension.tools, name).toContain(condition.toolOn);
        } else {
          expect.fail(`${name}: a Harness setting's condition is its extension's switch or tool`);
        }
      }
    }
  });

  // The ticket's table (SPI-1385), less the settings SPI-1387 made constants. Settings outside it are Advanced until
  // SPI-1388 makes the Harness's constants.
  it("puts each setting where SPI-1385's table does", () => {
    const by = (level: string) =>
      everySetting()
        .filter(([, disclosure]) => levelOf(disclosure) === level)
        .map(([name]) => name)
        .sort();
    expect(by("visible")).toEqual(
      [
        "environment.containerSize",
        "environment.containerIdleMinutes",
        "environment.containerBudget",
        "environment.turnLimitMinutes",
        "environment.variables",
        "environment.globalMiseConfig",
        "environment.containerSetup",
        "environment.imageSetup",
        "environment.agentsReadDotfiles",
        "environment.graceDays",
        "environment.idleAfterSeconds",
        "tool-output.outputKiB",
        "context.rolloverOnCompaction",
      ].sort(),
    );
    expect(by("contextual")).toEqual(
      [
        "environment.customVcpu",
        "environment.customMemoryMib",
        "environment.customDiskMb",
        "environment.globalMiseInstallMinutes",
        "environment.containerSetupMinutes",
        "environment.containerSetupFailure",
        "environment.imageSetupMinutes",
        "environment.whileBuilding",
        "web.searchModel",
        "guardian.model",
        "guardian.thinkingLevel",
        "guardian.tools",
        "guardian.commands",
        "guardian.policy",
        "advisor.model",
        "advisor.reviewEvery",
        "advisor.thinkingLevel",
        "advisor.correctiveTurns",
      ].sort(),
    );
  });
});

describe("conditionHolds", () => {
  const custom = { settings: ["containerSize"], equals: "custom" } as const;

  it("follows another setting's value", () => {
    expect(conditionHolds(custom, { containerSize: "cpu-1" })).toBe(false);
    expect(conditionHolds(custom, { containerSize: "custom" })).toBe(true);
  });

  it("follows whether a script has text", () => {
    expect(conditionHolds({ filled: "containerSetup" }, { containerSetup: "  \n" })).toBe(false);
    expect(conditionHolds({ filled: "containerSetup" }, { containerSetup: "apt-get install -y jq\n" })).toBe(true);
  });

  it("follows the extension's switch and its tools", () => {
    const off = { enabled: false, toolOn: () => false };
    const on = { enabled: true, toolOn: (tool: string) => tool === "web_search" };
    expect(conditionHolds({ extensionOn: true }, {}, off)).toBe(false);
    expect(conditionHolds({ extensionOn: true }, {}, on)).toBe(true);
    expect(conditionHolds({ toolOn: "web_search" }, {}, on)).toBe(true);
    expect(conditionHolds({ toolOn: "web_search" }, {}, off)).toBe(false);
  });
});

describe("settingPlace", () => {
  it("is Section › Advanced › Title for an Advanced setting", () => {
    expect(settingPlace({ environment: "cloneMinutes" })).toBe("Environment › Advanced › Clone time limit (minutes)");
    expect(settingPlace({ extension: "web", key: "searchesPerCall" })).toBe(
      "Tools › Web tools › Advanced › Searches per call",
    );
    expect(settingPlace({ extension: "guardian", key: "reviewTimeoutSeconds" })).toBe(
      "Extensions › Guardian › Advanced › Review time limit (seconds)",
    );
    expect(settingPlace({ settingsServer: "strikes" })).toBe("MCP servers › Settings server › Advanced › Strikes");
  });

  it("is under the row a contextual setting joins", () => {
    expect(settingPlace({ environment: "containerSetupMinutes" })).toBe(
      "Environment › Container setup › Container setup time limit (minutes)",
    );
    expect(settingPlace({ environment: "customVcpu" })).toBe("Environment › Custom size: vCPU");
  });

  it("is in the Workspaces section for the Grace", () => {
    expect(settingPlace({ environment: "graceDays" })).toBe("Workspaces › Purge after (days)");
  });
});

describe("limitHit", () => {
  it("says where to change a contextual or Advanced setting", () => {
    expect(
      limitHit(`The clone stopped at its ${limitValue(15, "minute")} limit`, { environment: "cloneMinutes" }),
    ).toBe(
      "The clone stopped at its 15-minute limit; change it under Environment › Advanced › Clone time limit (minutes).",
    );
    expect(
      limitHit(`The Container setup stopped at its ${limitValue(10, "minute")} limit`, {
        environment: "containerSetupMinutes",
      }),
    ).toBe(
      "The Container setup stopped at its 10-minute limit; change it under Environment › Container setup › Container setup time limit (minutes).",
    );
  });

  it("names only the limit for a visible setting, which the page shows", () => {
    expect(
      limitHit(`The turn stopped at its ${limitValue(120, "minute")} limit`, { environment: "turnLimitMinutes" }),
    ).toBe("The turn stopped at its 120-minute limit.");
  });
});

describe("disclosureReport", () => {
  it("reports the level, what shows a contextual setting, and where it is", () => {
    expect(disclosureReport({ environment: "cloneMinutes" })).toEqual({
      disclosure: "advanced",
      where: "Environment › Advanced › Clone time limit (minutes)",
    });
    expect(disclosureReport({ environment: "customVcpu" })).toEqual({
      disclosure: "contextual",
      shownWhen: "shown while Container size is custom",
      where: "Environment › Custom size: vCPU",
    });
    expect(disclosureReport({ extension: "guardian", key: "model" })).toEqual({
      disclosure: "contextual",
      shownWhen: "shown while Guardian is on",
      where: "turn Guardian on, then Extensions › Guardian › Model",
    });
    // An extension's Advanced settings follow it: shown while it is on, or while one of its tools is offered.
    expect(disclosureReport({ extension: "guardian", key: "reviewTimeoutSeconds" })).toEqual({
      disclosure: "advanced",
      shownWhen: "shown while Guardian is on",
      where: "turn Guardian on, then Extensions › Guardian › Advanced › Review time limit (seconds)",
    });
    expect(disclosureReport({ extension: "web", key: "searchResults" })).toEqual({
      disclosure: "advanced",
      shownWhen: "shown while one of web_fetch or web_search is offered",
      where: "offer one of web_fetch or web_search, then Tools › Web tools › Advanced › Search results",
    });
    expect(disclosureReport({ extension: "tool-output", key: "outputKiB" })).toEqual({
      disclosure: "visible",
      where: "Extensions › Tool output › Output shown to the model (KiB)",
    });
  });
});

describe("timeLimitHit and changeThemUnder", () => {
  it("names a time limit with its value, or without one a report did not carry, and where to change it", () => {
    expect(timeLimitHit(15, "minute", { environment: "cloneMinutes" })).toBe(
      "its 15-minute time limit; change it under Environment › Advanced › Clone time limit (minutes)",
    );
    expect(timeLimitHit(undefined, "minute", { environment: "containerSetupMinutes" })).toBe(
      "its time limit; change it under Environment › Container setup › Container setup time limit (minutes)",
    );
    // What the sentence goes on to say comes before the place, which ends it.
    expect(timeLimitHit(30, "minute", { environment: "imageSetupMinutes" }, ": exit 1")).toBe(
      "its 30-minute time limit: exit 1; change it under Environment › Image setup › Image setup time limit (minutes)",
    );
    // A limit is hit while its feature is in use, so the hit says nothing of turning it on.
    expect(timeLimitHit(30, "second", { extension: "guardian", key: "reviewTimeoutSeconds" })).toBe(
      "its 30-second time limit; change it under Extensions › Guardian › Advanced › Review time limit (seconds)",
    );
  });

  it("lists several settings of one place once", () => {
    expect(
      changeThemUnder([
        { settingsServer: "strikes" },
        { settingsServer: "strikeWindowMinutes" },
        { settingsServer: "strikeLockMinutes" },
      ]),
    ).toBe(
      "; change them under MCP servers › Settings server › Advanced › Strikes, Strike window (minutes) and Strike lock (minutes)",
    );
  });
});
