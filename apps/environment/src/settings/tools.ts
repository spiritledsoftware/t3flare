// The Settings server's tools (ADR-0035, plan §3 "The tools"): static definitions, the same for every caller and both
// doors, so the list changes only with a deploy. Input schemas are generated from the registry (extension ids, setting
// names and their limits, sizes, Exposures); server and skill names are validated at call time. Every tool's class is
// fixed: reads are `read`, writes are `write` (plan D7), and `readOnlyHint` says so.
//
// `resume` (plan D12) is not among them: it is `RESUME_TOOL`, the Owner-client endpoint's alone in `model` (M5b,
// SPI-1201), never the in-process server's.
import {
  DEFAULT_SETTINGS_SERVER_LIMITS,
  SETTINGS_SERVER_LIMIT_KEYS,
  SETTINGS_SERVER_LIMITS,
  BUILTIN_TOOLS,
  ENVIRONMENT_SETTINGS,
  type EnvironmentFieldSchema,
  EXPOSURES,
  EXTENSIONS,
  MAX_ENV_STRING_BYTES,
  MAX_SETUP_BYTES,
  MAX_VARIABLES_BYTES,
  OFFERED_PRESETS,
  type ToolClass,
} from "@t3flare/harness-registry";

import { durationText } from "./changes.ts";

export interface SettingsTool {
  readonly name: string;
  readonly class: ToolClass;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** What the server covers, said the same to both doors (plan D17). */
const SETTINGS_SCOPE =
  "t3flare's own settings: the Harness settings (Pi Durable's extensions and the MCP server set), the Environment settings (Container size, idle time, budget, how long open Terminals hold the Container and how many may run, the CLI agents' processes per Workspace, the Turn limit, the Answer wait, the settings read wait, how long a clone or a checkpoint may run, Variables, Global mise config, whether Terminals and CLI agents read the Owner's dotfiles, how long usage records and pi sessions are kept, the MCP calls' time limit and result size, the Grace) and the Environment skills; and the Workspaces, which list_workspaces reads and purge_workspace asks to purge (their files only: a Workspace something in t3 references is refused, and deleting a project or thread stays t3's). These are not t3's preferences (t3_environment_preferences_update). Read tools run.";

/** What both doors say of a Purge (ADR-0044 §5). */
const PURGE_NOTE =
  "A Purge (purge_workspace) names no revision and always waits for the owner's answer, in every mode.";

/**
 * What agents are told about the server (plan D17): its instructions and its tools' descriptions, nothing else. Built
 * when served, with the Answer wait `answerMs` its asked changes wait (SPI-1316) and how many may wait at once per
 * thread, `openPerThread` (the Settings server's limit, SPI-1322).
 */
export const settingsInstructions = (
  answerMs: number,
  openPerThread: number = DEFAULT_SETTINGS_SERVER_LIMITS.openPerThread,
): string =>
  `${SETTINGS_SCOPE} Every settings write names the expectedRevision it read, and the thread's mode rules it: plan mode refuses writes; outside full access a write waits for the owner's card; a change that widens what agents have or can do always waits for the owner's answer on a card or its Change page (at most ${durationText(answerMs)}, ${openPerThread === 1 ? "one at a time" : `at most ${openPerThread} at a time`} per thread). ${PURGE_NOTE} Do not repeat a declined change.`;

/**
 * The same for an Owner client (plan D11, D12): it has no thread mode, and its asked changes wait on the Change page in
 * its Elicitation mode, for the Answer wait `answerMs`.
 */
export const settingsOwnerInstructions = (answerMs: number): string =>
  `${SETTINGS_SCOPE} Every settings write names the expectedRevision it read. ${PURGE_NOTE} A change that narrows what agents have or can do applies at once; one that widens it waits for the owner's answer on its Change page (at most ${durationText(answerMs)}): open the link the result or the question gives, and do not repeat the call; read the settings to see whether it applied. Do not repeat a declined change.`;

/**
 * What an Owner client is told besides, by its Elicitation mode (plan D12): the mode the owner set for this client on the
 * Settings page, or the URL's `?elicitation_mode=` override (so the text does not say which).
 */
export const OWNER_MODE_INSTRUCTIONS = {
  browser: "",
  native:
    " This client is in the native Elicitation mode: such a change is asked as a form in your client, and its Accept applies it.",
  model:
    " This client is in the model Elicitation mode: such a change answers approval-required with a requestId: show it to the user, then call resume with the requestId and their answer. A change that takes a secret, starts a sign-in or installs or updates skills waits on its Change page instead.",
} as const;

const ASKED_NOTE =
  "Changes that widen what agents have or can do (the Change tier `asked`) wait for the owner's answer, on his card or the Change page, before they apply; turning things down is `free`.";

const expectedRevision = (entity: string) => ({
  type: "integer",
  minimum: 0,
  description: `The ${entity} revision you read (get_settings or a write's result); a moved one is refused with the current revision.`,
});

/** One setting's schema as JSON Schema. */
const fieldJson = (schema: EnvironmentFieldSchema): Record<string, unknown> => {
  switch (schema.type) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer", minimum: schema.minimum, maximum: schema.maximum };
    case "number":
      return { type: schema.whole === true ? "integer" : "number", minimum: schema.minimum };
    case "enum":
      return schema.integers === undefined
        ? { type: "string", enum: [...schema.values] }
        : {
            type: "string",
            pattern: `^(${schema.values.map((value) => value.replace(/[^A-Za-z0-9]/g, "\\$&")).join("|")}|[1-9][0-9]*)$`,
            description: `One of ${schema.values.join(", ")}, or a whole number of at least ${schema.integers.minimum}, in digits.`,
          };
    case "text":
      return schema.maxLength === undefined ? { type: "string" } : { type: "string", maxLength: schema.maxLength };
    case "file":
      return { type: "string", description: `At most ${schema.maxBytes} bytes of UTF-8.` };
    case "ports":
      return {
        type: "array",
        minItems: 1,
        maxItems: schema.maxCount,
        uniqueItems: true,
        items: { type: "integer", minimum: 1, maximum: 65_535, not: { enum: [...schema.reserved] } },
      };
    case "variables":
      return {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "A name a shell can export." },
            value: { type: "string", description: "The value. A secret's read back as empty, with valueRedacted." },
            secret: { type: "boolean", description: "Whether the value is secret: stored sealed, never read back." },
            valueRedacted: {
              type: "boolean",
              description: "On a secret: true keeps the value stored under its name, as the read gave it.",
            },
          },
          required: ["name"],
        },
        description: `The whole set of Variables, each { name, value, secret }. A secret read back has valueRedacted: true; send it so to keep its value, or a new value to replace it. Turning Secret off needs the value given again. Anything run in a Workspace can read every Variable, a secret's value included. Each NAME=value is at most ${MAX_ENV_STRING_BYTES} bytes of UTF-8, and all of them together at most ${MAX_VARIABLES_BYTES}.`,
      };
  }
};

