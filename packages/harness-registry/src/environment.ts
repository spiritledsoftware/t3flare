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
import { fitVariables, MAX_VARIABLES, type Variable } from "./variables.ts";

export * from "./variables.ts";

/**
 * The most minutes a limit t3flare times itself (its own alarm or timer) may be set to: a sanity bound, not a constraint
 * (ADR-0048). Why a week: the longest single wait t3flare times, a Workspace's wait for a Base build (`waitLimitMs` =
 * imageSetupMinutes + 2 × snapshotMinutes, apps/agents/src/workspace/baseStart.ts), stays under the 24.8 days past
 * which a JS timer overflows and fires at once. A value handed to a platform API takes that API's maximum instead,
 * named in a comment where it is set.
 */
export const MAX_TIMED_MINUTES = 10_080;

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
 * The CLI agents' processes per Workspace by default (`cliProcessesPerWorkspace`; plan §2.1, review F7), counted in
 * Codex processes (Claude Code and OpenCode count twice, `CLI_WEIGHT` in apps/agents/src/workspace/processHost.ts). An
 * idle Codex app-server measured 157–160 MB RSS on step4a (steps-evidence-1:docs/steps/step-4a/m3-memory.json), so four
 * take about 0.65 GB of `cpu-1`'s 3 GiB, beside computerd (~100 MB) and the agents' own commands (an `npm ci` and its
 * tests peak at 1–1.5 GB).
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
 * How long after its last turn a CLI agent's process holds the Container (review F7): t3's session release
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
 * A named constraint, provisional: the Workspace DO's memory. Each of an agent's Terminals keeps a headless xterm (1,000
 * lines of scrollback) in the Workspace DO's 128 MB isolate, which holds its files' sync too; 32 is a guess at what
 * fits, and SPI-978's measurement of the DO's memory sets the figure. An agent's exited Terminals keep their xterm
 * outside the live count: `MAX_KEPT` (apps/agents/src/workspace/agentTerminals.ts) bounds them per Session only, so their
 * Workspace-wide total grows with the Sessions the Workspace serves until the DO restarts.
 */
export const MAX_AGENT_TERMINALS_PER_WORKSPACE = 32;

/**
 * The most of the Owner's own Terminals per Workspace (`terminalsPerWorkspace`): a sanity bound, not a constraint
 * (ADR-0048 §1, SPI-1359). An Owner's Terminal keeps no xterm in the Workspace DO, only its exec handle, a carry string
 * and held input, and all of them share one pending-output buffer (`BACKPRESSURE_BYTES`,
 * apps/agents/src/workspace/terminalHost.ts); their output is pushed, not a returned stream, so the DO's outgoing
 * connections do not bound them (ADR-0021). Each shell's memory is the Container's, which bounds them in fact, and the
 * setting's description states that.
 */
export const MAX_TERMINALS_PER_WORKSPACE = 1000;

/** The largest Global mise config, in bytes of UTF-8. */
export const MAX_GLOBAL_MISE_BYTES = 16 * 1024;

/**
 * The largest Image setup and Container setup, each, in bytes of UTF-8 (ADR-0047 §9). Fixed by a constraint: every
 * Environment setting is one stored value of at most 2 MB, and the Environment settings are one value together.
 */
export const MAX_SETUP_BYTES = 256 * 1024;

/** Why `text` cannot be an Image setup (a Test base build's proposal included): past `MAX_SETUP_BYTES`; undefined when it fits. */
export const imageSetupTooLong = (text: string): string | undefined => {
  const bytes = new TextEncoder().encode(text).length;
  return bytes > MAX_SETUP_BYTES
    ? `the Image setup is at most ${MAX_SETUP_BYTES / 1024} KiB, not ${bytes} bytes`
    : undefined;
};

/**
 * The most of a setup's output a report may keep, in KiB (`setupOutputKiB`'s bound). Fixed by a constraint: the
 * Environment DO keeps the last report, output and all, as one Durable Object value, which holds at most 2 MB.
 */
export const MAX_SETUP_OUTPUT_KIB = 256;

/** What a Container whose setup failed does (ADR-0047 §7): carries on, or refuses every command but a passive read. */
export const CONTAINER_SETUP_FAILURES = ["carryOn", "refuse"] as const;
export type ContainerSetupFailure = (typeof CONTAINER_SETUP_FAILURES)[number];

