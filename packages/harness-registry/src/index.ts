// The harness registry (ADR-0026): every Pi Durable extension the Settings page shows, with its switch and its settings
// schema, and how the stored settings resolve for a Session. Imported by the Environment Worker (the panel and its API
// validate against it) and the agents Worker (the Session builds its registry from the resolved view). Later ports
// (docs/parity.md §6: web, todo, context, guardian…) add an entry here and appear in the panel without panel work.
//
import { JSON_ESCAPE_MAX_BYTES, SESSION_ROW_BYTES, SESSION_ROW_ENVELOPE_BYTES } from "@t3flare/session-protocol";

import {
  defaultSettingsServer,
  type Exposure,
  type McpServerSetting,
  RESERVED_SERVER_NAMES,
  SERVER_NAME,
  SETTINGS_SERVER,
  SETTINGS_SERVER_LIMIT_KEYS,
  SETTINGS_SERVER_LIMITS,
  type SettingsServerLimitKey,
  type ServerAuth,
  type SettingsServerLimits,
  type ToolClass,
} from "./mcp.ts";
import {
  AGENT_EXITED_TERMINALS_KEPT,
  ENVIRONMENT_SETTINGS,
  type EnvironmentKey,
  MAX_TIMED_SECONDS,
  SWEEP_SETTING_KEYS,
} from "./environment.ts";
import {
  type Disclosure,
  type DisclosureCondition,
  type EnvironmentSettingEntry,
  fieldProblem,
  type SettingEntry,
  type SettingValue,
} from "./fields.ts";
import { FIND_DEFAULT_LIMIT, GREP_DEFAULT_LIMIT, LS_DEFAULT_LIMIT, TOOL_OUTPUT_LINES } from "./harnessConstants.ts";
import { storedValueProblem } from "./storedValue.ts";
import { EXPOSURES, legacyResolvedTools, type ResolvedTools, resolveTools, type ToolsLayer } from "./tools.ts";

export * from "./mcp.ts";
export * from "./fields.ts";
export * from "./environment.ts";
export * from "./tools.ts";
export * from "./harnessConstants.ts";

// Settings are Global (the Cloud Environment) now; the stored shape has per-Project `overrides`, empty, resolved with
// a merge (an Override's keyed settings merge over Global's key by key; lists are replaced whole) so a
// later step only adds a scope picker.

export interface ExtensionEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Whether the extension is on with no setting stored; `always` has no switch (on, and cannot be turned off). */
  readonly default: "on" | "off" | "always";
  readonly settings: Readonly<Record<string, SettingEntry>>;
  /** Why the panel cannot change it at all. */
  readonly locked?: string;
  /**
   * Its tools (tools.ts): it has no switch of its own, and is on while any of them is not `hidden`. The panel shows it
   * in the Tools section, its settings beside its tools.
   */
  readonly tools?: ReadonlyArray<string>;
  /**
   * A Guard (ADR-0035 §3, plan D5): it checks what agents do, so turning it off, or any change to its settings, is an
   * asked Change tier.
   */
  readonly guard?: true;
}

/**
 * A model setting (the Guardian's, the Advisor's, `web_search`'s): a Model endpoint's slug, `<endpointId>/<modelId>`, or
 * `default` (the endpoints' small model, text generation's default rule). Free text, since the endpoints are the owner's. A
 * value that names no endpoint (`isRetiredSlug`: an old value) is read as `default`.
 */
const modelSetting = (
  title: string,
  description: string,
  fallback: string,
  disclosure: SettingEntry["disclosure"],
): SettingEntry => ({
  title,
  description,
  disclosure,
  // No length of t3flare's: a value that names no endpoint is read as `default`, and the Harness settings' one stored
  // value bounds it (SPI-1368).
  schema: { type: "text", default: fallback },
});
const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
/**
 * QuickJS interrupt polls per CPU second of a tight loop on Cloudflare Durable Objects, as pi-codemode measured them
 * (`runtime/inline.d.ts`, October 2026): about 10,000. The rate depends on the code, so it converts only roughly.
 */
export const CODEMODE_POLLS_PER_SECOND = 10_000;

/** A codemode script's interrupt budget by default (`codemode.interruptBudget`): pi-codemode's DEFAULT_INTERRUPT_BUDGET. */
export const DEFAULT_CODEMODE_INTERRUPT_BUDGET = 100_000;

/**
 * The codemode sandbox Worker's CPU limit per request, in ms. A named constraint: apps/environment/alchemy.run.ts sets no
 * `limits.cpu_ms` for it, so a Durable Object's default of 30 seconds applies. Change the two together.
 */
export const CODEMODE_CPU_LIMIT_MS = 30_000;

/**
 * The most a codemode script's interrupt budget may be set to (`codemode.interruptBudget`), derived from the sandbox's
 * CPU limit at the measured poll rate: past it, the platform's CPU limit, not the budget, would stop a computing script
 * (SPI-1364). The sandbox (apps/codemode-sandbox) allows a request up to this.
 */
export const MAX_CODEMODE_INTERRUPT_BUDGET = (CODEMODE_CPU_LIMIT_MS / 1000) * CODEMODE_POLLS_PER_SECOND;

/**
 * The most KiB of a tool's result the model may be shown (`outputKiB`). A named constraint: pi-durable keeps a tool
 * result as one Session row (`SESSION_ROW_BYTES` less its record), its text at up to `JSON_ESCAPE_MAX_BYTES` per byte;
 * half the row is the text's, and the other half holds the rest of the result (a program's structured copy, `details`,
 * `web_search`'s stored result lists, which `web/search.ts` sizes from what is left).
 */
export const MAX_TOOL_OUTPUT_KIB = Math.floor(
  (SESSION_ROW_BYTES - SESSION_ROW_ENVELOPE_BYTES) / 2 / JSON_ESCAPE_MAX_BYTES / 1024,
);
/**
 * The least KiB of a tool's result the model may be shown. A named constraint, t3flare's own correctness: a tool keeps
 * room inside its output limit for its own notes (a Terminal's header and the scrolled-off lines, which take at most
 * half; web_fetch's continuation note; a History page's envelope), which needs a few KiB.
 */
