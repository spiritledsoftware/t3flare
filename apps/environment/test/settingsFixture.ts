// @effect-diagnostics globalTimers:off
// One Environment's Settings server for M4's tests (SPI-1199): the stores in memory and Node's SQLite, the MCP host with
// its settings branch, a fake GitHub for skills, a fake OAuth, an asker that records cards, and the Settings page's deps
// with the Change page's API, all over the same storage as the Environment DO wires them.
import { DEFAULT_OWNER_ANSWER_MS, settingsServerLimitsOf, type StoredHarness } from "@t3flare/harness-registry";
import type { McpAsker, McpQuestionAnswer, McpQuestionCard } from "@t3flare/session-protocol";

import type { AccessCaller } from "../src/access.ts";
import { valueSealer } from "../src/credentials/sealed.ts";
import type { HarnessDeps } from "../src/harness/panel.ts";
import { harnessSecrets } from "../src/harness/secrets.ts";
import { harnessStatus } from "../src/harness/panel.ts";
import { harnessStore } from "../src/harness/store.ts";
import { type McpCallAnswer, type McpEngineBinding, McpHost } from "../src/mcp/host.ts";
import { cliThreadState } from "../src/provider/cli/cliAsk.ts";
import { DURABLE_AGENT, durableModes, forgetDurableModes, noteDurableModes } from "../src/provider/threadCaller.ts";
import { settingsChanges } from "../src/settings/changes.ts";
import { ownerClients } from "../src/settings/clients.ts";
import type { OwnCaller } from "../src/settings/caller.ts";
import { changesApiOf, settingsCall, type SettingsServerDeps } from "../src/settings/server.ts";
import { skillStore } from "../src/skills/store.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";
import { fakeGithub } from "./skillRepo.fixture.ts";

export const NOW = Date.UTC(2026, 10, 14, 12, 0);
export const HOST = "t3.example.dev";
export const PANEL = `https://${HOST}/_t3flare/settings`;
export const AUTHORIZATION_URL = "https://auth.example/authorize?state=s3cr3t-state";
/** The Stage's credentials key a secret Variable is sealed with (ADR-0046). */
export const CREDENTIALS_KEY = "c".repeat(64);

export const memory = () => {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    /** Every key and value kept (the leak scan, settingsHostile.test.ts). */
    entries: () => [...map.entries()],
  };
};

/**
 * A Settings call's structured result, or `{ unavailable }` with the host's message when the call reached no tool (the
 * server off, a hidden tool, no caller).
 */
export const structured = (answer: McpCallAnswer): Record<string, any> =>
  answer.kind === "result" ? (answer.structured as Record<string, any>) : { unavailable: answer.message };

/** A Settings call's text: its result's, or the host's message. */
export const textOf = (answer: McpCallAnswer): string => (answer.kind === "result" ? answer.text : answer.message);

export interface FixtureOptions {
  /** The owner's answer on each card: a value, or a function of the card (a never-settling promise leaves it open). */
  readonly answer?: McpQuestionAnswer | ((card: McpQuestionCard) => Promise<McpQuestionAnswer>);
  readonly harness?: StoredHarness;
  readonly cardWaitMs?: number;
  /** The Answer wait the changes table reads (SPI-1316); its default without it. */
  readonly answerMs?: () => number;
  /** The wait the asker names, as a CLI process's relay asker does (its spawn-time Answer wait, SPI-1316). */
  readonly askerWaitMs?: number;
  /** The Workspaces `list_workspaces` and `purge_workspace` act on (ADR-0044 §5). */
  readonly workspaces?: SettingsServerDeps["workspaces"];
  /** `get_status` reads the panel's Status, as the Environment DO wires it, rather than the revision alone. */
  readonly panelStatus?: boolean;
  /** The MCP engine the host lists and calls through (none by default: a list or call answers that it is not bound). */
  readonly engine?: McpEngineBinding;
}

