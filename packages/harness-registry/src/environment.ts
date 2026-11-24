// The Environment settings (SPI-1149, ADR-0032): what the Cloud Environment gives every Workspace and its Container,
// apart from the Harness settings (ADR-0026). Kept in the Environment DO under their own key and revision, so a change
// here never makes a Session take the Harness settings again. Edited in the Settings page's Environment section; read by
// each Workspace DO before a Container start, and by the Environment DO's Sweep for the Grace (ADR-0043), which the page
// edits in its Workspaces section. Imported by both Workers.
//
// One schema (`ENVIRONMENT_SETTINGS`), one resolve (`resolveEnvironment`), one change (`applyEnvironmentChange`): a later
// setting (the Global mise config, SPI-1150; Variables, SPI-1152) is one entry in `ENVIRONMENT_SETTINGS`. The resolved
// type, the resolve, the validation and the panel's section all follow from it.
import { type EnvironmentSettingEntry, type EnvironmentValue, fieldProblem, normalizeField } from "./fields.ts";
import { DO_VALUE_BYTES, storedValueProblem } from "./storedValue.ts";
import { fitVariables, MAX_ENV_STRING_BYTES, MAX_VARIABLES_BYTES, type Variable } from "./variables.ts";

export * from "./variables.ts";

/**
 * The most minutes a limit t3flare times itself (its own alarm or timer) may be set to: a sanity bound, not a constraint
 * (ADR-0048). Why a week: the longest single wait t3flare times, a Workspace's wait for a Base build (`waitLimitMs` =
 * imageSetupMinutes + 2 × snapshotMinutes, apps/agents/src/workspace/baseStart.ts), stays under the 24.8 days past
 * which a JS timer overflows and fires at once. A value handed to a platform API takes that API's maximum instead,
 * named in a comment where it is set.
 */
export const MAX_TIMED_MINUTES = 10_080;

/** `MAX_TIMED_MINUTES` in seconds, for the limits set in seconds (SPI-1366). */
export const MAX_TIMED_SECONDS = MAX_TIMED_MINUTES * 60;

/**
 * The Container budget's default: at most this many Containers run at once across the deploy. The Owner changes it in
 * the Environment settings (`containerBudget`); each Workspace DO carries it with its lease request.
 */
export const DEFAULT_CONTAINER_BUDGET = 3;

/**
 * The most the Container budget may be set to: a sanity bound, not a constraint (ADR-0048). Nothing in t3flare forces
 * 100, and `max_instances` does not apply under `schedulingPolicy: "durable_object"` (apps/agents/src/budget.ts); 100 of
 * the largest size (4 vCPU, 12 GiB, 20 GB) is under each of the account's documented default concurrent Container
 * limits, which bound it in fact and which t3flare does not check.
 */
export const MAX_CONTAINER_BUDGET = 100;

/**
 * The CLI agents' processes per Workspace by default (`cliProcessesPerWorkspace`; plan §2.1, review F7), each process
 * counted once (SPI-1364). An idle Codex app-server measured 157–160 MB RSS on step4a
 * (steps-evidence-1:docs/steps/step-4a/m3-memory.json), so four take about 0.65 GB of `cpu-1`'s 3 GiB, beside computerd
 * (~100 MB) and the agents' own commands (an `npm ci` and its tests peak at 1–1.5 GB). Claude Code peaked at 344 MiB and
 * OpenCode at 439 MiB in a turn running `npm ci && npm test` (steps-evidence-1:docs/steps/step-4b/m0-local.json P7), which
 * the setting's description states.
 */
export const DEFAULT_CLI_PROCESSES_PER_WORKSPACE = 4;

/**
 * The most CLI agents' processes per Workspace: a sanity bound, not a constraint (ADR-0048). Nothing in t3flare forces
 * 100; the Container size's memory bounds it in fact (100 Codex processes take about 16 GB, past the largest size's
 * 12 GiB), and the setting's description states that consequence.
 */
export const MAX_CLI_PROCESSES_PER_WORKSPACE = 100;

/**
 * The reclaim delay's default, in seconds (`cliReclaimSeconds`; review F7): a CLI agent's process out of a turn this
 * long may be ended to free the Container for another Workspace.
 */
export const DEFAULT_CLI_RECLAIM_SECONDS = 30;

/**
 * When t3 releases an idle provider session, ending a CLI agent's process: 10 minutes, set by t3flare's own Patch 0003
 * (`patches/0003-provider-session-idle-10-minutes.patch`, stock t3's is 30) to bound what an idle CLI session costs
 * (docs/cost.md). The patch and this constant must name the same minutes (apps/agents/test/processHost.test.ts).
 */
export const CLI_SESSION_RELEASE_MS = 10 * 60_000;

/**
 * The longest t3 keeps an idle provider session pinned while its runtime reports background work (a Claude scheduled
 * wakeup, background task or running subagent, all silent on stdio): t3's `DEFAULT_MAX_IDLE_PIN_MS`, 4 hours
 * (`apps/server/src/orchestration-v2/ProviderSessionManager.ts`, not exported; no patch changes it). t3 checks the pin
 * once per `CLI_SESSION_RELEASE_MS`, so a pinned session is released at most a release past it. Registered in
 * docs/upstream-fragility.md; apps/agents/test/processHost.test.ts holds this constant to t3's source.
 */
export const T3_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;

/**
 * How long after its last turn a CLI agent's process holds the Container: t3's session release
 * (`CLI_SESSION_RELEASE_MS`) and a minute for the process to exit.
 */
export const CLI_IDLE_HOLD_MS = CLI_SESSION_RELEASE_MS + 60_000;

/**
 * The most seconds a CLI agent's process out of a turn waits before it may be ended to free the Container for another
 * Workspace (`cliReclaimSeconds`). A named constraint: a CLI process holds the Container for `CLI_IDLE_HOLD_MS` after
 * its last turn, so a longer delay changes nothing.
 */
export const MAX_CLI_RECLAIM_SECONDS = CLI_IDLE_HOLD_MS / 1000;

/**
 * The Turn limit's default, in minutes (`turnLimitMinutes`; step 2a's cost guardrail, ADR-0015's CLI cap): how long a
 * turn of the Durable agent or of a CLI agent may run before it is ended.
 */
export const DEFAULT_TURN_LIMIT_MINUTES = 120;

/**
 * The Turn limit's default in ms: the one source for it, used where no setting reaches (a test's services, a Session's
 * turn whose start carried no limit, or one recorded before the setting).
 */
export const DEFAULT_TURN_LIMIT_MS = DEFAULT_TURN_LIMIT_MINUTES * 60_000;

/**
 * The clone time limit's default, in minutes (`cloneMinutes`, SPI-1324): how long a Workspace's clone, and a worktree
 * Workspace's clone and checkout, may run in its Container. The Workspace DO uses it for a call that carries no limit.
 */
export const DEFAULT_CLONE_MINUTES = 15;

/** The clone time limit's default in ms: used where no setting reaches (a call that carries none, a test's services). */
export const DEFAULT_CLONE_MS = DEFAULT_CLONE_MINUTES * 60_000;

/**
 * The checkpoint time limit's default, in minutes (`checkpointMinutes`, SPI-1324): how long a turn's checkpoint and its
 * restore, a worktree's seed bundle, and carrying a removed worktree's commits home may run in the Container. The
 * Workspace DO uses it for a call that carries no limit.
 */
export const DEFAULT_CHECKPOINT_MINUTES = 10;

/**
 * The checkpoint time limit's default in ms: used where no setting reaches (a call that carries none, a test's services).
 */
export const DEFAULT_CHECKPOINT_MS = DEFAULT_CHECKPOINT_MINUTES * 60_000;

/**
 * The command time limit's default, in minutes (`commandMinutes`, SPI-1364): how long a Container command that carries no
 * limit of its own may run (an agent's file search on a Container-only path, git's reads and actions for t3, the
 * credential helper's install). The Workspace DO uses it for a call that carries none.
 */
export const DEFAULT_COMMAND_MINUTES = 2;

/** The command time limit's default in ms: used where no setting reaches (a call that carries none, a test's services). */
export const DEFAULT_COMMAND_MS = DEFAULT_COMMAND_MINUTES * 60_000;

/** The Container connect wait's default, in seconds (`containerConnectSeconds`, SPI-1364): computer's connect deadline. */
export const DEFAULT_CONTAINER_CONNECT_SECONDS = 60;

/**
 * The reclaim protection's default, in seconds (`reclaimProtectionSeconds`, SPI-1364): a Workspace that ran a command this
 * recently is never stopped to free the Container budget for another, so two Workspaces under a full budget do not stop
 * each other between commands.
 */
export const DEFAULT_RECLAIM_PROTECTION_SECONDS = 30;

/** The Environment skills wait's default, in seconds (`skillsWaitSeconds`, SPI-1364; plan §4.2's "up to 5 s"). */
export const DEFAULT_SKILLS_WAIT_SECONDS = 5;

/**
 * The stop graces' defaults, in seconds (SPI-1364): a stopped command's processes get TERM, then KILL after
 * `abortGraceSeconds` (t3flare's own kill script's 2 s); a stopped port's group after `portStopGraceSeconds`, stock t3's
 * `STOP_GRACE_MS` (3 s, `apps/server/src/preview/PortScanner.ts`; docs/upstream-fragility.md U103).
 */
export const DEFAULT_ABORT_GRACE_SECONDS = 2;
export const DEFAULT_PORT_STOP_GRACE_SECONDS = 3;

/**
 * The most seconds a stop grace may be set to: a sanity bound (ADR-0048 §1). The Container's script times it with bash's
 * clock, no timer, so nothing forces it; the Workspace DO waits on the script's exec meanwhile.
 */
export const MAX_STOP_GRACE_SECONDS = 600;

/**
 * How long the kill script keeps signalling after its KILL before it gives up: a process KILL cannot end (one in
 * uninterruptible sleep) would otherwise keep it looping. apps/sandbox-image/src/kill.ts names the same second.
 */
export const KILL_GIVE_UP_MS = 1000;

/** The git reads kept's default (`gitReadsKept`, SPI-1364): sized to t3's ~30 read shapes per branch. */
export const DEFAULT_GIT_READS_KEPT = 500;

/**
 * The most git read answers a Workspace keeps: a sanity bound (ADR-0048 §1). What forces a bound is the Workspace DO's
 * storage (10 GB), which a row of at most 8 MB per answer reaches only past 1,250 answers of the largest size; typical
 * answers are a few KB, and the description states the cost.
 */
export const MAX_GIT_READS_KEPT = 100_000;

/** The harness temp files' retention default, in hours (`tempFilesHours`, SPI-1364). */
export const DEFAULT_TEMP_FILES_HOURS = 24;

/** The router trace's default length (`routerTraceEntries`, SPI-1364). */
export const DEFAULT_ROUTER_TRACE_ENTRIES = 300;

/**
 * The most router trace entries: a sanity bound (ADR-0048 §1). The trace lives in the Environment DO's 128 MB isolate; an
 * entry is its command's first words and a detail cut at 400 characters, so 10,000 take at most a few MB.
 */
export const MAX_ROUTER_TRACE_ENTRIES = 10_000;

/** A Durable Object isolate's memory, in MB: Cloudflare's documented Workers limit, which descriptions state. */
export const ISOLATE_MEMORY_MB = 128;

/** How long input to a new t3 Terminal waits for its shell's first prompt, by default, in seconds (SPI-1364). */
export const DEFAULT_FIRST_PROMPT_SECONDS = 20;

/**
 * t3's Terminals' history in the Environment DO (SPI-1364): each Terminal's history in KiB, and how many exited Terminals
 * keep theirs for a reattach. Each was set for the 128 MB isolate: 1 MiB and 16, where stock t3 keeps 8 MiB and 128.
 */
export const DEFAULT_TERMINAL_HISTORY_KIB = 1024;
export const DEFAULT_EXITED_TERMINALS_KEPT = 16;

/**
 * The most of each: a sanity bound (ADR-0048 §1), stock t3's own values (`Manager.ts`'s DEFAULT_HISTORY_BYTE_LIMIT and
 * DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS). What bounds them in fact is their product with the open Terminals in the
 * Environment DO's 128 MB isolate, which the descriptions state.
 */
export const MAX_TERMINAL_HISTORY_KIB = 8192;
export const MAX_EXITED_TERMINALS_KEPT = 128;