export const MIN_TOOL_OUTPUT_KIB = 4;
/** The Tool output limit's default: pi-durable's own `DEFAULT_MAX_BYTES`. Its lines are `TOOL_OUTPUT_LINES`. */
export const DEFAULT_TOOL_OUTPUT_KIB = 50;

export const EXTENSIONS: ReadonlyArray<ExtensionEntry> = [
  {
    id: "codemode",
    title: "Code mode",
    description:
      "The codemode tool: the model writes a JavaScript script whose tool calls run as nested calls, each judged exactly as a direct call (ADR-0027). Scripts run in the codemode sandbox Worker. Hidden: no code mode, and a tool set to codemode is deferred instead.",
    default: "on",
    tools: ["codemode"],
    settings: {
      inlineBudget: {
        title: "Inline budget",
        description:
          "Estimated tokens the tool declarations in the code mode section may use; past it, scripts find tools with searchTools(). A larger budget puts more declarations in every request's prompt; 0 leaves them all to searchTools(). No maximum.",
        // No maximum (ADR-0048's SPI-1368 refinement): a budget past every declaration inlines them all, and nothing
        // breaks at any value.
        schema: { type: "integer", minimum: 0, default: 2_000 },
        tier: "down-free",
        disclosure: "advanced",
      },
      interruptBudget: {
        title: "Script compute budget (polls)",
        description: `How much uninterrupted computing one script may do, in QuickJS interrupt polls (about ${CODEMODE_POLLS_PER_SECOND.toLocaleString("en-US")} per CPU second on Cloudflare): a script that computes past it without calling a tool fails as timed out. Near the most, ${MAX_CODEMODE_INTERRUPT_BUDGET.toLocaleString("en-US")}, a script can reach the sandbox's CPU limit instead, which resets the sandbox and fails every script running in it. Applies at each thread's next turn.`,
        // A named constraint (`MAX_CODEMODE_INTERRUPT_BUDGET`): the codemode sandbox Worker's CPU limit.
        schema: {
          type: "integer",
          minimum: 1_000,
          maximum: MAX_CODEMODE_INTERRUPT_BUDGET,
          default: DEFAULT_CODEMODE_INTERRUPT_BUDGET,
        },
        tier: "down-free",
        disclosure: "advanced",
      },
    },
  },
  {
    id: "tool-search",
    title: "Tool search",
    description:
      "The tool_search tool, which loads a deferred tool for direct use. Hidden: a deferred tool is offered directly, since nothing could load it.",
    default: "on",
    tools: ["tool_search"],
    settings: {},
  },
  {
    id: "coding-tools",
    title: "Coding tools",
    description: "read, write, edit and bash (Worker Shell or Container).",
    default: "on",
    tools: ["read", "edit", "write", "bash"],
    settings: {},
  },
  {
    id: "tool-output",
    title: "Tool output",
    description: `How much of each tool's result the model is shown, for every tool but code mode and todo, which keep their own: bash keeps the last part of its output, the others their first, and the result says what was left out. A result is also cut at ${TOOL_OUTPUT_LINES.toLocaleString("en-US")} lines, pi's own. read pages through a file in at most 50 KiB or 2,000 lines per call, and never more than these.`,
    default: "always",
    settings: {
      outputKiB: {
        title: "Output shown to the model (KiB)",
        description: `The most of one tool result the model reads. A larger limit puts more of every result into the model's context, and each call costs that much more. At most ${MAX_TOOL_OUTPUT_KIB} KiB.`,
        // A named constraint each way: MAX_TOOL_OUTPUT_KIB (the Session row) and MIN_TOOL_OUTPUT_KIB (a tool's own notes).
        schema: {
          type: "integer",
          minimum: MIN_TOOL_OUTPUT_KIB,
          maximum: MAX_TOOL_OUTPUT_KIB,
          default: DEFAULT_TOOL_OUTPUT_KIB,
        },
        tier: "down-free",
        disclosure: "visible",
      },
    },
  },
  {
    id: "files",
    title: "File tools",
    description: `ls, find and grep. A call that names no limit lists ${LS_DEFAULT_LIMIT} entries, finds ${FIND_DEFAULT_LIMIT.toLocaleString("en-US")} paths or ${GREP_DEFAULT_LIMIT} matches, pi's own defaults; a call may ask for more, and the Tool output limit still bounds what the model reads.`,
    default: "on",
    tools: ["ls", "find", "grep"],
    settings: {},
  },
  {
    id: "ask-user",
    title: "Ask user",
    description:
      "ask_user: a question to the owner on the thread, answered as t3's user_input request. Hidden: the agent has no ask_user (for a harness whose question tools come from an MCP server).",
    default: "on",
    tools: ["ask_user"],
    settings: {},
  },
  {
    id: "web",
    title: "Web tools",
    description:
      "web_fetch: one public page as Markdown, text or HTML, through an SSRF guard. web_search: a model on an Anthropic Messages Model endpoint searches with Anthropic's server-side web search tool and cites its sources (no new key); hidden by default, since each search is a model request on the endpoint's spend. Both are reads, allowed in every mode (SPI-1054).",
    default: "on",
    tools: ["web_fetch", "web_search"],
    settings: {
      searchModel: modelSetting(
        "Search model",
        "The model that runs web_search's searches: an Anthropic Messages Model endpoint's model with an API key or no auth whose server takes Anthropic's web search tool, as <endpointId>/<modelId>, or default (the endpoints' small model).",
        "default",
        { contextual: { toolOn: "web_search" } },
      ),
      searchResults: {
        title: "Search results",
        description: "How many results web_search returns when a call doesn't ask for a number.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 100, default: 8 },
        tier: "down-free",
        disclosure: "advanced",
      },
      searchesPerCall: {
        title: "Searches per call",
        description:
          "The most searches the search model may run for one web_search call. Each web_search query is a model request on the search model's endpoint.",
        // 50: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 50, default: 2 },
        tier: "down-free",
        disclosure: "advanced",
      },
    },
  },
  {
    id: "todo",
    title: "Todo list",
    description:
      "todo: the agent's Task list for the thread, kept in the Session and shown as t3's todo list. It survives compaction and rollover, and plan mode allows it (SPI-1055).",
    default: "on",
    tools: ["todo"],
    settings: {},
  },
  {
    id: "context",
    title: "Context management",
    description:
      "context_notes (named Notes kept across compaction and rollover), context_history (the thread's stored History, from before a Handoff too) and context_rollover (the agent hands off to a fresh context it writes itself). Notes and History stay in the Session's storage (SPI-1056).",
    default: "on",
    tools: ["context_notes", "context_history", "context_rollover"],
    settings: {
      rolloverOnCompaction: {
        title: "Rollover on compaction",
        description:
          "When the context nears full, ask the agent to roll over with its own Handoff instead of a generated summary; a compaction that cannot wait uses the last saved Handoff. Off: pi-durable's own summary.",
        schema: { type: "boolean", default: true },
        tier: "free",
        disclosure: "visible",
      },
    },
  },
  {
    id: "termctrl",
    title: "Terminals and Background jobs",
    description: `terminal_start, terminal_send, terminal_stop, terminal_list and terminal_wait: interactive programs (REPLs, TUIs, prompts) as PTYs in the Workspace's container, and bash's background: true. Approvals follow the thread's mode as bash's do; nothing starts a container until a Terminal or a job starts. Any number run at once; a Workspace keeps its last ${AGENT_EXITED_TERMINALS_KEPT} exited ones readable, and they end with its container (SPI-1057, SPI-1397).`,
    default: "on",
    tools: ["terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait"],
    settings: {},
  },
  {
    id: "guardian",
    title: "Guardian",
    description:
      "A reviewer model judges risky tool calls (code mode's nested calls too) before they run and blocks the ones whose risk the owner did not authorize; t3 shows the reason. Beside the thread's approvals, never instead of them. Off by default: each review is a model request (SPI-1058).",
    default: "off",
    guard: true,
    settings: {
      model: modelSetting(
        "Model",
        "The Guardian model, as <endpointId>/<modelId>, or default (the endpoints' small model). A small, fast one: every reviewed call waits for it.",
        "default",
        { contextual: { extensionOn: true } },
      ),
      thinkingLevel: {
        title: "Thinking",
        description: "The first pass's thinking; a would-be rejection is checked again at low or above.",
        schema: { type: "enum", values: THINKING_LEVELS, default: "off" },
        disclosure: { contextual: { extensionOn: true } },
      },
      // The Guardian's three texts have no length of their own: the Harness settings are one stored value, which bounds
      // them together (`applyChange`, SPI-1368).
      tools: {
        title: "Tool Policies",
        description:
          "Which tools are reviewed, as name=allow|review|deny pairs separated by commas (bash=review, mcp__github__create_issue=allow). Unlisted tools keep the built-in default: bash reviewed unless a Safe Command, edits to Sensitive Paths and terminals reviewed, read-only tools allowed.",
        schema: { type: "text", default: "" },
        disclosure: { contextual: { extensionOn: true } },
      },
      commands: {
        title: "Command Rules",
        description:
          "Literal command prefixes as prefix=allow|review|deny pairs separated by commas (git push=deny, npm test=allow). deny blocks without a review.",
        schema: { type: "text", default: "" },
        disclosure: { contextual: { extensionOn: true } },
      },
      policy: {
        title: "Security Policy",
        description: "Trusted destinations and forbidden actions, added to the built-in policy the Guardian judges by.",
        schema: { type: "text", default: "", multiline: true },
        disclosure: { contextual: { extensionOn: true } },
      },
      // No `tier`: a Guard's settings are always asked (tiers.ts `extensionTier`).
      reviewTimeoutSeconds: {
        title: "Review time limit (seconds)",
        description: "Every reviewed call waits up to this long; a Review that runs out fails and blocks the call.",
        // Timed by t3flare's own setTimeout (guardian/review.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 60 },
        disclosure: "advanced",
      },
    },
  },
  {
    id: "advisor",
    title: "Advisor",
    description:
      "A reviewer model reads the thread's completed work in the background and gives attributed advice (nit, concern, blocker), shown in t3 as Advisor notices. It never starts a turn t3 did not start. Off by default: each review is a model request (SPI-1059).",
    default: "off",
    settings: {
      model: modelSetting(
        "Model",
        "The Advisor model, as <endpointId>/<modelId>; inherit follows the thread's model.",
        "inherit",
        { contextual: { extensionOn: true } },
      ),
      reviewEvery: {
        title: "Review cadence",
        description:
          "turn: after every tool round that is not read-only; a whole number: every that many rounds and at the end; request: once, when the agent answers. A shorter cadence reviews more often, and each Review is a model request.",
        // Any whole number of rounds (SPI-1365): advisor.ts takes any positive one.
        schema: { type: "enum", values: ["turn", "request"], default: "turn", integers: { minimum: 1 } },
        disclosure: { contextual: { extensionOn: true } },
      },
      thinkingLevel: {
        title: "Thinking",
        description: "The Advisor's thinking level.",
        schema: { type: "enum", values: THINKING_LEVELS, default: "high" },
        disclosure: { contextual: { extensionOn: true } },
      },
      correctiveTurns: {
        title: "Corrective continuations",
        description:
          "How often a blocker found as the agent answers continues the same turn to address it (0: never); later blockers wait for the next turn.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 0, maximum: 100, default: 1 },
        tier: "down-free",
        disclosure: { contextual: { extensionOn: true } },
      },
      reviewTimeoutSeconds: {
        title: "Review time limit (seconds)",
        description:
          "When the agent answers, its turn waits up to this long for the Review under way and again for a final one; a Review still running after this long is stopped, and the Advisor pauses until its settings change.",
        // Timed by t3flare's own setTimeout (advisor.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 120 },
        tier: "down-free",
        disclosure: "advanced",
      },
      maxToolRounds: {
        title: "Tool rounds per Review",
        description:
          "How many rounds of read, grep, find and ls the Advisor may take in a Review (0: no tool rounds: the Advisor reviews from what it is given). Each tool round is a model request on the Advisor model's endpoint.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 0, maximum: 100, default: 8 },
        tier: "down-free",
        disclosure: "advanced",
      },
    },
  },
  {
    id: "skills",
    title: "Skills",
    description:
      "Repo skills (.pi/skills, .agents/skills, .claude/skills from the thread's directory up to the repo root) listed in the prompt for the agent to read, offered in t3's composer as $name, and Prompt templates (.pi/prompts) as Slash commands; a picked skill or template expands into the message. Off: no listing, no composer entries, no expansion (SPI-1147).",
    default: "on",
    settings: {},
  },
  {
    id: "prompt-suggestions",
    title: "Prompt suggestions",
    description:
      "After a turn, the endpoints' small model suggests your next message from the turn's request and answer, while t3's prompt suggestions are on (its Labs setting).",
    default: "always",
    settings: {},
  },
  {
    id: "permissions",
    title: "Permissions",
    description:
      "The runtime and interaction modes' approvals, the linked-thread rules and path translation. Can never be turned off from the panel.",
    default: "always",
    settings: {},
    locked: "the thread's modes and the link fence depend on it",
    guard: true,
  },
  {
    id: "project-context",
    title: "Project context",
    description:
      "The repo's AGENTS.md and CLAUDE.md in the prompt, each whole: a file that cannot be read is named in its place, never cut.",
    default: "always",
    settings: {},
  },
];

