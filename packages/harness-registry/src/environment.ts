// The Environment settings (SPI-1149, ADR-0032): what the Cloud Environment gives every Workspace and its Container,
// apart from the Harness settings (ADR-0026). Kept in the Environment DO under their own key and revision, so a change
// here never makes a Session take the Harness settings again. Edited in the Settings page's Environment section; read by
// each Workspace DO before a Container start, and by the Environment DO's Sweep for the Grace (ADR-0043), which the page
// edits in its Workspaces section. Imported by both Workers.
//
// One schema (`ENVIRONMENT_SETTINGS`), one resolve (`resolveEnvironment`), one change (`applyEnvironmentChange`): a later
// setting (the Global mise config, SPI-1150; Variables, SPI-1152) is one entry in `ENVIRONMENT_SETTINGS`. The resolved
// type, the resolve, the validation and the panel's section all follow from it.
import {
  type EnvironmentSettingEntry,
  type EnvironmentValue,
  fieldProblem,
  fitPorts,
  normalizeField,
} from "./fields.ts";
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
 * What an off time limit (SPI-1386: 0, no limit) gives a deadline that cannot be left out, in ms: computerd's exec, whose
 * absent `timeoutMs` is unverified, and the MCP engine's requests, whose SDK times a request it gives no timeout at 60 s.
 * `MAX_TIMED_MINUTES`, the shared sanity maximum (ADR-0048 §2): a week, under the 24.8 days past which a JS timer
 * overflows. A limit t3flare times itself and can leave unarmed (the Turn limit) arms nothing instead.
 */
export const OFF_DEADLINE_MS = MAX_TIMED_MINUTES * 60_000;

/** A time limit in ms as a deadline: `OFF_DEADLINE_MS` when it is off (0). The one place an off limit becomes the week. */
export const offDeadlineMs = (ms: number): number => (ms === 0 ? OFF_DEADLINE_MS : ms);

/** A time limit of `value` units of `unitMs` as a deadline in ms: `OFF_DEADLINE_MS` when it is off (0). */
export const deadlineMs = (value: number, unitMs: number): number => offDeadlineMs(value * unitMs);

/**
 * The Container budget's default (SPI-1386: local parity): 0, no budget, so as many Containers run at once as the
 * account's own limits allow. The Owner sets a number in the Environment settings (`containerBudget`) to cap cost; each
 * Workspace DO carries it with its lease request.
 */
export const DEFAULT_CONTAINER_BUDGET = 0;

/**
 * The most the Container budget may be set to: a sanity bound, not a constraint (ADR-0048). Nothing in t3flare forces
 * 100, and `max_instances` does not apply under `schedulingPolicy: "durable_object"` (apps/agents/src/budget.ts); 100 of
 * the largest size (4 vCPU, 12 GiB, 20 GB) is under each of the account's documented default concurrent Container
 * limits, which bound it in fact and which t3flare does not check.
 */
export const MAX_CONTAINER_BUDGET = 100;

/**
 * The memory a Container keeps for what is not a CLI agent, in MiB (SPI-1387): computerd (~100 MB) and the agents' own
 * commands beside them. A value only t3flare's machinery uses.
 */
export const CLI_RESERVED_MEMORY_MIB = 1024;

/**
 * The largest measured CLI agent turn's peak memory, in bytes (SPI-1387): 440 MiB, about 461 MB, OpenCode's measured
 * 439 MiB in a turn running `npm ci && npm test` (steps-evidence-1:docs/steps/step-4b/m0-local.json P7) rounded up to a
 * whole 10 MiB, the Owner's "about 450 MB per CLI process"; Claude Code peaked at 344 MiB, and an idle Codex app-server
 * measured 157–160 MB (steps-evidence-1:docs/steps/step-4a/m3-memory.json).
 */
export const CLI_TURN_PEAK_BYTES = 440 * 1024 * 1024;

/**
 * How many CLI agents' processes one Workspace's Container may run at once, each process counted once (SPI-1364),
 * derived from its memory (SPI-1387): what is left past `CLI_RESERVED_MEMORY_MIB`, over `CLI_TURN_PEAK_BYTES`, and at
 * least one. 4 on `cpu-1` (3 GiB), 16 on `standard-3` (8 GiB).
 */
export const cliProcessesPerWorkspaceOf = (memoryMib: number): number =>
  Math.max(1, Math.floor(((memoryMib - CLI_RESERVED_MEMORY_MIB) * 1024 * 1024) / CLI_TURN_PEAK_BYTES));

/**
 * The CLI agents' processes per Workspace for the Container size `settings` set (SPI-1387): `cliProcessesPerWorkspaceOf`
 * its memory.
 */
export const cliProcessesPerWorkspace = (
  settings: Pick<ResolvedEnvironment, "containerSize" | "customVcpu" | "customMemoryMib" | "customDiskMb">,
): number =>
  cliProcessesPerWorkspaceOf(containerResources(settings.containerSize, customResources(settings)).memoryMib);

/**
 * How long a CLI agent's process out of a turn waits, only while the Container budget is full, before it may be ended to
 * free the Container for another Workspace, in seconds (review F7; SPI-1387). A value only t3flare's machinery uses; a
 * CLI process holds the Container for `CLI_IDLE_HOLD_MS` after its last turn in any case.
 */
export const CLI_RECLAIM_SECONDS = 30;

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
 * The Turn limit's default, in minutes (`turnLimitMinutes`; step 2a's cost guardrail, ADR-0015's CLI cap): how long a
 * turn of the Durable agent or of a CLI agent may run before it is ended. 0, off (SPI-1386: stock t3 has no turn limit);
 * the Owner opts in with minutes.
 */
export const DEFAULT_TURN_LIMIT_MINUTES = 0;

/**
 * The Turn limit's default in ms, 0 (off): the one source for it, used where no setting reaches (a test's services, a
 * Session's turn whose start carried no limit, or one recorded before the setting).
 */
export const DEFAULT_TURN_LIMIT_MS = DEFAULT_TURN_LIMIT_MINUTES * 60_000;

/**
 * The clone time limit's default, in minutes (`cloneMinutes`, SPI-1324): how long a Workspace's clone, and a worktree
 * Workspace's clone and checkout, may run in its Container. 0, off (SPI-1386: a local git clone has no time limit). The
 * Workspace DO uses it for a call that carries no limit.
 */
export const DEFAULT_CLONE_MINUTES = 0;

/** The clone time limit's default in ms (0, off): used where no setting reaches (a call that carries none, a test's). */
export const DEFAULT_CLONE_MS = DEFAULT_CLONE_MINUTES * 60_000;

/**
 * The checkpoint time limit's default, in minutes (`checkpointMinutes`, SPI-1324): how long a turn's checkpoint and its
 * restore, a worktree's seed bundle, and carrying a removed worktree's commits home may run in the Container. 0, off
 * (SPI-1386: local t3 checkpoints with no time limit). The Workspace DO uses it for a call that carries no limit.
 */
export const DEFAULT_CHECKPOINT_MINUTES = 0;

/**
 * The checkpoint time limit's default in ms (0, off): used where no setting reaches (a call that carries none, a test's).
 */
export const DEFAULT_CHECKPOINT_MS = DEFAULT_CHECKPOINT_MINUTES * 60_000;

/**
 * The command time limit's default, in minutes (`commandMinutes`, SPI-1364): how long a Container command that carries no
 * limit of its own may run (an agent's file search on a Container-only path, git's reads and actions for t3, the
 * credential helper's install). 0, off (SPI-1386: an agent's search or read has no time limit locally). The Workspace DO
 * uses it for a call that carries none.
 */