/** The Settings server's limits as `change_mcp` takes them (SPI-1322), each from its schema. */
const LIMITS_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    SETTINGS_SERVER_LIMIT_KEYS.map((key) => [key, fieldJson(SETTINGS_SERVER_LIMITS[key].schema)]),
  ),
  additionalProperties: false,
};

/** The changeable extensions (a locked one, or one with no switch and no settings, cannot be changed by anyone). */
const CHANGEABLE = EXTENSIONS.filter(
  (entry) =>
    entry.locked === undefined &&
    ((entry.default !== "always" && entry.tools === undefined) || Object.keys(entry.settings).length > 0),
);

const extensionSettings = (): string =>
  CHANGEABLE.filter((entry) => Object.keys(entry.settings).length > 0)
    .map((entry) => `${entry.id}: ${Object.keys(entry.settings).join(", ")}`)
    .join("; ");

const settingNames = [...new Set(CHANGEABLE.flatMap((entry) => Object.keys(entry.settings)))].sort();

export const SETTINGS_TOOLS: ReadonlyArray<SettingsTool> = [
  {
    name: "get_settings",
    class: "read",
    description:
      "Reads the Harness settings (entity harness: each Pi Durable extension's switch and settings) or the Environment settings (entity environment: Container size, idle time, budget, the Terminals' holds terminalBusyHoldMinutes and terminalPromptHoldMinutes and counts terminalsPerWorkspace and agentTerminalsPerWorkspace, the agents' Terminal scrollback agentTerminalScrollbackLines, the CLI agents' processes per Workspace cliProcessesPerWorkspace and their reclaim delay cliReclaimSeconds, the Turn limit turnLimitMinutes, the Answer wait ownerAnswerMinutes, the settings read wait settingsReadSeconds, the clone and checkpoint time limits cloneMinutes and checkpointMinutes, Variables, Global mise config, the dotfiles toggles terminalsReadBashrc and agentsReadDotfiles, how long history is kept usageRetentionDays and piSessionRetentionDays (Pi's and Claude Code's sessions), the MCP calls' time limit mcpCallSeconds and result size mcpResultKiB, the MCP servers' connect and listing time limits mcpConnectSeconds and mcpListSeconds, their logs kept per call mcpLogEntries, their progress notices passed on per second mcpProgressPerSecond and how long a Legacy server is taken as Legacy mcpLegacyRecheckHours, the housekeeping waits and counts (SPI-1366: githubRetrySeconds, textGenerationSeconds, mcpPausesPerCall, cliMcpStartSeconds, mcpSignInMinutes, idleAfterSeconds, prWatchWakeMinutes, remoteRetryMinutes, safeModeAfterFailures, browserProfileSaveSeconds, htmlBrowserKeepAliveSeconds, pageTokenHours, clientsPerKey, connectPublishLogKept), the retries durableRetries, cliRetries and killAttempts and t3's trace traceKiB and traceFiles (SPI-1367), with the running Containers and costs): the revision, every setting resolved, its limits and its Change tier rule.",
    inputSchema: {
      type: "object",
      required: ["entity"],
      properties: { entity: { type: "string", enum: ["harness", "environment"] } },
      additionalProperties: false,
    },
  },
  {
    name: "list_mcp_servers",
    class: "read",
    description:
      "Lists the MCP server set with the Harness revision: each server's kind, switch, Exposure and sign-in state (a secret only as set or not), and the Settings server's writes switch and limits. Name a server to list its tools with class, hint and Exposure.",
    inputSchema: { type: "object", properties: { server: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "list_skills",
    class: "read",
    description:
      "Lists the Environment skills with the Environment revision. Name a skill to read its SKILL.md and its files.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "list_workspaces",
    class: "read",
    description:
      "Lists every Workspace (a project's, with its Worktree Workspaces under it): its status, what in t3 references it, when the Sweep would purge it and what it would do, and the Grace (purging on or off, its days). Each id is what purge_workspace takes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_status",
    class: "read",
    description:
      "The Settings page's Status (which revisions Sessions and Workspaces took, skills, the Base snapshot), the Base snapshot's record (baseSnapshot: its state, a failed build's output), the last Test base build's (testBaseBuild), the Settings server's access switch, and this caller's open changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_audit",
    class: "read",
    description:
      "Reads the settings' audit log, newest first: 20 entries by default, as many as `limit` asks; pass the answer's `before` to page.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 }, before: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: "test_mcp_server",
    class: "read",
    description: "Lists one MCP server's tools now, as the panel's Test does, and answers its status.",
    inputSchema: {
      type: "object",
      required: ["server"],
      properties: { server: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "preview_skills",
    class: "read",
    description:
      "Previews the skills at a GitHub source (owner/repo, a tree URL, or owner/repo/path@ref): the candidates at the resolved commit, with digests. Installs nothing.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: { source: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "check_skill_updates",
    class: "read",
    description:
      "Checks the kept Environment skills (all, or those named) against their source: per skill, current or the commit to update to.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
  {
    name: "change_extension",
    class: "write",
    description: `Changes one Pi Durable extension's switch or some of its settings (the Harness settings); an extension with tools has no switch: change_tools hides or offers its tools. Settings by extension: ${extensionSettings()}. Applies at each thread's next turn. ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "extension"],
      properties: {
        expectedRevision: expectedRevision("Harness"),
        extension: { type: "string", enum: CHANGEABLE.map((entry) => entry.id) },
        enabled: { type: "boolean" },
        settings: {
          type: "object",
          propertyNames: { enum: settingNames },
          description: "Some of the extension's settings, by name; get_settings lists each one's limits.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_tools",
    class: "write",
    description: `Sets tools' Exposures (the Harness settings): direct (in every request), deferred (loaded by tool_search), codemode (code mode's scripts only) or hidden; null returns a tool to its default. tools: built-in tools by name (${BUILTIN_TOOLS.map((tool) => tool.name).join(", ")}; codemode and tool_search are direct or hidden). t3: t3's own tools, exposure for those without their own and tools by t3's name (t3_thread_wait and t3_background_wait are never codemode). preset (core, codemode-only, everything) sets every tool that is not hidden first, t3's and MCP servers' included (core defers MCP servers'; an MCP server's code-mode-only tools are left). An extension runs while any of its tools is not hidden. Applies at each thread's next turn. ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision"],
      properties: {
        expectedRevision: expectedRevision("Harness"),
        preset: { type: "string", enum: Object.keys(OFFERED_PRESETS) },
        tools: {
          type: "object",
          additionalProperties: { anyOf: [{ type: "string", enum: [...EXPOSURES] }, { type: "null" }] },
        },
        t3: {
          type: "object",
          properties: {
            exposure: { type: "string", enum: [...EXPOSURES] },
            tools: {
              type: "object",
              additionalProperties: { anyOf: [{ type: "string", enum: [...EXPOSURES] }, { type: "null" }] },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_mcp",
    class: "write",
    description: `Changes the MCP server set (the Harness settings): op server (enabled, exposure, toolExposure by upstream tool name with null for the server's, writes and limits for the Settings server only: ${SETTINGS_SERVER_LIMIT_KEYS.join(", ")}, its caps on how often a caller may ask, change and read; a change to them is always asked), op class (a tool's class read, write, or null for its own hint), op add (a Direct server: url and auth none, header with the header's name, or oauth; a header value is typed by the owner on the Change page, never here), op remove, or op header-value (asks the owner to type a header server's value on the Change page). ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "change"],
      properties: {
        expectedRevision: expectedRevision("Harness"),
        change: {
          type: "object",
          required: ["op", "server"],
          properties: {
            op: { type: "string", enum: ["server", "class", "add", "remove", "header-value"] },
            server: { type: "string" },
            enabled: { type: "boolean" },
            exposure: { type: "string", enum: [...EXPOSURES] },
            toolExposure: {
              type: "object",
              additionalProperties: { anyOf: [{ type: "string", enum: [...EXPOSURES] }, { type: "null" }] },
            },
            writes: { type: "boolean" },
            limits: LIMITS_SCHEMA,
            tool: { type: "string" },
            class: { anyOf: [{ type: "string", enum: ["read", "write"] }, { type: "null" }] },
            url: { type: "string" },
            auth: {
              type: "object",
              required: ["kind"],
              properties: { kind: { type: "string", enum: ["none", "header", "oauth"] }, header: { type: "string" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_mcp_sign_in",
    class: "write",
    description:
      "Asks the owner to start an OAuth sign-in for a Direct server added with auth oauth. The sign-in happens in the owner's browser from the Change page, never through an agent.",
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "server"],
      properties: { expectedRevision: expectedRevision("Harness"), server: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "change_environment",
    class: "write",
    description: `Changes some of the Environment settings. The Container settings apply when each Workspace's Container next starts, not in one running now (terminalsReadBashrc, the Terminals' holds and counts too; a lower count closes no open Terminal); agentsReadDotfiles and cliProcessesPerWorkspace apply at each CLI agent's next start (a lower count ends no running process), cliReclaimSeconds to CLI agents' processes started after the change; turnLimitMinutes at each thread's next turn (a running turn keeps the limit it started with); ownerAnswerMinutes to cards raised after the change (a card already waiting keeps its deadline; a running CLI agent's cards keep the wait it started with); settingsReadSeconds at each thread's next turn, and at a Container start once the Workspace has kept it (a start uses the wait it last kept, so a change can take one more start to apply fully); cloneMinutes at the next clone or worktree checkout and checkpointMinutes at the next checkpoint, worktree bundle or carry (one already running keeps its limit); usageRetentionDays at the next prune of the usage records (it runs as usage is recorded, at most once an hour) and to usage recorded from then on, piSessionRetentionDays at each Pi or Claude Code start; mcpCallSeconds and mcpResultKiB at the next MCP call (a CLI agent's own tool timeout, which grows with mcpCallSeconds, at its next start); mcpConnectSeconds and mcpLegacyRecheckHours at the next connection to an MCP server, mcpListSeconds at the next discovery of an MCP server, mcpLogEntries and mcpProgressPerSecond at the next MCP call; outsideRequestSeconds at the next request to GitHub, a sign-in's vendor, an MCP server's sign-in or token refresh, T3 Connect or a Model endpoint's model list; githubRetrySeconds at the next failure GitHub names no time for; textGenerationSeconds at the next text generation; mcpPausesPerCall at the next MCP call, cliMcpStartSeconds at each CLI agent's next start, mcpSignInMinutes to MCP sign-ins started after it; idleAfterSeconds at the next idle check, prWatchWakeMinutes at the next sleep, remoteRetryMinutes at the next try, safeModeAfterFailures at the next start of t3; browserProfileSaveSeconds to preview profiles opened after it, htmlBrowserKeepAliveSeconds to the next HTML render browser; pageTokenHours at the next change from the Settings page, clientsPerKey at the next new Owner client, connectPublishLogKept at the next T3 Connect publish; durableRetries and killAttempts at each thread's next turn, cliRetries at each CLI agent's next start, traceKiB and traceFiles at t3's next start; repoSkillsListed, skillsDirectoryEntries, skillsLinkEntries and promptsDirectoryEntries at each Workspace's next Container start; the Grace (sweepPurges, graceDays) applies at the next Sweep. ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "settings"],
      properties: {
        expectedRevision: expectedRevision("Environment"),
        settings: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(ENVIRONMENT_SETTINGS).map(([key, entry]) => [
              key,
              fieldJson(entry.schema as EnvironmentFieldSchema),
            ]),
          ),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_skills",
    class: "write",
    description: `Changes the Environment skills (their revision is the Environment settings'): op install (source, the previewed 40-hex commit, folders), update (name, commit from check_skill_updates), enable, disable or remove (name). ${ASKED_NOTE}`,
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "op"],
      properties: {
        expectedRevision: expectedRevision("Environment"),
        op: { type: "string", enum: ["install", "update", "enable", "disable", "remove"] },
        source: { type: "string" },
        commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        folders: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rebuild_base",
    class: "write",
    description:
      "Asks the Builder to build the Base snapshot again from the saved Environment settings (the Image setup, the Global mise config, the Variables), as the Settings page's Rebuild does. Free; a build under way goes on. get_status shows its state as baseSnapshot. A change to those settings, and each deploy, builds a new one on its own.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "test_base_build",
    class: "write",
    description:
      "Tests a proposed Image setup before you ask to save it: the test Builder runs this text in place of the saved one, with the saved Global mise config, Variables (secret ones included) and limits, exactly as a Base build would, and proves a start from its snapshot. Free; nothing is saved, its snapshot is never used, and a new test cancels one under way. It takes minutes: get_status shows its result as testBaseBuild (state, exit code, the end of its output with secret values blanked, size and time), kept until the next test.",
    inputSchema: {
      type: "object",
      required: ["imageSetup"],
      properties: {
        imageSetup: {
          type: "string",
          description: `The whole proposed Image setup: a bash script of at most ${MAX_SETUP_BYTES} bytes of UTF-8.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "purge_workspace",
    class: "write",
    description:
      "Asks the owner to purge one Workspace now: its files, its Container, and its deleted threads' Sessions, for good; a project's Workspace takes its Worktree Workspaces with it. Refused when anything in t3 references it or one of its worktrees (a live or archived project or thread, an open run or Terminal): delete the project or thread in t3 first. It never deletes the t3 project. Always asked, in every mode, with no expectedRevision; the references are read again when the owner answers.",
    inputSchema: {
      type: "object",
      required: ["workspace"],
      properties: { workspace: { type: "string", description: "The Workspace's id, as list_workspaces names it." } },
      additionalProperties: false,
    },
  },
];

export const settingsToolOf = (name: string): SettingsTool | undefined =>
  SETTINGS_TOOLS.find((tool) => tool.name === name);

/**
 * `resume` (plan D12's `model`): Executor's shape, a `requestId` and a `response` with its `action`, so that
 * `isPausingServer` is true of a tool list that includes it. A write: it applies the change it accepts.
 */
export const RESUME_TOOL: SettingsTool = {
  name: "resume",
  class: "write",
  description:
    "Answers a change that waits for approval (a write's approval-required result): requestId from that result, and response.action accept (applies it), decline (refuses it; do not ask again) or cancel (withdraws it). Call it only with the user's answer.",
  inputSchema: {
    type: "object",
    required: ["requestId", "response"],
    properties: {
      requestId: { type: "string" },
      response: {
        type: "object",
        required: ["action"],
        properties: { action: { enum: ["accept", "decline", "cancel"] }, content: { type: "object" } },
      },
    },
  },
};

/** A tool as an MCP definition: its name, description, input schema, and `readOnlyHint` from its class. */
export const toolDefinition = (tool: SettingsTool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.class === "read" },
});

/** The tools as MCP definitions, by name: what the MCP host lists as the server's inventory. */
export const settingsDefinitions = (): Readonly<Record<string, Readonly<Record<string, unknown>>>> =>
  Object.fromEntries(SETTINGS_TOOLS.map((tool) => [tool.name, toolDefinition(tool)]));