const entryOf = (id: string) => EXTENSIONS.find((entry) => entry.id === id);

// ── Disclosure (ADR-0049 §4, §6) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A setting of the one schema: an Environment setting, an extension's (the Harness settings), or one of the Settings
 * server's limits (its entry's settings, SPI-1322).
 */
export type SettingRef =
  | { readonly environment: EnvironmentKey }
  | { readonly extension: string; readonly key: string }
  | { readonly settingsServer: SettingsServerLimitKey };

/**
 * The Settings page's headings `settingPlace` names: its sections, and the Settings server's card in the MCP servers
 * section. The page renders these (apps/environment/test/harnessPage.test.ts holds the two to each other).
 */
export const SETTINGS_PAGE_PLACES = {
  environment: "Environment",
  workspaces: "Workspaces",
  extensions: "Extensions",
  tools: "Tools",
  mcp: "MCP servers",
  settingsServer: "Settings server",
} as const;

/** The setting `ref` names, with the place on the Settings page that holds it before its own title. */
const placed = (
  ref: SettingRef,
): {
  readonly entry: SettingEntry | EnvironmentSettingEntry;
  readonly at: ReadonlyArray<string>;
  readonly extension?: ExtensionEntry;
} => {
  const places = SETTINGS_PAGE_PLACES;
  if ("environment" in ref) {
    const entry: EnvironmentSettingEntry = ENVIRONMENT_SETTINGS[ref.environment];
    // The Grace and its purge are in the Workspaces section (ADR-0044 §1); a setting that joins a file's row is under it.
    if ((SWEEP_SETTING_KEYS as ReadonlyArray<string>).includes(ref.environment))
      return { entry, at: [places.workspaces] };
    const row =
      entry.row === undefined
        ? undefined
        : (ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>)[entry.row];
    return {
      entry,
      at: row === undefined || entry.disclosure === "advanced" ? [places.environment] : [places.environment, row.title],
    };
  }
  if ("settingsServer" in ref)
    return { entry: SETTINGS_SERVER_LIMITS[ref.settingsServer], at: [places.mcp, places.settingsServer] };
  const extension = entryOf(ref.extension);
  const entry = extension?.settings[ref.key];
  if (extension === undefined || entry === undefined) throw new Error(`No setting ${ref.extension}.${ref.key}`);
  return { entry, at: [extension.tools === undefined ? places.extensions : places.tools, extension.title], extension };
};