export const DEFAULT_COMMAND_MINUTES = 0;

/** The command time limit's default in ms (0, off): used where no setting reaches (a call that carries none, a test's). */
export const DEFAULT_COMMAND_MS = DEFAULT_COMMAND_MINUTES * 60_000;

/**
 * The Container connect wait's default, in seconds (`containerConnectSeconds`, SPI-1364): computer's connect deadline.
 * 120 (SPI-1386): a large image or a slow cold start needs longer than the 60 before it.
 */
export const DEFAULT_CONTAINER_CONNECT_SECONDS = 120;

/**
 * The reclaim protection, in seconds (SPI-1364, SPI-1387): a Workspace that ran a command this recently is never stopped
 * to free the Container budget for another, so two Workspaces under a full budget do not evict each other between
 * commands. A value only t3flare's machinery uses.
 */
export const RECLAIM_PROTECTION_SECONDS = 30;

/**
 * How long a turn waits for a running Container to take a newly changed set of Environment skills, in seconds (SPI-1364,
 * plan §4.2's "up to 5 s"; SPI-1387). Past it the turn goes on with the set the Container has: nothing fails. A value
 * only t3flare's machinery uses.
 */
export const SKILLS_WAIT_SECONDS = 5;

/**
 * The stop grace, in seconds (SPI-1387): a stopped command's processes, a stopped port's group and a stopped agent's
 * Terminal get this long after TERM or the close before KILL. Stock t3's `STOP_GRACE_MS` (3 s,
 * `apps/server/src/preview/PortScanner.ts`; docs/upstream-fragility.md U103). A value only t3flare's machinery uses.
 */
export const STOP_GRACE_SECONDS = 3;

/**
 * How long the kill script keeps signalling after its KILL before it gives up: a process KILL cannot end (one in
 * uninterruptible sleep) would otherwise keep it looping. apps/sandbox-image/src/kill.ts names the same second.
 */
export const KILL_GIVE_UP_MS = 1000;

/**
 * How many git read answers a Workspace keeps (SPI-1364, SPI-1387): sized to t3's ~30 read shapes per branch, each a few
 * KB. A value only t3flare's machinery uses.
 */
export const GIT_READS_KEPT = 500;

/** How long t3flare keeps its temp files in a Workspace, in hours (SPI-1364, SPI-1387): long outputs, scratch folders. */
export const TEMP_FILES_HOURS = 24;

/**
 * How many of the latest commands the router's diagnostic trace keeps in the Environment DO's memory (SPI-1364,
 * SPI-1387). A value only t3flare's machinery uses; their texts are bounded by bytes where they are kept
 * (`ROUTER_TRACE_BYTES`, apps/environment/src/agents/processRouter.ts).
 */
export const ROUTER_TRACE_ENTRIES = 300;

/** A Durable Object isolate's memory, in MB: Cloudflare's documented Workers limit, which descriptions state. */
export const ISOLATE_MEMORY_MB = 128;

/**
 * How long input to a new t3 Terminal waits for its shell's first prompt, in seconds (SPI-1364, SPI-1387). A value only
 * t3flare's machinery uses.
 */
export const FIRST_PROMPT_SECONDS = 20;

/**
 * t3's Terminals' history in the Environment DO (SPI-1364, SPI-1387, SPI-1391): each Terminal's history in KiB, and how
 * many exited Terminals keep theirs for a reattach. Stock t3's values (8 MiB and 128): the history lives in each
 * Terminal's log file in the DO's storage, and memory holds only output not yet written there (Patch 0009,
 * docs/upstream-fragility.md U107).
 */
export const TERMINAL_HISTORY_KIB = 8 * 1024;
export const EXITED_TERMINALS_KEPT = 128;

/**
 * The dev servers' usual ports (G11, ADR-0031). A preview browser that may open any port (`previewPorts` off, SPI-1390)
 * routes these in the slots its Container's listeners leave free, so a dev server that starts on one later needs no
 * restart of the browser.
 */
export const USUAL_DEV_SERVER_PORTS: ReadonlyArray<number> = [3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787];

/**
 * The most Container ports one preview browser reaches. A named constraint: Browser Run routes at most eight hosts
 * (`outboundByHost`) per browser, each port is one host, and they are fixed when the browser is acquired (its acquire
 * refuses a ninth: "at most 8 outbound hosts are allowed", the SPI-1390 Stage probe).
 */
export const MAX_PREVIEW_PORTS = 8;

/**
 * The Container ports t3flare's own servers listen on, each with what it is for: no Container preview may reach one
 * (SPI-1390's listener check, ADR-0031). computerd answers the Container's commands and files to the Workspace DO, and
 * the MCP bridge (apps/sandbox-image/src/mcp-bridge.ts, not run by the image yet) would run stdio MCP servers.
 */
export const RESERVED_CONTAINER_PORT_USES: Readonly<Record<number, string>> = {
  8080: "computerd, its server that runs the Container's commands and serves its files",
  17_781: "the MCP bridge, its server for stdio MCP servers",
};

/** The ports of `RESERVED_CONTAINER_PORT_USES`, ascending. */
export const RESERVED_CONTAINER_PORTS: ReadonlyArray<number> = Object.keys(RESERVED_CONTAINER_PORT_USES)
  .map(Number)
  .sort((a, b) => a - b);

/** What a refused reserved port says: "port 8080 is reserved by t3flare for computerd, …"; undefined for any other. */
export const reservedPortMessage = (port: number): string | undefined => {
  const use = RESERVED_CONTAINER_PORT_USES[port];
  return use === undefined ? undefined : `port ${port} is reserved by t3flare for ${use}`;
};

/** `reservedPortMessage` as a sentence of its own, for a page: "Port 8080 is reserved by t3flare for computerd, …." */
export const reservedPortSentence = (port: number): string | undefined => {
  const message = reservedPortMessage(port);
  return message === undefined ? undefined : `P${message.slice(1)}.`;
};

/**
 * How long a port's probe waits for an answer, in ms (SPI-1364, SPI-1387): stock t3's `WEB_PROBE_TIMEOUT`
 * (`apps/server/src/preview/PortScanner.ts`; docs/upstream-fragility.md U103). A slower port shows as down. A value only
 * t3flare's machinery uses.
 */
export const PORT_PROBE_MS = 1000;

/**
 * How long a Container start or a turn waits for the newest settings before it runs with the ones it last took, in
 * seconds (SPI-1314, SPI-1387). Past it nothing fails. A value only t3flare's machinery uses.
 */
export const SETTINGS_READ_SECONDS = 5;

/** `SETTINGS_READ_SECONDS` in ms. */
export const SETTINGS_READ_MS = SETTINGS_READ_SECONDS * 1000;

/**
 * Park after's default, in minutes (`parkAfterMinutes`, SPI-1389): how long a CLI agent's card waits on its live turn
 * before the turn parks and its process ends, so its Container can stop. Owner-approved, matching t3's own release of an
 * idle session (Patch 0003, `CLI_SESSION_RELEASE_MS`).
 */
export const DEFAULT_PARK_AFTER_MINUTES = 10;

/** Park after's default in ms: used where no setting reaches (a test's services, or a store that cannot be read). */
export const DEFAULT_PARK_AFTER_MS = DEFAULT_PARK_AFTER_MINUTES * 60_000;

