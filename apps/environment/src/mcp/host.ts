// @effect-diagnostics globalDate:off globalConsole:off globalTimers:off
// The MCP host (ADR-0028, plan §3.0): the Environment DO's part that holds the MCP server set's inventory, each
// server's protocol state and its credentials, and makes every MCP list and call through the MCP Worker's engine
// (`MCP_ENGINE`), the one place the SDK runs. No credential leaves the Environment Worker except inside the engine call
// that uses it; the engine scrubs it (`redact`) from whatever comes back.
//
// - Inventory: each server's tools, listed at most every 10 minutes, on the panel's test, or after a failure; a failed
//   list keeps the last one, marked stale. Capped per server (review M12).
// - Classes: the owner's choice in the settings, else the tool's own `readOnlyHint` (`classOf`), as t3 does (owner,
//   2026-11-12, back to stock: no definition-hash pins).
// - Calls: the Session or the relay has already decided (`decideCall`); the host checks the server is enabled and offered
//   to the caller, finds the tool's definition, and calls. A failed or timed-out write is never retried.
import {
  classOf,
  DEFAULT_MCP_CALL_MS,
  MCP_PAUSES_PER_CALL,
  MCP_RESULT_KIB,
  type Exposure,
  CARD_WAIT_MS,
  MAX_SCHEMA_BYTES,
  MCP_REQUEST_OFF_MS,
  offDeadlineMs,
  type McpServerSetting,
  mcpServersOf,
  ownEntry,
  DO_VALUE_BYTES,
  STORED_CHARACTER_BYTES,
  storedBytes,
  type StoredHarness,
  type ToolClass,
  toolNamesOf,
} from "@t3flare/harness-registry";
import {
  appUriOfMeta,
  type McpEngineDiscoverResult,
  type McpEngineHooks,
  type McpEnginePriorEncoded,
  type McpEngineRequestEncoded,
  type McpEngineRequestResult,
  type McpEngineTargetEncoded,
} from "@t3flare/mcp/types";
import type { McpAsker, McpQuestionAnswer } from "@t3flare/session-protocol";
import { sha256Hex } from "@t3flare/skills";

import type { KvStorage } from "../harness/keys.ts";
import { OFF_MESSAGE, type OwnCaller } from "../settings/caller.ts";
import { settingsDefinitions } from "../settings/tools.ts";
import { canonicalJson } from "./canonical.ts";
import {
  type ElicitAnswer,
  type ElicitResultOrCancel,
  isPausingServer,
  pauseOf,
  planPause,
  planQuestion,
  type QuestionContext,
  type QuestionPlan,
} from "./elicitation.ts";

/** The MCP Worker's `McpEngine`, as the Environment binds it. */
export interface McpEngineBinding {
  discover(
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    hooks: McpEngineHooks,
  ): Promise<typeof McpEngineDiscoverResult.Encoded>;
  request(
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    request: McpEngineRequestEncoded,
    hooks: McpEngineHooks,
  ): Promise<typeof McpEngineRequestResult.Encoded>;
}

export const INVENTORY_TTL_MS = 10 * 60_000;
/** The MCP result size in bytes (`MCP_RESULT_KIB`, SPI-1387): a host given none of its own (a test's) takes it. */
const DEFAULT_RESULT_BYTES = MCP_RESULT_KIB * 1024;

/** The MCP result size as its limit reads: "1,024 KiB", or bytes when it is not whole KiB (a test's). */
const resultLimitText = (max: number): string =>
  max % 1024 === 0 ? `${(max / 1024).toLocaleString("en-US")} KiB` : `${max.toLocaleString("en-US")} bytes`;

/**
 * What a result or an App past the MCP result size answers (SPI-1387, ADR-0049 §4): the limit and its value, a fixed one
 * Cloudflare's 128 MB isolate forces, as the Environment holds a result several times over while it reads it.
 */
export const resultTooLarge = (max: number): string =>
  `The tool's result was larger than t3flare's fixed ${resultLimitText(max)} limit on one MCP result (the Environment's memory bounds it), so t3flare refused it whole`;
export const appTooLarge = (max: number): string =>
  `The App's resource was larger than t3flare's fixed ${resultLimitText(max)} limit on one MCP result (the Environment's memory bounds it), so t3flare refused it`;
/** What follows a result's text when its structured content was past the MCP result size and dropped (SPI-1387). */
export const structuredDropped = (max: number): string =>
  `\n[t3flare dropped this result's structured content, past its fixed ${resultLimitText(max)} limit on one MCP result]`;
/** What follows an inline result's text that the MCP result size cut (SPI-1387). */
export const resultCut = (max: number): string =>
  `\n[t3flare cut this result at its fixed ${resultLimitText(max)} limit on one MCP result]`;

/** One tool as the host lists it, with its class resolved. */
export interface InventoryTool {
  readonly name: string;
  readonly upstream: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly hash: string;
  readonly class: ToolClass;
  /** What the tool's own hint says, shown beside an owner's override. */
  readonly hinted: ToolClass;
  readonly exposure: Exposure;
  /**
   * G11 (MCP apps, review L10): the tool's `_meta.ui` alone (its App's `ui://` resource and who the tool is for), passed
   * on in the relay's `tools/list`; nothing else of a tool's `_meta`.
   */
  readonly ui?: Readonly<Record<string, unknown>>;
}