/** `ref`'s disclosure: where the Settings page shows it. */
export const disclosureOf = (ref: SettingRef): Disclosure => placed(ref).entry.disclosure;

/** `words` as a list read with "or": "web_fetch or web_search". */
const orList = (words: ReadonlyArray<string>): string =>
  words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

/**
 * What the page needs before it shows `ref`, beyond its disclosure's own condition, if anything: an extension's
 * Advanced settings follow the extension (ADR-0049 §6), shown while it is on, or for one with tools while one of them is
 * offered, as its contextual ones are.
 */
const requirement = (ref: SettingRef): { readonly shownWhen: string; readonly first?: string } | undefined => {
  const { entry, extension } = placed(ref);
  const disclosure = entry.disclosure;
  if (typeof disclosure !== "string") {
    const condition = disclosure.contextual;
    if ("extensionOn" in condition)
      return { shownWhen: shownWhen(condition, extension), first: `turn ${extension?.title ?? "its extension"} on` };
    if ("toolOn" in condition) return { shownWhen: shownWhen(condition), first: `offer ${condition.toolOn}` };
    return { shownWhen: shownWhen(condition) };
  }
  if (disclosure !== "advanced" || extension === undefined || extension.default === "always") return undefined;
  return extension.tools === undefined
    ? { shownWhen: `shown while ${extension.title} is on`, first: `turn ${extension.title} on` }
    : {
        shownWhen: `shown while one of ${orList(extension.tools)} is offered`,
        first: `offer one of ${orList(extension.tools)}`,
      };
};

/**
 * Where the Settings page holds `ref`, as the Owner finds it: Section › Advanced › Title for an Advanced setting (with
 * the extension or card between for one of a Harness extension's or the Settings server's), Section › Title, or the row
 * it joins, otherwise.
 */
export const settingPlace = (ref: SettingRef): string => {
  const { entry, at } = placed(ref);
  return [...at, ...(entry.disclosure === "advanced" ? ["Advanced"] : []), entry.title].join(" › ");
};