/** Park after of resolved Environment settings, in ms (SPI-1389); 0 when it is off (never park). */
export const parkAfterMsOf = (environment: { readonly parkAfterMinutes: number }): number =>
  environment.parkAfterMinutes * 60_000;

/**
 * How long a card waits for the Owner's answer (SPI-1389): until it is answered, as on stock t3. Where the machinery needs
 * a deadline (an Open change's page token and its row, the MCP library's wait for an elicitation's answer) it takes the
 * off deadline, a week (`OFF_DEADLINE_MS`).
 */
export const CARD_WAIT_MS = OFF_DEADLINE_MS;

/**
 * The Terminal holds' defaults, in minutes (`terminalBusyHoldMinutes`, `terminalPromptHoldMinutes`; SPI-1317): while a
 * Terminal runs a foreground command, open Terminals hold the Container until their last input is the busy hold old
 * (step 2b, ADR-0021; review F10: output does not count); while every one sits at its prompt, the prompt hold (cost
 * audit F1). The busy hold also caps a Container preview's hold (the Workspace DO's `#someoneWorks`).
 */
export const DEFAULT_TERMINAL_BUSY_HOLD_MINUTES = 30;
export const DEFAULT_TERMINAL_PROMPT_HOLD_MINUTES = 10;

/**
 * Pi Durable agents' Terminals and Background jobs (SPI-1397) run with no count of their own, as the Owner's Terminals
 * do and as on the Owner's machine: each keeps only its screen in the Workspace DO's memory, and its scrollback in the
 * Workspace DO's SQLite (`apps/agents/src/workspace/agentScrollback.ts`), up to `AGENT_TERMINAL_HISTORY_BYTES`, stock
 * t3's Terminal history (its `DEFAULT_HISTORY_BYTE_LIMIT`, 8 MiB). Older lines are dropped, oldest first, and the agent's
 * next look says so.
 */
export const AGENT_TERMINAL_HISTORY_BYTES = 8 * 1024 * 1024;

/**
 * How many exited Terminals and Background jobs one Workspace keeps readable across its Sessions, stock t3's 128 (its
 * exited Terminals kept; SPI-1397, the Owner's value): past it one is forgotten, never a running one: first those whose
 * exit was already seen, oldest exit first, then those not yet seen, whose exit is still reported once. An agent naming
 * one is told this bound. Until then each keeps its final screen and scrollback in the Workspace DO's SQLite, no xterm.
 */
export const AGENT_EXITED_TERMINALS_KEPT = 128;

/**
 * The lines an agent's Terminal's headless xterm keeps above its screen (SPI-1397), the room for output that scrolled
 * off before it goes to storage: its output is parsed in pieces that scroll at most this far, each piece's lines are
 * stored, and only then does the next go in. Provisional: a smaller margin parses more pieces, a larger one holds more
 * of each Terminal in memory.
 */
export const AGENT_TERMINAL_SPILL_LINES = 64;

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
 * How much of a setup's output a report keeps, in KiB of UTF-8: the tail the Status section shows (SPI-1360, SPI-1387).
 * The whole log is not kept anyway. A value only t3flare's machinery uses. It stays under `MAX_SETUP_OUTPUT_KIB`: the
 * Environment DO keeps the last report, output and all, as one Durable Object value, which `storedBytes` counts as three
 * bytes for each character of its JSON (storedValue.ts), and a byte of UTF-8 is at most one character.
 */
export const SETUP_OUTPUT_KIB = 32;

/**
 * The most of a setup's output a kept report may carry, in KiB: a third of one Durable Object value (`DO_VALUE_BYTES`),
 * since `storedBytes` counts three bytes for each character, so the output takes at most the whole value and the
 * report's other fields fit its margin only while the output is well under it. A report kept while the output kept was a
 * setting (SPI-1360 to SPI-1387) may carry more than `SETUP_OUTPUT_KIB`, so a read takes up to this.
 */
export const MAX_SETUP_OUTPUT_KIB = Math.floor(DO_VALUE_BYTES / 3 / 1024);

/** What a Container whose setup failed does (ADR-0047 §7): carries on, or refuses every command but a passive read. */
export const CONTAINER_SETUP_FAILURES = ["carryOn", "refuse"] as const;
export type ContainerSetupFailure = (typeof CONTAINER_SETUP_FAILURES)[number];

/**
 * The most days a scheduled rebuild may wait (ADR-0047 §3): the platform expires a snapshot 30 days after its creation
 * or last restore, and t3flare counts one 29 days past its last restore as gone. The schedule counts from creation.
 */
export const MAX_REBUILD_DAYS = 29;

/**
 * How long a failing key's first Base build retry waits, in minutes (SPI-1359, SPI-1387); each one after waits twice as
 * long, up to a day. A retry also comes at every Container start that finds no Base snapshot. A value only t3flare's
 * machinery uses.
 */
export const BASE_RETRY_MINUTES = 60;

/**
 * What a new Container starts from while a Base build runs (ADR-0047 §6): the last good Base snapshot when it was made on
 * the current Workspace image, the build's result once it ends, or the Workspace image.
 */
export const WHILE_BUILDING = ["lastGood", "wait", "image"] as const;
export type WhileBuilding = (typeof WHILE_BUILDING)[number];

/** The same while the last good Base snapshot was made on another Workspace image (ADR-0047 §6): wait, or the image. */
export const WHILE_BUILDING_NEW_IMAGE = ["wait", "image"] as const;
export type WhileBuildingNewImage = (typeof WHILE_BUILDING_NEW_IMAGE)[number];

/** The Environment settings a Base build reads besides the Global mise config and the Variables (ADR-0047 §9). */
export const BASE_BUILD_SETTING_KEYS = [
  "imageSetup",
  "imageSetupMinutes",
  "snapshotMinutes",
  "builderInBudget",
  "rebuildEveryDays",
] as const;

/**
 * The Grace's default, in days (ADR-0043 §1). 0 is never: the Sweep marks and purges nothing (SPI-1387 folded the
 * Sweep's own switch into it); at once is the Owner's own Purge.
 */
export const DEFAULT_GRACE_DAYS = 7;
/**
 * The longest Grace: a sanity bound (ADR-0048 §1), ten years. Nothing forces it; the bound that holds is a JS Date's
 * range (about 100 million days), which the Sweep's dates live in, far past it.
 */
export const MAX_GRACE_DAYS = 3650;

/**
 * The Environment settings the Sweep reads (ADR-0043) and no Container does: they apply at the next Sweep, not at a
 * Container start, and the Settings page shows them in its Workspaces section, not its Environment section.
 */
export const SWEEP_SETTING_KEYS = ["graceDays"] as const;

/**
 * The agents' settings (SPI-1315): how long a turn may run, and how long a CLI agent's card waits before its turn parks
 * (SPI-1389). They bound agents, not a Container start, so the Settings page shows them in an Agents row of their own, in
 * this order.
 */
export const AGENT_SETTING_KEYS = ["turnLimitMinutes", "parkAfterMinutes"] as const;

/**
 * The dotfiles toggles (ADR-0047 §9): whether the Owner's own config in their home reaches Terminals and CLI agents. The
 * Settings page shows them in a row of their own. `terminalsReadBashrc` applies at a Container start (the Workspace DO
 * keeps it with the launch); `agentsReadDotfiles` at each CLI agent's start (the Environment DO reads it at the spawn).
 */
export const DOTFILES_SETTING_KEYS = ["terminalsReadBashrc", "agentsReadDotfiles"] as const;

