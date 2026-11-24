// The MCP rules every caller shares (ADR-0028): the Durable agent's `mcp` extension, the MCP host, and the CLI relay
// judge a call with the same function, and a tool's class is resolved the same way everywhere.
import { MAX_TIMED_MINUTES } from "./environment.ts";
import type { SettingEntry } from "./fields.ts";
import { DO_VALUE_BYTES } from "./storedValue.ts";

export type ToolClass = "read" | "write";
export type RuntimeModeName = "approval-required" | "auto-accept-edits" | "full-access" | (string & {});

/**
 * A call's verdict (plan §3.3): `run`, `refuse`, or `ask` the owner. A linked thread follows its own mode, as in stock t3
 * (owner, 2026-11-12, back to stock: the per-call rule for linked writes is removed).
 */
export type CallVerdict =
  | { readonly kind: "run" }
  | { readonly kind: "ask" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * `record[key]` when `key` is the record's own key, else undefined: a user-supplied key (a tool's or server's name)
 * never reads `Object.prototype` (`toString`, `constructor`, `__proto__`) (SPI-1198 review).
 */
export const ownEntry = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && record !== null && Object.hasOwn(record, key) ? record[key] : undefined;

export const PLAN_REFUSAL =
  "Refused: this thread is in plan mode, which is read-only; this tool may change things outside it.";

export const decideCall = (input: {
  readonly class: ToolClass;
  readonly mode: RuntimeModeName;
  readonly interaction: string;
  /** The owner accepted this tool for the rest of the Session. */
  readonly accepted: boolean;
}): CallVerdict => {
  if (input.class === "read") return { kind: "run" };
  if (input.interaction === "plan") return { kind: "refuse", reason: PLAN_REFUSAL };
  if (input.mode === "full-access" || input.accepted) return { kind: "run" };
  return { kind: "ask" };
};

/**
 * Where a server comes from: added in the panel (Route B), or the Settings server (ADR-0035, plan D2), served
 * in-process by the MCP host. The built-in `commissary` kind is retired (SPI-1160).
 */
export type ServerKind = "direct" | "settings";

/**
 * A tool's class: the owner's choice in the panel, else the tool's own `readOnlyHint` (true: read; anything else: write),
 * as t3 does. Owner, 2026-11-12, back to stock: no definition-hash pins, and a direct server's tools are not write
 * until the owner marks them read.
 */
export const classOf = (
  tool: { readonly annotations?: { readonly readOnlyHint?: unknown } },
  owner: ToolClass | undefined,
): ToolClass => owner ?? (tool.annotations?.readOnlyHint === true ? "read" : "write");

/** pi's limit on a tool name. */
export const MAX_TOOL_NAME = 64;

/** `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_-]` of the tool's name as `_`. */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_").replace(/-/g, "_")}`;

/**
 * The tool names of a server's tools by upstream name, and the tools refused: names that collide once sanitised
 * (review H3: both are refused, so a lookalike cannot take a reviewed tool's name) or that are too long.
 */
export const toolNamesOf = (
  server: string,
  tools: ReadonlyArray<string>,
): {
  readonly names: Readonly<Record<string, string>>;
  readonly refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }>;
} => {
  const byName = new Map<string, Array<string>>();
  for (const tool of tools) {
    const name = mcpToolName(server, tool);
    byName.set(name, [...(byName.get(name) ?? []), tool]);
  }
  const names: Record<string, string> = {};
  const refused: Array<{ tool: string; reason: string }> = [];
  for (const [name, upstream] of byName) {
    if (upstream.length > 1)
      for (const tool of upstream)
        refused.push({
          tool,
          reason: `its name collides with ${upstream.filter((other) => other !== tool).join(", ")} as ${name}`,
        });
    else if (name.length > MAX_TOOL_NAME)
      refused.push({ tool: upstream[0]!, reason: `${name} is longer than ${MAX_TOOL_NAME} characters` });
    else names[upstream[0]!] = name;
  }
  return { names, refused };
};

/** How a server's tools reach the Durable agent. */
export type Exposure = "direct" | "deferred" | "codemode" | "hidden";

/** A direct server's sign-in (Route B). */
export type ServerAuth =
  | { readonly kind: "none" }
  | { readonly kind: "header"; readonly header: string }
  | { readonly kind: "oauth" };