export interface Inventory {
  readonly server: string;
  readonly listedAt: number;
  readonly status: "ok" | "failed" | "never";
  readonly error?: string;
  /** The definitions as the server gave them, by upstream name (what a call sends back as `tool`). */
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * What the server says of its tools (its `instructions`, scrubbed of credentials by the engine), passed on to the
   * agent (SPI-1374). Absent when it gave none, or when they did not fit the inventory's bytes (`INSTRUCTIONS_REFUSED`).
   */
  readonly instructions?: string;
  /**
   * The tools refused, by name, after an `INSTRUCTIONS_REFUSED` entry when the instructions were dropped; a cut list ends
   * with an entry whose `more` counts the rest (`fitRefused`).
   */
  readonly refused: ReadonlyArray<RefusedTool>;
}

/** What a Session (or the relay) is given: the servers it may use, with their tools; no secret, no URL. */
export interface McpView {
  readonly version: string;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly kind: McpServerSetting["kind"];
    readonly state: "available" | "stale" | "unavailable";
    readonly listedAt: number | null;
    readonly exposure: Exposure;
    readonly tools: ReadonlyArray<InventoryTool>;
    /** The server's own instructions (SPI-1374): the relay's `initialize` and the pi Session's guidance pass them on. */
    readonly instructions?: string;
  }>;
}

export type McpCallAnswer =
  | { readonly kind: "result"; readonly isError: boolean; readonly text: string; readonly structured?: unknown }
  | { readonly kind: "unavailable"; readonly message: string; readonly mayHaveRun: boolean };

const inventoryKey = (server: string) => `t3flare:mcp:inventory:${server}`;
const priorKey = (server: string) => `t3flare:mcp:prior:${server}`;

/** A tool definition's hash: what the server says the tool is (name, description, schemas, annotations). */
export const definitionHash = async (definition: Readonly<Record<string, unknown>>): Promise<string> => {
  const { name, title, description, inputSchema, outputSchema, annotations } = definition;
  // `keepUndefined`: byte-identical to the hashes kept with stored inventories (canonical.ts).
  return (
    await sha256Hex(canonicalJson({ name, title, description, inputSchema, outputSchema, annotations }, true))
  ).slice(0, 32);
};

const overrideOf = (value: unknown): ToolClass | undefined =>
  value === "read" || value === "write" ? value : undefined;

const errorText = (error: unknown): string => {
  const record = (error ?? {}) as { _tag?: unknown; message?: unknown; status?: unknown };
  const tag = typeof record._tag === "string" ? record._tag : "Error";
  const message = typeof record.message === "string" ? record.message : JSON.stringify(error);
  return `${tag}: ${message}`;
};

export interface McpHostDeps {
  readonly kv: KvStorage & { delete(key: string): unknown };
  readonly engine: McpEngineBinding | undefined;
  readonly settings: () => StoredHarness;
  /** A direct server's header value, from the secret store (part 4). */
  readonly secret?: (server: string, field: string) => Promise<string | undefined>;
  /** An OAuth server's access token (review M4): refreshed when stale; undefined when the owner must sign in. */
  readonly oauthToken?: (server: string, stale: boolean) => Promise<string | undefined>;
  readonly now?: () => number;
  /** Keeps background work alive past the request (`ctx.waitUntil`). */
  readonly background?: (work: Promise<unknown>) => void;
  /** The t3 host as deployed: a page question that sends the owner there is declined (SPI-1079). */
  readonly ownHost?: () => string | undefined;
  /**
   * How long a server's question waits for the owner, in ms, read when a call starts or a pause is raised. Default:
   * `CARD_WAIT_MS` (SPI-1389): until it is answered, as on stock t3; a CLI agent's turn parks before then.
   */
  readonly questionWaitMs?: () => number;
  /**
   * The MCP call time limit in ms (`mcpCallSeconds`, SPI-1359), read as each call's target is made; 0 when it is off
   * (SPI-1386), which the target carries as `OFF_DEADLINE_MS`. Default: `DEFAULT_MCP_CALL_MS`.
   */
  readonly callTimeoutMs?: () => number;
  /**
   * The MCP servers' limits (SPI-1363), read as each call's target is made: how long a connection may take to start
   * (`mcpConnectSeconds`) and one listing (`mcpListSeconds`), in ms, how many server logs a call keeps
   * (`MCP_LOG_ENTRIES`), how many progress notices it passes on a second (`MCP_PROGRESS_PER_SECOND`) and how long a Legacy
   * server is taken as Legacy, in ms (`MCP_LEGACY_RECHECK_HOURS`). Absent, the engine's defaults, the same values.
   */
  readonly limits?: () => McpServerLimits;
  /**
   * The MCP result size in bytes, read at each call: a larger streamed result is refused, a larger inline one cut, each
   * saying so. Default: `MCP_RESULT_KIB` (SPI-1359, SPI-1387); a test passes its own.
   */
  readonly resultBytes?: () => number;
  /**
   * How many of one call's pauses t3flare answers (SPI-1366), read as each call starts. Default: `MCP_PAUSES_PER_CALL`
   * (SPI-1387); a test passes its own.
   */
  readonly pausesPerCall?: () => number;
  /**
   * The Settings server (ADR-0035, plan D2): a call to the `settings` entry goes here, with the caller the Environment
   * derived and the call's asker, before any inventory or pausing logic. Absent, its calls are refused.
   */
  readonly settingsServer?: (input: {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly caller: OwnCaller;
    readonly asker?: McpAsker;
    readonly signal?: AbortSignal;
  }) => Promise<McpCallAnswer>;
}

/** The refused entry that stands for a server's instructions dropped from its inventory (SPI-1374). */
export const INSTRUCTIONS_REFUSED = "(instructions)";