/** The Container preview ports by default (G11, ADR-0031): the dev servers' usual ports. */
export const DEFAULT_PREVIEW_PORTS: ReadonlyArray<number> = [3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787];

/**
 * The most Container preview ports. A named constraint: Browser Run routes at most eight hosts (`outboundByHost`) per
 * browser, and each port is one host.
 */
export const MAX_PREVIEW_PORTS = 8;

/**
 * The ports no Container preview may reach. A named constraint: computerd's (8080) and the MCP bridge's (17781,
 * apps/sandbox-image/src/mcp-bridge.ts) are t3flare's own servers in the Container.
 */
export const RESERVED_CONTAINER_PORTS: ReadonlyArray<number> = [8080, 17_781];

/**
 * How long a port's probe waits for an answer by default, in ms (SPI-1364): stock t3's `WEB_PROBE_TIMEOUT`
 * (`apps/server/src/preview/PortScanner.ts`; docs/upstream-fragility.md U103).
 */
export const DEFAULT_PORT_PROBE_MS = 1000;

/**
 * The settings read wait's default, in seconds (`settingsReadSeconds`, SPI-1314): how long a Container start or a turn
 * waits for the newest settings before it runs with the ones it last took.
 */
export const DEFAULT_SETTINGS_READ_SECONDS = 5;

/**
 * The settings read wait's default in ms: used where no setting reaches (a turn whose start carried none, a Workspace
 * that kept no settings yet).
 */
export const DEFAULT_SETTINGS_READ_MS = DEFAULT_SETTINGS_READ_SECONDS * 1000;

/**
 * The Answer wait's default, in minutes (`ownerAnswerMinutes`, SPI-1316): how long a card waits for the Owner's answer,
 * be it an MCP server's question, a CLI agent's tool approval, or an Open change.
 */
export const DEFAULT_OWNER_ANSWER_MINUTES = 10;

/**
 * The Answer wait's default in ms: used where no setting reaches (a test's services, or a store that cannot be read).
 */
export const DEFAULT_OWNER_ANSWER_MS = DEFAULT_OWNER_ANSWER_MINUTES * 60_000;

/** The Answer wait of resolved Environment settings, in ms (SPI-1316). */
export const ownerAnswerMsOf = (environment: { readonly ownerAnswerMinutes: number }): number =>
  environment.ownerAnswerMinutes * 60_000;

/**
 * The Terminal holds' defaults, in minutes (`terminalBusyHoldMinutes`, `terminalPromptHoldMinutes`; SPI-1317): while a
 * Terminal runs a foreground command, open Terminals hold the Container until their last input is the busy hold old
 * (step 2b, ADR-0021; review F10: output does not count); while every one sits at its prompt, the prompt hold (cost
 * audit F1). The busy hold also caps a Container preview's hold (the Workspace DO's `#someoneWorks`).
 */
export const DEFAULT_TERMINAL_BUSY_HOLD_MINUTES = 30;
export const DEFAULT_TERMINAL_PROMPT_HOLD_MINUTES = 10;

/**
 * The Terminals per Workspace by default, t3's (`terminalsPerWorkspace`) and Durable agents' running Terminals and
 * Background jobs (`agentTerminalsPerWorkspace`), each its own cap (ADR-0021's 8; SPI-1317).
 */
export const DEFAULT_TERMINALS_PER_WORKSPACE = 8;

/**
 * The most Terminals and Background jobs Pi Durable agents may run at once per Workspace (`agentTerminalsPerWorkspace`).
 * A named constraint, provisional: the Workspace DO's memory. Each of an agent's Terminals keeps a headless xterm (its
 * scrollback, `agentTerminalScrollbackLines`, 1,000 lines by default) in the Workspace DO's 128 MB isolate, which holds its files' sync too; 32 is a guess at what
 * fits, and SPI-978's measurement of the DO's memory sets the figure. An agent's exited Terminals keep their xterm
 * outside the live count: `MAX_KEPT` (apps/agents/src/workspace/agentTerminals.ts) bounds them per Session only, so their
 * Workspace-wide total grows with the Sessions the Workspace serves until the DO restarts.
 */
export const MAX_AGENT_TERMINALS_PER_WORKSPACE = 32;

/** The lines of scrollback each of an agent's Terminals keeps by default (`agentTerminalScrollbackLines`). */
export const DEFAULT_AGENT_TERMINAL_SCROLLBACK_LINES = 1000;

/**
 * The most lines of scrollback an agent's Terminal may keep (`agentTerminalScrollbackLines`). A named constraint,
 * provisional, like `MAX_AGENT_TERMINALS_PER_WORKSPACE`: each Terminal's headless xterm keeps its scrollback in the
 * Workspace DO's 128 MB isolate, about 12 bytes per cell (a 120-column line about 1.4 KB). 10,000 lines of one
 * 120-column Terminal are about 14 MB, so only a few Terminals that size fit; SPI-978's measurement sets the figure.
 */
export const MAX_AGENT_TERMINAL_SCROLLBACK_LINES = 10_000;

/**
 * The most of the Owner's own Terminals per Workspace (`terminalsPerWorkspace`): a sanity bound, not a constraint
 * (ADR-0048 §1, SPI-1359). An Owner's Terminal keeps no xterm in the Workspace DO, only its exec handle, a carry string
 * and held input, and all of them share one pending-output buffer (`BACKPRESSURE_BYTES`,
 * apps/agents/src/workspace/terminalHost.ts); their output is pushed, not a returned stream, so the DO's outgoing
 * connections do not bound them (ADR-0021). Each shell's memory is the Container's, which bounds them in fact, and the
 * setting's description states that.
 */
export const MAX_TERMINALS_PER_WORKSPACE = 1000;

/**
 * The largest file setting (the Global mise config, the Image setup, the Container setup), in bytes of UTF-8: a third
 * of one stored value, since the Environment settings are one Durable Object value (`DO_VALUE_BYTES`) and a byte of
 * UTF-8 is at most one character, which `storedBytes` counts as three. Derived from that constraint; what the settings
 * take together is checked as a whole (`applyEnvironmentChange`), so one file this large leaves little room for others.
 */
export const MAX_FILE_SETTING_BYTES = Math.floor(DO_VALUE_BYTES / 3);

/** The largest Global mise config, in bytes of UTF-8 (`MAX_FILE_SETTING_BYTES`). */
export const MAX_GLOBAL_MISE_BYTES = MAX_FILE_SETTING_BYTES;

/** The largest Image setup and Container setup, each, in bytes of UTF-8 (ADR-0047 §9; `MAX_FILE_SETTING_BYTES`). */
export const MAX_SETUP_BYTES = MAX_FILE_SETTING_BYTES;

/** Why `text` cannot be an Image setup (a Test base build's proposal included): past `MAX_SETUP_BYTES`; undefined when it fits. */
export const imageSetupTooLong = (text: string): string | undefined => {
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_SETUP_BYTES ? `the Image setup is at most ${MAX_SETUP_BYTES} bytes, not ${bytes}` : undefined;
};

/**
 * The most of a setup's output a report may keep, in KiB (`setupOutputKiB`'s bound). Fixed by a constraint: the
 * Environment DO keeps the last report, output and all, as one Durable Object value, which holds at most 8 MB.
 */
export const MAX_SETUP_OUTPUT_KIB = 256;

/** What a Container whose setup failed does (ADR-0047 §7): carries on, or refuses every command but a passive read. */
export const CONTAINER_SETUP_FAILURES = ["carryOn", "refuse"] as const;
export type ContainerSetupFailure = (typeof CONTAINER_SETUP_FAILURES)[number];

/**
 * The most days a scheduled rebuild may wait (ADR-0047 §3): the platform expires a snapshot 30 days after its creation
 * or last restore, and t3flare counts one 29 days past its last restore as gone. The schedule counts from creation.
 */
export const MAX_REBUILD_DAYS = 29;

/**
 * The Base build retry's default, in minutes (`baseRetryMinutes`, SPI-1359): how long a failing key's first retry
 * waits; each one after waits twice as long.
 */
export const DEFAULT_BASE_RETRY_MINUTES = 60;

/**
 * What a new Container starts from while a Base build runs (ADR-0047 §6): the last good Base snapshot when it was made on
 * the current Workspace image, the build's result once it ends, or the Workspace image.
 */
export const WHILE_BUILDING = ["lastGood", "wait", "image"] as const;
export type WhileBuilding = (typeof WHILE_BUILDING)[number];

/** The same while the last good Base snapshot was made on another Workspace image (ADR-0047 §6): wait, or the image. */
export const WHILE_BUILDING_NEW_IMAGE = ["wait", "image"] as const;
export type WhileBuildingNewImage = (typeof WHILE_BUILDING_NEW_IMAGE)[number];

/** The Builder's size setting's value for "the Container size" (ADR-0047 §9). */
export const BUILDER_SAME_SIZE = "sameAsContainer";

/** The Environment settings a Base build reads besides the Global mise config and the Variables (ADR-0047 §9). */
export const BASE_BUILD_SETTING_KEYS = [
  "imageSetup",
  "imageSetupMinutes",
  "snapshotMinutes",
  "builderSize",
  "builderInBudget",
  "rebuildEveryDays",
  "baseRetryMinutes",
] as const;

/** The Grace's default and bounds, in days (ADR-0043 §1): no zero, since at once is the Owner's own Purge. */
export const DEFAULT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 3650;

/**
 * The Environment settings the Sweep reads (ADR-0043) and no Container does: they apply at the next Sweep, not at a
 * Container start, and the Settings page shows them in its Workspaces section, not its Environment section.
 */
export const SWEEP_SETTING_KEYS = ["sweepPurges", "graceDays"] as const;

/**
 * The agents' settings (SPI-1315): how long a turn may run, how long a card waits for the Owner's answer (SPI-1316),
 * and the CLI agents' processes per Workspace and their reclaim delay. They bound agents, not a Container start, so the
 * Settings page shows them in an Agents row of their own, in this order.
 */
export const AGENT_SETTING_KEYS = [
  "turnLimitMinutes",
  "ownerAnswerMinutes",
  "cliProcessesPerWorkspace",
  "cliReclaimSeconds",
] as const;

/**
 * The dotfiles toggles (ADR-0047 §9): whether the Owner's own config in their home reaches Terminals and CLI agents. The
 * Settings page shows them in a row of their own. `terminalsReadBashrc` applies at a Container start (the Workspace DO
 * keeps it with the launch); `agentsReadDotfiles` at each CLI agent's start (the Environment DO reads it at the spawn).
 */
export const DOTFILES_SETTING_KEYS = ["terminalsReadBashrc", "agentsReadDotfiles"] as const;

/**
 * How long t3flare keeps its own usage records and pi's sessions (SPI-1323), in days. 92 matches t3's own usage cache
 * (`CACHE_RETENTION_DAYS`), past its Usage page's widest range (90 days); 60 is review F2's.
 */
export const DEFAULT_USAGE_RETENTION_DAYS = 92;
export const DEFAULT_PI_SESSION_RETENTION_DAYS = 60;
/**
 * A sanity bound (ADR-0048 §1), the Grace's ten years: nothing forces it. It is also "keep for good", in place of a 0
 * sentinel, so turning the value up is always the free direction.
 */
export const MAX_RETENTION_DAYS = MAX_GRACE_DAYS;

/**
 * How long history is kept (SPI-1323): t3flare's usage records and pi's sessions. Neither bounds a Container start nor
 * waits for the Sweep, so the Settings page shows them in a History row of their own. `usageRetentionDays` applies at
 * the Environment DO's next prune and to entries recorded from then on; `piSessionRetentionDays` at each pi start.
 */
export const RETENTION_SETTING_KEYS = ["usageRetentionDays", "piSessionRetentionDays"] as const;

/**
 * The MCP call time limit's default, in seconds (`mcpCallSeconds`, SPI-1359): how long the MCP host lets one tool call
 * run. 270: a little past Commissary's own upstream timeout (240 s), so a call through Commissary is ended by
 * Commissary, which says why, not by t3flare. Any other server's length is the Owner's taste.
 */
export const DEFAULT_MCP_CALL_SECONDS = 270;

/** The MCP call time limit's default in ms: used where no setting reaches (a test's host, a call that carries none). */
export const DEFAULT_MCP_CALL_MS = DEFAULT_MCP_CALL_SECONDS * 1000;

