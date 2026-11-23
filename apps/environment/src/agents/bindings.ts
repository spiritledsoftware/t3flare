// What the Environment DO hands t3's code that is not a t3 service (step 1's note: expose what 2a needs deliberately):
// the agents Worker's Durable Object bindings, the Model endpoints, and the GitHub minter. Set by the DO's constructor, before
// t3 boots; module state, as the DO is the only one in its isolate.
import { DEFAULT_OWNER_ANSWER_MS, DEFAULT_SETTINGS_READ_MS, DEFAULT_TURN_LIMIT_MS } from "@t3flare/harness-registry";
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
   * The Turn limit (SPI-1315, `turnLimitMinutes`) in ms, as stored now: read at each turn's start, by the CLI wrapper and
   * the Durable agent's adapter, so a change applies at each thread's next turn. Absent (a test's services): the default.
   */
  readonly turnLimitMs?: () => number;
  /**
   * The settings read wait (SPI-1314, `settingsReadSeconds`) in ms, as stored now: read at each turn's start by the
   * Durable agent's adapter, so a change applies at each thread's next turn. Absent (a test's services): the default.
   */
  readonly settingsReadMs?: () => number;
  /**
   * The Answer wait (SPI-1316, `ownerAnswerMinutes`) in ms, as stored now: read when a card is raised (an MCP server's
   * question, a CLI agent's tool approval, an Open change) and at each CLI spawn, so a change applies to the cards raised
   * after it. Absent (a test's services): the default.
   */
  readonly ownerAnswerMs?: () => number;
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
 * The Turn limit now, in ms (SPI-1315): the stored setting, or its default when the services or the store cannot be read,
 * so a turn always starts with a limit.
 */
export const turnLimitMsNow = (): number => {
  try {
    return current?.turnLimitMs?.() ?? DEFAULT_TURN_LIMIT_MS;
  } catch {
    return DEFAULT_TURN_LIMIT_MS;
  }
};

/**
 * The settings read wait now, in ms (SPI-1314): the stored setting, or its default when the services or the store cannot
 * be read, so a turn's reads are always bounded.
 */
export const settingsReadMsNow = (): number => {
  try {
    return current?.settingsReadMs?.() ?? DEFAULT_SETTINGS_READ_MS;
  } catch {
    return DEFAULT_SETTINGS_READ_MS;
  }
};

/**
 * The Answer wait now, in ms (SPI-1316): the stored setting, or its default when the services or the store cannot be
 * read, so a card always closes.
 */
export const ownerAnswerMsNow = (): number => {
  try {
    return current?.ownerAnswerMs?.() ?? DEFAULT_OWNER_ANSWER_MS;
  } catch {
    return DEFAULT_OWNER_ANSWER_MS;
  }
};