/** Why a tool, or a server's instructions, is refused: past the bytes one server's inventory holds, named with its value. */
const PAST_SCHEMA_BYTES = `past the ${(MAX_SCHEMA_BYTES / 1024 / 1024).toFixed(1)} MiB of tool definitions and instructions one server's inventory holds`;

/**
 * A tool the inventory refused, the server's instructions dropped (`tool` is `INSTRUCTIONS_REFUSED`), or (`more`) the
 * closing entry of a cut list, counting the tools past it.
 */
export interface RefusedTool {
  readonly tool: string;
  readonly reason: string;
  readonly more?: number;
}

/** How many entries `refused` stands for: the tools, the ones past a cut included, and any dropped instructions. */
export const refusedCount = (refused: ReadonlyArray<RefusedTool>): number =>
  refused.reduce((count, entry) => count + (entry.more ?? 1), 0);

/** The MCP servers' limits a target carries (SPI-1363, SPI-1368). */
export interface McpServerLimits {
  readonly connectTimeoutMs: number;
  readonly listTimeoutMs: number;
  readonly logEntries: number;
  readonly progressPerSecond: number;
  readonly legacyEraTtlMs: number;
}

export class McpHost {
  readonly #deps: McpHostDeps;
  readonly #refreshing = new Map<string, Promise<Inventory>>();
  /** Bumped by `forget`: work started under an older generation of a name writes nothing back. */
  readonly #generations = new Map<string, number>();

  constructor(deps: McpHostDeps) {
    this.#deps = deps;
  }