/**
 * How long t3flare waits for one answer from GitHub or a sign-in vendor by default (`outsideRequestSeconds`, SPI-1365):
 * today's 15 seconds.
 */
export const DEFAULT_OUTSIDE_REQUEST_SECONDS = 15;

/** The MCP result size's default, in KiB (`mcpResultKiB`, SPI-1359): today's 1 MiB. */
export const DEFAULT_MCP_RESULT_KIB = 1024;

/**
 * The most KiB of one MCP tool result (`mcpResultKiB`). A provisional bound, from an estimate, not a measurement: the
 * Environment DO's 128 MB isolate also runs t3's server, and the MCP host holds a result several times over while it
 * reads it (`readStream` and `resultText` in apps/environment/src/mcp/host.ts: the chunks, the joined bytes, the decoded
 * text, the parsed JSON, then the text and structured content encoded again to be cut), about six times its size. 8 MiB
 * of result is then about 48 MB, leaving t3 the rest. A measurement of the isolate's peak sets the figure.
 */
export const MAX_MCP_RESULT_KIB = 8 * 1024;

/**
 * The MCP calls' settings (SPI-1359): how long one tool call may run and how large its result may be. They bound every
 * agent's MCP calls through the MCP host, Pi Durable's and the CLI relay's, at the next call, never a Container start, so
 * the Settings page shows them in an MCP calls row of their own, in this order.
 */
export const MCP_CALL_SETTING_KEYS = [
  "mcpCallSeconds",
  "mcpResultKiB",
  "mcpPausesPerCall",
  "cliMcpStartSeconds",
  "mcpSignInMinutes",
] as const;

/**
 * The MCP servers' settings (SPI-1363): how long a connection may take to start and one listing, and how many of a
 * server's logs a call keeps. Read as each call's target is made, never at a Container start, so the Settings page shows
 * them in an MCP servers row of their own, after the MCP calls row.
 */
export const MCP_SERVER_SETTING_KEYS = ["mcpConnectSeconds", "mcpListSeconds", "mcpLogEntries"] as const;

/**
 * The outside requests' setting (SPI-1365): how long one request to GitHub or a sign-in's vendor may wait. It bounds the
 * Environment's own requests at the next one, never a Container start, so the Settings page shows it in a row of its own.
 */
export const OUTSIDE_REQUEST_SETTING_KEYS = [
  "outsideRequestSeconds",
  "githubRetrySeconds",
  "textGenerationSeconds",
] as const;

/**
 * How long t3flare lets the Environment sleep, and what wakes it (SPI-1366): the idle delay before it resets, the PR
 * watch's wake, the Remote tasks' retry, and the failed boots before safe mode. Read by the Environment DO at each use,
 * never at a Container start, so the Settings page shows them in a Sleep and wake row of their own.
 */
export const LIFECYCLE_SETTING_KEYS = [
  "idleAfterSeconds",
  "prWatchWakeMinutes",
  "remoteRetryMinutes",
  "safeModeAfterFailures",
] as const;

/** The preview browsers' cadences (SPI-1366), in a Previews row of their own: read at each browser's next use. */
export const PREVIEW_SETTING_KEYS = ["browserProfileSaveSeconds", "htmlBrowserKeepAliveSeconds"] as const;

/**
 * The Settings page's token, the Owner clients kept, and T3 Connect's publish log (SPI-1366), in a row of their own: read
 * at each request or publish, never at a Container start.
 */
export const ACCESS_SETTING_KEYS = ["pageTokenHours", "clientsPerKey", "connectPublishLogKept"] as const;

/**
 * How often a failed model request is tried again, and a stopped command's survivors killed again (SPI-1367), in a
 * Retries row of their own: read at each thread's next turn or each CLI agent's next start, never at a Container start.
 */
export const RETRY_SETTING_KEYS = ["durableRetries", "cliRetries", "killAttempts"] as const;

/** t3's own trace file (SPI-1367), in a row of its own: read at t3's next start, never at a Container start. */
export const TRACE_SETTING_KEYS = ["traceKiB", "traceFiles"] as const;

/** Every Environment setting read at its own next use, not at a Container start (SPI-1366): the Settings server says so. */
export const NEXT_USE_SETTING_KEYS = [
  ...OUTSIDE_REQUEST_SETTING_KEYS,
  ...LIFECYCLE_SETTING_KEYS,
  ...PREVIEW_SETTING_KEYS,
  ...ACCESS_SETTING_KEYS,
  ...RETRY_SETTING_KEYS,
  ...TRACE_SETTING_KEYS,
  // SPI-1364: the Container preview ports at each preview browser's acquisition, the command trace at each command.
  "previewPorts",
  "routerTraceEntries",
] as const;

/** The text generation time limit's default, in seconds (`textGenerationSeconds`, SPI-1366): today's 110 s. */
export const DEFAULT_TEXT_GENERATION_SECONDS = 110;

/**
 * How much longer than the text generation time limit the Environment waits for the agents Worker's answer: the agents
 * Worker ends the request at the limit itself and says why, so its answer, not the Environment's own deadline, reaches
 * t3 (SPI-1366; 10 s, today's 120 s less 110 s).
 */
export const TEXT_GENERATION_MARGIN_MS = 10_000;

/** The GitHub retry's default, in seconds (`githubRetrySeconds`, SPI-1366): today's minute. */
export const DEFAULT_GITHUB_RETRY_SECONDS = 60;

/**
 * How many times the GitHub retry the GitHub App's back-off may grow to, doubling at each failure in a row: today's 1 to
 * 15 minutes, as a ratio of the setting.
 */
export const GITHUB_RETRY_GROWTH = 15;

/** The idle delay's default, in seconds (`idleAfterSeconds`, SPI-1366): today's minute. */
export const DEFAULT_IDLE_AFTER_SECONDS = 60;

/** The PR watch's wake's default, in minutes (`prWatchWakeMinutes`, SPI-1366). */
export const DEFAULT_PR_WATCH_WAKE_MINUTES = 10;

/** The Remote tasks' longest retry wait's default, in minutes (`remoteRetryMinutes`, SPI-1366). */
export const DEFAULT_REMOTE_RETRY_MINUTES = 30;

/** Failed boots in a row before safe mode, by default (`safeModeAfterFailures`, SPI-1366). */
export const DEFAULT_SAFE_MODE_AFTER_FAILURES = 3;

/** The most failed boots in a row before safe mode may be set to: a sanity bound (ADR-0048 §1), nothing forces it. */
export const MAX_SAFE_MODE_AFTER_FAILURES = 1000;

/** How often an open preview browser's profile is saved while it changed, by default (`browserProfileSaveSeconds`). */
export const DEFAULT_BROWSER_PROFILE_SAVE_SECONDS = 60;

/**
 * How long the HTML renders' browser outlives its last render, by default (`htmlBrowserKeepAliveSeconds`): today's
 * Browser Run `keep_alive`, 120 s (the 60 s before SPI-1366 was a close of t3flare's own, now gone).
 */
export const DEFAULT_HTML_BROWSER_KEEP_ALIVE_SECONDS = 120;

/**
 * The most a Browser Run session's `keep_alive` may be: Browser Run's own maximum, 10 minutes (a named constraint;
 * apps/environment/src/preview/browserRun.ts `BROWSER_KEEP_ALIVE_MS`).
 */
export const MAX_BROWSER_KEEP_ALIVE_SECONDS = 600;

/** How many hours a Settings page's token lasts, at least, by default (`pageTokenHours`, SPI-1366). */
export const DEFAULT_PAGE_TOKEN_HOURS = 1;

/** Owner clients kept per Owner key, by default (`clientsPerKey`, SPI-1366). */
export const DEFAULT_CLIENTS_PER_KEY = 50;

/** The most Owner clients per key may be set to: a sanity bound (ADR-0048 §1); each is a small SQLite row. */
export const MAX_CLIENTS_PER_KEY = 100_000;

/** T3 Connect's publish log's entries kept, by default (`connectPublishLogKept`, SPI-1366). */
export const DEFAULT_CONNECT_PUBLISH_LOG_KEPT = 100;

/**
 * The most entries of T3 Connect's publish log may be set to: a sanity bound (ADR-0048 §1). The log is one Durable
 * Object value, rewritten whole at each publish; an entry is about 300 bytes, so 10,000 are about 3 MB of its 8 MB.
 */
export const MAX_CONNECT_PUBLISH_LOG_KEPT = 10_000;

/** Answers to one MCP call's pauses, by default (`mcpPausesPerCall`, SPI-1366). */
export const DEFAULT_MCP_PAUSES_PER_CALL = 16;

/** The most answers to one call's pauses may be set to: a sanity bound (ADR-0048 §1); each is a card or a decline. */
export const MAX_MCP_PAUSES_PER_CALL = 10_000;

/** How long a CLI agent waits for an MCP relay server to start, by default (`cliMcpStartSeconds`, SPI-1366). */
export const DEFAULT_CLI_MCP_START_SECONDS = 20;

/** How long a connection to an MCP server may take to start, by default (`mcpConnectSeconds`, SPI-1363): today's 15 s. */
export const DEFAULT_MCP_CONNECT_SECONDS = 15;

/** How long one listing of an MCP server may take, every page, by default (`mcpListSeconds`, SPI-1363): today's 120 s. */
export const DEFAULT_MCP_LIST_SECONDS = 120;

/** How many of a call's last server logs are kept, by default (`mcpLogEntries`, SPI-1363): today's 50. */
export const DEFAULT_MCP_LOG_ENTRIES = 50;

/**
 * The most server logs one MCP call may keep: a sanity bound (ADR-0048 §1). The MCP Worker holds up to 65,536
 * characters of each log's text until the call ends (its `RAW_LIMIT`), two bytes each at worst, so 128 KiB a log: 200
 * are at most 25 MiB of its 128 MB isolate, which also holds the call itself.
 */
export const MAX_MCP_LOG_ENTRIES = 200;

/** How long an MCP server's sign-in may take, by default (`mcpSignInMinutes`, SPI-1366). */
export const DEFAULT_MCP_SIGN_IN_MINUTES = 10;

/** A Durable agent's retries of a failed model request, by default (`durableRetries`, SPI-1367): pi-durable's own 3. */
export const DEFAULT_DURABLE_RETRIES = 3;

/**
 * pi-durable's wait before its first retry, doubling at each next one, and the longest one wait may be: mirrors of its
 * `DEFAULT_RETRY_POLICY` (`baseDelayMs`, `maxAgentDelayMs`) under pi-ai's `retryDelayMs` (fragility U105).
 */
export const DURABLE_RETRY_FIRST_WAIT_MS = 2000;
export const DURABLE_RETRY_LONGEST_WAIT_MS = 60_000;

/**
 * How long `retries` of pi-durable's retries wait in all (SPI-1367). A 429 that resets within this span is met by one of
 * them; a later reset is out of their reach, so the Session pauses the thread until it at once, with one request.
 */
export const retriedSpanMs = (retries: number): number => {
  let span = 0;
  for (let attempt = 1; attempt <= retries; attempt++)
    span += Math.min(DURABLE_RETRY_FIRST_WAIT_MS * 2 ** (attempt - 1), DURABLE_RETRY_LONGEST_WAIT_MS);
  return span;
};

/** A CLI agent's retries of a failed model request, by default (`cliRetries`, SPI-1367): today's 1. */
export const DEFAULT_CLI_RETRIES = 1;

/**
 * The most retries of one failed model request may be set to: a sanity bound (ADR-0048 §1), nothing forces it. Each is
 * a request the endpoint may bill, and the Turn limit still ends the turn.
 */
export const MAX_MODEL_RETRIES = 100;

/** Kills of a stopped command's surviving processes, by default (`killAttempts`, SPI-1367): today's 12. */
export const DEFAULT_KILL_ATTEMPTS = 12;

/** How long the Session waits after a stopped command before it tries a failed kill again (its alarm). */
export const KILL_RETRY_MS = 5_000;

/**
 * The most kills of one stopped command may be set to: a sanity bound (ADR-0048 §1), nothing forces it. Each is
 * `KILL_RETRY_MS` after the last and keeps the Container awake.
 */
export const MAX_KILL_ATTEMPTS = 1000;

/** t3's trace file's size before it rotates, in KiB, by default (`traceKiB`, SPI-1367): today's 1 MiB. */
export const DEFAULT_TRACE_KIB = 1024;