/**
 * A limit's message when it is hit (ADR-0049 §4): `message`, which names the limit and its value, as a sentence; for a
 * contextual or Advanced setting, followed by where on the Settings page to change it. Every place that says a limit
 * was hit (a refusal, an agent's tool result, the Status section) builds its message here, so the place follows the
 * setting when it moves.
 */
export const limitHit = (message: string, ref: SettingRef): string => `${message}${changeItUnder(ref)}.`;

/**
 * Where to change `ref` as a clause, "; change it under …", for a contextual or Advanced setting; nothing for a visible
 * one. What the page needs first to show it is left out: a limit is hit only while its feature is in use, which is when
 * the page shows it (`disclosureReport` says it for a read).
 */
export const changeItUnder = (ref: SettingRef): string =>
  disclosureOf(ref) === "visible" ? "" : `; change it under ${settingPlace(ref)}`;

/**
 * Where to change several settings of one place as a clause: "; change them under MCP servers › Settings server ›
 * Advanced › Strikes, Strike window (minutes) and Strike lock (minutes)". Each is a contextual or Advanced setting.
 */
export const changeThemUnder = (refs: ReadonlyArray<SettingRef>): string => {
  const paths = refs.map((ref) => settingPlace(ref).split(" › "));
  const shared = paths[0]!.slice(0, -1);
  const titles = paths.map((path) => path.at(-1)!);
  const listed = titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
  return `; change them under ${[...shared, listed].join(" › ")}`;
};

/** `count` of a unit as a limit's value reads before a noun: "15-minute", "1-second". */
export const limitValue = (count: number, unit: string): string => `${count.toLocaleString("en-US")}-${unit}`;

/**
 * A time limit, hit, to the end of its sentence: "its 15-minute time limit", then `rest` (what the sentence goes on to
 * say: an error, a date), then where to change it (`changeItUnder`), last. `value` absent: a report from before the
 * limit was carried, "its time limit".
 */
export const timeLimitHit = (
  value: number | undefined,
  unit: "minute" | "second",
  ref: SettingRef,
  rest = "",
): string => `its ${value === undefined ? "" : `${limitValue(value, unit)} `}time limit${rest}${changeItUnder(ref)}`;

/**
 * A hold, hit, to the end of its sentence (SPI-1431): "30-minute Terminal hold while a command runs", its value then its
 * setting's title without the title's unit, then where to change it (`changeItUnder`), last.
 */
export const holdHit = (value: number, unit: "minute" | "second", ref: SettingRef): string =>
  `${limitValue(value, unit)} ${placed(ref).entry.title.replace(/ \([^)]*\)$/, "")}${changeItUnder(ref)}`;

/** What shows a contextual setting, in words: "shown while Container size is custom". */
export const shownWhen = (condition: DisclosureCondition, extension?: ExtensionEntry): string => {
  const titleOf = (key: string) =>
    (ENVIRONMENT_SETTINGS as Readonly<Record<string, EnvironmentSettingEntry>>)[key]?.title ?? key;
  if ("equals" in condition)
    return `shown while ${condition.settings.map(titleOf).join(" or ")} is ${condition.equals}`;
  if ("filled" in condition) return `shown while ${titleOf(condition.filled)} is not empty`;
  if ("toolOn" in condition) return `shown while ${condition.toolOn} is offered`;
  return `shown while ${extension?.title ?? "its extension"} is on`;
};

/**
 * Whether a contextual setting's condition holds: `values` the group's settings as they stand (an Environment
 * setting's), `extension` its extension's state (a Harness setting's).
 */
export const conditionHolds = (
  condition: DisclosureCondition,
  values: Readonly<Record<string, unknown>>,
  extension?: { readonly enabled: boolean; readonly toolOn: (tool: string) => boolean },
): boolean => {
  if ("equals" in condition) return condition.settings.some((key) => values[key] === condition.equals);
  if ("filled" in condition)
    return typeof values[condition.filled] === "string" && (values[condition.filled] as string).trim() !== "";
  if ("toolOn" in condition) return extension?.toolOn(condition.toolOn) === true;
  return extension?.enabled === true;
};

/**
 * A setting's disclosure as the Settings server's read reports it (ADR-0035's ADR-0049 refinement): its level, what
 * shows it where something must hold first (a contextual setting's condition; an extension's Advanced setting's
 * extension being on), and where on the page it is, after what to turn on first, so an agent can point the Owner to it.
 */
export const disclosureReport = (
  ref: SettingRef,
): {
  readonly disclosure: "visible" | "contextual" | "advanced";
  readonly shownWhen?: string;
  readonly where: string;
} => {
  const disclosure = disclosureOf(ref);
  const level = typeof disclosure === "string" ? disclosure : "contextual";
  const required = requirement(ref);
  // A read may come while the feature is off, so the place says what to do first: "turn Guardian on, then …".
  const place = settingPlace(ref);
  return {
    disclosure: level,
    ...(required === undefined ? {} : { shownWhen: required.shownWhen }),
    where: required?.first === undefined ? place : `${required.first}, then ${place}`,
  };
};

/**
 * Extension `id` as `resolved` has it, or its defaults when `resolved` predates the entry (a Session keeps the view it
 * last took, and a deploy can add an entry before the Session's next turn reads the settings again).
 */
export const extensionOf = (
  resolved: ResolvedHarness,
  id: string,
): { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>> } => {
  const taken = resolved.extensions[id];
  const entry = entryOf(id);
  if (entry === undefined) return taken ?? { enabled: false, settings: {} };
  const defaults = Object.fromEntries(
    Object.entries(entry.settings).map(([key, setting]) => [key, setting.schema.default]),
  );
  const tools = entry.tools === undefined ? undefined : resolvedToolsOf(resolved).tools;
  const enabled =
    tools === undefined || entry.tools === undefined
      ? (taken?.enabled ?? entry.default !== "off")
      : entry.tools.some((tool) => tools[tool] !== "hidden");
  return { enabled, settings: { ...defaults, ...taken?.settings } };
};