  #now() {
    return this.#deps.now?.() ?? Date.now();
  }

  /** The MCP result size now, in bytes (`MCP_RESULT_KIB`). */
  #resultBytes(): number {
    return this.#deps.resultBytes?.() ?? DEFAULT_RESULT_BYTES;
  }

  /** How long a card waits (SPI-1389): until it is answered, so the off deadline the engine's input bound needs. */
  #waitOf(): number {
    return this.#deps.questionWaitMs?.() ?? CARD_WAIT_MS;
  }

  servers(): Readonly<Record<string, McpServerSetting>> {
    return mcpServersOf(this.#deps.settings());
  }

  /** The engine's target for `server`, its credential resolved; undefined when it cannot be reached. */
  async #target(name: string, server: McpServerSetting): Promise<McpEngineTargetEncoded | string> {
    if (server.url === undefined) return `${name} has no URL`;
    const headers: Record<string, string> = {};
    const redact: Array<string> = [];
    if (server.auth?.kind === "header") {
      const value = await this.#deps.secret?.(name, "header");
      if (value === undefined) return `${name}'s ${server.auth.header} header is not set`;
      headers[server.auth.header] = value;
      redact.push(value);
    }
    // An off limit (SPI-1386) gives a tool call the off deadline, not none: the engine's SDK times a request it gives no
    // timeout at 60 s. Only the call is the Owner's to leave unbounded: the server's other requests keep 270 s
    // (`MCP_REQUEST_OFF_MS`), the bound they had with the call limit's old default; a limit set bounds both, as before.
    const callMs = this.#deps.callTimeoutMs?.() ?? DEFAULT_MCP_CALL_MS;
    const timeoutMs = offDeadlineMs(callMs);
    const requestTimeoutMs = callMs === 0 ? MCP_REQUEST_OFF_MS : callMs;
    return {
      kind: "http",
      conn: name,
      name,
      url: server.url,
      headers,
      redact,
      timeoutMs,
      requestTimeoutMs,
      ...this.#deps.limits?.(),
    };
  }

  /** The engine's `auth` hook for an OAuth server: asked for a token, and again with `stale` after a 401. */
  #authHooks(name: string, server: McpServerSetting): McpEngineHooks {
    const token = this.#deps.oauthToken;
    if (server.auth?.kind !== "oauth" || token === undefined) return {};
    return { auth: (stale: boolean) => token(name, stale) };
  }

  #prior(name: string): McpEnginePriorEncoded {
    return this.#deps.kv.get<McpEnginePriorEncoded>(priorKey(name)) ?? {};
  }

  #generation(name: string): number {
    return this.#generations.get(name) ?? 0;
  }

  /** Keeps the engine's protocol state for `name`, unless `name` was forgotten since `generation` began. */
  #keepState(
    name: string,
    state: { readonly era?: unknown; readonly session?: unknown } | undefined,
    generation: number,
  ) {
    if (state === undefined || generation !== this.#generation(name)) return;
    const prior: Record<string, unknown> = { ...this.#prior(name) };
    for (const key of ["era", "session"] as const) {
      if (state[key] === null) delete prior[key];
      else if (state[key] !== undefined) prior[key] = state[key];
    }
    this.#deps.kv.put(priorKey(name), prior);
  }

  /**
   * Forgets `name`'s kept inventory and protocol state (era, session id), so a server added under a name that held one
   * before (a removed server, or the retired built-in `commissary`) starts fresh: no old tools, no old session. A list
   * or a single engine request still in flight for the old server writes nothing back (its generation is past), and the
   * next list starts anew rather than joining the old one. A call paused on a card resumes under the new generation
   * (ADR-0028's known limit).
   */
  forget(name: string): void {
    this.#generations.set(name, this.#generation(name) + 1);
    this.#refreshing.delete(name);
    this.#deps.kv.delete(inventoryKey(name));
    this.#deps.kv.delete(priorKey(name));
  }

  inventory(name: string): Inventory {
    // The Settings server's tools are static (plan D2): no engine, no inventory kept, no credential, always listed.
    if (ownEntry(this.servers(), name)?.kind === "settings")
      return { server: name, listedAt: this.#now(), status: "ok", definitions: settingsDefinitions(), refused: [] };
    return (
      this.#deps.kv.get<Inventory>(inventoryKey(name)) ?? {
        server: name,
        listedAt: 0,
        status: "never",
        definitions: {},
        refused: [],
      }
    );
  }

  /** Lists `name`'s tools now (one list in flight per server). */
  list(name: string): Promise<Inventory> {
    if (ownEntry(this.servers(), name)?.kind === "settings") return Promise.resolve(this.inventory(name));
    const running = this.#refreshing.get(name);
    if (running !== undefined) return running;
    const work: Promise<Inventory> = this.#list(name).finally(() => {
      if (this.#refreshing.get(name) === work) this.#refreshing.delete(name);
    });
    this.#refreshing.set(name, work);
    return work;
  }

  async #list(name: string): Promise<Inventory> {
    const generation = this.#generation(name);
    const server = ownEntry(this.servers(), name);
    const before = this.inventory(name);
    const failed = (error: string): Inventory => {
      const rest = { ...before, status: "failed" as const, listedAt: before.listedAt, failedAt: this.#now() };
      const { failedAt, ...next } = { ...rest, error: fitError(rest, error) };
      if (generation === this.#generation(name)) this.#deps.kv.put(inventoryKey(name), { ...next, failedAt });
      console.warn(JSON.stringify({ t3flare: "mcp-list-failed", server: name, error }));
      return next;
    };
    if (server === undefined) return failed("no such server");
    if (this.#deps.engine === undefined) return failed("the MCP engine is not bound");
    const target = await this.#target(name, server);
    if (typeof target === "string") return failed(target);
    let result: typeof McpEngineDiscoverResult.Encoded;
    try {
      result = await this.#deps.engine.discover(target, this.#prior(name), this.#authHooks(name, server));
    } catch (error) {
      return failed(`the MCP engine failed: ${String(error)}`);
    }
    this.#keepState(name, result.state as never, generation);
    if (result.kind !== "discovered") return failed(errorText(result.error));
    const definitions: Record<string, Readonly<Record<string, unknown>>> = {};
    const refused: Array<{ tool: string; reason: string }> = (result.problems ?? []).map((problem) => ({
      tool: problem.tool,
      reason: problem.problem,
    }));
    // The server's instructions share its tools' bytes (SPI-1374), reserved first: past them, they are dropped.
    let bytes = 0;
    let instructions = result.instructions;
    if (instructions !== undefined) {
      const size = storedBytes(instructions);
      if (size > MAX_SCHEMA_BYTES) {
        refused.unshift({ tool: INSTRUCTIONS_REFUSED, reason: `the server's instructions, ${PAST_SCHEMA_BYTES}` });
        instructions = undefined;
      } else bytes = size;
    }
    for (const tool of result.tools) {
      const size = storedBytes(tool);
      if (bytes + size > MAX_SCHEMA_BYTES) {
        refused.push({ tool: tool.name, reason: PAST_SCHEMA_BYTES });
        continue;
      }
      bytes += size;
      definitions[tool.name] = tool as Readonly<Record<string, unknown>>;
    }
    const rest = {
      server: name,
      listedAt: this.#now(),
      status: "ok" as const,
      definitions,
      ...(instructions === undefined ? {} : { instructions }),
    };
    const next: Inventory = { ...rest, refused: fitRefused(rest, refused) };
    // Forgotten meanwhile (removed, or added again): the old server's tools are not kept under the new one's name.
    if (generation !== this.#generation(name)) return this.inventory(name);
    this.#deps.kv.put(inventoryKey(name), next);
    console.log(
      JSON.stringify({
        t3flare: "mcp-listed",
        server: name,
        tools: Object.keys(definitions).length,
        refused: refusedCount(next.refused),
      }),
    );
    return next;
  }

  /** `name`'s tools with names, classes and exposure resolved. */
  async tools(
    name: string,
    server: McpServerSetting,
    inventory: Inventory,
  ): Promise<{ readonly tools: ReadonlyArray<InventoryTool>; readonly refused: Inventory["refused"] }> {
    const named = toolNamesOf(name, Object.keys(inventory.definitions));
    const tools: Array<InventoryTool> = [];
    for (const [upstream, toolName] of Object.entries(named.names)) {
      const definition = inventory.definitions[upstream]!;
      const annotations = definition.annotations as { readonly readOnlyHint?: unknown } | undefined;
      tools.push({
        name: toolName,
        upstream,
        description:
          typeof definition.description === "string"
            ? definition.description
            : typeof definition.title === "string"
              ? definition.title
              : upstream,
        inputSchema: (definition.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        hash: await definitionHash(definition),
        // Only "read" or "write" is an override (settings stored before the back-to-stock cut held hash pins: ignored).
        class: classOf(
          annotations === undefined ? {} : { annotations },
          overrideOf(ownEntry(server.classes, upstream)),
        ),
        hinted: classOf(annotations === undefined ? {} : { annotations }, undefined),
        exposure: ownEntry(server.toolExposure, upstream) ?? server.exposure,
        ...uiOf(definition),
      });
    }
    return { tools, refused: [...inventory.refused, ...named.refused] };
  }

  /**
   * What a caller may use: the enabled servers, linked threads included (owner, 2026-11-12, back to stock), from the
   * kept inventories; an inventory older than INVENTORY_TTL_MS is listed again in the background.
   */
  async view(): Promise<McpView> {
    const servers: Array<McpView["servers"][number]> = [];
    for (const [name, server] of Object.entries(this.servers()).sort(([a], [b]) => a.localeCompare(b))) {
      if (!server.enabled) continue;
      const inventory = this.inventory(name);
      if (this.#now() - inventory.listedAt > INVENTORY_TTL_MS) {
        const refresh = this.list(name).catch(() => undefined);
        this.#deps.background?.(refresh);
      }
      const { tools } = await this.tools(name, server, inventory);
      const pausing = isPausingServer(inventory.definitions);
      servers.push({
        name,
        kind: server.kind,
        state: inventory.status === "ok" ? "available" : inventory.listedAt > 0 ? "stale" : "unavailable",
        listedAt: inventory.listedAt > 0 ? inventory.listedAt : null,
        exposure: server.exposure,
        ...(inventory.instructions === undefined ? {} : { instructions: inventory.instructions }),
        // SPI-1079: a pausing server's `resume` is t3flare's to call (with the owner's answer), so no agent is offered it.
        tools: tools.filter(
          (tool) =>
            tool.exposure !== "hidden" &&
            !(pausing && tool.upstream === RESUME_TOOL) &&
            // The Settings server read-only (plan D2): its write tools are not listed.
            !(server.kind === "settings" && server.writes === false && tool.class === "write"),
        ),
      });
    }
    const version = await definitionHash({
      name: "view",
      // A server's instructions only where it has them, so a view without any keeps the version it had (SPI-1374).
      inputSchema: servers.map((server) => [
        server.name,
        server.tools.map((tool) => [tool.name, tool.hash, tool.class, tool.exposure]),
        ...(server.instructions === undefined ? [] : [server.instructions]),
      ]),
    });
    return { version, servers };
  }

  /**
   * Calls `tool` (the upstream name) of `name` with `args`, for a caller already judged. With an `asker` (an agent's call,
   * SPI-1079) the call declares elicitation and every question the server asks, and every pause of a pausing server
   * (Executor's model mode), becomes a card the caller shows; only the owner's answer goes back.
   */
  async call(input: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    /** The class the caller judged the call by: a read whose class is write now is refused, to be asked again. */
    readonly judged?: ToolClass;
    readonly signal?: AbortSignal;
    /** The caller's cards for the server's questions (SPI-1079); without one, every question is cancelled. */
    readonly asker?: McpAsker;
    /** Who calls, as the Environment derived it (plan D3): the Settings server judges its writes by it. */
    readonly caller?: OwnCaller;
  }): Promise<McpCallAnswer> {
    const server = ownEntry(this.servers(), input.server);
    // The Settings server switched off says so, and that only the panel turns it back on (plan D2).
    if (server?.kind === "settings" && !server.enabled)
      return { kind: "unavailable", message: OFF_MESSAGE, mayHaveRun: false };
    if (server === undefined || !server.enabled)
      return {
        kind: "unavailable",
        message: `The owner removed or disabled the MCP server ${input.server}; its tools are gone from the next turn.`,
        mayHaveRun: false,
      };
    if (server.kind === "settings") {
      // Fails closed (plan D3): without the Environment's caller nothing reaches the Settings server.
      if (this.#deps.settingsServer === undefined || input.caller === undefined)
        return {
          kind: "unavailable",
          message: "The Settings server cannot tell who is calling, so it answers nothing.",
          mayHaveRun: false,
        };
      // Hidden by the tool's exposure or the server's, as the listing reads it (`tools`), and as the Owner door's `hiddenTools`.
      if ((ownEntry(server.toolExposure, input.tool) ?? server.exposure) === "hidden")
        return { kind: "unavailable", message: `${input.tool} is hidden by the owner.`, mayHaveRun: false };
      return this.#deps.settingsServer({
        tool: input.tool,
        args: input.args,
        caller: input.caller,
        ...(input.asker === undefined ? {} : { asker: input.asker }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    }
    const inventory = this.inventory(input.server);
    const definition = ownEntry(inventory.definitions, input.tool);
    if (definition === undefined)
      return {
        kind: "unavailable",
        message: `${input.server} has no tool ${input.tool} (any more).`,
        mayHaveRun: false,
      };
    if (ownEntry(server.toolExposure, input.tool) === "hidden")
      return { kind: "unavailable", message: `${input.tool} is hidden by the owner.`, mayHaveRun: false };
    const pausing = isPausingServer(inventory.definitions);
    // SPI-1079: a pausing server's `resume` is t3flare's to call, with the owner's answer, never the agent's.
    if (pausing && input.tool === RESUME_TOOL)
      return { kind: "unavailable", message: RESUME_REFUSAL(input.server), mayHaveRun: false };
    if (input.judged !== "write") {
      // A class change applies to the next call (plan §6.2): a read the owner (or a new hint) made write asks.
      const now = (await this.tools(input.server, server, inventory)).tools.find(
        (tool) => tool.upstream === input.tool,
      );
      if (now?.class !== "read")
        return {
          kind: "unavailable",
          message: `${input.tool} is now a write tool; call it again and it asks the owner.`,
          mayHaveRun: false,
        };
    }
    if (this.#deps.engine === undefined)
      return { kind: "unavailable", message: "The MCP engine is not bound.", mayHaveRun: false };
    const target = await this.#target(input.server, server);
    if (typeof target === "string") return { kind: "unavailable", message: target, mayHaveRun: false };
    const context: QuestionContext = {
      server: input.server,
      tool: input.tool,
      args: input.args,
      isOwnHost: (host) => host === this.#deps.ownHost?.()?.toLowerCase(),
    };
    const first = await this.#request(
      input.server,
      server,
      target,
      definition,
      input.args,
      input.signal,
      input.asker,
      context,
    );
    if (first.kind === "unavailable" || !pausing)
      return first.kind === "unavailable"
        ? first
        : {
            kind: "result",
            ...resultWithStructured(first.value, this.#resultBytes()),
          };
    return this.#answerPauses(input.server, server, target, first.value, input.signal, input.asker, context);
  }

  /**
   * G11 (MCP apps, review L10): an App's `ui://` resource, read for a CLI through the relay: only a URI one of `server`'s
   * own offered tools declares (`_meta.ui.resourceUri`), the server's `ReadResourceResult` as it is, at most the MCP
   * result size (`MCP_RESULT_KIB`) in bytes read and in characters of its JSON passed on. The value crosses
   * the relay's RPC (32 MiB) as UTF-16, two bytes a character once any character is past Latin-1, so characters, not
   * bytes, are what must stay under half of it; the isolate holds a few copies of it while it reads (`MCP_RESULT_KIB`).
   */
  async readAppResource(input: {
    readonly server: string;
    readonly uri: string;
  }): Promise<
    { readonly kind: "result"; readonly value: unknown } | { readonly kind: "refused"; readonly message: string }
  > {
    const server = ownEntry(this.servers(), input.server);
    if (server === undefined || !server.enabled) return { kind: "refused", message: `${input.server} is not enabled.` };
    const { tools } = await this.tools(input.server, server, this.inventory(input.server));
    const declared = tools.some(
      (tool) => tool.exposure !== "hidden" && tool.exposure !== "codemode" && tool.ui?.resourceUri === input.uri,
    );
    if (!input.uri.startsWith("ui://") || !declared)
      return { kind: "refused", message: `${input.server} declares no App at ${input.uri}.` };
    if (this.#deps.engine === undefined) return { kind: "refused", message: "The MCP engine is not bound." };
    const target = await this.#target(input.server, server);
    if (typeof target === "string") return { kind: "refused", message: target };
    const generation = this.#generation(input.server);
    let result: typeof McpEngineRequestResult.Encoded;
    try {
      result = await this.#deps.engine.request(
        target,
        this.#prior(input.server),
        { op: "resources/read", uri: input.uri, ctx: { origin: "agent" } } as never,
        this.#authHooks(input.server, server),
      );
    } catch (error) {
      return { kind: "refused", message: `The read failed: ${String(error)}` };
    }
    this.#keepState(input.server, result.state as never, generation);
    if (result.kind !== "complete")
      return {
        kind: "refused",
        message: `The read failed (${result.kind === "failed" ? errorText(result.error) : result.kind}).`,
      };
    const max = this.#resultBytes();
    const read =
      result.result.kind === "inline"
        ? { kind: "read" as const, value: result.result.value as unknown }
        : await readBounded(result.result.body as ReadableStream<Uint8Array>, max);
    if (read.kind === "tooLarge") return { kind: "refused", message: `${appTooLarge(max)} (over ${max} bytes).` };
    const characters = JSON.stringify(read.value)?.length ?? 0;
    if (characters > max) return { kind: "refused", message: `${appTooLarge(max)} (${characters} characters).` };
    return { kind: "result", value: read.value };
  }

  /** One `tools/call` through the engine, its questions answered from the caller's cards: the result's value, or why not. */
  async #request(
    name: string,
    server: McpServerSetting,
    target: McpEngineTargetEncoded,
    definition: Readonly<Record<string, unknown>>,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    asker: McpAsker | undefined,
    context: QuestionContext,
  ): Promise<{ readonly kind: "value"; readonly value: unknown } | Extract<McpCallAnswer, { kind: "unavailable" }>> {
    const engine = this.#deps.engine!;
    const aborted = new Promise<void>((resolve) => {
      if (signal === undefined) return;
      if (signal.aborted) resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const generation = this.#generation(name);
    const cards = new Map<string, string>();
    // One wait for the whole call: the engine's input bound and each card's timer agree.
    const waitMs = asker === undefined ? undefined : this.#waitOf();
    const questionHooks: McpEngineHooks =
      asker === undefined
        ? {}
        : {
            onInput: async (request) => {
              const plan = planQuestion(request, context);
              // Kept before the wait, so the server's own withdrawal (`onInputEnded`) can close the card meanwhile.
              if (plan.kind === "card") cards.set(request.key, plan.card.id);
              const answer = await this.#answer(plan, asker, context, "question", waitMs);
              return answer.kind === "now" ? answer.answer : { kind: "answered", result: answer.result };
            },
            onInputEnded: async (key) => {
              const id = cards.get(key);
              if (id !== undefined) await asker.withdraw(id);
            },
          };
    let result: typeof McpEngineRequestResult.Encoded;
    try {
      result = await engine.request(
        target,
        this.#prior(name),
        {
          op: "tools/call",
          tool: definition as never,
          arguments: args as never,
          ctx: {
            origin: "agent",
            ...(waitMs === undefined ? {} : { answers: { elicitation: true, inputWaitMs: waitMs } }),
          },
        },
        {
          ...this.#authHooks(name, server),
          ...(signal === undefined ? {} : { untilAborted: () => aborted }),
          ...questionHooks,
        },
      );
    } catch (error) {
      return {
        kind: "unavailable",
        message: `The MCP call failed; it may have run: ${String(error)}`,
        mayHaveRun: true,
      };
    }
    this.#keepState(name, result.state as never, generation);
    if (result.kind === "failed") {
      const tag = (result.error as { _tag?: string })._tag;
      const message = `The MCP call failed (${errorText(result.error)}). It may have run upstream; do not repeat a change without checking.`;
      if (tag === "NotFound") this.#deps.background?.(this.list(name).catch(() => undefined));
      return { kind: "unavailable", message, mayHaveRun: true };
    }
    if (result.kind !== "complete")
      return {
        kind: "unavailable",
        message: `The MCP server answered ${result.kind}, which t3flare does not take yet.`,
        mayHaveRun: true,
      };
    const value =
      result.result.kind === "inline"
        ? result.result.value
        : await readStream(
            result.result.body as ReadableStream<Uint8Array>,
            this.#resultBytes(),
            resultTooLarge(this.#resultBytes()),
          );
    return { kind: "value", value };
  }

  /**
   * A plan's answer: at once (declined unseen, or refused), or the owner's on the caller's card, which closes after
   * `waitMs` unanswered (the asker's wait now when not given). Logged with the fields answered, never a value.
   */
  async #answer(
    plan: QuestionPlan,
    asker: McpAsker,
    context: QuestionContext,
    what: "question" | "pause",
    waitMs: number = this.#waitOf(),
  ): Promise<Answered> {
    const log = (event: Record<string, unknown>) =>
      console.log(
        JSON.stringify({ t3flare: "mcp-question", what, server: context.server, tool: context.tool, ...event }),
      );
    if (plan.kind === "now") {
      log({ outcome: "answered-unseen", why: plan.why });
      return { kind: "now", answer: plan.answer };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<McpQuestionAnswer>((resolve) => {
      timer = setTimeout(() => resolve({ decision: "cancel", reason: "no answer in time" }), waitMs);
    });
    let answer: McpQuestionAnswer;
    try {
      answer = await Promise.race([asker.ask(plan.card), timedOut]);
    } catch (error) {
      answer = { decision: "cancel", reason: `the card could not be shown: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
    if (answer.reason === "no answer in time")
      await Promise.resolve(asker.withdraw(plan.card.id)).catch(() => undefined);
    const sent = plan.answerOf(answer);
    log({
      card: plan.card.kind,
      outcome: sent.result.action,
      fields: Object.keys(sent.result.content ?? {}),
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      ...(sent.note === undefined ? {} : { note: sent.note }),
    });
    return { kind: "card", ...sent };
  }

  /**
   * A pausing server's result (Executor's model mode, SPI-1079): each pause becomes a card and t3flare calls `resume`
   * with the owner's answer, at most `MCP_PAUSES_PER_CALL` times; the agent gets the last result, never a `requestId`. An approval
   * is resumed with `accept` only when the owner accepted; a decline is sent as `decline`, an unanswered card as `cancel`.
   */
  async #answerPauses(
    name: string,
    server: McpServerSetting,
    target: McpEngineTargetEncoded,
    value: unknown,
    signal: AbortSignal | undefined,
    asker: McpAsker | undefined,
    context: QuestionContext,
  ): Promise<McpCallAnswer> {
    const resume = this.inventory(name).definitions[RESUME_TOOL]!;
    // Read as the call starts (SPI-1366): a change applies at the next call.
    const pauses = this.#deps.pausesPerCall?.() ?? MCP_PAUSES_PER_CALL;
    let current = value;
    for (let round = 0; ; round++) {
      const pause = pauseOf(current);
      if (pause === undefined) return { kind: "result", ...redactedResult(current, this.#resultBytes()) };
      if (asker === undefined)
        return {
          kind: "result",
          isError: true,
          text: `${name} paused this call for the owner's ${pause.status === "approval-required" ? "approval" : "input"}, which this caller cannot ask for. It did not run.`,
        };
      if (round === pauses)
        return {
          kind: "unavailable",
          message: `${name} paused this call more than ${pauses} times, t3flare's fixed limit; t3flare stopped answering. Some of its steps may have run.`,
          mayHaveRun: true,
        };
      const answer = await this.#answer(planPause(pause, context), asker, context, "pause");
      // Declined unseen or refused (a credential form, a malformed one): the server is told `decline`.
      const response =
        answer.kind === "card"
          ? answer.result
          : answer.answer.kind === "answered"
            ? answer.answer.result
            : { action: "decline" };
      const next = await this.#request(
        name,
        server,
        target,
        resume,
        { requestId: pause.requestId, response },
        signal,
        asker,
        context,
      );
      if (next.kind === "unavailable")
        return { ...next, message: `Resuming ${name}'s paused call failed: ${next.message}` };
      current = next.value;
    }
  }
}

/** A question's answer: at once, or from the owner's card. */
type Answered =
  | { readonly kind: "now"; readonly answer: ElicitAnswer }
  | ({ readonly kind: "card" } & ElicitResultOrCancel);

/** The tool a pausing server resumes a paused call with (Executor's). */
const RESUME_TOOL = "resume";
const RESUME_REFUSAL = (server: string) =>
  `t3flare answers ${server}'s approval and input requests itself, from the owner's card, and resumes the paused call; resume is not yours to call. If the call is still needed, call the original tool again.`;

/** A result as text, without a pause's `requestId` (an expired or busy outcome still carries one). */
const redactedResult = (value: unknown, max: number): { readonly isError: boolean; readonly text: string } => {
  const content = (value as { structuredContent?: unknown } | null)?.structuredContent as
    | { requestId?: unknown; message?: unknown }
    | undefined;
  if (content === undefined || content === null || typeof content.requestId !== "string") return resultText(value, max);
  return {
    isError: (value as { isError?: unknown }).isError === true,
    text:
      typeof content.message === "string"
        ? content.message.replaceAll(content.requestId, "[request]")
        : "The server is still answering an earlier request for this call; try the call again.",
  };
};

/**
 * `error` as much as an inventory (`rest`, its other fields, the last good listing's tools among them) can keep beside it
 * in its one Durable Object value (`DO_VALUE_BYTES`, a named constraint): whole when it fits, else its start.
 */
export const fitError = (rest: Readonly<Record<string, unknown>>, error: string): string => {
  const room = DO_VALUE_BYTES - storedBytes({ ...rest, error: "" });
  let kept = error;
  // `storedBytes` counts the JSON, whose escapes can take more than one character a unit: cut until it fits.
  while (kept.length > 0 && storedBytes(kept) > room)
    kept = kept.slice(0, Math.max(0, Math.min(kept.length - 1, Math.floor((kept.length * room) / storedBytes(kept)))));
  return kept;
};

/** What the closing "and N more" entry of a cut refused list may take stored. */
const MORE_ENTRY_BYTES = 1024;

/**
 * `refused` as an inventory (`rest`, its other fields) can keep it in its one Durable Object value (`DO_VALUE_BYTES`):
 * each name and reason whole, and the list cut where it would pass the value, ending with how many more were refused. Without the cut a huge server's refusals would fail the write, and discovery would run again at
 * every view.
 */
const fitRefused = (
  rest: Omit<Inventory, "refused">,
  refused: ReadonlyArray<{ readonly tool: string; readonly reason: string }>,
): Inventory["refused"] => {
  const room = DO_VALUE_BYTES - storedBytes({ ...rest, refused: [] }) - MORE_ENTRY_BYTES;
  const kept: Array<{ readonly tool: string; readonly reason: string }> = [];
  let used = 0;
  for (const entry of refused) {
    const shown = { tool: entry.tool, reason: entry.reason };
    const bytes = storedBytes(shown) + STORED_CHARACTER_BYTES;
    if (used + bytes > room) break;
    kept.push(shown);
    used += bytes;
  }
  return kept.length === refused.length
    ? kept
    : [
        ...kept,
        {
          tool: "…",
          reason: `and ${refused.length - kept.length} more tools refused, past what one server's inventory holds`,
          more: refused.length - kept.length,
        },
      ];
};

/** `body` read whole and parsed; a body past `max` bytes is refused (`tooLarge`), since JSON cannot be read in part. */
const readStream = async (
  body: ReadableStream<Uint8Array>,
  max: number,
  tooLarge = "The tool's result was larger than t3flare takes",
): Promise<unknown> => {
  const read = await readBounded(body, max);
  return read.kind === "read"
    ? read.value
    : { isError: true, content: [{ type: "text", text: `${tooLarge} (${max} bytes).` }] };
};

/** `body` read whole and parsed, or `tooLarge` once it passes `max` bytes (the rest is not read). */
const readBounded = async (
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ readonly kind: "read"; readonly value: unknown } | { readonly kind: "tooLarge" }> => {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { kind: "tooLarge" };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: "read", value: JSON.parse(new TextDecoder().decode(all)) };
};

/** `text` cut to at most `max` bytes of UTF-8, never inside a character. */
const cutBytes = (text: string, max: number): string => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  // A character the cut splits decodes as U+FFFD at the end: dropped.
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, "");
};

/** The byte length of `text` in UTF-8. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A `CallToolResult` as text for the model: its text blocks, else its structured content, else its JSON; at most `max`
 * bytes of UTF-8 (`MCP_RESULT_KIB`), and a cut one says so (`resultCut`).
 */
export const resultText = (
  value: unknown,
  max = DEFAULT_RESULT_BYTES,
): { readonly isError: boolean; readonly text: string } => {
  const result = (value ?? {}) as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const blocks = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
  const texts = blocks.flatMap((block) =>
    block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : typeof block.type === "string"
        ? [`[${block.type} content]`]
        : [],
  );
  const text =
    texts.length > 0
      ? texts.join("\n")
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : JSON.stringify(value);
  const cut = cutBytes(text, max);
  return { isError: result.isError === true, text: cut === text ? text : `${cut}${resultCut(max)}` };
};

/** G11 (review L10): a tool definition's `_meta.ui`, and nothing else of its `_meta`, when it declares one. */
const uiOf = (definition: Readonly<Record<string, unknown>>): { readonly ui?: Readonly<Record<string, unknown>> } => {
  const meta = definition._meta as Record<string, unknown> | undefined;
  const ui = meta?.ui;
  if (ui === null || typeof ui !== "object" || Array.isArray(ui)) return {};
  const uri = appUriOfMeta(meta as never);
  const visibility = (ui as { visibility?: unknown }).visibility;
  return {
    ui: {
      ...(uri === undefined ? {} : { resourceUri: uri }),
      ...(Array.isArray(visibility) && visibility.every((entry) => typeof entry === "string") ? { visibility } : {}),
    },
  };
};

/**
 * G11: a result as text (`resultText`) with its `structuredContent`, which an App reads, passed on beside it; dropped
 * past `max` bytes of UTF-8 (`MCP_RESULT_KIB`), since it cannot be cut, and then the text says so (`structuredDropped`),
 * whether or not the text itself was cut.
 */
export const resultWithStructured = (
  value: unknown,
  max: number,
): { readonly isError: boolean; readonly text: string; readonly structured?: unknown } => {
  const shown = resultText(value, max);
  const structured = (value as { structuredContent?: unknown } | null)?.structuredContent;
  if (structured === undefined) return shown;
  if (utf8Bytes(JSON.stringify(structured)) <= max) return { ...shown, structured };
  return { ...shown, text: `${shown.text}${structuredDropped(max)}` };
};