/**
 * How long t3flare keeps its own usage records and pi's and Claude Code's sessions (SPI-1323), in days. 0, off, by
 * default (SPI-1386: local parity): usage records are kept for good, as local t3 keeps them; pi keeps its sessions for
 * good, and Claude Code applies its own cleanup (`cleanupPeriodDays`, 30 days when unset).
 */
export const DEFAULT_USAGE_RETENTION_DAYS = 0;
export const DEFAULT_PI_SESSION_RETENTION_DAYS = 0;
/**
 * A sanity bound (ADR-0048 §1), the Grace's ten years: nothing forces it. Off (0) keeps for good, and ranks above it in
 * a Change tier (`offRank`), so keeping longer is always the free direction.
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
 * run. 0, off (SPI-1386: local parity): t3flare ends no call, and the server's own timeout still applies. The engine
 * still needs a deadline, so an off limit gives it `OFF_DEADLINE_MS`.
 */
export const DEFAULT_MCP_CALL_SECONDS = 0;

/**
 * How long an MCP server's requests other than a tool call (a resource read, a prompt, a listing page, a completion, a
 * subscription, a task's poll) may take while the call time limit is off: 270 s, the call time limit's default before
 * SPI-1386, which bounded them with it. Only a tool call is the Owner's to leave unbounded; these guard t3flare's own
 * reads of a server. With the call time limit set, they take it, as before.
 */
export const MCP_REQUEST_OFF_MS = 270_000;

/** The MCP call time limit's default in ms (0, off): used where no setting reaches (a test's host, a call with none). */
export const DEFAULT_MCP_CALL_MS = DEFAULT_MCP_CALL_SECONDS * 1000;

/**
 * How long t3flare waits for one answer from GitHub, a sign-in's vendor, T3 Connect or a Model endpoint, in seconds
 * (SPI-1365; SPI-1387 raised it from 15, past which a slow vendor's answer failed a sign-in renewal or an Update). A value
 * only t3flare's machinery uses.
 */
export const OUTSIDE_REQUEST_SECONDS = 30;

/** `OUTSIDE_REQUEST_SECONDS` in ms, as `AbortSignal.timeout` takes it. */
export const OUTSIDE_REQUEST_MS = OUTSIDE_REQUEST_SECONDS * 1000;

/** Whether `error` is a request's own time limit (`AbortSignal.timeout`'s `TimeoutError`). */
export const isTimeout = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { readonly name?: unknown }).name === "TimeoutError";

/**
 * The outside request time limit, hit (ADR-0049 §4): "did not answer in 30 s, t3flare's fixed outside request time
 * limit", for a request that waited `ms`.
 */
export const outsideRequestTimedOut = (ms: number = OUTSIDE_REQUEST_MS): string =>
  `did not answer in ${(ms / 1000).toLocaleString("en-US")} s, t3flare's fixed outside request time limit`;

/**
 * A clause for a message that says an outside request failed: " (it did not answer in 30 s, …)" when `error` is its
 * time limit, nothing otherwise, so a request that times out names its limit and its value (SPI-1387).
 */
export const outsideTimeoutClause = (error: unknown, ms: number = OUTSIDE_REQUEST_MS): string =>
  isTimeout(error) ? ` (it ${outsideRequestTimedOut(ms)})` : "";

/**
 * The most of one MCP tool result t3flare takes, in KiB of UTF-8 (SPI-1359, SPI-1387). A memory-safety bound, from an
 * estimate: the Environment DO's 128 MB isolate also runs t3's server, and the MCP host holds a result about six times over while it
 * reads it (`readStream` and `resultText` in apps/environment/src/mcp/host.ts: the chunks, the joined bytes, the decoded
 * text, the parsed JSON, then the text and structured content encoded again to be cut). Raise it only after a
 * measurement of the isolate's peak.
 */
export const MCP_RESULT_KIB = 1024;

/**
 * The MCP calls' settings (SPI-1359): how long one tool call may run. It bounds every agent's MCP calls through the MCP
 * host, Pi Durable's and the CLI relay's, at the next call, never a Container start, so the Settings page shows it in an
 * MCP calls row of its own.
 */
export const MCP_CALL_SETTING_KEYS = ["mcpCallSeconds"] as const;

/**
 * The MCP servers' settings (SPI-1363): how long a connection may take to start and one listing. Read as each call's
 * target is made, never at a Container start, so the Settings page shows them in an MCP servers row of their own, after
 * the MCP calls row.
 */
export const MCP_SERVER_SETTING_KEYS = ["mcpConnectSeconds", "mcpListSeconds"] as const;

/**
 * The outside requests' setting (SPI-1365): how long a Model endpoint's text generation may take. It bounds the
 * Environment's own requests at the next one, never a Container start, so the Settings page shows it in a row of its own.
 */
export const OUTSIDE_REQUEST_SETTING_KEYS = ["textGenerationSeconds"] as const;

/**
 * How long t3flare lets the Environment sleep, and what wakes it (SPI-1366): the idle delay before it resets and the PR
 * watch's wake. Read by the Environment DO at each use, never at a Container start, so the Settings page shows them in a
 * Sleep and wake row of their own.
 */
export const LIFECYCLE_SETTING_KEYS = ["idleAfterSeconds", "prWatchWakeMinutes"] as const;

/** Every Environment setting read at its own next use, not at a Container start (SPI-1366): the Settings server says so. */
export const NEXT_USE_SETTING_KEYS = [
  ...OUTSIDE_REQUEST_SETTING_KEYS,
  ...LIFECYCLE_SETTING_KEYS,
  // SPI-1364: the Container preview ports at each preview browser's acquisition.
  "previewPorts",
] as const;

/**
 * The text generation time limit's default, in seconds (`textGenerationSeconds`, SPI-1366): 180, stock t3's own for
 * Claude's and Codex's text generation (`CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`; SPI-1386). Nothing of t3's times a
 * Model endpoint's text generation around it.
 */
export const DEFAULT_TEXT_GENERATION_SECONDS = 180;

/**
 * How much longer than the text generation time limit the Environment waits for the agents Worker's answer: the agents
 * Worker ends the request at the limit itself and says why, so its answer, not the Environment's own deadline, reaches
 * t3 (SPI-1366; 10 s, the Environment's old 120 s less the old 110 s limit).
 */
export const TEXT_GENERATION_MARGIN_MS = 10_000;

/**
 * How long t3flare waits before asking GitHub again after it failed or was refused, in seconds (SPI-1366, SPI-1387):
 * GitHub's own Retry-After always wins. A value only t3flare's machinery uses.
 */
export const GITHUB_RETRY_SECONDS = 60;

/**
 * How many times `GITHUB_RETRY_SECONDS` the GitHub App's back-off may grow to, doubling at each failure in a row: 1 to
 * 15 minutes.
 */
export const GITHUB_RETRY_GROWTH = 15;

/** The idle delay's default, in seconds (`idleAfterSeconds`, SPI-1366): today's minute. */
export const DEFAULT_IDLE_AFTER_SECONDS = 60;

/** The PR watch's wake's default, in minutes (`prWatchWakeMinutes`, SPI-1366). */
export const DEFAULT_PR_WATCH_WAKE_MINUTES = 10;

/**
 * The longest wait before a Remote task whose machine does not answer is tried again, in minutes (SPI-1366, SPI-1387). A
 * value only t3flare's machinery uses.
 */
export const REMOTE_RETRY_MINUTES = 30;

/** Failed t3 starts in a row before safe mode (SPI-1366, SPI-1387). A value only t3flare's machinery uses. */
export const SAFE_MODE_AFTER_FAILURES = 3;