/**
 * The most KiB t3's trace file may be set to: one inline row of the State directory (`CHUNK_BYTES`,
 * apps/environment/src/platform/stateStore.ts). A named constraint, the Environment DO's 128 MB isolate, which also runs
 * t3's server: the State directory appends by reading the whole file and writing it back joined (`writeFile`), and t3
 * flushes the trace about five times a second (its 200 ms batch window), so each flush holds about three times the file
 * at once. Past one row, a flush also reads and rewrites every chunk row.
 */
export const MAX_TRACE_KIB = 4 * 1024;

/** t3's older trace files kept after a rotation, by default (`traceFiles`, SPI-1367): today's 1. */
export const DEFAULT_TRACE_FILES = 1;

/**
 * The most older trace files kept may be set to: a sanity bound (ADR-0048 §1), nothing forces it. Each is up to
 * `traceKiB` of the Environment DO's storage, and t3's trace diagnostics read every one.
 */
export const MAX_TRACE_FILES = 100;

/**
 * How far a Workspace reads its Repo skills and Prompt templates (SPI-1365), in a Skills row of their own: discovery runs
 * in the Workspace DO with no Container, at each request, with the settings the Workspace's last Container start kept.
 */
export const SKILLS_SETTING_KEYS = [
  "repoSkillsListed",
  "skillsDirectoryEntries",
  "skillsLinkEntries",
  "promptsDirectoryEntries",
] as const;

/** The most Repo skills listed may be set to: a sanity bound (ADR-0048 §1); the model's context bounds it in fact. */
export const MAX_REPO_SKILLS_LISTED = 10_000;

/**
 * The most entries a skills or Prompt templates directory may be set to list: a sanity bound (ADR-0048 §1). Each
 * listing is held whole in the Workspace DO's 128 MB isolate, which bounds it in fact.
 */
export const MAX_DIRECTORY_ENTRIES = 100_000;

/**
 * What else t3flare keeps, and for how long (SPI-1364): its temp files in a Workspace, the git answers a Workspace keeps,
 * and the command trace. The Settings page shows them in the History row, after `RETENTION_SETTING_KEYS`.
 */
export const KEPT_SETTING_KEYS = ["tempFilesHours", "gitReadsKept", "routerTraceEntries"] as const;

/**
 * How long a Workspace's Container commands and starts may take and wait (SPI-1364). The Settings page shows them in a
 * Commands row of their own, in this order.
 */
export const COMMAND_SETTING_KEYS = [
  "commandMinutes",
  "containerConnectSeconds",
  "reclaimProtectionSeconds",
  "skillsWaitSeconds",
  "abortGraceSeconds",
  "portStopGraceSeconds",
] as const;

/** t3's Terminals: the first prompt's wait and their history (SPI-1364). The Settings page shows them in a Terminals row. */
export const TERMINAL_SETTING_KEYS = ["firstPromptSeconds", "terminalHistoryKiB", "exitedTerminalsKept"] as const;

/**
 * The Container previews (SPI-1364): their ports and the port check's wait. The Settings page shows them first in the
 * Previews row, before the preview browsers' cadences (`PREVIEW_SETTING_KEYS`).
 */
export const CONTAINER_PREVIEW_SETTING_KEYS = ["previewPorts", "portProbeMs"] as const;

/**
 * The Environment settings t3 reads when the Environment starts (SPI-1364): its Terminals' history, which t3's
 * TerminalManager takes when it is built. A change applies at the Environment's next restart, as every deploy makes.
 */
export const ENVIRONMENT_RESTART_SETTING_KEYS = ["terminalHistoryKiB", "exitedTerminalsKept"] as const;

/** A Container's resources, as `ctx.container.start({ instance })` takes a custom size. */
export interface ContainerResources {
  readonly vcpu: number;
  /** Mebibytes. */
  readonly memoryMib: number;
  /** Megabytes. */
  readonly diskMb: number;
}

/** The named types the runtime accepts under `schedulingPolicy: "durable_object"` that t3flare offers. */
export type NamedContainerType = "standard-1" | "standard-2" | "standard-3" | "standard-4";

/** What a start passes as `instance`: a named type, or a custom size's resources. Never omitted (that starts `lite`). */
export type ContainerInstance = NamedContainerType | ContainerResources;

/**
 * The Container sizes, by the name kept in the settings, smallest memory first. `cpu-1` is t3flare's size before this
 * setting (1 vCPU, 3 GiB, 12 GB), a custom size started as its resources; the others are Cloudflare's
 * named types, started by name, with the resources its limits page gives
 * (docs-archive-1:docs/steps/spi-1001-research-container-sizes.md §2). Not offered: `lite` and `basic` (the runtime refuses `basic`).
 * Any other size is `custom` (`CUSTOM_SIZE`, SPI-1365), its resources the Owner's settings. A stored name never changes
 * meaning: adding a size is free, removing one needs a rename map.
 */
export const CONTAINER_SIZES = {
  "cpu-1": { custom: true, resources: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } },
  "standard-1": { custom: false, resources: { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 } },
  "standard-2": { custom: false, resources: { vcpu: 1, memoryMib: 6144, diskMb: 12_000 } },
  "standard-3": { custom: false, resources: { vcpu: 2, memoryMib: 8192, diskMb: 16_000 } },
  "standard-4": { custom: false, resources: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 } },
} as const satisfies Readonly<Record<string, { readonly custom: boolean; readonly resources: ContainerResources }>>;

/** The size whose resources are the settings `customVcpu`, `customMemoryMib` and `customDiskMb` (SPI-1365). */
export const CUSTOM_SIZE = "custom";

export type ContainerSize = keyof typeof CONTAINER_SIZES | typeof CUSTOM_SIZE;

export const CONTAINER_SIZE_NAMES = [...Object.keys(CONTAINER_SIZES), CUSTOM_SIZE] as ReadonlyArray<ContainerSize>;

/**
 * The least a custom size may have: Cloudflare's minimums for a custom instance under `schedulingPolicy:
 * "durable_object"` (1/16 vCPU, 256 MiB, 2 GB; developers.cloudflare.com/containers/platform-details/limits, read
 * 2026-11-23). A named constraint. Its maximums are the account's limits (4 vCPU, 12 GiB and 20 GB by default, raised on
 * request), which t3flare cannot read: Cloudflare refuses a start past them.
 */
export const CUSTOM_SIZE_MINIMUMS: ContainerResources = { vcpu: 1 / 16, memoryMib: 256, diskMb: 2000 };

/**
 * An account's default limits per Container instance (the same page): what the custom size's description names, never
 * checked, since an account can have them raised.
 */
export const ACCOUNT_DEFAULT_LIMITS: ContainerResources = { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 };

/** A custom size's resources as `settings` set them. */
export const customResources = (
  settings: Pick<ResolvedEnvironment, "customVcpu" | "customMemoryMib" | "customDiskMb">,
): ContainerResources => ({
  vcpu: settings.customVcpu,
  memoryMib: settings.customMemoryMib,
  diskMb: settings.customDiskMb,
});

export const DEFAULT_CONTAINER_SIZE: ContainerSize = "cpu-1";

/**
 * What `ctx.container.start({ instance })` takes for `size`: a custom size's resources (`custom` for `CUSTOM_SIZE`), a
 * named type's name. Never undefined (an omitted `instance` starts `lite`); a stored name t3flare does not offer resolves
 * to the default first (`resolveEnvironment`).
 */
export const containerInstance = (
  size: ContainerSize,
  custom: ContainerResources = CONTAINER_SIZES["cpu-1"].resources,
): ContainerInstance => {
  if (size === CUSTOM_SIZE) return custom;
  const entry = CONTAINER_SIZES[size];
  return entry.custom ? entry.resources : (size as NamedContainerType);
};

/** What the Builder's Container starts with (ADR-0047 §9): its own size, or the Container size. */
export const builderInstance = (
  settings: Pick<
    ResolvedEnvironment,
    "containerSize" | "builderSize" | "customVcpu" | "customMemoryMib" | "customDiskMb"
  >,
): ContainerInstance =>
  containerInstance(
    settings.builderSize === BUILDER_SAME_SIZE ? settings.containerSize : (settings.builderSize as ContainerSize),
    customResources(settings),
  );

/** What the Environment DO stores (`t3flare:environment:settings`): the settings set explicitly. */
export interface StoredEnvironment {
  /** Bumped by every change; never moved by a Harness settings change (and the reverse). */
  readonly revision: number;
  readonly settings: Readonly<Record<string, EnvironmentValue>>;
}

export const EMPTY_ENVIRONMENT: StoredEnvironment = { revision: 0, settings: {} };