export const settingsFixture = (options: FixtureOptions = {}) => {
  let now = NOW;
  const kv = memory();
  const sql = nodeSqlStorage();
  const store = harnessStore(kv);
  if (options.harness !== undefined) store.save(options.harness);
  const secrets = harnessSecrets(kv, () => now);
  const variableSealer = valueSealer(CREDENTIALS_KEY);
  const cards: Array<McpQuestionCard> = [];
  const withdrawn: Array<string> = [];
  const asker: McpAsker = {
    ...(options.askerWaitMs === undefined ? {} : { waitMs: options.askerWaitMs }),
    ask: async (card) => {
      cards.push(card);
      const answer = options.answer ?? { decision: "accept" };
      return typeof answer === "function" ? answer(card) : answer;
    },
    withdraw: (id) => void withdrawn.push(id),
  };
  const begun: Array<string> = [];
  const oauth = {
    begin: async (server: string) => {
      begun.push(server);
      return { ok: true as const, value: { authorizationUrl: AUTHORIZATION_URL, registration: "dynamic" } };
    },
    status: () => ({ signedIn: false, expiresAt: null, refreshable: false }),
    forget: () => undefined,
    accessToken: async () => undefined,
  };
  const github = fakeGithub();
  const skills = {
    store: skillStore({ sql, transactionSync: (closure) => closure(), harness: store, kv }),
    reader: async () => ({ reader: github.reader, how: "installation" as const }),
    unauthenticated: () => false,
  };
  const logs: Array<Record<string, unknown>> = [];
  const modesOwner = {};
  const noted: Array<string> = [];
  let deps: SettingsServerDeps;
  const host: McpHost = new McpHost({
    kv,
    engine: options.engine,
    secret: async (server, field) => secrets.read(server, field),
    settings: () => store.load(),
    now: () => now,
    settingsServer: (input) => settingsCall(deps, input),
  });
  /** A new table over the same SQLite: an Environment reset between the ask and the answer. */
  const changes = () =>
    settingsChanges(
      sql,
      () => now,
      (event) => void logs.push(event),
      options.answerMs ?? (() => DEFAULT_OWNER_ANSWER_MS),
      // As the Environment DO wires it (SPI-1322): the Settings server's limits as stored now.
      () => settingsServerLimitsOf(store.load()),
    );
  /** The Owner clients' modes, over the same SQLite (the panel sets them; the endpoint reads them). */
  const clients = ownerClients(sql, () => now);
  deps = {
    ops: { store, mcp: host, secrets, variableSealer, oauth, skills, now: () => now },
    oauthStatus: oauth.status,
    // As the Environment DO wires it: a Durable thread's modes are the adapter's record, a CLI's its live session's.
    modes: (caller) =>
      caller.thread === undefined
        ? undefined
        : caller.agent === DURABLE_AGENT
          ? durableModes(caller.thread)
          : cliThreadState(caller.thread),
    changes: changes(),
    origin: () => `https://${HOST}`,
    status: () =>
      options.panelStatus === true ? harnessStatus({ store }) : { "settings revision": store.load().revision },
    running: async () => ({ count: 0, holders: [] }),
    log: (event) => void logs.push(event),
    ...(options.cardWaitMs === undefined ? {} : { cardWaitMs: options.cardWaitMs }),
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
  };
  const durable = (thread = "thread-d", runtimeMode = "approval-required"): OwnCaller => {
    if (!noted.includes(thread)) {
      noteDurableModes(thread, { runtimeMode, interactionMode: "default" }, modesOwner);
      noted.push(thread);
    }
    return { door: "own", thread, agent: DURABLE_AGENT };
  };
  const call = (
    caller: OwnCaller,
    tool: string,
    args: Record<string, unknown> = {},
    extra: { readonly signal?: AbortSignal; readonly asker?: McpAsker } = {},
  ) =>
    host.call({
      server: "settings",
      tool,
      args,
      caller,
      asker: extra.asker ?? asker,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });
  /** The panel's deps; `ownerEndpoint: false` is a stage without the Owner-client endpoint (no `ownerEndpoint`). */
  const panel = (
    caller: AccessCaller = { kind: "owner", subject: "owner-sub" },
    panelOptions: { readonly ownerEndpoint?: boolean } = {},
  ): HarnessDeps => ({
    caller,
    host: HOST,
    store,
    mcp: host,
    secrets,
    variableSealer,
    oauth,
    now: () => now,
    skills,
    changes: changesApiOf(deps),
    clients,
    ...(panelOptions.ownerEndpoint === false ? {} : { ownerEndpoint: `https://${HOST}/_t3flare/mcp` }),
  });
  return {
    kv,
    sql,
    store,
    secrets,
    oauth,
    begun,
    github,
    skills,
    host,
    clients,
    get deps() {
      return deps;
    },
    /** Swaps in a new table instance over the same storage (the Environment reset). */
    reset: () => {
      deps = { ...deps, changes: changes() };
    },
    call,
    durable,
    panel,
    cards,
    withdrawn,
    logs,
    now: () => now,
    advance: (ms: number) => (now += ms),
    dispose: () => {
      for (const thread of noted.splice(0)) forgetDurableModes(thread, modesOwner);
    },
  };
};

export type SettingsFixture = ReturnType<typeof settingsFixture>;

/** Lets pending promise chains run. */
export const flush = async (times = 20) => {
  for (let index = 0; index < times; index++) await Promise.resolve();
};

/**
 * Waits until `check` holds (a held call reached its card): first by draining the microtask queue, which is all most
 * flows need, and only then by yielding to timers (a held stream's or a real fetch's work), up to `tries` times.
 */
export const until = async (check: () => boolean, tries = 200) => {
  for (let index = 0; index < tries; index++) {
    if (check()) return;
    await flush();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("never happened");
};