/**
 * How often an open preview browser's profile (cookies, site storage) is saved while it changed, in seconds (SPI-1366,
 * SPI-1387): a restart loses up to this much of it. A value only t3flare's machinery uses.
 */
export const BROWSER_PROFILE_SAVE_SECONDS = 60;

/**
 * How long the HTML renders' browser outlives its last render, in seconds: its Browser Run `keep_alive` (SPI-1366,
 * SPI-1387). Browser Run bills the time it stays open, and takes at most `MAX_BROWSER_KEEP_ALIVE_SECONDS`. A value only
 * t3flare's machinery uses.
 */
export const HTML_BROWSER_KEEP_ALIVE_SECONDS = 120;

/**
 * The most a Browser Run session's `keep_alive` may be: Browser Run's own maximum, 10 minutes (a named constraint;
 * apps/environment/src/preview/browserRun.ts `BROWSER_KEEP_ALIVE_MS`).
 */
export const MAX_BROWSER_KEEP_ALIVE_SECONDS = 600;

/**
 * How many hours a Settings page's token lasts, at least (SPI-1366, SPI-1387); the page fetches its own new one. A value
 * only t3flare's machinery uses.
 */
export const PAGE_TOKEN_HOURS = 1;

/** Owner clients the Settings server remembers per Owner key (SPI-1366, SPI-1387). A value only t3flare's machinery uses. */
export const CLIENTS_PER_KEY = 50;

/**
 * T3 Connect's publish log's entries kept (SPI-1366, SPI-1387): the log is one Durable Object value, rewritten whole at
 * each publish. A value only t3flare's machinery uses.
 */
export const CONNECT_PUBLISH_LOG_KEPT = 100;

/**
 * Answers to one MCP call's pauses (SPI-1366, SPI-1387): a loop guard against a server that pauses forever. A value only
 * t3flare's machinery uses.
 */
export const MCP_PAUSES_PER_CALL = 16;

/**
 * How long Codex waits for each of t3flare's MCP relay servers to start, in seconds (SPI-1366, SPI-1387); past it Codex
 * starts without that relay and says so. A value only t3flare's machinery uses.
 */
export const CLI_MCP_START_SECONDS = 20;

/**
 * How long a connection to an MCP server may take to start, by default (`mcpConnectSeconds`, SPI-1363): 30 s (SPI-1386),
 * since a cold-starting server can take longer than the 15 s before it to initialize.
 */
export const DEFAULT_MCP_CONNECT_SECONDS = 30;

/** How long one listing of an MCP server may take, every page, by default (`mcpListSeconds`, SPI-1363): today's 120 s. */
export const DEFAULT_MCP_LIST_SECONDS = 120;

/**
 * How many of a call's last server logs (warning and above) are kept (SPI-1363, SPI-1387): each is held, up to 128 KiB,
 * in the MCP Worker's memory until the call ends. A value only t3flare's machinery uses.
 */
export const MCP_LOG_ENTRIES = 50;

/**
 * How many progress notices an MCP call passes on to the thread a second (SPI-1368, SPI-1387): each is a request to the
 * thread's Session, and a flood would slow its other requests, a Stop among them. A value only t3flare's machinery uses.
 */
export const MCP_PROGRESS_PER_SECOND = 10;

/**
 * How long a server found to speak Legacy MCP is taken as Legacy before it is probed again, in hours (SPI-1368,
 * SPI-1387). A value only t3flare's machinery uses.
 */
export const MCP_LEGACY_RECHECK_HOURS = 24;

/**
 * How long an MCP server's OAuth sign-in may take, from its start to the server's redirect back, in minutes; each started
 * sign-in is kept sealed this long (SPI-1366, SPI-1387). A value only t3flare's machinery uses.
 */
export const MCP_SIGN_IN_MINUTES = 10;

/**
 * A Durable agent's retries of a failed model request (SPI-1367, SPI-1387): pi-durable's own 3, waiting 2, 4 and 8 s.
 * Each retry is a request the endpoint may bill. A value only t3flare's machinery uses.
 */
export const DURABLE_RETRIES = 3;

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

/**
 * Kills of a stopped command's surviving processes, `KILL_RETRY_MS` apart, so about a minute of tries (SPI-1367,
 * SPI-1387); each keeps the Workspace's Container awake. A value only t3flare's machinery uses.
 */
export const KILL_ATTEMPTS = 12;

/** How long the Session waits after a stopped command before it tries a failed kill again (its alarm). */
export const KILL_RETRY_MS = 5_000;

/**
 * t3's trace file's size before it rotates, in KiB (SPI-1367, SPI-1387). A memory-safety bound for the Environment DO's
 * 128 MB isolate, which also runs t3's server: the State directory appends by reading the whole file and writing it back
 * joined (`writeFile`), and t3 flushes the trace about five times a second, so each flush holds about three times the
 * file at once.
 */
export const TRACE_KIB = 1024;

/** t3's older trace files kept after a rotation (SPI-1367, SPI-1387): diagnostics only. A value only t3flare's machinery uses. */
export const TRACE_FILES = 1;

/**
 * How far a Workspace reads its Repo skills (SPI-1365), in a Skills row of their own: discovery runs in the Workspace DO
 * with no Container, at each request, with the settings the Workspace's last Container start kept.
 */
export const SKILLS_SETTING_KEYS = ["repoSkillsListed"] as const;

/** The most Repo skills listed may be set to: a sanity bound (ADR-0048 §1); the model's context bounds it in fact. */
export const MAX_REPO_SKILLS_LISTED = 10_000;

/**
 * How long a Workspace's Container commands and starts may take and wait (SPI-1364). The Settings page shows them in a
 * Commands row of their own, in this order.
 */
export const COMMAND_SETTING_KEYS = ["commandMinutes", "containerConnectSeconds"] as const;

/** The Container previews (SPI-1364): their ports. The Settings page shows them in the Previews row. */
export const CONTAINER_PREVIEW_SETTING_KEYS = ["previewPorts"] as const;

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

/**
 * The Container size's default (SPI-1386): standard-3, 2 vCPU, 8 GiB and 16 GB, closer to a laptop than cpu-1, so a big
 * build does not run out of memory; it costs more per Container hour. The custom size's fields default to its resources.
 */
export const DEFAULT_CONTAINER_SIZE = "standard-3" satisfies ContainerSize;

/**
 * What `ctx.container.start({ instance })` takes for `size`: a custom size's resources (`custom` for `CUSTOM_SIZE`), a
 * named type's name. Never undefined (an omitted `instance` starts `lite`); a stored name t3flare does not offer resolves
 * to the default first (`resolveEnvironment`).
 */
export const containerInstance = (
  size: ContainerSize,
  custom: ContainerResources = CONTAINER_SIZES[DEFAULT_CONTAINER_SIZE].resources,
): ContainerInstance => {
  if (size === CUSTOM_SIZE) return custom;
  const entry = CONTAINER_SIZES[size];
  return entry.custom ? entry.resources : (size as NamedContainerType);
};

/**
 * What the Builder's Container starts with (ADR-0047 §9): the Container size (SPI-1387 removed its own size), so every
 * Container size starts from the Base snapshot it makes.
 */
export const builderInstance = (
  settings: Pick<ResolvedEnvironment, "containerSize" | "customVcpu" | "customMemoryMib" | "customDiskMb">,
): ContainerInstance => containerInstance(settings.containerSize, customResources(settings));

