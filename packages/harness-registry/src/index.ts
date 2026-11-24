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
  type ServerAuth,
  type SettingsServerLimits,
  type ToolClass,
} from "./mcp.ts";
import {
  DEFAULT_TERMINALS_PER_WORKSPACE,
  ENVIRONMENT_SETTINGS,
  MAX_STOP_GRACE_SECONDS,
  MAX_TIMED_MINUTES,
  MAX_TIMED_SECONDS,
} from "./environment.ts";
import { fieldProblem, type SettingEntry, type SettingValue } from "./fields.ts";
import { EXPOSURES, legacyResolvedTools, type ResolvedTools, resolveTools, type ToolsLayer } from "./tools.ts";

export * from "./mcp.ts";
export * from "./fields.ts";
export * from "./environment.ts";
export * from "./tools.ts";

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
const modelSetting = (title: string, description: string, fallback: string): SettingEntry => ({
  title,
  description,
  schema: { type: "text", maxLength: 300, default: fallback },
});
const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
/**
 * The largest body web_fetch converts from HTML or JSON; a larger one is returned as it came. A named constraint: a
 * Worker isolate's 128 MB, which also holds the Session's own state. Conversion costs about 7 times the body: measured
 * in workerd (apps/agents/test/webFetchMemory.workerd.test.ts), 5 MiB of two-byte HTML takes 24 MB of heap to convert,
 * plus 10 MB of body buffers outside it, about 34 MB of the 128, which leaves the Session most of the isolate. 5 MiB was
 * also the size limit before it was a setting, so every page that converted then still does.
 */
export const FETCH_CONVERT_MAX_KIB = 5120;
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

/** termctrl's settle constant (pi-termctrl's `terminal-tools.ts`): a Terminal's quiet before a wait answers, in ms. */
export const DEFAULT_TERMINAL_QUIET_MS = 250;

/**
 * How long terminal_stop waits for an entry's exit after its close by default, in seconds: termctrl's
 * DEFAULT_STOP_GRACE_MS (`termctrl-registry.ts`).
 */
export const DEFAULT_TERMINAL_STOP_GRACE_SECONDS = 3;

/**
 * The most `fetchMaxKiB` may be set to. A named constraint: a Worker isolate's 128 MB holds the body, its decoded text
 * and the lines web_fetch pages through, beside the Session itself, and an isolate out of memory resets the Session
 * mid-turn. Measured in workerd (apps/agents/test/webFetchMemory.workerd.test.ts): 16 MiB of two-byte HTML, returned
 * unconverted, takes 32 MB of heap plus 32 MB of body buffers outside it, about 64 MB, half the isolate. 32 MiB took
 * 64 MB of heap, about 128 MB in all.
 */
export const FETCH_MAX_KIB = 16_384;
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
 * The least KiB and lines of a tool's result the model may be shown. A named constraint, t3flare's own correctness: a
 * tool keeps room inside its output limit for its own notes (a Terminal's header and the scrolled-off lines, which take
 * at most half; web_fetch's continuation note; a History page's envelope), which needs a few KiB and lines.
 */