/** Extension `id`'s settings with nothing stored: each its schema's default. */
export const defaultSettings = (id: string): Readonly<Record<string, SettingValue>> =>
  extensionOf(resolveHarness(EMPTY_HARNESS), id).settings;

/** The tools' Exposures of a resolved view, a view kept from before Exposures existed included. */
export const resolvedToolsOf = (resolved: ResolvedHarness): ResolvedTools =>
  resolved.tools !== undefined && resolved.t3 !== undefined
    ? { tools: resolved.tools, t3: resolved.t3 }
    : legacyResolvedTools(resolved);

/**
 * One scope's stored choices: per extension, its switch and the settings set explicitly; per tool, its Exposure
 * (tools.ts). A stored switch of an extension that now has tools, and the retired offered-tools preset, are read only to
 * resolve a tool with no Exposure of its own.
 */
export interface HarnessLayer extends ToolsLayer {
  readonly extensions?: Readonly<
    Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, SettingValue>> }>
  >;
}

/** What the Environment DO stores (`t3flare:harness:settings`). */
export interface StoredHarness {
  /** Bumped by every change; a Session reinstalls what changed when it sees a new one. */
  readonly revision: number;
  readonly global: HarnessLayer;
  /** The MCP server set (ADR-0028), Environment-wide: the servers the owner added. */
  readonly mcp?: { readonly servers: Readonly<Record<string, McpServerSetting>> };
  /** Per-Project overrides, by project id: the later seam (empty now). */
  readonly overrides: Readonly<Record<string, HarnessLayer>>;
}

export const EMPTY_HARNESS: StoredHarness = { revision: 0, global: {}, overrides: {} };

/**
 * The MCP server set (ADR-0028): the direct servers the owner added, and the Settings server's entry (on, deferred and
 * read-write, plan D2), implied until a change stores one. Any other stored kind is dropped (the retired built-in
 * `commissary` kind among them, before SPI-1160), so its name is free and the next change saves the set without it.
 */
export const mcpServersOf = (stored: StoredHarness): Readonly<Record<string, McpServerSetting>> => ({
  // The Settings server's own entry is set last, from `settingsEntryOf`; no other entry may take its name.
  ...Object.fromEntries(
    Object.entries(stored.mcp?.servers ?? {}).filter(
      ([name, server]) => server.kind === "direct" && name !== SETTINGS_SERVER,
    ),
  ),
  settings: settingsEntryOf(stored),
});

/**
 * A stored entry the set ignores (plan D2, SPI-1197 review): a server stored under the Settings server's name that is
 * not the Settings server (a Direct server named `settings`, added before the name was reserved), or an entry of kind
 * `settings` under any other name. Ignored, never mistaken for the Settings server; the panel's Status names it, and
 * the next change to the set drops it from storage.
 */
const ignoredServer = (name: string, server: McpServerSetting): boolean =>
  (name === SETTINGS_SERVER) !== (server.kind === "settings");

/** The Settings server's entry: the stored one when it is of kind `settings`, else the implied default. */
const settingsEntryOf = (stored: StoredHarness): McpServerSetting => {
  const kept = stored.mcp?.servers?.[SETTINGS_SERVER];
  return kept !== undefined && kept.kind === "settings" ? kept : defaultSettingsServer();
};

/**
 * The Settings server's limits (SPI-1322) from the ones `set` on its entry: each one set, else its default. A value that
 * no longer fits its schema (a store from another version) reads as its default, as `resolveEnvironment` reads one.
 */
export const resolveSettingsServerLimits = (set: Readonly<Record<string, unknown>> | undefined): SettingsServerLimits =>
  Object.fromEntries(
    SETTINGS_SERVER_LIMIT_KEYS.map((key) => {
      const value = set === undefined || !Object.hasOwn(set, key) ? undefined : set[key];
      const schema = SETTINGS_SERVER_LIMITS[key].schema;
      return [key, value !== undefined && fieldProblem(schema, value) === undefined ? value : schema.default];
    }),
  ) as SettingsServerLimits;

/** The Settings server's limits from the stored Harness settings (`resolveSettingsServerLimits` of its entry's). */
export const settingsServerLimitsOf = (stored: StoredHarness): SettingsServerLimits =>
  resolveSettingsServerLimits(settingsEntryOf(stored).limits);

/** The Settings server's limits with none set: each its schema's default, today's values (SPI-1322). */
export const DEFAULT_SETTINGS_SERVER_LIMITS: SettingsServerLimits = resolveSettingsServerLimits(undefined);

/** One limit a change names (SPI-1322): its value now and the one asked for; `before` undefined: not a known limit. */
export interface MovedLimit {
  readonly key: string;
  readonly before: number | undefined;
  readonly after: unknown;
}

/**
 * The limits `limits` moves against `stored`'s (SPI-1322): each named key that is not a limit, and each limit whose
 * value differs from its value now. One set to its value now moves nothing. What `mcpTier` and the Change page judge.
 */
export const movedLimits = (
  stored: StoredHarness,
  limits: Readonly<Record<string, unknown>>,
): ReadonlyArray<MovedLimit> => {
  const now: Readonly<Record<string, number>> = settingsServerLimitsOf(stored);
  return Object.entries(limits).flatMap(([key, after]) => {
    const before = Object.hasOwn(now, key) ? now[key] : undefined;
    return before === after ? [] : [{ key, before, after }];
  });
};

/** The names of stored MCP entries the set ignores (`ignoredServer`), for the panel's Status. */
export const ignoredServersOf = (stored: StoredHarness): ReadonlyArray<string> =>
  Object.entries(stored.mcp?.servers ?? {})
    .filter(([name, server]) => ignoredServer(name, server))
    .map(([name]) => name);