/**
 * The most days a scheduled rebuild may wait (ADR-0047 §3): the platform expires a snapshot 30 days after its creation
 * or last restore, and t3flare counts one older than 29 days as gone.
 */
export const MAX_REBUILD_DAYS = 29;

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

/** The MCP result size's default, in KiB (`mcpResultKiB`, SPI-1359): today's 1 MiB. */
export const DEFAULT_MCP_RESULT_KIB = 1024;

/**
 * The most KiB of one MCP tool result (`mcpResultKiB`). A named constraint: the Environment DO's 128 MB isolate, which
 * also runs t3's server. The MCP host holds a result whole while it reads it, as bytes, as decoded text and as parsed
 * JSON at once (`readStream`, apps/environment/src/mcp/host.ts), so a result takes about three times its size; 16 MiB
 * of result is about 48 MB of it, leaving t3 the rest.
 */
export const MAX_MCP_RESULT_KIB = 16 * 1024;

/**
 * The MCP calls' settings (SPI-1359): how long one tool call may run and how large its result may be. They bound every
 * agent's MCP calls through the MCP host, Pi Durable's and the CLI relay's, at the next call, never a Container start, so
 * the Settings page shows them in an MCP calls row of their own, in this order.
 */
export const MCP_CALL_SETTING_KEYS = ["mcpCallSeconds", "mcpResultKiB"] as const;

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
 * (docs-archive-1:docs/steps/spi-1001-research-container-sizes.md §2). Not offered: `lite` and `basic` (the runtime refuses `basic`),
 * and other custom sizes. A stored name never changes meaning: adding a size is free, removing one needs a
 * rename map.
 */
export const CONTAINER_SIZES = {
  "cpu-1": { custom: true, resources: { vcpu: 1, memoryMib: 3072, diskMb: 12_000 } },
  "standard-1": { custom: false, resources: { vcpu: 0.5, memoryMib: 4096, diskMb: 8_000 } },
  "standard-2": { custom: false, resources: { vcpu: 1, memoryMib: 6144, diskMb: 12_000 } },
  "standard-3": { custom: false, resources: { vcpu: 2, memoryMib: 8192, diskMb: 16_000 } },
  "standard-4": { custom: false, resources: { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 } },
} as const satisfies Readonly<Record<string, { readonly custom: boolean; readonly resources: ContainerResources }>>;

export type ContainerSize = keyof typeof CONTAINER_SIZES;

export const CONTAINER_SIZE_NAMES = Object.keys(CONTAINER_SIZES) as ReadonlyArray<ContainerSize>;

export const DEFAULT_CONTAINER_SIZE: ContainerSize = "cpu-1";

/**
 * What `ctx.container.start({ instance })` takes for `size`: a custom size's resources, a named type's name. Never
 * undefined (an omitted `instance` starts `lite`); a stored name t3flare does not offer resolves to the default first
 * (`resolveEnvironment`).
 */
export const containerInstance = (size: ContainerSize): ContainerInstance => {
  const entry = CONTAINER_SIZES[size];
  return entry.custom ? entry.resources : (size as NamedContainerType);
};