/** The Environment settings' schema: the panel renders its section from it and the API validates against it. */
export const ENVIRONMENT_SETTINGS = {
  containerSize: {
    title: "Container size",
    description:
      "The vCPU, memory and disk a Workspace's Container starts with; custom takes them from the three settings it shows. Applies at each Workspace's next Container start; a running Container keeps its size.",
    schema: {
      type: "enum",
      values: CONTAINER_SIZE_NAMES,
      default: DEFAULT_CONTAINER_SIZE,
    },
  },
  customVcpu: {
    title: "Custom size: vCPU",
    description: `The custom size's vCPU, used when the Container size or the Builder size is custom: at least ${CUSTOM_SIZE_MINIMUMS.vcpu}, Cloudflare's least. Past your account's limits (${ACCOUNT_DEFAULT_LIMITS.vcpu} vCPU, ${ACCOUNT_DEFAULT_LIMITS.memoryMib / 1024} GiB and ${ACCOUNT_DEFAULT_LIMITS.diskMb / 1000} GB by default) Cloudflare refuses the start, and no Container starts until the size changes. Applies at each Workspace's next Container start.`,
    // At least Cloudflare's minimum (`CUSTOM_SIZE_MINIMUMS`); no maximum of t3flare's: the account's limit is Cloudflare's.
    schema: { type: "number", minimum: CUSTOM_SIZE_MINIMUMS.vcpu, default: CONTAINER_SIZES["cpu-1"].resources.vcpu },
  },
  customMemoryMib: {
    title: "Custom size: memory (MiB)",
    description: `The custom size's memory, at least ${CUSTOM_SIZE_MINIMUMS.memoryMib} MiB.`,
    schema: {
      type: "number",
      minimum: CUSTOM_SIZE_MINIMUMS.memoryMib,
      whole: true,
      default: CONTAINER_SIZES["cpu-1"].resources.memoryMib,
    },
  },
  customDiskMb: {
    title: "Custom size: disk (MB)",
    description: `The custom size's disk, at least ${CUSTOM_SIZE_MINIMUMS.diskMb} MB.`,
    schema: {
      type: "number",
      minimum: CUSTOM_SIZE_MINIMUMS.diskMb,
      whole: true,
      default: CONTAINER_SIZES["cpu-1"].resources.diskMb,
    },
  },
  containerIdleMinutes: {
    title: "Idle time (minutes)",
    description:
      "A Container stops after this long without a command; its memory and disk are billed while it waits idle. Applies at each Workspace's next Container start.",
    // t3flare's own alarm stops an idle Container (WorkspaceDO `#scheduleAlarm`); the platform's `setInactivityTimeout`
    // (at most 6 hours) is never set, so the shared sanity maximum applies.
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 2 },
    tier: "down-free",
  },
  terminalBusyHoldMinutes: {
    title: "Terminal hold while a command runs (minutes)",
    description:
      "While a Terminal runs a command, open Terminals keep the Container running, and billed, for this long after their last input, even past the Idle time; output does not count. A Container preview keeps it running as long after the last command, CLI agent's turn, or input to a Terminal or CLI agent. Applies at each Workspace's next Container start.",
    // t3flare's own alarm releases the Container (WorkspaceDO `#scheduleAlarm`), so the shared sanity maximum applies
    // (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_TERMINAL_BUSY_HOLD_MINUTES },
    tier: "down-free",
  },
  terminalPromptHoldMinutes: {
    title: "Terminal hold at the prompt (minutes)",
    description:
      "While every open Terminal sits at its prompt, they keep the Container running, and billed, for this long after their last input, even past the Idle time. Applies at each Workspace's next Container start.",
    // As the busy hold: t3flare's own alarm, the shared sanity maximum (ADR-0048 §2).
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMED_MINUTES,
      default: DEFAULT_TERMINAL_PROMPT_HOLD_MINUTES,
    },
    tier: "down-free",
  },
  containerBudget: {
    title: "Container budget",
    description:
      "How many Containers may run at once across the Environment. Applies at the next start; lowering it stops no running Container, and new starts wait until fewer run.",
    schema: { type: "integer", minimum: 1, maximum: MAX_CONTAINER_BUDGET, default: DEFAULT_CONTAINER_BUDGET },
    tier: "down-free",
  },
  terminalsPerWorkspace: {
    title: "Terminals per Workspace",
    description: `How many of your Terminals one Workspace may have open at once; one more is refused. Each Terminal uses memory in the Container. At most ${MAX_TERMINALS_PER_WORKSPACE}. Applies at each Workspace's next Container start; lowering it closes no open Terminal.`,
    // A sanity bound (`MAX_TERMINALS_PER_WORKSPACE`, ADR-0048 §1): the Container's memory bounds it in fact.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TERMINALS_PER_WORKSPACE,
      default: DEFAULT_TERMINALS_PER_WORKSPACE,
    },
    tier: "down-free",
  },
  agentTerminalsPerWorkspace: {
    title: "Agents' Terminals per Workspace",
    description: `How many Terminals and Background jobs Pi Durable agents may run at once in one Workspace, across its threads; one more is refused. Each Terminal and Background job uses memory in the Container. At most ${MAX_AGENT_TERMINALS_PER_WORKSPACE}. Applies at each Workspace's next Container start; lowering it stops none that run.`,
    // A named constraint, provisional (`MAX_AGENT_TERMINALS_PER_WORKSPACE`): their xterms in the Workspace DO's memory.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_AGENT_TERMINALS_PER_WORKSPACE,
      default: DEFAULT_TERMINALS_PER_WORKSPACE,
    },
    tier: "down-free",
  },
  agentTerminalScrollbackLines: {
    title: "Agents' Terminal scrollback (lines)",
    description: `How many lines that scrolled off an agent's Terminal or Background job it keeps (0: only the screen); the agent cannot read past them, though a Background job's log keeps all of its output. Each line uses memory in the Workspace's own Durable Object, not the Container: about 1.4 KiB at 120 columns, for every Terminal it keeps; past that object's 128 MB it restarts, and every agent's Terminal and Background job ends. At most ${MAX_AGENT_TERMINAL_SCROLLBACK_LINES.toLocaleString("en-US")}. Applies at each Workspace's next Container start.`,
    // A named constraint, provisional (`MAX_AGENT_TERMINAL_SCROLLBACK_LINES`): their xterms in the Workspace DO's memory.
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_AGENT_TERMINAL_SCROLLBACK_LINES,
      default: DEFAULT_AGENT_TERMINAL_SCROLLBACK_LINES,
    },
    tier: "down-free",
  },
  cliProcessesPerWorkspace: {
    title: "CLI agents' processes per Workspace",
    description:
      "How many CLI agents' processes one Workspace's Container may run at once. Each takes the Container's memory: an idle Codex about 160 MB, Claude Code and OpenCode up to about 350 and 450 MB in a turn; past what the Container size has, commands fail for memory. Applies at each CLI agent's next start; lowering it ends no running process, and new starts are refused until fewer run.",
    // A sanity bound (ADR-0048): the Container's memory is the real one, which the description states.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_CLI_PROCESSES_PER_WORKSPACE,
      default: DEFAULT_CLI_PROCESSES_PER_WORKSPACE,
    },
    tier: "down-free",
  },
  cliReclaimSeconds: {
    title: "CLI agent's idle time before it may end (seconds)",
    description:
      "Only while the Container budget is full and another Workspace asks for a Container: a CLI agent's process idle this long after its turn may be ended to free the Container for another Workspace. 0 is as soon as its turn ends. Applies at each CLI agent's next start; a running one keeps what it started with.",
    // A named constraint (`MAX_CLI_RECLAIM_SECONDS`): past the CLI idle hold, a longer delay changes nothing.
    schema: { type: "integer", minimum: 0, maximum: MAX_CLI_RECLAIM_SECONDS, default: DEFAULT_CLI_RECLAIM_SECONDS },
    tier: "free",
  },
  turnLimitMinutes: {
    title: "Turn limit (minutes)",
    description:
      "How long one agent turn may run, for Pi Durable and CLI agents alike. A turn longer than this is ended (a CLI agent's process with it), and the thread shows it failed. Each minute of a turn can spend model tokens and hold a Container. Applies at each thread's next turn; a running turn keeps the limit it started with.",
    // t3flare times it itself (the Session's alarm, the CLI wrapper's timer), so the shared sanity maximum applies: a
    // week is under the 24.8 days past which a JS timer overflows.
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_TURN_LIMIT_MINUTES },
    tier: "down-free",
  },
  ownerAnswerMinutes: {
    title: "Answer wait (minutes)",
    description:
      "How long a card waits for your answer: an MCP server's question, a CLI agent's tool approval, and an Open change. An unanswered card is refused after this long. While it waits, the turn stays open and may hold its Container. Applies to cards raised after the change; a card already waiting keeps its deadline, and a running CLI agent keeps the wait it started with.",
    // t3flare times it itself (the MCP host's and the CLI card's timers, an Open change's expiry), so the shared sanity
    // maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_OWNER_ANSWER_MINUTES },
    tier: "down-free",
  },
  settingsReadSeconds: {
    title: "Settings read wait (seconds)",
    description:
      "How long a Container start or a turn waits for the newest settings before it goes ahead with the ones it last read; a start waits as long to learn which Base snapshot it starts from. A long wait holds a start or a turn that long whenever the settings are slow to answer. Applies at each thread's next turn. A Container start uses the wait it last kept, so a change can take one more start to apply fully.",
    // t3flare times it itself (the Session's and the Workspace DO's timers), so the shared sanity maximum applies
    // (ADR-0048 §2), in seconds.
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_SETTINGS_READ_SECONDS },
    tier: "free",
  },
  variables: {
    title: "Variables",
    description: `NAME=value pairs every command in a Workspace starts with: agents' commands, Terminals and CLI agents. A Secret one's value is stored sealed and never shown again, but every agent and command in a Workspace can read it, as on stock t3. Anything t3flare, t3, mise's [env] or the command itself sets wins over them. Each NAME=value is at most ${MAX_ENV_STRING_BYTES / 1024} KiB and all of them together at most ${MAX_VARIABLES_BYTES / 1024 / 1024} MiB, Linux's limits on a command's environment with room left for the command itself. Applies at each Workspace's next Container start.`,
    schema: { type: "variables", default: [] },
  },
  globalMiseConfig: {
    title: "Global mise config",
    description:
      "A mise.toml every Container's commands get, under a repository's own and over the image's base tools. Laid down and installed at each Workspace's next Container start; a running Container keeps what it started with. Kept only if git and gh still run under it. Left empty, mise uses your dotfiles' ~/.config/mise/config.toml instead, if git and gh still run under that; the Dotfiles toggles don't change this. disable_tools and disable_backends are ignored. Agents can read this file: put no secret in it, [env] included.",
    schema: { type: "file", maxBytes: MAX_GLOBAL_MISE_BYTES, default: "" },
  },
  globalMiseInstallMinutes: {
    title: "Global mise install time limit (minutes)",
    description:
      "How long mise install may run for the Global mise config (or your dotfiles' mise config) in a new Container, and in a Base build, before it is stopped. While it runs, the Container is in use, so its idle time does not stop it. A Container's first commands can wait up to twice this (once before the Container setup and again after it, when the setup may have changed your dotfiles' mise config) plus the Container setup time limit. In a Base build the install also counts against the Image setup time limit, which stops the build first if it is shorter. Applies at each Workspace's next Container start and the next Base build; a running Container keeps what it started with.",
    // The lay-down script's own `timeout` and the Workspace DO's wait for its exec (`globalMiseDeadlineMs`) time it, no
    // platform limit: the shared sanity maximum applies (ADR-0048).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 10 },
    tier: "down-free",
    row: "globalMiseConfig",
  },
  containerSetup: {
    title: "Container setup",
    description:
      "A bash script run once in every new Container before its first command, after the Global mise config: as root in / with HOME=/root and the Variables. Commands, Terminals and CLI agents wait for it. Status shows its exit and the end of its output, secret Variables blanked. Applies at each Workspace's next Container start.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
  },
  containerSetupMinutes: {
    title: "Container setup time limit (minutes)",
    description: "How long it may run before it is stopped and counts as failed.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 5 },
    tier: "down-free",
    row: "containerSetup",
  },
  containerSetupFailure: {
    title: "When the Container setup fails",
    description:
      "A non-zero exit, the time limit, or a Container that could not run it. Refuse commands: that Container runs no command, Terminal or CLI agent until a new Container starts.",
    schema: {
      type: "enum",
      values: CONTAINER_SETUP_FAILURES,
      default: "carryOn",
      labels: { carryOn: "Carry on", refuse: "Refuse commands" },
    },
    row: "containerSetup",
  },
  setupOutputKiB: {
    title: "Setup output kept (KiB)",
    description:
      "The last part of a setup's output that the Status section keeps and shows, secret Variables blanked: the Container setup's and the Base build's Image setup's. 4 to 256 KiB, 32 by default. Applies at each Workspace's next Container start and the next Base build; a report already kept stays as it is.",
    schema: { type: "integer", minimum: 4, maximum: MAX_SETUP_OUTPUT_KIB, default: 32 },
    tier: "down-free",
    row: "containerSetup",
  },
  cloneMinutes: {
    title: "Clone time limit (minutes)",
    description:
      "How long each clone may run in the Workspace's Container: a project's clone, and a new worktree's clone and its checkout. A clone or checkout that runs longer than this fails; while it runs it holds the Container. A new worktree's bundle counts against the Checkpoint time limit instead. Applies at the next clone or checkout; one already running keeps its limit.",
    // computerd times each exec with its own timer and no maximum (computer 0.11.2), so the shared sanity maximum
    // applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_CLONE_MINUTES },
    tier: "down-free",
  },
  checkpointMinutes: {
    title: "Checkpoint time limit (minutes)",
    description:
      "How long each checkpoint may run in the Workspace's Container: a turn's checkpoint and its restore, bundling a project's commits into a new worktree, and carrying a removed worktree's commits home. A checkpoint, bundle or carry that runs longer than this fails; while it runs it holds the Container. A removed worktree whose commits could not be carried home is kept, not purged. Applies at the next checkpoint, bundle or carry; one already running keeps its limit.",
    // As the clone time limit: computerd's own timer, no maximum, the shared sanity maximum (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_CHECKPOINT_MINUTES },
    tier: "down-free",
  },
  imageSetup: {
    title: "Image setup",
    description:
      "A bash script run once, as root with HOME=/root and every Variable (secret ones included), on the Workspace image after the Global mise config is laid down; its result is the Base snapshot. Once saved, a change builds a new one in the Builder, as a deploy and Rebuild do. Whatever it writes, a secret included, is in every Workspace's Container until the next Base build. Empty with no Global mise config, there is nothing to build.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
  },
  imageSetupMinutes: {
    title: "Image setup time limit (minutes)",
    description:
      "How long the Builder's Container may take to start and run the Image setup before the Base build fails.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 30 },
    tier: "down-free",
    row: "imageSetup",
  },
  snapshotMinutes: {
    title: "Snapshot time limit (minutes)",
    description:
      "How long the snapshot and the start from it that proves it may take before the Base build is reported failed. A snapshot that finishes later is still kept if nothing changed meanwhile.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 5 },
    tier: "down-free",
    row: "imageSetup",
  },
  builderSize: {
    title: "Builder size",
    description:
      "The vCPU, memory and disk the Builder's Container runs the Image setup with. Every Container size starts from the Base snapshot it makes.",
    schema: {
      type: "enum",
      values: [BUILDER_SAME_SIZE, ...CONTAINER_SIZE_NAMES],
      default: BUILDER_SAME_SIZE,
      labels: { [BUILDER_SAME_SIZE]: "Same as Container size" },
    },
    row: "imageSetup",
  },
  builderInBudget: {
    title: "Builder counts against the Container budget",
    description:
      "On, the Builder waits for room under the Container budget before it starts, and holds one place while it runs. Off, it runs beside the budget's Containers.",
    schema: { type: "boolean", default: false },
    row: "imageSetup",
  },
  rebuildEveryDays: {
    title: "Rebuild every (days)",
    description: `Builds the Base snapshot again this many days after the last good one, so the Image setup's downloads stay current. 0 is off. At most ${MAX_REBUILD_DAYS}: a Base snapshot expires 30 days after it was made or a Container last started from it, and this schedule counts from when it was made. It also comes early enough for a failed rebuild and its retry to finish before the snapshot expires, though, for that reason, never sooner than one build after the last: with very long time limits and retry, rebuilds then follow one another, and a failed one can outlast the snapshot.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REBUILD_DAYS, default: 0 },
    row: "imageSetup",
  },
  baseRetryMinutes: {
    title: "Base build retry (minutes)",
    description: `How long a failed Base build waits before it is built again on its own. Each further failure in a row doubles the wait, up to a day (or up to this setting, if it is longer than a day). The retry comes when a Workspace starts and finds no Base snapshot, the Environment starts, a new Workspace image arrives, or the schedule fires; a Rebuild runs at once. A shorter wait runs the Builder's Container, and bills it, more often while a build keeps failing. At most ${MAX_TIMED_MINUTES} (a week). Applies at the next retry.`,
    // t3flare's own alarm times it (the Builder's), no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_BASE_RETRY_MINUTES },
    tier: "up-free",
    row: "imageSetup",
  },
  whileBuilding: {
    title: "While a Base build runs",
    description:
      "What a Workspace's new Container starts from while the Base snapshot is being built. Last good Base snapshot: the one made before on this Workspace image, though its Image setup may be older. Wait: up to the Image setup and Snapshot time limits (35 minutes by default), then from the new Base snapshot, or the Workspace image if the build failed. Workspace image: starts at once, without the Image setup. A running Container keeps what it started from.",
    schema: {
      type: "enum",
      values: WHILE_BUILDING,
      default: "lastGood",
      labels: { lastGood: "Last good Base snapshot", wait: "Wait for the build", image: "Workspace image" },
    },
    row: "imageSetup",
  },
  whileBuildingNewImage: {
    title: "With no last good Base snapshot on this Workspace image",
    description:
      "Only when the setting above starts from the last good Base snapshot and none was made on the current Workspace image (a deploy changed the image, or none was ever made). Wait: up to the Image setup and Snapshot time limits. Workspace image: starts at once, without the Image setup.",
    schema: {
      type: "enum",
      values: WHILE_BUILDING_NEW_IMAGE,
      default: "wait",
      labels: { wait: "Wait for the build", image: "Workspace image" },
    },
    row: "imageSetup",
  },
  terminalsReadBashrc: {
    title: "Terminals read ~/.bashrc",
    description:
      "A Terminal's shell runs your ~/.bashrc, so your aliases, functions and prompt are there. Off, it starts with t3flare's shell setup alone. Applies at each Workspace's next Container start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  agentsReadDotfiles: {
    title: "CLI agents read your dotfiles",
    description:
      "Each CLI agent starts with a copy of your config for it (~/.claude and ~/.claude.json, ~/.codex, ~/.config/opencode, ~/.pi/agent, except its auth.json): your instructions, settings, hooks, skills and plugins. t3flare's model routing and managed settings still win, and Codex's shells get t3flare's environment (its inherit, exclude and include_only). An Environment skill wins over one of yours of the same name in Claude Code, OpenCode and pi; Codex shows both skills. Off, an agent starts with t3flare's config alone. Applies at each CLI agent's next start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  sweepPurges: {
    title: "Purge after the Grace",
    description:
      "Whether the Sweep purges a Workspace nothing references, a Tombstone with a date, and a deleted thread's Session once the Grace has passed. Off, the Sweep still marks what is unreferenced and purges nothing. Turned on, nothing is purged until one Grace after. Applies at the next Sweep.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
  },
  graceDays: {
    title: "Grace (days)",
    description:
      "How many days the Sweep keeps a Workspace nothing references, a Tombstone with a date, and a deleted thread's Session before it purges them. A change moves the date of everything already waiting. Applies at the next Sweep.",
    schema: { type: "integer", minimum: 1, maximum: MAX_GRACE_DAYS, default: DEFAULT_GRACE_DAYS },
    tier: "up-free",
  },
  usageRetentionDays: {
    title: "Usage records kept (days)",
    description:
      "How many days t3flare keeps its usage records: each model answer's tokens and cost, which t3's Usage page shows. Shortening this deletes the older records at the next prune; they cannot be restored. t3's Usage page shows at most 90 days, so records older than that are kept but shown nowhere until t3 widens its window. At most 3650 (ten years), which keeps them for good. Applies at the next prune (at most once an hour, as usage is recorded) and to usage recorded from then on.",
    schema: { type: "integer", minimum: 1, maximum: MAX_RETENTION_DAYS, default: DEFAULT_USAGE_RETENTION_DAYS },
    tier: "up-free",
  },
  piSessionRetentionDays: {
    title: "Pi and Claude Code sessions kept (days)",
    description:
      "How many days a Pi or Claude Code session no one has written to is kept. An older one is deleted at the next Pi start, or by Claude Code at its next start; t3 can no longer resume that thread's conversation. At most 3650 (ten years), which keeps them for good. Applies at each Pi or Claude Code start.",
    schema: { type: "integer", minimum: 1, maximum: MAX_RETENTION_DAYS, default: DEFAULT_PI_SESSION_RETENTION_DAYS },
    tier: "up-free",
  },
  mcpCallSeconds: {
    title: "MCP call time limit (seconds)",
    description: `How long one MCP tool call may run before t3flare ends it and the agent is told it failed; it may have run on the server. Time spent waiting for your answer to the server's question does not count. A CLI agent's own tool timeout grows with it. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next call; a CLI agent's timeout at its next start.`,
    // The MCP engine times the call with its own timer (packages/mcp/src/connection.ts), no platform limit: the shared
    // sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_CALL_SECONDS },
    tier: "down-free",
  },
  outsideRequestSeconds: {
    title: "Outside request time limit (seconds)",
    description: `How long t3flare waits for one answer from GitHub, a sign-in's vendor (OpenAI, Anthropic, GitHub Copilot), T3 Connect or a Model endpoint: each GitHub read of a skills preview, install, update or check, each GitHub request of an Update and of the GitHub App's tokens, each request of a sign-in, its renewal and its revocation (a ChatGPT revocation with its retries takes at most twice this), each request of an MCP server's sign-in and of its token's refresh (every call to that server waits on a refresh), T3 Connect's sign-in code and its unlink, and a Model endpoint's model list, all its pages together. A request past it fails, and what waited on it with it; a longer limit holds a stalled one that long, and an agent's Stop during its skills install waits for the install, up to about 500 times this limit if every read stalls. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next request.`,
    // Timed by t3flare's own AbortSignal.timeout, no platform limit (an outbound fetch has none): the shared sanity
    // maximum applies (ADR-0048 §2).
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMED_SECONDS,
      default: DEFAULT_OUTSIDE_REQUEST_SECONDS,
    },
    tier: "down-free",
  },
  repoSkillsListed: {
    title: "Repo skills listed",
    description: `How many of a repository's skills (.pi/skills, .agents/skills, .claude/skills) are listed in a Pi Durable agent's prompt and offered in t3's composer, nearest first; the rest are counted as not listed. Each listed skill's name and description is in front of the model on every turn. At most ${MAX_REPO_SKILLS_LISTED}. Applies at each Workspace's next Container start.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REPO_SKILLS_LISTED, default: 100 },
    tier: "down-free",
  },
  skillsDirectoryEntries: {
    title: "Entries read per skills directory",
    description: `How many files and folders t3flare lists in one skills directory looking for SKILL.md files; skills past them are not found. A larger listing takes more of the Workspace's memory. At most ${MAX_DIRECTORY_ENTRIES}.`,
    schema: { type: "integer", minimum: 1, maximum: MAX_DIRECTORY_ENTRIES, default: 5000 },
    tier: "down-free",
  },
  skillsLinkEntries: {
    title: "Entries read through a skills link",
    description: `The same for a link in a skills directory to a folder elsewhere, which may lead anywhere. At most ${MAX_DIRECTORY_ENTRIES}.`,
    schema: { type: "integer", minimum: 1, maximum: MAX_DIRECTORY_ENTRIES, default: 200 },
    tier: "down-free",
  },
  promptsDirectoryEntries: {
    title: "Entries read per Prompt templates directory",
    description: `How many files and folders t3flare lists in one Prompt templates directory (.pi/prompts, a CLI agent's commands); templates past them are not offered. At most ${MAX_DIRECTORY_ENTRIES}.`,
    schema: { type: "integer", minimum: 1, maximum: MAX_DIRECTORY_ENTRIES, default: 1000 },
    tier: "down-free",
  },
  mcpResultKiB: {
    title: "MCP result size (KiB)",
    description: `The most of one MCP tool result t3flare takes, in KiB of UTF-8. A larger streamed result is refused whole, since it cannot be read in part; a larger inline one has its text cut to this, and its structured content dropped. The Environment holds a result whole while it reads it, beside t3, so a larger size uses more of its memory. At most ${MAX_MCP_RESULT_KIB} (${MAX_MCP_RESULT_KIB / 1024} MiB). Applies at the next call.`,
    // A provisional bound (`MAX_MCP_RESULT_KIB`): the Environment DO's isolate memory, by an estimate.
    schema: { type: "integer", minimum: 1, maximum: MAX_MCP_RESULT_KIB, default: DEFAULT_MCP_RESULT_KIB },
    tier: "down-free",
  },
  mcpPausesPerCall: {
    title: "Answers to one call's pauses",
    description: `How many times t3flare answers an MCP server that pauses one call for your approval or input (Executor's model mode): each pause is a card, or a decline when the card cannot be asked or goes unanswered. Past it, the call ends and the agent is told some of its steps may have run. At most ${MAX_MCP_PAUSES_PER_CALL}. Applies at the next call.`,
    // A sanity bound (`MAX_MCP_PAUSES_PER_CALL`): nothing forces a count, but some count ends a server that pauses forever.
    schema: { type: "integer", minimum: 1, maximum: MAX_MCP_PAUSES_PER_CALL, default: DEFAULT_MCP_PAUSES_PER_CALL },
    tier: "down-free",
  },
  mcpConnectSeconds: {
    title: "MCP server connect time limit (seconds)",
    description: `How long t3flare waits for an MCP server to answer the first requests of each connection (its probe and its initialize), for a call, a discovery or a test. Past it the server is reported unreachable; a longer limit holds a dead server's calls and discovery that long. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next connection to an MCP server.`,
    // The MCP engine times it with the SDK's own timer, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_CONNECT_SECONDS },
    tier: "down-free",
  },
  mcpListSeconds: {
    title: "MCP server listing time limit (seconds)",
    description: `How long t3flare lets one listing of an MCP server's tools, prompts or resources take, all its pages together. Past it that discovery fails and the server's agents get none of what it lists; a longer limit holds a slow or endless listing that long, its pages in memory. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next discovery of an MCP server.`,
    // The MCP engine times it with its own timer, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_LIST_SECONDS },
    tier: "down-free",
  },
  mcpLogEntries: {
    title: "MCP server logs kept per call",
    description: `How many of an MCP server's last log messages (warning and above) t3flare keeps during one call; older ones are dropped. Each is held, up to 128 KiB, in the MCP Worker's memory until the call ends. At most ${MAX_MCP_LOG_ENTRIES}. Applies at the next MCP call.`,
    // A sanity bound (`MAX_MCP_LOG_ENTRIES`), sized against the MCP Worker's isolate memory.
    schema: { type: "integer", minimum: 1, maximum: MAX_MCP_LOG_ENTRIES, default: DEFAULT_MCP_LOG_ENTRIES },
    tier: "down-free",
  },
  cliMcpStartSeconds: {
    title: "CLI agent's MCP start wait (seconds)",
    description: `How long Codex waits for each of t3flare's MCP relay servers to start before it goes on without that server's tools for the session. A longer wait holds a Codex start that long when the relay is slow. At most ${MAX_TIMED_SECONDS} (a week). Applies at each CLI agent's next start.`,
    // Codex times it itself (`startup_timeout_sec`), no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_CLI_MCP_START_SECONDS },
    tier: "free",
  },
  mcpSignInMinutes: {
    title: "MCP server sign-in time (minutes)",
    description: `How long an MCP server's OAuth sign-in may take, from its start on this page to the server's redirect back; a later redirect is refused and the sign-in must start again. Each started sign-in is kept, sealed, this long, then deleted. At most ${MAX_TIMED_MINUTES} (a week). Applies to sign-ins started after the change.`,
    // t3flare's own expiry, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_MCP_SIGN_IN_MINUTES },
    tier: "down-free",
  },
  githubRetrySeconds: {
    title: "Wait before asking GitHub again (seconds)",
    description: `How long t3flare waits before asking GitHub again after it failed or was refused, unless GitHub named its own time, which is always kept. The GitHub App's token waits double with each failure in a row, up to ${GITHUB_RETRY_GROWTH} times this; a GitHub Copilot renewal waits this once; an account the App is not installed on is looked for again at most this often. Meanwhile every agent and git operation that needs a token gets the same failure. A shorter wait asks GitHub more often while it fails, which can bring on its rate limits. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next failure.`,
    // t3flare's own wait, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_GITHUB_RETRY_SECONDS },
    tier: "up-free",
  },
  textGenerationSeconds: {
    title: "Text generation time limit (seconds)",
    description: `How long a Model endpoint's model may take to write a thread's title, a commit message, a pull request's text or a branch name. Past it, that action fails and says the endpoint did not answer in time; a slow or reasoning model may need longer. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next text generation.`,
    // The agents Worker's AbortSignal.timeout and the Environment's own wait (this plus `TEXT_GENERATION_MARGIN_MS`) time
    // it, no platform limit on a service binding's call: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_TEXT_GENERATION_SECONDS },
    tier: "down-free",
  },
  idleAfterSeconds: {
    title: "Environment sleeps after (seconds)",
    description: `How long the Environment waits with no open page, request or work before it sleeps; t3 starts again at the next request or wake, which takes a few seconds. While it waits it stays up, and Cloudflare bills its time. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next idle check.`,
    // t3flare's own check (an interval in the Environment DO), no platform limit: the shared sanity maximum applies
    // (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_IDLE_AFTER_SECONDS },
    tier: "down-free",
  },
  prWatchWakeMinutes: {
    title: "Pull request check while asleep (minutes)",
    description: `While a pull request is watched and the Environment sleeps, how often it wakes to check it: a merge or close is noticed up to this late. Each wake starts t3 for about a minute. At most ${MAX_TIMED_MINUTES} (a week). Applies at the next sleep.`,
    // t3flare's own alarm, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_PR_WATCH_WAKE_MINUTES },
    tier: "up-free",
  },
  remoteRetryMinutes: {
    title: "Longest Remote task retry (minutes)",
    description: `The longest the Environment waits before trying again a Remote task whose machine does not answer: 5 minutes, then 15, then this, each capped at it. A machine that comes back is noticed up to this late; each try starts t3. At most ${MAX_TIMED_MINUTES} (a week). Applies at the next try.`,
    // t3flare's own alarm, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_REMOTE_RETRY_MINUTES },
    tier: "up-free",
  },
  safeModeAfterFailures: {
    title: "Failed starts before safe mode",
    description: `How many starts of t3 in a row may fail before the Environment enters safe mode, where it starts t3 no more until you turn safe mode off; until then each request or wake starts it again. At most ${MAX_SAFE_MODE_AFTER_FAILURES}. Applies at the next start.`,
    // A sanity bound (`MAX_SAFE_MODE_AFTER_FAILURES`): some count ends a boot loop, its size is taste.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SAFE_MODE_AFTER_FAILURES,
      default: DEFAULT_SAFE_MODE_AFTER_FAILURES,
    },
    tier: "down-free",
  },
  browserProfileSaveSeconds: {
    title: "Browser profile save (seconds)",
    description: `How often an open preview browser's profile (its cookies and site storage) is saved while it changes. If the Environment restarts, up to this much of it is lost; each save is a browser command that keeps the browser, and its billing, alive. At most ${MAX_TIMED_SECONDS} (a week). Applies to profiles opened after the change.`,
    // t3flare's own timer, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMED_SECONDS,
      default: DEFAULT_BROWSER_PROFILE_SAVE_SECONDS,
    },
    tier: "up-free",
  },
  htmlBrowserKeepAliveSeconds: {
    title: "Keep the HTML render browser (seconds)",
    description: `How long the browser that renders t3's HTML stays open after its last render; the next render after it pays a new browser's start. Browser Run bills the time it stays open. At most ${MAX_BROWSER_KEEP_ALIVE_SECONDS} (Browser Run's own maximum). Applies to the next browser opened.`,
    // A named constraint: Browser Run's `keep_alive` takes at most 10 minutes (`MAX_BROWSER_KEEP_ALIVE_SECONDS`).
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_BROWSER_KEEP_ALIVE_SECONDS,
      default: DEFAULT_HTML_BROWSER_KEEP_ALIVE_SECONDS,
    },
    tier: "down-free",
  },
  pageTokenHours: {
    title: "Settings page token lifetime (hours)",
    description: `How long this page's token for changes lasts: at least this many hours and at most one more. The page fetches a new one when it runs out, so a page left open keeps working; a token copied out of it works as long. At most ${MAX_TIMED_MINUTES / 60} (a week). Applies to the next change.`,
    // Not timed by a timer (an HMAC of the hour), but a security window: the shared sanity maximum applies (ADR-0048).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES / 60, default: DEFAULT_PAGE_TOKEN_HOURS },
    tier: "down-free",
  },
  clientsPerKey: {
    title: "Owner clients kept per key",
    description: `How many clients of one Owner key the Settings server remembers, with the mode you set for each. A new client past it forgets the least recently seen, those you set Native or Model last. At most ${MAX_CLIENTS_PER_KEY}. Applies at the next new client.`,
    // A sanity bound (`MAX_CLIENTS_PER_KEY`): each is a small SQLite row; some count bounds a client that invents names.
    schema: { type: "integer", minimum: 1, maximum: MAX_CLIENTS_PER_KEY, default: DEFAULT_CLIENTS_PER_KEY },
    tier: "up-free",
  },
  connectPublishLogKept: {
    title: "T3 Connect publishes kept",
    description: `How many of T3 Connect's latest publish outcomes the Environment keeps for its status view. It is rewritten whole at each publish, so a longer log costs more at each. At most ${MAX_CONNECT_PUBLISH_LOG_KEPT}. Applies at the next publish.`,
    // A sanity bound (`MAX_CONNECT_PUBLISH_LOG_KEPT`): the log is one Durable Object value.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_CONNECT_PUBLISH_LOG_KEPT,
      default: DEFAULT_CONNECT_PUBLISH_LOG_KEPT,
    },
    tier: "up-free",
  },
  durableRetries: {
    title: "Durable agent retries",
    description: `How many times a Durable agent tries a failed model request again before its turn fails. The tries wait ${DURABLE_RETRY_FIRST_WAIT_MS / 1000} seconds, doubling, each at most ${DURABLE_RETRY_LONGEST_WAIT_MS / 1000} seconds (${DEFAULT_DURABLE_RETRIES} span ${retriedSpanMs(DEFAULT_DURABLE_RETRIES) / 1000} seconds), so a rate limit that resets within that span is waited through and a later one pauses the thread. Each try is a request the endpoint may bill. 0 never tries again. At most ${MAX_MODEL_RETRIES}. Applies at each thread's next turn.`,
    // Counted by pi-durable's generation retry (its `settings.retry`), no platform limit: a sanity maximum.
    schema: { type: "integer", minimum: 0, maximum: MAX_MODEL_RETRIES, default: DEFAULT_DURABLE_RETRIES },
    tier: "down-free",
  },
  cliRetries: {
    title: "CLI agent retries",
    description: `How many times Codex, Claude Code and the pi CLI try a failed model request again before the turn fails (OpenCode keeps its own). Each try is a request the endpoint may bill. 0 never tries again. At most ${MAX_MODEL_RETRIES}. Applies at each CLI agent's next start.`,
    // Each CLI's own retry count (Codex's request and stream retries, Claude Code's CLAUDE_CODE_MAX_RETRIES, pi's
    // retry.maxRetries), no platform limit: a sanity maximum.
    schema: { type: "integer", minimum: 0, maximum: MAX_MODEL_RETRIES, default: DEFAULT_CLI_RETRIES },
    tier: "down-free",
  },
  killAttempts: {
    title: "Kill tries after a stop (Durable agents)",
    description: `After a Durable agent's command is stopped, how many times t3flare tries to end its processes that survive, about ${KILL_RETRY_MS / 1000} seconds apart (${DEFAULT_KILL_ATTEMPTS} is about ${(DEFAULT_KILL_ATTEMPTS * KILL_RETRY_MS) / 1000} seconds), before it leaves them running. Each try keeps the Workspace's Container awake. At most ${MAX_KILL_ATTEMPTS}. Applies at each thread's next turn.`,
    // At least 1: a stopped command's first kill always runs (RunningExecs.stopped), so 0 would act as 1.
    schema: { type: "integer", minimum: 1, maximum: MAX_KILL_ATTEMPTS, default: DEFAULT_KILL_ATTEMPTS },
    tier: "down-free",
  },
  traceKiB: {
    title: "t3's trace file size (KiB)",
    description: `How large t3's trace file, which t3's diagnostics read, grows before t3 starts a new one. Each trace write reads the whole file and writes it back, so a larger file costs more Durable Object storage writes and memory at every write. At most ${MAX_TRACE_KIB} (${MAX_TRACE_KIB / 1024} MiB). Applies at t3's next start.`,
    // A named constraint (MAX_TRACE_KIB): one State directory row, for the isolate's memory at each flush.
    schema: { type: "integer", minimum: 1, maximum: MAX_TRACE_KIB, default: DEFAULT_TRACE_KIB },
    tier: "down-free",
  },
  traceFiles: {
    title: "t3's older trace files kept",
    description: `How many full trace files t3 keeps besides the one it writes. Lowering it deletes the oldest at t3's next start. At most ${MAX_TRACE_FILES}. Applies at t3's next start.`,
    // t3 refuses fewer than 1 (makeAsyncRotatingFileSink); the maximum is a sanity bound (MAX_TRACE_FILES).
    schema: { type: "integer", minimum: 1, maximum: MAX_TRACE_FILES, default: DEFAULT_TRACE_FILES },
    tier: "up-free",
  },
  tempFilesHours: {
    title: "Temp files kept (hours)",
    description: `How long t3flare keeps its temp files in a Workspace: a long command's output saved for the agent to read, and scratch folders. Older ones are deleted at an agent's first file operation after the Workspace wakes; an agent given such a file's path can no longer read it. At most ${MAX_RETENTION_DAYS * 24} (ten years), which keeps them for good. Applies from each Workspace's next Container start.`,
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RETENTION_DAYS * 24,
      default: DEFAULT_TEMP_FILES_HOURS,
    },
    tier: "up-free",
  },
  gitReadsKept: {
    title: "Git answers kept per Workspace",
    description: `How many answers to t3's git reads (a branch list, a status) each Workspace keeps, to answer them while its Container is stopped. Past this the least recently used is deleted, and that read fails while the Container is stopped until it runs again. Each answer is stored in the Workspace and is usually a few KB. At most ${MAX_GIT_READS_KEPT}. Applies at each Workspace's next Container start.`,
    // A sanity bound (`MAX_GIT_READS_KEPT`): the Workspace DO's storage is the real one.
    schema: { type: "integer", minimum: 1, maximum: MAX_GIT_READS_KEPT, default: DEFAULT_GIT_READS_KEPT },
    tier: "down-free",
  },
  routerTraceEntries: {
    title: "Command trace entries",
    description: `How many of the latest commands t3 ran through t3flare (git, gh, CLI agents) the diagnostic trace keeps. Each entry takes memory in the Environment until it restarts. At most ${MAX_ROUTER_TRACE_ENTRIES}. Applies at the next command.`,
    // A sanity bound (`MAX_ROUTER_TRACE_ENTRIES`): the Environment DO's memory.
    schema: { type: "integer", minimum: 1, maximum: MAX_ROUTER_TRACE_ENTRIES, default: DEFAULT_ROUTER_TRACE_ENTRIES },
    tier: "down-free",
  },
  commandMinutes: {
    title: "Command time limit (minutes)",
    description: `How long a command in the Workspace's Container may run when nothing else sets its limit: an agent's search or read of a path only the Container has, and the credential helper's install. A command that runs longer than this is ended and fails; while it runs it holds the Container. t3's own git commands are not cut by it: each ends when t3 gives up on it. At most ${MAX_TIMED_MINUTES} (a week). Applies at each Workspace's next Container start.`,
    // computerd times each exec with its own timer and no maximum (computer 0.11.2), so the shared sanity maximum applies
    // (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_COMMAND_MINUTES },
    tier: "down-free",
  },
  containerConnectSeconds: {
    title: "Container start wait (seconds)",
    description: `How long a Container start waits for the Container to answer before it fails, every command waiting on it with it. A large image or a slow cold start may need longer; while it waits it holds a place in the Container budget. At most ${MAX_TIMED_SECONDS} (a week). Applies from each Workspace's next Container start; one start may still use the wait before.`,
    // computer's connect deadline, one timer shared by its retries (baseStart.ts); the shared sanity maximum applies
    // (ADR-0048 §2), in seconds.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TIMED_SECONDS,
      default: DEFAULT_CONTAINER_CONNECT_SECONDS,
    },
    tier: "down-free",
  },
  reclaimProtectionSeconds: {
    title: "Reclaim protection after a command (seconds)",
    description: `Only while the Container budget is full and another Workspace asks for a Container: a Workspace that ran a command this recently keeps its Container, and the other waits. Shorter lets a waiting start go sooner, but two busy Workspaces may stop each other's Container between commands and cold-start each time. At most ${MAX_TIMED_SECONDS} (a week). Applies at each Workspace's next Container start.`,
    // Compared with the last command's time, no timer: the shared sanity maximum applies (ADR-0048 §2), in seconds.
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_TIMED_SECONDS,
      default: DEFAULT_RECLAIM_PROTECTION_SECONDS,
    },
    tier: "free",
  },
  skillsWaitSeconds: {
    title: "Environment skills wait (seconds)",
    description: `How long a turn waits for a running Container to get a newly changed set of Environment skills before it goes on with the set the Container has. A long wait delays the turn's start that long whenever the copy is slow. At most ${MAX_TIMED_SECONDS} (a week). Applies at each Workspace's next Container start.`,
    // The Container's script counts its looks with sleep, no timer; the exec's deadline derives from it
    // (apps/agents/src/workspace/skillSetTake.ts). The shared sanity maximum applies (ADR-0048 §2), in seconds.
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_SKILLS_WAIT_SECONDS },
    tier: "free",
  },
  abortGraceSeconds: {
    title: "Stopped command's grace (seconds)",
    description: `When an agent's command is stopped: how long its processes get after TERM to end on their own before KILL. A process that needs longer to flush (a database) loses what it had not written; the stop waits up to this long, and ${KILL_GIVE_UP_MS / 1000} s more for KILL. At most ${MAX_STOP_GRACE_SECONDS}. Applies at each Workspace's next Container start.`,
    // A sanity bound (`MAX_STOP_GRACE_SECONDS`).
    schema: { type: "integer", minimum: 0, maximum: MAX_STOP_GRACE_SECONDS, default: DEFAULT_ABORT_GRACE_SECONDS },
    tier: "free",
  },
  portStopGraceSeconds: {
    title: "Stopped port's grace (seconds)",
    description: `When a listening port is stopped from t3: how long its processes get after TERM to end on their own before KILL. A dev server that needs longer to flush loses what it had not written; the stop waits up to this long. At most ${MAX_STOP_GRACE_SECONDS}. Applies at each Workspace's next Container start.`,
    // A sanity bound (`MAX_STOP_GRACE_SECONDS`).
    schema: { type: "integer", minimum: 0, maximum: MAX_STOP_GRACE_SECONDS, default: DEFAULT_PORT_STOP_GRACE_SECONDS },
    tier: "free",
  },
  firstPromptSeconds: {
    title: "Wait for a new Terminal's prompt (seconds)",
    description: `What you type into a new Terminal before its shell first shows its prompt is held until the prompt shows. For a shell that never shows t3flare's prompt (a custom rc file that replaces it), the Terminal looks unresponsive for this long; the next thing you type after it sends what was held. At most ${MAX_TIMED_SECONDS} (a week). Applies at each Workspace's next Container start.`,
    // t3flare's own check against the clock (terminalHost.ts), so the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_FIRST_PROMPT_SECONDS },
    tier: "free",
  },
  terminalHistoryKiB: {
    title: "Terminal history (KiB)",
    description: `How much of each Terminal's output t3 keeps to show again on a reattach; older output is dropped. Every open Terminal's history, and each kept exited one's, is held in the Environment's memory, ${ISOLATE_MEMORY_MB} MB beside everything else it runs: too much can fail the Environment and every thread with it. At most ${MAX_TERMINAL_HISTORY_KIB} (stock t3's). Applies when the Environment next restarts, as every deploy does.`,
    // A sanity bound (`MAX_TERMINAL_HISTORY_KIB`): the isolate's memory is the real one, which the description states.
    schema: {
      type: "integer",
      minimum: 64,
      maximum: MAX_TERMINAL_HISTORY_KIB,
      default: DEFAULT_TERMINAL_HISTORY_KIB,
    },
    tier: "down-free",
  },
  exitedTerminalsKept: {
    title: "Exited Terminals kept",
    description: `How many exited Terminals keep their history for a reattach; past this the oldest is forgotten. Each kept one holds up to the Terminal history in the same memory. At most ${MAX_EXITED_TERMINALS_KEPT} (stock t3's). Applies when the Environment next restarts, as every deploy does.`,
    // A sanity bound (`MAX_EXITED_TERMINALS_KEPT`), as the Terminal history's.
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_EXITED_TERMINALS_KEPT,
      default: DEFAULT_EXITED_TERMINALS_KEPT,
    },
    tier: "down-free",
  },
  previewPorts: {
    title: "Container preview ports",
    description: `The Container ports a preview browser can open, comma-separated, each as http://<port>.t3flare.internal/: a dev server on any other port cannot be previewed. At most ${MAX_PREVIEW_PORTS}, and never ${RESERVED_CONTAINER_PORTS.join(" or ")}, t3flare's own; by default ${DEFAULT_PREVIEW_PORTS.join(", ")}. Applies to preview browsers opened after the change.`,
    // Named constraints: Browser Run's eight hosts (`MAX_PREVIEW_PORTS`), t3flare's own ports (`RESERVED_CONTAINER_PORTS`).
    // No tier, deliberately: which Container ports a browser may reach is asked either way (ADR-0035 §3).
    schema: {
      type: "ports",
      maxCount: MAX_PREVIEW_PORTS,
      reserved: RESERVED_CONTAINER_PORTS,
      default: DEFAULT_PREVIEW_PORTS,
    },
  },
  portProbeMs: {
    title: "Port check wait (ms)",
    description: `How long a check of a Container port waits for its server to answer; a dev server slower than this to answer shows as down. At most ${MAX_TIMED_MINUTES * 60_000} (a week). Applies at each Workspace's next Container start.`,
    // AbortSignal.timeout, a JS timer: the shared sanity maximum applies (ADR-0048 §2), in ms.
    schema: { type: "integer", minimum: 100, maximum: MAX_TIMED_MINUTES * 60_000, default: DEFAULT_PORT_PROBE_MS },
    tier: "free",
  },
} as const satisfies Readonly<Record<string, EnvironmentSettingEntry>>;