export const MIN_TOOL_OUTPUT_KIB = 4;
export const MIN_TOOL_OUTPUT_LINES = 50;
/** The Tool output limit's defaults: pi-durable's own (`DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`), today's values. */
export const DEFAULT_TOOL_OUTPUT_KIB = 50;
export const DEFAULT_TOOL_OUTPUT_LINES = 2000;
/** A sanity bound (ADR-0048) for a count of lines, entries or results: nothing in t3flare forces it. */
const MAX_COUNT = 100_000;
/** A sanity bound (ADR-0048) for a count of characters: nothing in t3flare forces it. */
const MAX_CHARACTERS = 1_000_000;
/** A sanity bound (ADR-0048) for one line's preview: nothing in t3flare forces it. */
const MAX_PREVIEW_CHARACTERS = 10_000;
/** The longest wait a Terminal's wait settings take, in ms (ADR-0048 §2): the wait runs in Workspace slices toward one deadline. */
const MAX_WAIT_MS = MAX_TIMED_MINUTES * 60_000;
/** A Terminal wait setting: `default` ms when a call names no wait, `description` its own, its maximum stated. */
const waitMsSetting = (title: string, description: string, fallback: number): SettingEntry => ({
  title,
  description: `${description} At most ${MAX_WAIT_MS.toLocaleString("en-US")} (a week).`,
  // MAX_WAIT_MS: t3flare times the wait itself (ADR-0048 §2).
  schema: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, default: fallback },
  tier: "free",
});
/** The Guardian's evidence budget, in characters of untrusted evidence a Review carries (about pi-guardian's 32,000-token ceiling). */
export const GUARDIAN_EVIDENCE_CHARACTERS = 96_000;

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
          "Estimated tokens the tool declarations in the code mode section may use; past it, scripts find tools with searchTools().",
        schema: { type: "integer", minimum: 500, maximum: 20_000, default: 2_000 },
        tier: "free",
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
    description:
      "How much of each tool's result the model is shown, for every tool but code mode and todo, which keep their own: bash keeps the last part of its output, the others their first, and the result says what was left out. read pages through a file in at most 50 KiB or 2,000 lines per call, and never more than these.",
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
      },
      outputLines: {
        title: "Output lines shown to the model",
        description: `The most lines of one tool result the model reads, whichever of the two limits comes first. At most ${MAX_COUNT.toLocaleString("en-US")}.`,
        // MAX_COUNT: a sanity bound (ADR-0048), pi-durable's own code mode limit; the KiB limit bounds the row.
        // MIN_TOOL_OUTPUT_LINES: a named constraint (a tool's own notes).
        schema: {
          type: "integer",
          minimum: MIN_TOOL_OUTPUT_LINES,
          maximum: MAX_COUNT,
          default: DEFAULT_TOOL_OUTPUT_LINES,
        },
        tier: "down-free",
      },
    },
  },
  {
    id: "files",
    title: "File tools",
    description: "ls, find and grep. Larger results use more of the model's context on every call.",
    default: "on",
    tools: ["ls", "find", "grep"],
    settings: {
      lsLimit: {
        title: "Entries per ls call",
        description: "The most entries one ls call lists; also what it lists when a call asks for no limit.",
        // MAX_COUNT: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: MAX_COUNT, default: 500 },
        tier: "down-free",
      },
      findLimit: {
        title: "Results per find call",
        description: "The most paths one find call returns; also what it returns when a call asks for no limit.",
        // MAX_COUNT: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: MAX_COUNT, default: 1000 },
        tier: "down-free",
      },
      grepLimit: {
        title: "Matches per grep call",
        description: "The most matches one grep call returns; also what it returns when a call asks for no limit.",
        // MAX_COUNT: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: MAX_COUNT, default: 100 },
        tier: "down-free",
      },
    },
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
      fetchTimeoutSeconds: {
        title: "Fetch time limit (seconds)",
        description: "How long a web_fetch call that names no timeout of its own may take in all.",
        // Timed by t3flare's own setTimeout (net.ts withDeadline): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 30 },
        tier: "down-free",
      },
      fetchMaxTimeoutSeconds: {
        title: "Longest fetch time limit a call may set (seconds)",
        description:
          "The longest timeout a web_fetch call may set; the fetch time limit above is always allowed, even when longer.",
        // Timed by t3flare's own setTimeout (net.ts withDeadline): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 120 },
        tier: "down-free",
      },
      fetchMaxKiB: {
        title: "Fetch size limit (KiB)",
        description: `The largest response body web_fetch reads; a larger one is refused. An HTML or JSON body over ${FETCH_CONVERT_MAX_KIB / 1024} MiB is returned as it came, without conversion to Markdown or text.`,
        // A named constraint: FETCH_MAX_KIB.
        schema: { type: "integer", minimum: 64, maximum: FETCH_MAX_KIB, default: 5120 },
        tier: "down-free",
      },
      searchModel: modelSetting(
        "Search model",
        "The model that runs web_search's searches: an Anthropic Messages Model endpoint's model with an API key or no auth whose server takes Anthropic's web search tool, as <endpointId>/<modelId>, or default (the endpoints' small model).",
        "default",
      ),
      searchResults: {
        title: "Search results",
        description: "How many results web_search returns when a call doesn't ask for a number.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 100, default: 8 },
        tier: "down-free",
      },
      searchesPerCall: {
        title: "Searches per call",
        description:
          "The most searches the search model may run for one web_search call. Each web_search query is a model request on the search model's endpoint.",
        // 50: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 50, default: 2 },
        tier: "down-free",
      },
      searchSummaryTokens: {
        title: "Search summary tokens",
        description: "The most tokens the search model may write for one web_search call's summary.",
        // 64,000: a sanity bound; the endpoint itself refuses a value past its model's own output limit (ADR-0048).
        schema: { type: "integer", minimum: 100, maximum: 64_000, default: 1500 },
        tier: "down-free",
      },
      searchTimeoutSeconds: {
        title: "Search time limit (seconds)",
        description: "How long one web_search call may take in all, reading the search model's answer included.",
        // Timed by t3flare's own setTimeout (net.ts withDeadline): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 90 },
        tier: "down-free",
      },
      searchContextCharacters: {
        title: "Search result characters",
        description: `The characters of result text one web_search call shares across its results when the call names no budget of its own; past it, results are shortened or lose their text, never their title and URL. More puts more of each page in front of the model, still within Tool output's limit. At most ${MAX_CHARACTERS.toLocaleString("en-US")}.`,
        // MAX_CHARACTERS: a sanity bound (ADR-0048); the Tool output limit cuts what the model reads in any case.
        schema: { type: "integer", minimum: 100, maximum: MAX_CHARACTERS, default: 6000 },
        tier: "down-free",
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
      },
      previewCharacters: {
        title: "History preview (characters)",
        description: `How many characters each line of a context_history list shows, and each match of a context_history or context_notes search. Longer previews show more of each entry, and each page takes more of the model's context. At most ${MAX_PREVIEW_CHARACTERS.toLocaleString("en-US")}.`,
        // MAX_PREVIEW_CHARACTERS: a sanity bound (ADR-0048); the Tool output limit cuts a page in any case.
        schema: { type: "integer", minimum: 12, maximum: MAX_PREVIEW_CHARACTERS, default: 120 },
        tier: "down-free",
      },
    },
  },
  {
    id: "termctrl",
    title: "Terminals and Background jobs",
    description: `terminal_start, terminal_send, terminal_stop, terminal_list and terminal_wait: interactive programs (REPLs, TUIs, prompts) as PTYs in the Workspace's container, and bash's background: true. Approvals follow the thread's mode as bash's do; nothing starts a container until a Terminal or a job starts. At most the Environment setting ${ENVIRONMENT_SETTINGS.agentTerminalsPerWorkspace.title} (${DEFAULT_TERMINALS_PER_WORKSPACE} by default) run at once in a Workspace, and they end with its container (SPI-1057).`,
    default: "on",
    tools: ["terminal_start", "terminal_send", "terminal_stop", "terminal_list", "terminal_wait"],
    settings: {
      backgroundBash: {
        title: "Background jobs from bash",
        description:
          "Offer bash's background parameter: a command still running after the Start wait becomes a Background job.",
        schema: { type: "boolean", default: true },
        tier: "down-free",
      },
      cols: {
        title: "Columns",
        description: "A Terminal's width.",
        schema: { type: "integer", minimum: 40, maximum: 400, default: 120 },
        tier: "free",
      },
      rows: {
        title: "Rows",
        description: "A Terminal's height.",
        schema: { type: "integer", minimum: 10, maximum: 200, default: 40 },
        tier: "free",
      },
      startWaitMs: waitMsSetting(
        "Start wait (ms)",
        "How long terminal_start waits for a new Terminal's screen to settle when the call names no wait, and how long bash with background: true runs before the command becomes a Background job (0: at once). Longer holds the agent's call that long; shorter can return a screen still drawing.",
        2000,
      ),
      inputWaitMs: waitMsSetting(
        "Input wait (ms)",
        "How long terminal_send waits for the screen to settle after typing when the call names no wait. Shorter returns sooner, possibly before the program has answered.",
        500,
      ),
      pollWaitMs: waitMsSetting(
        "Poll wait (ms)",
        "How long terminal_send with nothing to type waits for new output when the call names no wait. The agent's call is held up to this long while a program is quiet.",
        30_000,
      ),
      scrollbackLines: {
        title: "Scrollback lines shown",
        description: `How many lines that scrolled off a Terminal since the agent last looked its next result shows; past this, the first and last are kept and the middle dropped. More shows the agent more of what it missed and leaves less room for the rest of the result. Never more than the Environment setting ${ENVIRONMENT_SETTINGS.agentTerminalScrollbackLines.title} keeps. At most ${MAX_COUNT.toLocaleString("en-US")}.`,
        // MAX_COUNT: a sanity bound (ADR-0048); the lines shown take at most half the Tool output limit in any case.
        schema: { type: "integer", minimum: 2, maximum: MAX_COUNT, default: 100 },
        tier: "down-free",
      },
      scrollbackKiB: {
        title: "Scrollback KiB shown",
        description: `The most KiB of those lines a result shows, whichever limit comes first. Never more than half of Tool output's Output shown to the model, so the current screen always fits beside them. At most ${MAX_TOOL_OUTPUT_KIB}.`,
        // MAX_TOOL_OUTPUT_KIB: a sanity bound (ADR-0048). Above half the Tool output limit in effect, that half is used
        // instead, so no value past the Tool output limit's own maximum can matter.
        schema: { type: "integer", minimum: 1, maximum: MAX_TOOL_OUTPUT_KIB, default: 16 },
        tier: "down-free",
      },
      quietMs: {
        title: "Quiet before a Terminal settles (ms)",
        description: `A wait on a Terminal answers once its screen has had no new output for this long. Shorter answers sooner but may catch a program between bursts of output, so the agent reads a screen that is still changing. At most ${MAX_TIMED_MINUTES * 60_000} (a week). Applies at each thread's next turn.`,
        // Compared with the clock between 50 ms polls (agentTerminals.ts), no timer: the shared sanity maximum applies
        // (ADR-0048 §2), in ms.
        schema: {
          type: "integer",
          minimum: 50,
          maximum: MAX_TIMED_MINUTES * 60_000,
          default: DEFAULT_TERMINAL_QUIET_MS,
        },
        tier: "free",
      },
      stopGraceSeconds: {
        title: "Stopped Terminal's wait (seconds)",
        description: `How long terminal_stop waits for a Terminal or Background job to end after closing it, before it kills its processes again. A program that ignores the close keeps the stop waiting this long. At most ${MAX_STOP_GRACE_SECONDS}. Applies at each thread's next turn.`,
        // A sanity bound (`MAX_STOP_GRACE_SECONDS`).
        schema: {
          type: "integer",
          minimum: 1,
          maximum: MAX_STOP_GRACE_SECONDS,
          default: DEFAULT_TERMINAL_STOP_GRACE_SECONDS,
        },
        tier: "free",
      },
    },
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
      ),
      thinkingLevel: {
        title: "Thinking",
        description: "The first pass's thinking; a would-be rejection is checked again at low or above.",
        schema: { type: "enum", values: THINKING_LEVELS, default: "off" },
      },
      tools: {
        title: "Tool Policies",
        description:
          "Which tools are reviewed, as name=allow|review|deny pairs separated by commas (bash=review, mcp__github__create_issue=allow). Unlisted tools keep the built-in default: bash reviewed unless a Safe Command, edits to Sensitive Paths and terminals reviewed, read-only tools allowed.",
        schema: { type: "text", maxLength: 4_000, default: "" },
      },
      commands: {
        title: "Command Rules",
        description:
          "Literal command prefixes as prefix=allow|review|deny pairs separated by commas (git push=deny, npm test=allow). deny blocks without a review.",
        schema: { type: "text", maxLength: 4_000, default: "" },
      },
      policy: {
        title: "Security Policy",
        description: "Trusted destinations and forbidden actions, added to the built-in policy the Guardian judges by.",
        schema: { type: "text", maxLength: 8_000, default: "", multiline: true },
      },
      // No `tier`: a Guard's settings are always asked (tiers.ts `extensionTier`).
      reviewTimeoutSeconds: {
        title: "Review time limit (seconds)",
        description: "Every reviewed call waits up to this long; a Review that runs out fails and blocks the call.",
        // Timed by t3flare's own setTimeout (guardian/review.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 60 },
      },
      batchArgumentCharacters: {
        title: "Other calls in the batch (characters)",
        description: `When the model makes several calls at once, how much of each other call the Guardian reads beside the one it reviews: its path and command whole, the rest of its arguments cut to this many characters (0: path and command only). More lets the Guardian judge the calls together, and each Review reads more tokens. At most ${GUARDIAN_EVIDENCE_CHARACTERS.toLocaleString("en-US")}, all the evidence a Review reads.`,
        // GUARDIAN_EVIDENCE_CHARACTERS: a sanity bound (ADR-0048); past it, one batch call outweighs the evidence.
        schema: { type: "integer", minimum: 0, maximum: GUARDIAN_EVIDENCE_CHARACTERS, default: 2000 },
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
      ),
      reviewEvery: {
        title: "Review cadence",
        description:
          "turn: after every tool round that is not read-only; a whole number: every that many rounds and at the end; request: once, when the agent answers. A shorter cadence reviews more often, and each Review is a model request.",
        // Any whole number of rounds (SPI-1365): advisor.ts takes any positive one.
        schema: { type: "enum", values: ["turn", "request"], default: "turn", integers: { minimum: 1 } },
      },
      thinkingLevel: {
        title: "Thinking",
        description: "The Advisor's thinking level.",
        schema: { type: "enum", values: THINKING_LEVELS, default: "high" },
      },
      correctiveTurns: {
        title: "Corrective continuations",
        description:
          "How often a blocker found as the agent answers continues the same turn to address it (0: never); later blockers wait for the next turn.",
        schema: { type: "integer", minimum: 0, maximum: 3, default: 1 },
        tier: "down-free",
      },
      reviewTimeoutSeconds: {
        title: "Review time limit (seconds)",
        description:
          "When the agent answers, its turn waits up to this long for the Review under way and again for a final one; a Review still running after this long is stopped, and the Advisor pauses until its settings change.",
        // Timed by t3flare's own setTimeout (advisor.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 120 },
        tier: "down-free",
      },
      maxFindings: {
        title: "Findings per Review",
        description: "The most findings one Review delivers; the Advisor is asked for at most this many.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 100, default: 4 },
        tier: "down-free",
      },
      maxNits: {
        title: "Nits per request",
        description: "The most Nits delivered while the agent answers one request (0: none).",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 0, maximum: 100, default: 3 },
        tier: "down-free",
      },
      maxToolRounds: {
        title: "Tool rounds per Review",
        description:
          "How many rounds of read, grep, find and ls the Advisor may take in a Review (0: no tool rounds: the Advisor reviews from what it is given). Each tool round is a model request on the Advisor model's endpoint.",
        // 100: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 0, maximum: 100, default: 8 },
        tier: "down-free",
      },
      concernCooldownTurns: {
        title: "Concern cooldown (turns)",
        description:
          "After a Concern, turns before another Concern steers the running agent; one found meanwhile waits for the next Review (0: no cooldown).",
        // 1000: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 0, maximum: 1_000, default: 3 },
        tier: "up-free",
      },
      catchUpBacklog: {
        title: "Catch-up backlog (turns)",
        description:
          "When this many turns wait unreviewed, the agent pauses for the Review under way, for up to the Catch-up wait.",
        // 1000: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 1_000, default: 3 },
        // Free either way: neither key changes spend or what the agent sees. A lower backlog or a longer wait can hold
        // the agent's turn, but never past the Review's own time limit.
        tier: "free",
      },
      catchUpWaitSeconds: {
        title: "Catch-up wait (seconds)",
        description: "How long the agent waits at the catch-up backlog (0: never waits).",
        // Timed by t3flare's own setTimeout (advisor.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_SECONDS, default: 30 },
        // Free either way: see catchUpBacklog.
        tier: "free",
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
    settings: {
      excerptCharacters: {
        title: "Suggestion characters read",
        description: `The most characters of the request and of the answer the small model reads, the last of each; more costs more tokens per suggestion. At most ${MAX_CHARACTERS.toLocaleString("en-US")}.`,
        // MAX_CHARACTERS: a sanity bound (ADR-0048); the small model's own context refuses more in any case.
        schema: { type: "integer", minimum: 100, maximum: MAX_CHARACTERS, default: 4000 },
        tier: "down-free",
      },
      timeoutSeconds: {
        title: "Suggestion time limit (seconds)",
        description: `How long a suggestion may take; a slower one is dropped, and no suggestion shows. At most ${MAX_TIMED_SECONDS.toLocaleString("en-US")} (a week).`,
        // Timed by t3flare's own setTimeout (promptSuggestion.ts): up to MAX_TIMED_SECONDS (ADR-0048 §2).
        schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: 20 },
        tier: "free",
      },
    },
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
    description: "The repo's AGENTS.md and CLAUDE.md in the prompt.",
    default: "always",
    settings: {
      maxFileCharacters: {
        title: "Characters per file",
        description:
          "The most of one AGENTS.md or CLAUDE.md the prompt shows; a longer file is cut. A longer limit puts more of each AGENTS.md or CLAUDE.md in front of the model on every turn.",
        // 1,000,000: a sanity bound, nothing in t3flare forces it (ADR-0048).
        schema: { type: "integer", minimum: 1, maximum: 1_000_000, default: 16_000 },
        tier: "down-free",
      },
    },
  },
];

const entryOf = (id: string) => EXTENSIONS.find((entry) => entry.id === id);

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
    if (!SERVER_NAME.test(change.server))
      return { ok: false, error: `${change.server}: a name of a-z, 0-9 and -` };
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
  return {
    ok: true,
    harness: {
      ...stored,
      revision: stored.revision + 1,
      global: { extensions: { ...stored.global.extensions, [entry.id]: next } },
    },
  };
};
export { CARD_TEXT_MAX, cardText, visible, withoutHidden } from "./cardText.ts";
export { isDeniedT3Tool, T3_TOOL_DENYLIST } from "./t3Tools.ts";
export { descriptionFor, guidanceFor, toolLikeNamesIn } from "./t3Guidance.ts";
export * from "./globalMise.ts";
export * from "./containerSetup.ts";
export * from "./baseBuild.ts";
export * from "./storedValue.ts";
export * from "./tiers.ts";