/** One MCP server as the harness settings keep it (no secret: header values and tokens are in the secret store). */
export interface McpServerSetting {
  /** `direct`, or `settings` for the Settings server's own entry; an entry of any other kind is dropped on load (`mcpServersOf`). */
  readonly kind: ServerKind;
  readonly url?: string;
  readonly auth?: ServerAuth;
  readonly enabled: boolean;
  readonly exposure: Exposure;
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  /** The owner's class overrides, by exact upstream tool name. */
  readonly classes?: Readonly<Record<string, ToolClass>>;
  /**
   * Kind `settings` only (plan D2): whether its write tools are offered. Absent reads as true. With `enabled` it is the
   * panel's three-way access switch: off, read-only, read-write.
   */
  readonly writes?: boolean;
  /**
   * Kind `settings` only (SPI-1322): its limits on asking, changing and reading (`SETTINGS_SERVER_LIMITS`), as set.
   * A key not set, or one that no longer fits, reads as its default (`settingsServerLimitsOf`).
   */
  readonly limits?: Readonly<Record<string, number>>;
}

/** The Settings server's name in the MCP server set (plan D2): a Durable agent sees `mcp__settings__<tool>`. */
export const SETTINGS_SERVER = "settings";

/** Names a direct server may not take: they are the relay's, t3's or the Settings server's. */
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["t3", "t3-code", SETTINGS_SERVER]);

/**
 * A direct server's name: a path segment of the relay's (`MCP_RELAY_PREFIX`), so its characters are fixed. Its length is
 * not: each tool's name, `mcp__<server>__<tool>`, is held to t3's 64 characters on its own (`toolNamesOf`).
 */
export const SERVER_NAME = /^[a-z0-9-]+$/;

/** The Settings server's implied entry (plan D2): on, deferred and read-write until a change stores one. */
export const defaultSettingsServer = (): McpServerSetting => ({
  kind: "settings",
  enabled: true,
  exposure: "deferred",
  writes: true,
});

/**
 * The most Open changes per caller may be set to: a sanity bound (ADR-0048 §1). Every access to the changes table reads
 * every open row, and each is small and expires, so nothing near it costs anything that matters.
 */
export const MAX_OPEN_PER_CALLER = 1000;

/** The most a per-hour cap may be set to: a sanity bound (ADR-0048 §1). */
const MAX_PER_HOUR = 100_000;
/** The most strikes a run may need: a sanity bound (ADR-0048 §1), far past any run an Owner would wait for. */
const MAX_STRIKES = 1000;
/**
 * The most minutes a strike window, lock or declined repeat may span: a sanity bound (ADR-0048 §1). These are look-back
 * windows over kept rows, not timers t3flare runs, so ADR-0048 §2's timer limit does not bind them; the shared week is
 * borrowed only as a familiar bound.
 */
const MAX_LOOKBACK_MINUTES = MAX_TIMED_MINUTES;

const perHour = (title: string, description: string, fallback: number) =>
  ({
    title,
    description,
    schema: { type: "integer", minimum: 1, maximum: MAX_PER_HOUR, default: fallback },
  }) as const;

/**
 * The Settings server's limits (SPI-1322, plan D16): how often a caller (an own agent's thread, or an Owner client's
 * Access identity) may ask, change and read through it. Options on its own entry, so every change to them is asked,
 * in either direction (plan D5). Each applies at the caller's next request; what is already recorded is judged by the
 * new values. The per-hour windows themselves are fixed: they are the unit the keys name.
 */
export const SETTINGS_SERVER_LIMITS = {
  strikes: {
    title: "Strikes",
    description:
      "This many asked changes in a row that you decline (or, from an agent's thread, leave unanswered) lock the caller out of asking for the Strike lock.",
    schema: { type: "integer", minimum: 1, maximum: MAX_STRIKES, default: 3 },
  },
  strikeWindowMinutes: {
    title: "Strike window (minutes)",
    description:
      "The strikes count as a run when they fall within this long of each other, or within the Answer wait of each other's when that is longer.",
    schema: { type: "integer", minimum: 1, maximum: MAX_LOOKBACK_MINUTES, default: 60 },
  },
  strikeLockMinutes: {
    title: "Strike lock (minutes)",
    description:
      "How long a run of strikes refuses the caller's asked changes, from the last of them. 0 turns the lock off.",
    schema: { type: "integer", minimum: 0, maximum: MAX_LOOKBACK_MINUTES, default: 60 },
  },
  declinedRepeatMinutes: {
    title: "Declined repeat (minutes)",
    description:
      "How long the same change, once you decline it, is refused when the same caller asks it again. 0 allows it at once.",
    schema: { type: "integer", minimum: 0, maximum: MAX_LOOKBACK_MINUTES, default: 10 },
  },
  appliedPerHour: perHour(
    "Changes an hour",
    "Settings changes applied per caller per hour, whether they ran on their own or you approved them.",
    30,
  ),
  askedPerHour: perHour("Asked changes an hour", "Changes a caller may ask you for per hour, answered or not.", 6),
  readsPerHour: perHour("Reads an hour", "Settings reads per caller per hour.", 240),
  networkReadsPerHour: perHour(
    "Network reads an hour",
    "Reads per caller per hour that reach GitHub or an MCP server (testing a server, previewing or checking skills): they use up GitHub's or that server's own rate limits.",
    20,
  ),
  openPerThread: {
    title: "Open changes per thread",
    description: "Asked changes one agent thread may have waiting for you at once.",
    schema: { type: "integer", minimum: 1, maximum: MAX_OPEN_PER_CALLER, default: 1 },
  },
  openPerOwner: {
    title: "Open changes per Owner client",
    description: "Asked changes one Owner client's identity may have waiting for an answer at once.",
    schema: { type: "integer", minimum: 1, maximum: MAX_OPEN_PER_CALLER, default: 2 },
  },
} as const satisfies Readonly<Record<string, SettingEntry>>;