export type EnvironmentKey = keyof typeof ENVIRONMENT_SETTINGS;

const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENT_SETTINGS) as ReadonlyArray<EnvironmentKey>;

/** The value a field of `schema` holds: an enum's own names, a number, a boolean or text (a `file` field's too). */
type ValueOf<Schema> = Schema extends { readonly type: "enum"; readonly values: ReadonlyArray<infer Name> }
  ? Name
  : Schema extends { readonly type: "integer" | "number" }
    ? number
    : Schema extends { readonly type: "boolean" }
      ? boolean
      : Schema extends { readonly type: "variables" }
        ? ReadonlyArray<Variable>
        : Schema extends { readonly type: "ports" }
          ? ReadonlyArray<number>
          : string;

/** What a Workspace DO reads: every setting resolved, a stored value that no longer fits read as its default. */
export type ResolvedEnvironment = { readonly revision: number } & {
  readonly [Key in EnvironmentKey]: ValueOf<(typeof ENVIRONMENT_SETTINGS)[Key]["schema"]>;
};

/** Setting `key`'s entry, typed as any Environment setting (the schema's own type is narrower per key). */
export const settingOf = (key: EnvironmentKey): EnvironmentSettingEntry => ENVIRONMENT_SETTINGS[key];

/** Whether `value` fits setting `key`'s schema. */
export const fitsEnvironmentSetting = (key: EnvironmentKey, value: unknown): boolean =>
  fieldProblem(settingOf(key).schema, value) === undefined;