/** One change to the MCP server set from the panel or a script. */
export type McpChange =
  | {
      readonly op: "server";
      readonly server: string;
      readonly enabled?: boolean;
      readonly exposure?: Exposure;
      readonly toolExposure?: Readonly<Record<string, Exposure | null>>;
      /** The Settings server's entry only (plan D2): whether its write tools are offered. */
      readonly writes?: boolean;
      /**
       * The Settings server's entry only (SPI-1322): some of its limits (`SETTINGS_SERVER_LIMITS`), merged over those
       * set. Each is checked against its schema.
       */
      readonly limits?: Readonly<Record<string, unknown>>;
    }
  /** The owner's class for a tool; `null` returns it to the tool's own hint. */
  | { readonly op: "class"; readonly server: string; readonly tool: string; readonly class: ToolClass | null }
  | { readonly op: "add"; readonly server: string; readonly url: string; readonly auth: ServerAuth }
  | { readonly op: "remove"; readonly server: string };

/** `url` as a direct server may have it (plan §5.3, review M5): HTTPS, a name not an IP literal, no userinfo, no port games. */
export const directUrlProblem = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a URL";
  }
  if (parsed.protocol !== "https:") return "only https";
  if (parsed.username !== "" || parsed.password !== "") return "no credentials in the URL";
  const host = parsed.hostname.toLowerCase();
  if (
    /^[\d.]+$/.test(host) ||
    host.startsWith("[") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  )
    return "a public host name, not an address";
  return undefined;
};

/**
 * `url` without its query and fragment (plan D14): a Direct server's URL may carry a key in its query, so whatever shows
 * it outside the panel shows this. Text the URL parser refuses (a bad port, an empty host) is cut at its first `?` or
 * `#` (SPI-1195 review): a key in a malformed URL is still a key.
 */
export const withoutQuery = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
  if (parsed.search === "" && parsed.hash === "") return url;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
};

/** `stored` with the MCP `change` applied and the revision bumped, or why it is refused. */
export const applyMcpChange = (
  stored: StoredHarness,
  change: McpChange,
): { readonly ok: true; readonly harness: StoredHarness } | { readonly ok: false; readonly error: string } => {
  const servers: Record<string, McpServerSetting> = { ...mcpServersOf(stored) };
  const current = Object.hasOwn(servers, change.server) ? servers[change.server] : undefined;
  const save = (next: Record<string, McpServerSetting>) => ({
    ok: true as const,
    harness: { ...stored, revision: stored.revision + 1, mcp: { servers: next } },
  });
  if (change.op === "add") {
    if (!SERVER_NAME.test(change.server)) return { ok: false, error: `${change.server}: a name of a-z, 0-9 and -` };
    if (RESERVED_SERVER_NAMES.has(change.server)) return { ok: false, error: `${change.server}: reserved` };
    if (current !== undefined) return { ok: false, error: `${change.server}: exists` };
    const problem = directUrlProblem(change.url);
    if (problem !== undefined) return { ok: false, error: `${change.server}: ${problem}` };
    if (change.auth.kind === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(change.auth.header))
      return { ok: false, error: `${change.server}: a header name` };
    return save({
      ...servers,
      [change.server]: { kind: "direct", url: change.url, auth: change.auth, enabled: true, exposure: "deferred" },
    });
  }
  if (current === undefined) return { ok: false, error: `${change.server}: no such server` };
  if (change.op === "remove") {
    if (current.kind === "settings") return { ok: false, error: `${change.server}: disable it instead` };
    const { [change.server]: _removed, ...rest } = servers;
    return save(rest);
  }
  if (change.op === "class") {
    // The Settings server's tools have fixed classes (plan D2), for the panel as for everyone.
    if (current.kind === "settings") return { ok: false, error: `${change.server}: its tools' classes are fixed` };
    if (change.class !== null && change.class !== "read" && change.class !== "write")
      return { ok: false, error: "class: read, write or null" };
    const { [change.tool]: _previous, ...classes } = current.classes ?? {};
    return save({
      ...servers,
      [change.server]: {
        ...current,
        classes: change.class === null ? classes : { ...classes, [change.tool]: change.class },
      },
    });
  }
  if (change.exposure !== undefined && !EXPOSURES.includes(change.exposure))
    return { ok: false, error: `exposure: one of ${EXPOSURES.join(", ")}` };
  if (change.enabled !== undefined && typeof change.enabled !== "boolean")
    return { ok: false, error: "enabled: true or false" };
  if (change.writes !== undefined) {
    if (current.kind !== "settings")
      return { ok: false, error: `${change.server}: only the Settings server has a writes switch` };
    if (typeof change.writes !== "boolean") return { ok: false, error: "writes: true or false" };
  }
  const limits = new Map<string, number>(Object.entries(current.limits ?? {}));
  if (change.limits !== undefined) {
    if (current.kind !== "settings")
      return { ok: false, error: `${change.server}: only the Settings server has limits` };
    if (typeof change.limits !== "object" || change.limits === null || Array.isArray(change.limits))
      return { ok: false, error: "limits: an object of limits" };
    for (const [key, value] of Object.entries(change.limits)) {
      const entry = (SETTINGS_SERVER_LIMITS as Readonly<Record<string, SettingEntry>>)[key];
      if (entry === undefined || !Object.hasOwn(SETTINGS_SERVER_LIMITS, key))
        return { ok: false, error: `limits.${key}: not a limit of the Settings server` };
      const problem = fieldProblem(entry.schema, value);
      if (problem !== undefined) return { ok: false, error: `limits.${key}: ${problem}` };
      limits.set(key, value as number);
    }
  }
  // A Map, so a tool named `__proto__` is a key like any other (SPI-1198 review), never the object's prototype.
  const exposures = new Map<string, Exposure>(Object.entries(current.toolExposure ?? {}));
  for (const [tool, exposure] of Object.entries(change.toolExposure ?? {})) {
    if (exposure === null) exposures.delete(tool);
    else if (!EXPOSURES.includes(exposure)) return { ok: false, error: `exposure: one of ${EXPOSURES.join(", ")}` };
    else exposures.set(tool, exposure);
  }
  const toolExposure: Record<string, Exposure> = Object.fromEntries(exposures);
  return save({
    ...servers,
    [change.server]: {
      ...current,
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.exposure === undefined ? {} : { exposure: change.exposure }),
      ...(change.writes === undefined ? {} : { writes: change.writes }),
      ...(change.limits === undefined ? {} : { limits: Object.fromEntries(limits) }),
      toolExposure,
    },
  });
};