/** What the Builder's Container starts with (ADR-0047 §9): its own size, or the Container size. */
export const builderInstance = (
  settings: Pick<ResolvedEnvironment, "containerSize" | "builderSize">,
): ContainerInstance =>
  containerInstance(
    settings.builderSize === BUILDER_SAME_SIZE ? settings.containerSize : (settings.builderSize as ContainerSize),
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
      "The vCPU, memory and disk a Workspace's Container starts with. Applies at each Workspace's next Container start; a running Container keeps its size.",
    schema: { type: "enum", values: CONTAINER_SIZE_NAMES, default: DEFAULT_CONTAINER_SIZE },
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
    description:
      "How many of your Terminals one Workspace may have open at once; one more is refused. Each Terminal uses memory in the Container. Applies at each Workspace's next Container start; lowering it closes no open Terminal.",
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
    description:
      "How many Terminals and Background jobs Pi Durable agents may run at once in one Workspace, across its threads; one more is refused. Each Terminal and Background job uses memory in the Container. Applies at each Workspace's next Container start; lowering it stops none that run.",
    // A named constraint, provisional (`MAX_AGENT_TERMINALS_PER_WORKSPACE`): their xterms in the Workspace DO's memory.
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MAX_AGENT_TERMINALS_PER_WORKSPACE,
      default: DEFAULT_TERMINALS_PER_WORKSPACE,
    },
    tier: "down-free",
  },
  cliProcessesPerWorkspace: {
    title: "CLI agents' processes per Workspace",
    description:
      "How many CLI agents' processes one Workspace's Container may run at once; Claude Code's and OpenCode's each count as two. Each CLI agent's process takes about 150 to 200 MB of the Container's memory; past what the Container size has, commands fail for memory. Applies at each CLI agent's next start; lowering it ends no running process, and new starts are refused until fewer run.",
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
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES * 60, default: DEFAULT_SETTINGS_READ_SECONDS },
    tier: "free",
  },
  variables: {
    title: "Variables",
    description: `NAME=value pairs every command in a Workspace starts with: agents' commands, Terminals and CLI agents. A Secret one's value is stored sealed and never shown again, but every agent and command in a Workspace can read it, as on stock t3. Anything t3flare, t3, mise's [env] or the command itself sets wins over them. At most ${MAX_VARIABLES}. Applies at each Workspace's next Container start.`,
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
    description: `Builds the Base snapshot again this many days after the last good one, so the Image setup's downloads stay current. 0 is off. At most ${MAX_REBUILD_DAYS}: a Base snapshot expires 30 days after it was made.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_REBUILD_DAYS, default: 0 },
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
    title: "Pi sessions kept (days)",
    description:
      "How many days t3flare keeps a Pi session no one has written to. An older one is deleted at the next Pi start; t3 can no longer resume that thread's Pi conversation. At most 3650 (ten years), which keeps them for good. Applies at each Pi start.",
    schema: { type: "integer", minimum: 1, maximum: MAX_RETENTION_DAYS, default: DEFAULT_PI_SESSION_RETENTION_DAYS },
    tier: "up-free",
  },
  mcpCallSeconds: {
    title: "MCP call time limit (seconds)",
    description:
      "How long one MCP tool call may run before t3flare ends it and the agent is told it failed; it may have run on the server. Time spent waiting for your answer to the server's question does not count. A CLI agent's own tool timeout grows with it. Applies at the next call; a CLI agent's timeout at its next start.",
    // The MCP engine times the call with its own timer (packages/mcp/src/connection.ts), no platform limit: the shared
    // sanity maximum applies (ADR-0048 §2).
    schema: { type: "integer", minimum: 1, maximum: MAX_TIMED_MINUTES * 60, default: DEFAULT_MCP_CALL_SECONDS },
    tier: "down-free",
  },
  mcpResultKiB: {
    title: "MCP result size (KiB)",
    description:
      "The most of one MCP tool result t3flare takes, in KiB of UTF-8. A larger streamed result is refused whole, since it cannot be read in part; a larger inline one has its text cut to this, and its structured content dropped. The Environment holds a result whole while it reads it, beside t3, so a larger size uses more of its memory. At most 16384 (16 MiB). Applies at the next call.",
    // A named constraint (`MAX_MCP_RESULT_KIB`): the Environment DO's isolate memory.
    schema: { type: "integer", minimum: 1, maximum: MAX_MCP_RESULT_KIB, default: DEFAULT_MCP_RESULT_KIB },
    tier: "down-free",
  },
} as const satisfies Readonly<Record<string, EnvironmentSettingEntry>>;

export type EnvironmentKey = keyof typeof ENVIRONMENT_SETTINGS;

const ENVIRONMENT_KEYS = Object.keys(ENVIRONMENT_SETTINGS) as ReadonlyArray<EnvironmentKey>;

/** The value a field of `schema` holds: an enum's own names, a number, a boolean or text (a `file` field's too). */
type ValueOf<Schema> = Schema extends { readonly type: "enum"; readonly values: ReadonlyArray<infer Name> }
  ? Name
  : Schema extends { readonly type: "integer" }
    ? number
    : Schema extends { readonly type: "boolean" }
      ? boolean
      : Schema extends { readonly type: "variables" }
        ? ReadonlyArray<Variable>
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
  return {
    ok: true,
    environment: {
      revision: stored.revision + 1,
      settings: { ...stored.settings, ...(Object.fromEntries(moved) as Record<string, EnvironmentValue>) },
    },
    changed: moved.map(([key]) => key as EnvironmentKey),
  };
};