/**
 * The settings every Workspace DO starts its Container with. `settings` is what was stored, or an answer from an
 * Environment newer or older than this Worker: a value that is missing or no longer fits reads as its default.
 */
export const resolveEnvironment = (stored: {
  readonly revision: number;
  readonly settings: Readonly<Record<string, unknown>>;
}): ResolvedEnvironment => {
  const resolved: Record<string, unknown> = { revision: stored.revision };
  for (const key of ENVIRONMENT_KEYS) {
    const value = stored.settings[key];
    const schema = settingOf(key).schema;
    // Variables: one a later rule refuses is dropped alone, never the whole set (ADR-0032's Variables refinement).
    if (schema.type === "variables") resolved[key] = fitVariables(value);
    else resolved[key] = value !== undefined && fitsEnvironmentSetting(key, value) ? value : schema.default;
  }
  // SAFETY: every key of the schema was set above, each to a value its schema accepts.
  return resolved as ResolvedEnvironment;
};

/**
 * The stored Environment settings as a read shows them (ADR-0046): a set of Variables as `fitVariables` reads it, each
 * secret's sealed value as its fingerprint. Everything else as stored.
 */
export const readStoredEnvironment = (stored: StoredEnvironment): StoredEnvironment =>
  stored.settings.variables === undefined
    ? stored
    : { ...stored, settings: { ...stored.settings, variables: fitVariables(stored.settings.variables) } };