/** What a Session reads: secret-free, every extension and tool resolved. */
export interface ResolvedHarness extends Partial<ResolvedTools> {
  readonly revision: number;
  readonly extensions: Readonly<
    Record<string, { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>> }>
  >;
  readonly codemode: { readonly enabled: boolean; readonly inlineBudget: number; readonly interruptBudget: number };
  readonly toolSearch: { readonly enabled: boolean };
  /**
   * A view from before Exposures existed: names or patterns of the tools offered without a search. A Session keeps the
   * view it last took (`resolvedToolsOf` reads it); a view resolved now has `tools` and `t3` instead.
   */
  readonly offered?: ReadonlyArray<string>;
}

/** The merge: the override's switch over Global's, its settings over Global's key by key. */
const merge = (base: HarnessLayer, over: HarnessLayer | undefined): HarnessLayer => {
  if (over === undefined) return base;
  const extensions = { ...base.extensions };
  for (const [id, choice] of Object.entries(over.extensions ?? {})) {
    const before = extensions[id];
    extensions[id] = {
      ...before,
      ...(choice.enabled === undefined ? {} : { enabled: choice.enabled }),
      settings: { ...before?.settings, ...choice.settings },
    };
  }
  const t3Exposure = over.t3?.exposure ?? base.t3?.exposure;
  return {
    extensions,
    tools: { ...base.tools, ...over.tools },
    t3: {
      ...(t3Exposure === undefined ? {} : { exposure: t3Exposure }),
      tools: { ...base.t3?.tools, ...over.t3?.tools },
    },
  };
};

/** The settings for a Session of `projectId` (Global only when it has no override). */
export const resolveHarness = (
  stored: StoredHarness,
  scope: { readonly projectId?: string } = {},
): ResolvedHarness & ResolvedTools => {
  const layer = merge(stored.global, scope.projectId === undefined ? undefined : stored.overrides[scope.projectId]);
  const tools = resolveTools(layer);
  const extensions: Record<string, { enabled: boolean; settings: Record<string, SettingValue> }> = {};
  for (const entry of EXTENSIONS) {
    const choice = layer.extensions?.[entry.id];
    const settings: Record<string, SettingValue> = {};
    for (const [key, setting] of Object.entries(entry.settings))
      settings[key] = choice?.settings?.[key] ?? setting.schema.default;
    const enabled =
      entry.tools !== undefined
        ? entry.tools.some((tool) => tools.tools[tool] !== "hidden")
        : entry.default === "always" || entry.locked !== undefined
          ? true
          : (choice?.enabled ?? entry.default === "on");
    extensions[entry.id] = { enabled, settings };
  }
  return {
    revision: stored.revision,
    extensions,
    codemode: {
      enabled: extensions.codemode!.enabled,
      inlineBudget: extensions.codemode!.settings.inlineBudget as number,
      interruptBudget: extensions.codemode!.settings.interruptBudget as number,
    },
    toolSearch: { enabled: extensions["tool-search"]!.enabled },
    ...tools,
  };
};

/** One change from the panel or a script: an extension's switch, or some of its settings. */
export interface HarnessChange {
  readonly extension: string;
  readonly enabled?: boolean;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** `stored` with `change` applied to Global and the revision bumped, or why it is refused. */
export const applyChange = (
  stored: StoredHarness,
  change: HarnessChange,
): { readonly ok: true; readonly harness: StoredHarness } | { readonly ok: false; readonly error: string } => {
  const entry = entryOf(change.extension);
  if (entry === undefined) return { ok: false, error: `${change.extension}: no such extension` };
  if (entry.locked !== undefined) return { ok: false, error: `${entry.id}: locked (${entry.locked})` };
  if (change.enabled !== undefined && entry.default === "always")
    return { ok: false, error: `${entry.id}: cannot be turned off` };
  if (change.enabled !== undefined && entry.tools !== undefined)
    return {
      ok: false,
      error: `${entry.id}: on while any of its tools is not hidden; set its tools' Exposure instead`,
    };
  // A stored non-boolean would resolve to the default, which may be on (fails closed here, before any tier is judged).
  if (change.enabled !== undefined && typeof change.enabled !== "boolean")
    return { ok: false, error: "enabled: true or false" };
  for (const [key, value] of Object.entries(change.settings ?? {})) {
    const setting = Object.hasOwn(entry.settings, key) ? entry.settings[key] : undefined;
    if (setting === undefined) return { ok: false, error: `${entry.id}.${key}: no such setting` };
    const why = fieldProblem(setting.schema, value);
    if (why !== undefined) return { ok: false, error: `${entry.id}.${key}: ${why}` };
  }
  const before = stored.global.extensions?.[entry.id];
  const next = {
    ...before,
    ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
    settings: { ...before?.settings, ...(change.settings as Record<string, SettingValue> | undefined) },
  };
  const harness: StoredHarness = {
    ...stored,
    revision: stored.revision + 1,
    // The rest of Global (the tools' Exposures, t3's tools) stays as it was.
    global: { ...stored.global, extensions: { ...stored.global.extensions, [entry.id]: next } },
  };
  // No length per text setting: the Harness settings are one Durable Object value, which bounds them together.
  const tooLarge = storedValueProblem("the Harness settings", harness);
  return tooLarge === undefined ? { ok: true, harness } : { ok: false, error: tooLarge };
};
export { CARD_TEXT_MAX, cardText, visible, withoutHidden } from "./cardText.ts";
export { isDeniedT3Tool, T3_TOOL_DENYLIST } from "./t3Tools.ts";
export { descriptionFor, guidanceFor, toolLikeNamesIn } from "./t3Guidance.ts";
export * from "./globalMise.ts";
export * from "./containerSetup.ts";
export * from "./baseBuild.ts";
export * from "./storedValue.ts";
export * from "./tiers.ts";
