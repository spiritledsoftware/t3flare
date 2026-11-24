// What the Environment DO hands t3's code that is not a t3 service (step 1's note: expose what 2a needs deliberately):
// the agents Worker's Durable Object bindings, the Model endpoints, and the GitHub minter. Set by the DO's constructor, before
// t3 boots; module state, as the DO is the only one in its isolate.
import {
  DEFAULT_CHECKPOINT_MS,
  DEFAULT_CLONE_MS,
  DEFAULT_MCP_CALL_MS,
  DEFAULT_PREVIEW_PORTS,
  DEFAULT_PARK_AFTER_MS,
  DEFAULT_TURN_LIMIT_MS,
  EMPTY_ENVIRONMENT,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "@t3flare/harness-registry";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import type { GitHubTokens } from "./github.ts";
import type { AgentsBindings } from "./rpc.ts";
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

import type { SweepSettings } from "./deletionSettings.ts";
import type { SkillStore } from "../skills/store.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";
import type { ProcessChannel } from "./processChannel.ts";
import type { LimitStore } from "../usage/limits.ts";
import type { UsageStore } from "../usage/records.ts";
import type { BrowserRunBinding, BrowserRunFetcher } from "../preview/browserRun.ts";
import type { PreviewStore } from "../preview/store.ts";
import type { Updates } from "../updates/records.ts";
import type { ParkedCards } from "../provider/cli/parked.ts";

export interface EnvironmentServices {
  readonly agents: AgentsBindings;
  /** The Model endpoints as stored now (SPI-1162), secret-free: every agent's models (ADR-0034). Absent: none. */
  readonly modelEndpoints?: () => ModelEndpoints;
  readonly github: () => GitHubTokens;
  readonly workspaces: WorkspaceRegistry;
  /** The Environment DO's SQLite (t3's projection, read by the deletion's reference check). */
  readonly sql: SqlStorage;
  /** The Sweep's settings as stored now (ADR-0043 §2–3): read at each use, so a change to the Grace needs no reset. */
  readonly sweep: () => SweepSettings;
  /**
   * Whether a CLI agent's home is first filled from the Owner's dotfiles (ADR-0047 §9, `agentsReadDotfiles`), as stored
   * now: read at each spawn, so a change applies at each CLI agent's next start. Absent (a test's services): on, the
   * setting's default.
   */
  readonly agentsReadDotfiles?: () => boolean;
  /**
   * How many days pi's and Claude Code's sessions are kept (SPI-1323, SPI-1367, `piSessionRetentionDays`), as stored now:
   * read at each spawn, so a change applies at each pi or Claude Code start. Absent (a test's services): the default.
   */
  readonly piSessionRetentionDays?: () => number;
  /**
   * The Turn limit (SPI-1315, `turnLimitMinutes`) in ms, as stored now: read at each turn's start, by the CLI wrapper and
   * the Durable agent's adapter, so a change applies at each thread's next turn. Absent (a test's services): the default.
   */
  readonly turnLimitMs?: () => number;
  /**
   * The clone time limit (SPI-1324, `cloneMinutes`) in ms, as stored now: read at each clone and at a worktree's clone
   * and checkout, and carried to the Workspace DO as `timeoutMs`, so a change applies at the next one. Absent (a test's
   * services): the default.
   */
  readonly cloneMs?: () => number;
  /**
   * The checkpoint time limit (SPI-1324, `checkpointMinutes`) in ms, as stored now: read at each checkpoint operation, a
   * worktree's seed bundle, and a removed worktree's carry, and carried to the Workspace DO as `timeoutMs`, so a change
   * applies at the next one. Absent (a test's services): the default.
   */
  readonly checkpointMs?: () => number;
  /** SPI-1364: the Container preview ports (`previewPorts`) now. Absent (tests): the default. */
  readonly previewPorts?: () => ReadonlyArray<number>;
  /**
   * Park after (SPI-1389, `parkAfterMinutes`) in ms, as stored now (0: never park): read at each CLI spawn, which keeps it
   * for the process's life. Absent (a test's services): the default.
   */
  readonly parkAfterMs?: () => number;
  /** A CLI agent's parked cards (SPI-1389), in the Environment DO's SQLite. Absent (a test's services): none are kept. */
  readonly parked?: ParkedCards;
  /**
   * Answers a parked Open change (SPI-1389) as the Owner did on its parked question: approve or decline. Resolves with
   * the change's outcome as the agent is told it. Absent (a test's services): the outcome is not known.
   */
  readonly answerParkedChange?: (changeId: string, approve: boolean) => Promise<string>;
  /**
   * The MCP call time limit (SPI-1359, `mcpCallSeconds`) in ms, as stored now: read at each CLI spawn for the CLI's own
   * tool timeout (`cliToolTimeoutSec`). Absent (a test's services): the default.
   */
  readonly mcpCallMs?: () => number;
  /**
   * The Environment settings as stored now (SPI-1366), resolved: for a setting read at its own next use (`environmentNow`).
   * Absent (a test's services): the defaults.
   */
  readonly environment?: () => ResolvedEnvironment;
  /** Asks for a Sweep after 5 s of quiet (ADR-0043 §5): the deletion wake's Layer calls it. */
  readonly wakeSweep: () => void;
  /** One-time marks in the Environment DO's storage (step 3: a setting seeded once, L1). */
  readonly marks: { has(key: string): boolean; set(key: string): void };
  /** SPI-1163: the model the text-generation setting was last pointed at as its default (`seedSettings.ts`). */
  readonly seededTextModel: { get(): string | undefined; set(slug: string): void };
  /** Step 4a: this instance's CLI processes (review F6: never module state). */
  readonly processes: ProcessChannel;
  /** Test stages: stage-only probes and faults answer. */
  readonly faults: boolean;
  /** The MCP servers a CLI process gets relay entries for (ADR-0028), at its spawn; a linked thread's are M13's. */
  readonly relayServers: () => ReadonlyArray<string>;
  /** SPI-1147: the Harness `skills` switch, as the stored settings resolve it now. */
  readonly skillsEnabled: () => boolean;
  /** SPI-1148: the Environment skills kept here (their rows, the enabled set's hash). */
  readonly environmentSkills: () => SkillStore;
  /** t3's `/mcp` at the public host, as a CLI in a Container reaches it with t3's per-thread bearer. */
  readonly t3McpUrl: () => string;
  /** t3's public origin (`https://<t3 host>`), or null where no host is configured (local workerd): task webhooks' base (parity G12). */
  readonly publicOrigin: () => string | null;
  /** t3flare's own usage records, for t3's Usage page (SPI-1173). */
  readonly usage: UsageStore;
  /** The subscription endpoints' limit windows, read from their answers' headers, for t3's limit meters (SPI-1174). */
  readonly limits: LimitStore;
  /** G11 (ADR-0031): the Browser Run binding, or undefined where none is bound (local workerd, tests). */
  readonly browserRun: BrowserRunBinding | undefined;
  /** G11: the `ContainerPreviews` entrypoint made for one Workspace, as a preview browser's `outboundByHost` target. */
  readonly containerPreviews: (workspace: string) => BrowserRunFetcher;
  /** G11: the Browser Run sessions this Environment holds, and the server browser's profiles (`preview/store.ts`). */
  readonly previewStore: PreviewStore;
  /** In-app Updates (ADR-0037): their records and dispatches. Absent (tests) or unconfigured (every stage but prod): none. */
  readonly updates?: Updates;
}

let current: EnvironmentServices | undefined;

export const bindEnvironmentServices = (services: EnvironmentServices): void => {
  current = services;
};

export const environmentServices = (): EnvironmentServices => {
  if (current === undefined) throw new Error("t3flare: the Environment DO has not bound its services");
  return current;
};

/**
 * The Turn limit now, in ms (SPI-1315): the stored setting, or its default when the services or the store cannot be read;
 * 0 when it is off (the default, SPI-1386), and the turn then arms no limit.
 */
export const turnLimitMsNow = (): number => {
  try {
    return current?.turnLimitMs?.() ?? DEFAULT_TURN_LIMIT_MS;
  } catch {
    return DEFAULT_TURN_LIMIT_MS;
  }
};

/**
 * The clone time limit now, in ms (SPI-1324): the stored setting, or its default when the services or the store cannot
 * be read, so a clone always carries one; 0 when it is off (the default, SPI-1386).
 */
export const cloneMsNow = (): number => {
  try {
    return current?.cloneMs?.() ?? DEFAULT_CLONE_MS;
  } catch {
    return DEFAULT_CLONE_MS;
  }
};

/**
 * The checkpoint time limit now, in ms (SPI-1324): the stored setting, or its default when the services or the store
 * cannot be read, so a checkpoint always carries one; 0 when it is off (the default, SPI-1386).
 */
export const checkpointMsNow = (): number => {
  try {
    return current?.checkpointMs?.() ?? DEFAULT_CHECKPOINT_MS;
  } catch {
    return DEFAULT_CHECKPOINT_MS;
  }
};

/**
 * The Container preview ports now (SPI-1364): the stored setting, or its default when the services or the store cannot be
 * read, so a preview browser always routes some.
 */
export const previewPortsNow = (): ReadonlyArray<number> => {
  try {
    return current?.previewPorts?.() ?? DEFAULT_PREVIEW_PORTS;
  } catch {
    return DEFAULT_PREVIEW_PORTS;
  }
};

/**
 * The MCP call time limit now, in ms (SPI-1359): the stored setting, or its default when the services or the store
 * cannot be read, so a CLI's tool timeout always covers a call; 0 when it is off (the default, SPI-1386), which
 * `cliToolTimeoutSec` counts as the off deadline.
 */
export const mcpCallMsNow = (): number => {
  try {
    return current?.mcpCallMs?.() ?? DEFAULT_MCP_CALL_MS;
  } catch {
    return DEFAULT_MCP_CALL_MS;
  }
};

/**
 * Park after now, in ms (SPI-1389): the stored setting, or its default when the services or the store cannot be read; 0
 * when it is off (never park).
 */
export const parkAfterMsNow = (): number => {
  try {
    return current?.parkAfterMs?.() ?? DEFAULT_PARK_AFTER_MS;
  } catch {
    return DEFAULT_PARK_AFTER_MS;
  }
};

/** The parked cards (SPI-1389), or undefined when the services hold none (a test's). */
export const parkedCardsNow = (): ParkedCards | undefined => current?.parked;

/**
 * The Environment settings now (SPI-1366): as stored, or their defaults when the services or the store cannot be read, so
 * whatever reads one always has a value.
 */
export const environmentNow = (): ResolvedEnvironment => {
  try {
    return current?.environment?.() ?? resolveEnvironment(EMPTY_ENVIRONMENT);
  } catch {
    return resolveEnvironment(EMPTY_ENVIRONMENT);
  }
};