/**
 * Whether two settings' values, as read, are equal: a scalar by identity, Variables by their names, values and Secret
 * toggles in order, a secret by its fingerprint (the same value sealed again is no change).
 */
const sameValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    JSON.stringify(a) === JSON.stringify(b));

/** One change from the panel or a script: some of the settings. */
export interface EnvironmentChange {
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * `stored` with `change` applied, or why it is refused. `changed` names the settings whose resolved value moved; only
 * they are stored and the revision is bumped only when there is one (a form posts every setting on each save).
 */
export const applyEnvironmentChange = (
  stored: StoredEnvironment,
  change: EnvironmentChange,
):
  | { readonly ok: true; readonly environment: StoredEnvironment; readonly changed: ReadonlyArray<EnvironmentKey> }
  | { readonly ok: false; readonly error: string } => {
  if (Object.keys(change.settings).length === 0) return { ok: false, error: "the change sets nothing" };
  for (const key of Object.keys(change.settings))
    if (!Object.hasOwn(ENVIRONMENT_SETTINGS, key)) return { ok: false, error: `${key}: no such setting` };
  const entries = Object.entries(change.settings).map(
    ([key, value]) => [key, normalizeField(settingOf(key as EnvironmentKey).schema, value)] as const,
  );
  for (const [key, value] of entries) {
    const why = fieldProblem(settingOf(key as EnvironmentKey).schema, value);
    if (why !== undefined) return { ok: false, error: `${key}: ${why}` };
  }
  const before: Readonly<Record<string, unknown>> = resolveEnvironment(stored);
  // Compared as read: a set of Variables as `fitVariables` reads it, its secrets by their fingerprints.
  const moved = entries.filter(
    ([key, value]) =>
      !sameValue(
        before[key],
        settingOf(key as EnvironmentKey).schema.type === "variables" ? fitVariables(value) : value,
      ),
  );
  if (moved.length === 0) return { ok: true, environment: stored, changed: [] };
  const environment: StoredEnvironment = {
    revision: stored.revision + 1,
    settings: { ...stored.settings, ...(Object.fromEntries(moved) as Record<string, EnvironmentValue>) },
  };
  // The one bound on their sizes together: the settings are one Durable Object value.
  const tooLarge = storedValueProblem("the Environment settings", environment);
  if (tooLarge !== undefined) return { ok: false, error: tooLarge };
  return { ok: true, environment, changed: moved.map(([key]) => key as EnvironmentKey) };
};