export type SettingsServerLimitKey = keyof typeof SETTINGS_SERVER_LIMITS;

/** Every limit resolved: what the caps check. */
export type SettingsServerLimits = Readonly<Record<SettingsServerLimitKey, number>>;

export const SETTINGS_SERVER_LIMIT_KEYS = Object.keys(SETTINGS_SERVER_LIMITS) as ReadonlyArray<SettingsServerLimitKey>;

/** What the consequence of loosening them is, said once where they are set. */
export const SETTINGS_SERVER_LIMITS_NOTE =
  "Looser limits (higher counts, or a shorter strike window, lock or repeat) let an agent ask you, and change your settings, more often.";

/**
 * The most stored bytes (`storedBytes`) of the tool definitions one server's inventory keeps: a server's inventory is
 * one Durable Object value (`DO_VALUE_BYTES`, 8 MB), and half of it is left for the tools it refuses and its other
 * fields. A named constraint; the tools past it are refused by name. Their count is the server's.
 */
export const MAX_SCHEMA_BYTES = Math.floor(DO_VALUE_BYTES / 2);

/** The CLI relay's path prefix in the Container (`computer.internal/t3flare/mcp/<server>`, ADR-0028). */
export const MCP_RELAY_PREFIX = "/t3flare/mcp/";

/**
 * A CLI process's MCP tool timeout in seconds (review M11, SPI-1316), from the Answer wait and the MCP call time limit
 * (`mcpCallSeconds`, SPI-1359) it is spawned with: a relayed call can wait on an approval card and then on an in-call
 * question, each up to the wait, while the call's own clock is paused (`packages/mcp/src/connection.ts`), plus the call
 * itself and a 30 s margin. At the default 10-minute wait and 270 s limit this is 1,500 s.
 */
export const cliToolTimeoutSec = (answerMs: number, callMs: number): number =>
  2 * Math.ceil(answerMs / 1000) + Math.ceil(callMs / 1000) + 30;

/** The variable a CLI process reads its tool handle from (Codex's `bearer_token_env_var`). */
export const TOOL_HANDLE_ENV = "T3FLARE_TOOL_HANDLE";

/**
 * The variable the pi CLI's process names its relayed servers in, comma-separated (SPI-1076, Patch 0007): t3's pi
 * extension lets a built-in MCP tool through unasked only when its server is one of these.
 */
export const RELAY_SERVERS_ENV = "T3FLARE_RELAY_SERVERS";

/** A CLI process's MCP message, as the Workspace DO passes it to the Environment DO (the caller from the handle). */
export interface McpRelayInput {
  readonly workspace: string;
  readonly thread: string;
  readonly cli: string;
  /**
   * The calling process's key (SPI-1316), from the handle: its relay cards wait the Answer wait it was spawned with.
   * Absent (a Workspace DO before it): the wait now.
   */
  readonly process?: string;
  readonly server: string;
  /** One JSON-RPC message (a request or a notification). */
  readonly message: unknown;
  /** Withdraws the call's card when the CLI goes away (`cancelAsk`). */
  readonly askId: string;
}

/** The relay's answer: a JSON-RPC response, nothing (a notification: 202), or a refusal before MCP (HTTP status). */
export type McpRelayAnswer =
  | { readonly kind: "response"; readonly body: unknown }
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly status: 401 | 403 | 404; readonly message: string };