/** The resources a Container of `size` has: a custom size's `custom`, a named one's own. */
export const containerResources = (
  size: ContainerSize,
  custom: ContainerResources = CONTAINER_SIZES[DEFAULT_CONTAINER_SIZE].resources,
): ContainerResources => (size === CUSTOM_SIZE ? custom : CONTAINER_SIZES[size].resources);

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
    disclosure: "visible",
  },
  customVcpu: {
    title: "Custom size: vCPU",
    description: `The custom size's vCPU, used when the Container size is custom: at least ${CUSTOM_SIZE_MINIMUMS.vcpu}, Cloudflare's least. Past your account's limits (${ACCOUNT_DEFAULT_LIMITS.vcpu} vCPU, ${ACCOUNT_DEFAULT_LIMITS.memoryMib / 1024} GiB and ${ACCOUNT_DEFAULT_LIMITS.diskMb / 1000} GB by default) Cloudflare refuses the start, and no Container starts until the size changes. Applies at each Workspace's next Container start.`,
    // At least Cloudflare's minimum (`CUSTOM_SIZE_MINIMUMS`); no maximum of t3flare's: the account's limit is Cloudflare's.
    schema: {
      type: "number",
      minimum: CUSTOM_SIZE_MINIMUMS.vcpu,
      default: CONTAINER_SIZES[DEFAULT_CONTAINER_SIZE].resources.vcpu,
    },
    disclosure: { contextual: { settings: ["containerSize"], equals: CUSTOM_SIZE } },
  },
  customMemoryMib: {
    title: "Custom size: memory (MiB)",
    description: `The custom size's memory, at least ${CUSTOM_SIZE_MINIMUMS.memoryMib} MiB.`,
    schema: {
      type: "number",
      minimum: CUSTOM_SIZE_MINIMUMS.memoryMib,
      whole: true,
      default: CONTAINER_SIZES[DEFAULT_CONTAINER_SIZE].resources.memoryMib,
    },
    disclosure: { contextual: { settings: ["containerSize"], equals: CUSTOM_SIZE } },
  },
  customDiskMb: {
    title: "Custom size: disk (MB)",
    description: `The custom size's disk, at least ${CUSTOM_SIZE_MINIMUMS.diskMb} MB.`,
    schema: {
      type: "number",
      minimum: CUSTOM_SIZE_MINIMUMS.diskMb,
      whole: true,
      default: CONTAINER_SIZES[DEFAULT_CONTAINER_SIZE].resources.diskMb,
    },
    disclosure: { contextual: { settings: ["containerSize"], equals: CUSTOM_SIZE } },
  },
  containerIdleMinutes: {
    title: "Idle time (minutes)",
    description:
      "A Container stops after this long without a command; its memory and disk are billed while it waits idle. Applies at each Workspace's next Container start.",
    // t3flare's own alarm stops an idle Container (WorkspaceDO `#scheduleAlarm`); the platform's `setInactivityTimeout`
    // (at most 6 hours) is never set, so the shared sanity maximum applies.
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 2 },
    tier: "down-free",
    disclosure: "visible",
  },
  terminalBusyHoldMinutes: {
    title: "Terminal hold while a command runs (minutes)",
    description:
      "While a Terminal runs a command, open Terminals keep the Container running, and billed, for this long after their last input, even past the Idle time; output does not count. A Container preview keeps it running as long after the last command, CLI agent's turn, or input to a Terminal or CLI agent. Applies at each Workspace's next Container start.",
    // t3flare's own alarm releases the Container (WorkspaceDO `#scheduleAlarm`), so the shared sanity maximum applies
    // (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_TERMINAL_BUSY_HOLD_MINUTES },
    tier: "down-free",
    disclosure: "advanced",
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
    disclosure: "advanced",
  },
  containerBudget: {
    title: "Container budget",
    description:
      "How many Containers may run at once across the Environment. Empty or 0 is off: no budget. Applies at the next start; lowering it stops no running Container, and new starts wait until fewer run.",
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_CONTAINER_BUDGET,
      default: DEFAULT_CONTAINER_BUDGET,
      off: true,
      offLabel: "no budget",
    },
    tier: "down-free",
    disclosure: "visible",
  },
  turnLimitMinutes: {
    title: "Turn limit (minutes)",
    description:
      "How long one agent turn may run, for Pi Durable and CLI agents alike. Empty or 0 is off: a turn runs until it ends, as in stock t3. A turn longer than this is ended (a CLI agent's process with it), and the thread shows it failed. Each minute of a turn can spend model tokens and hold a Container. Applies at each thread's next turn; a running turn keeps the limit it started with.",
    // t3flare times it itself (the Session's alarm, the CLI wrapper's timer), so the shared sanity maximum applies: a
    // week is under the 24.8 days past which a JS timer overflows. Off arms neither.
    schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_MINUTES, default: DEFAULT_TURN_LIMIT_MINUTES, off: true },
    tier: "down-free",
    disclosure: "visible",
  },
  parkAfterMinutes: {
    title: "Park after (minutes)",
    description:
      "How long a CLI agent's card waits on its turn before the turn parks: the card stays up as a question, the agent's process ends, and its Container can stop. Your answer starts a new turn, which repeats the call you allowed, once. Empty or 0 is off: the agent is never parked, and holds its Container until you answer. Applies at each CLI agent's next start.",
    // t3flare times it itself (the CLI wrapper's timer), so the shared sanity maximum applies (ADR-0048 §2). Off arms
    // nothing.
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_TIMED_MINUTES,
      default: DEFAULT_PARK_AFTER_MINUTES,
      off: true,
      offLabel: "never",
    },
    tier: "down-free",
    disclosure: "advanced",
  },
  variables: {
    title: "Variables",
    description: `NAME=value pairs every command in a Workspace starts with: agents' commands, Terminals and CLI agents. A Secret one's value is stored sealed and never shown again, but every agent and command in a Workspace can read it, as on stock t3. Anything t3flare, t3, mise's [env] or the command itself sets wins over them. Each NAME=value is at most ${MAX_ENV_STRING_BYTES / 1024} KiB and all of them together at most ${MAX_VARIABLES_BYTES / 1024 / 1024} MiB, Linux's limits on a command's environment with room left for the command itself. Applies at each Workspace's next Container start.`,
    schema: { type: "variables", default: [] },
    disclosure: "visible",
  },
  globalMiseConfig: {
    title: "Global mise config",
    description:
      "A mise.toml every Container's commands get, under a repository's own and over the image's base tools. Laid down and installed at each Workspace's next Container start; a running Container keeps what it started with. Kept only if git and gh still run under it. Left empty, mise uses your dotfiles' ~/.config/mise/config.toml instead, if git and gh still run under that; the Dotfiles toggles don't change this. disable_tools and disable_backends are ignored. Agents can read this file: put no secret in it, [env] included.",
    schema: { type: "file", maxBytes: MAX_GLOBAL_MISE_BYTES, default: "" },
    disclosure: "visible",
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
    disclosure: { contextual: { filled: "globalMiseConfig" } },
  },
  containerSetup: {
    title: "Container setup",
    description:
      "A bash script run once in every new Container before its first command, after the Global mise config: as root in / with HOME=/root and the Variables. Commands, Terminals and CLI agents wait for it. Status shows its exit and the end of its output, secret Variables blanked. Applies at each Workspace's next Container start.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
    disclosure: "visible",
  },
  containerSetupMinutes: {
    title: "Container setup time limit (minutes)",
    description: "How long it may run before it is stopped and counts as failed.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 5 },
    tier: "down-free",
    row: "containerSetup",
    disclosure: { contextual: { filled: "containerSetup" } },
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
    disclosure: { contextual: { filled: "containerSetup" } },
  },
  cloneMinutes: {
    title: "Clone time limit (minutes)",
    description:
      "How long each clone may run in the Workspace's Container: a project's clone, and a new worktree's clone and its checkout. Empty or 0 is off: it runs as long as it takes, up to a week. A clone or checkout that runs longer than this fails; while it runs it holds the Container. A new worktree's bundle counts against the Checkpoint time limit instead. Applies at the next clone or checkout; one already running keeps its limit.",
    // computerd times each exec with its own timer and no maximum (computer 0.11.2), so the shared sanity maximum
    // applies (ADR-0048 §2); off gives it `OFF_DEADLINE_MS`.
    schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_MINUTES, default: DEFAULT_CLONE_MINUTES, off: true },
    tier: "down-free",
    disclosure: "advanced",
  },
  checkpointMinutes: {
    title: "Checkpoint time limit (minutes)",
    description:
      "How long each checkpoint may run in the Workspace's Container: a turn's checkpoint and its restore, bundling a project's commits into a new worktree, and carrying a removed worktree's commits home. Empty or 0 is off: each runs as long as it takes, up to a week. A checkpoint, bundle or carry that runs longer than this fails; while it runs it holds the Container. A removed worktree whose commits could not be carried home is kept, not purged. Applies at the next checkpoint, bundle or carry; one already running keeps its limit.",
    // As the clone time limit: computerd's own timer, no maximum, the shared sanity maximum (ADR-0048 §2), off a week.
    schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_MINUTES, default: DEFAULT_CHECKPOINT_MINUTES, off: true },
    tier: "down-free",
    disclosure: "advanced",
  },
  imageSetup: {
    title: "Image setup",
    description:
      "A bash script run once, as root with HOME=/root and every Variable (secret ones included), on the Workspace image after the Global mise config is laid down; its result is the Base snapshot. Once saved, a change builds a new one in the Builder, as a deploy and Rebuild do. Whatever it writes, a secret included, is in every Workspace's Container until the next Base build. Empty with no Global mise config, there is nothing to build.",
    schema: { type: "file", maxBytes: MAX_SETUP_BYTES, default: "" },
    disclosure: "visible",
  },
  imageSetupMinutes: {
    title: "Image setup time limit (minutes)",
    description:
      "How long the Builder's Container may take to start and run the Image setup before the Base build fails.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 30 },
    tier: "down-free",
    row: "imageSetup",
    disclosure: { contextual: { filled: "imageSetup" } },
  },
  snapshotMinutes: {
    title: "Snapshot time limit (minutes)",
    description:
      "How long the snapshot and the start from it that proves it may take before the Base build is reported failed. A snapshot that finishes later is still kept if nothing changed meanwhile.",
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: 5 },
    tier: "down-free",
    row: "imageSetup",
    disclosure: "advanced",
  },
  builderInBudget: {
    title: "Builder counts against the Container budget",
    description:
      "The Builder's Container starts at the Container size. On, it waits for room under the Container budget before it starts, and holds one place while it runs. Off, it runs beside the budget's Containers.",
    schema: { type: "boolean", default: false },
    row: "imageSetup",
    disclosure: "advanced",
  },
  rebuildEveryDays: {
    title: "Rebuild every (days)",
    description: `Builds the Base snapshot again this many days after the last good one, so the Image setup's downloads stay current. 0 is off. At most ${MAX_REBUILD_DAYS}: a Base snapshot expires 30 days after it was made or a Container last started from it, and this schedule counts from when it was made. It also comes early enough for a failed rebuild and its retry to finish before the snapshot expires, though, for that reason, never sooner than one build after the last: with very long time limits, rebuilds then follow one another, and a failed one can outlast the snapshot.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REBUILD_DAYS, default: 0 },
    row: "imageSetup",
    disclosure: "advanced",
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
    disclosure: { contextual: { filled: "imageSetup" } },
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
    disclosure: "advanced",
  },
  terminalsReadBashrc: {
    title: "Terminals read ~/.bashrc",
    description:
      "A Terminal's shell runs your ~/.bashrc, so your aliases, functions and prompt are there. Off, it starts with t3flare's shell setup alone. Applies at each Workspace's next Container start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
    disclosure: "advanced",
  },
  agentsReadDotfiles: {
    title: "CLI agents read your dotfiles",
    description:
      "Each CLI agent starts with a copy of your config for it (~/.claude and ~/.claude.json, ~/.codex, ~/.config/opencode, ~/.pi/agent, except its auth.json): your instructions, settings, hooks, skills and plugins. t3flare's model routing and managed settings still win, and Codex's shells get t3flare's environment (its inherit, exclude and include_only). An Environment skill wins over one of yours of the same name in Claude Code, OpenCode and pi; Codex shows both skills. Off, an agent starts with t3flare's config alone. Applies at each CLI agent's next start.",
    schema: { type: "boolean", default: true },
    tier: "down-free",
    disclosure: "visible",
  },
  graceDays: {
    title: "Purge after (days)",
    description:
      "How many days the Sweep keeps a Workspace nothing references, a Tombstone with a date, and a deleted thread's Session before it purges them. 0 is never: the Sweep still marks what is unreferenced and purges nothing. A change moves the date of everything already waiting; from 0, nothing is purged until the new number of days after. Applies at the next Sweep.",
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_GRACE_DAYS,
      default: DEFAULT_GRACE_DAYS,
      off: true,
      offLabel: "never",
    },
    tier: "up-free",
    disclosure: "visible",
  },
  usageRetentionDays: {
    title: "Usage records kept (days)",
    description:
      "How many days t3flare keeps its usage records: each model answer's tokens and cost, which t3's Usage page shows. Empty or 0 is off: they are kept for good, as local t3 keeps them. Shortening this deletes the older records at the next prune; they cannot be restored. t3's Usage page shows at most 90 days, so records older than that are kept but shown nowhere until t3 widens its window. At most 3650 (ten years). Applies at the next prune (at most once an hour, as usage is recorded) and to usage recorded from then on.",
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_RETENTION_DAYS,
      default: DEFAULT_USAGE_RETENTION_DAYS,
      off: true,
      offLabel: "for good",
    },
    tier: "up-free",
    disclosure: "advanced",
  },
  piSessionRetentionDays: {
    title: "Pi and Claude Code sessions kept (days)",
    description:
      "How many days a Pi or Claude Code session no one has written to is kept. Empty or 0 is off: each agent keeps its own way, Pi for good and Claude Code for its own 30 days. An older one is deleted at the next Pi start, or by Claude Code at its next start; t3 can no longer resume that thread's conversation. At most 3650 (ten years). Applies at each Pi or Claude Code start.",
    schema: {
      type: "integer",
      minimum: 0,
      maximum: MAX_RETENTION_DAYS,
      default: DEFAULT_PI_SESSION_RETENTION_DAYS,
      off: true,
      offLabel: "each agent's own",
    },
    tier: "up-free",
    disclosure: "advanced",
  },
  mcpCallSeconds: {
    title: "MCP call time limit (seconds)",
    description: `How long one MCP tool call may run before t3flare ends it and the agent is told it failed; it may have run on the server. Empty or 0 is off: t3flare ends a call only after a week, and the server's own timeout still applies. Time spent waiting for your answer to the server's question does not count. A CLI agent's own tool timeout grows with it. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next call; a CLI agent's timeout at its next start.`,
    // The MCP engine times the call with its own timer (packages/mcp/src/connection.ts), no platform limit: the shared
    // sanity maximum applies (ADR-0048 §2); off gives it `OFF_DEADLINE_MS`.
    schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_CALL_SECONDS, off: true },
    tier: "down-free",
    disclosure: "advanced",
  },
  repoSkillsListed: {
    title: "Repo skills listed",
    description: `How many of a repository's skills (.pi/skills, .agents/skills, .claude/skills) are listed in a Pi Durable agent's prompt and offered in t3's composer, nearest first; the rest are counted as not listed. Each listed skill's name and description is in front of the model on every turn. At most ${MAX_REPO_SKILLS_LISTED}. Applies at each Workspace's next Container start.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REPO_SKILLS_LISTED, default: 100 },
    tier: "down-free",
    disclosure: "advanced",
  },
  mcpConnectSeconds: {
    title: "MCP server connect time limit (seconds)",
    description: `How long t3flare waits for an MCP server to answer the first requests of each connection (its probe and its initialize), for a call, a discovery or a test. Past it the server is reported unreachable; a longer limit holds a dead server's calls and discovery that long. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next connection to an MCP server.`,
    // The MCP engine times it with the SDK's own timer, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_CONNECT_SECONDS },
    tier: "down-free",
    disclosure: "advanced",
  },
  mcpListSeconds: {
    title: "MCP server listing time limit (seconds)",
    description: `How long t3flare lets one listing of an MCP server's tools, prompts or resources take, all its pages together. Past it that discovery fails and the server's agents get none of what it lists; a longer limit holds a slow or endless listing that long, its pages in memory. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next discovery of an MCP server.`,
    // The MCP engine times it with its own timer, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_MCP_LIST_SECONDS },
    tier: "down-free",
    disclosure: "advanced",
  },
  textGenerationSeconds: {
    title: "Text generation time limit (seconds)",
    description: `How long a Model endpoint's model may take to write a thread's title, a commit message, a pull request's text or a branch name. Past it, that action fails and says the endpoint did not answer in time; a slow or reasoning model may need longer. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next text generation.`,
    // The agents Worker's AbortSignal.timeout and the Environment's own wait (this plus `TEXT_GENERATION_MARGIN_MS`) time
    // it, no platform limit on a service binding's call: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_TEXT_GENERATION_SECONDS },
    tier: "down-free",
    disclosure: "advanced",
  },
  idleAfterSeconds: {
    title: "Environment sleeps after (seconds)",
    description: `How long the Environment waits with no open page, request or work before it sleeps; t3 starts again at the next request or wake, which takes a few seconds. While it waits it stays up, and Cloudflare bills its time. At most ${MAX_TIMED_SECONDS} (a week). Applies at the next idle check.`,
    // t3flare's own check (an interval in the Environment DO), no platform limit: the shared sanity maximum applies
    // (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_SECONDS, default: DEFAULT_IDLE_AFTER_SECONDS },
    tier: "down-free",
    disclosure: "visible",
  },
  prWatchWakeMinutes: {
    title: "Pull request check while asleep (minutes)",
    description: `While a pull request is watched and the Environment sleeps, how often it wakes to check it: a merge or close is noticed up to this late. Each wake starts t3 for about a minute. At most ${MAX_TIMED_MINUTES} (a week). Applies at the next sleep.`,
    // t3flare's own alarm, no platform limit: the shared sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES, default: DEFAULT_PR_WATCH_WAKE_MINUTES },
    tier: "up-free",
    disclosure: "advanced",
  },
  commandMinutes: {
    title: "Command time limit (minutes)",
    description: `How long a command in the Workspace's Container may run when nothing else sets its limit: an agent's search or read of a path only the Container has, and the credential helper's install. Empty or 0 is off: it runs as long as it takes, up to a week. A command that runs longer than this is ended and fails; while it runs it holds the Container. t3's own git commands are not cut by it: each ends when t3 gives up on it. At most ${MAX_TIMED_MINUTES} (a week). Applies at each Workspace's next Container start.`,
    // computerd times each exec with its own timer and no maximum (computer 0.11.2), so the shared sanity maximum applies
    // (ADR-0048 §2); off gives it `OFF_DEADLINE_MS`.
    schema: { type: "integer", minimum: 0, maximum: MAX_TIMED_MINUTES, default: DEFAULT_COMMAND_MINUTES, off: true },
    tier: "down-free",
    disclosure: "advanced",
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
    disclosure: "advanced",
  },
  previewPorts: {
    title: "Container preview ports",
    description: `Empty: a preview browser can open a dev server on any Container port except ${RESERVED_CONTAINER_PORTS.join(" and ")}, which t3flare uses itself, as a browser on your own machine opens any localhost port. A page open in that browser can then also reach every other server listening on 0.0.0.0 in the Workspace's Container. To allow only some ports, list them, separated by commas or spaces: at most ${MAX_PREVIEW_PORTS}, the most one preview browser can route on Cloudflare. Applies to preview browsers opened after the change.`,
    // Named constraints: Browser Run's eight hosts (`MAX_PREVIEW_PORTS`), t3flare's own ports (`RESERVED_CONTAINER_PORTS`).
    // No tier, deliberately: which Container ports a browser may reach is asked either way (ADR-0035 §3).
    schema: {
      type: "ports",
      maxCount: MAX_PREVIEW_PORTS,
      reserved: RESERVED_CONTAINER_PORT_USES,
      off: true,
      offLabel: "any port",
      default: [],
    },
    disclosure: "advanced",
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
 * The Sweep's switch before SPI-1387 folded it into the Grace: a stored `false` reads as a Grace of 0 (never), and a
 * change of the Grace drops it. Every other removed setting's stored value is ignored (ADR-0049).
 */
const LEGACY_SWEEP_PURGES = "sweepPurges";

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
    // An opt-in port list that no longer fits keeps what still does (SPI-1390); one with nothing left
    // reads as none, which is any port, and the Environment logs what it dropped.
    else if (schema.type === "ports" && value !== undefined && !fitsEnvironmentSetting(key, value))
      resolved[key] = fitPorts(value, schema.maxCount, schema.reserved).ports;
    else resolved[key] = value !== undefined && fitsEnvironmentSetting(key, value) ? value : schema.default;
  }
  // The Sweep's switch, folded into the Grace (SPI-1387): purging turned off reads as a Grace of 0, never, until the
  // Grace is next set, so the fold purges nothing the Owner had kept.
  if (stored.settings[LEGACY_SWEEP_PURGES] === false) resolved.graceDays = 0;
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
  const { [LEGACY_SWEEP_PURGES]: sweepPurges, ...kept } = stored.settings;
  const environment: StoredEnvironment = {
    revision: stored.revision + 1,
    settings: {
      // A change of the Grace replaces the Sweep's old switch it was folded with (SPI-1387).
      ...(moved.some(([key]) => key === "graceDays") || sweepPurges === undefined
        ? kept
        : { ...kept, [LEGACY_SWEEP_PURGES]: sweepPurges }),
      ...(Object.fromEntries(moved) as Record<string, EnvironmentValue>),
    },
  };
  // The one bound on their sizes together: the settings are one Durable Object value.
  const tooLarge = storedValueProblem("the Environment settings", environment);
  if (tooLarge !== undefined) return { ok: false, error: tooLarge };
  return { ok: true, environment, changed: moved.map(([key]) => key as EnvironmentKey) };
};
