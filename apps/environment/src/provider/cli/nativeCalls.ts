// A CLI's own approval requests as its process sent them (SPI-1389), by the native id t3's adapter gives the runtime
// request (`nativeRequestRef.nativeId`). A parked request's allowance matches the repeat by its whole call, read here off
// the process's stdout: t3's approval item carries only a title and a prompt, which a model-written reason or a tool's
// title can stand in for.
// - ACP (Claude Code, OpenCode): `session/request_permission`'s tool call, by its `toolCallId`: the tool's name (Claude
//   Code's `_meta.claudeCode.toolName`, else the tool call's title: an MCP tool's kind is only `other`), its kind and its
//   raw input (a command and its arguments; a file path and the edit's content), merged over the tool call's earlier
//   updates, as t3's adapter merges them.
// - Codex: an `item/…/requestApproval` request's method and every param but those that name the request or change
//   between its asks (`CODEX_REQUEST_ONLY`: its ids, its timestamps, the decisions offered and the model's reason), with
//   a file change's item's changes from its `item/started`; by `approvalId ?? itemId`.
// - pi has no approval requests of its own.
// A request whose call cannot be read is not kept: its park keeps no call, and the repeat asks again.

/**
 * How many requests (and Codex file-change items, and ACP tool calls) a process's recorder keeps, the oldest dropped
 * first. Guards only the Environment's memory: a turn has a few pending requests at once.
 */
export const NATIVE_CALLS_KEPT = 256;

export interface NativeCallRecorder {
  /** One protocol line the process wrote. */
  readonly observe: (line: string) => void;
  /** The whole call of the request t3 knows by `nativeId`, or undefined when none was read. */
  readonly callOf: (nativeId: string) => unknown;
}

/** The protocol a CLI's process speaks to t3, as far as its own approval requests go. */
export type NativeProtocol = "acp" | "codex" | "none";

export const nativeProtocolOf = (cli: string): NativeProtocol =>
  cli === "codex" ? "codex" : cli === "claude-agent-acp" || cli === "opencode" || cli === "claude" ? "acp" : "none";

/** A bounded map: setting a key past `NATIVE_CALLS_KEPT` drops the oldest. */
const bounded = <V>() => {
  const map = new Map<string, V>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: V) => {
      map.delete(key);
      map.set(key, value);
      if (map.size > NATIVE_CALLS_KEPT) map.delete(map.keys().next().value!);
    },
  };
};

type Message = { readonly id?: unknown; readonly method?: unknown; readonly params?: Record<string, unknown> };

const parseLine = (line: string): Message | undefined => {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
};

/** Codex's request params that are the call: the rest name the request (ids, a timestamp) or the model's reason. */
/**
 * Codex's request params that are not the call: its ids (which the repeat's request has new), the decisions it offers
 * (the client's choice, not the call), and the model's reason. A param named for a time (`…At`, `…AtMs`) goes too. Every
 * other param stays in the call: what runs (`command`, `kind`: a command or a write to its stdin), where (`cwd`,
 * `environmentId`), what it may reach (`permissions`, `networkApprovalContext`, `grantRoot`).
 */
const CODEX_REQUEST_ONLY = new Set([
  "threadId",
  "turnId",
  "itemId",
  "approvalId",
  "callId",
  "reason",
  "availableDecisions",
]);
const codexTimeParam = /At(Ms)?$/;

export const nativeCallRecorder = (protocol: NativeProtocol): NativeCallRecorder => {
  const calls = bounded<unknown>();
  // ACP: each tool call's name, kind and raw input as its updates gave them. Codex: each file-change item's changes.
  const tools = bounded<{ readonly name?: unknown; readonly kind?: unknown; readonly rawInput?: unknown }>();
  /** An ACP tool call's tool name: Claude Code's own, else its title. */
  const nameOf = (toolCall: Record<string, unknown>): unknown =>
    (toolCall._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName ?? toolCall.title;
  const changes = bounded<unknown>();
  const observeAcp = (message: Message) => {
    const params = message.params ?? {};
    if (message.method === "session/update") {
      const update = (params.update ?? {}) as Record<string, unknown>;
      if (
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        typeof update.toolCallId === "string"
      ) {
        const known = tools.get(update.toolCallId) ?? {};
        tools.set(update.toolCallId, {
          name: nameOf(update) ?? known.name,
          kind: update.kind ?? known.kind,
          rawInput: update.rawInput ?? known.rawInput,
        });
      }
      return;
    }
    if (message.method !== "session/request_permission" || message.id === undefined) return;
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    if (typeof toolCall.toolCallId !== "string") return;
    const known = tools.get(toolCall.toolCallId) ?? {};
    const rawInput = toolCall.rawInput ?? known.rawInput;
    if (rawInput === undefined || rawInput === null) return;
    const name = nameOf(toolCall) ?? known.name;
    // A call that names no tool cannot be told from another tool's with the same input: none is kept.
    if (typeof name !== "string" || name === "") return;
    calls.set(toolCall.toolCallId, { name, kind: toolCall.kind ?? known.kind ?? null, rawInput });
  };
  const observeCodex = (message: Message) => {
    const params = message.params ?? {};
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (item.type === "fileChange" && typeof item.id === "string" && item.changes !== undefined)
        changes.set(item.id, item.changes);
      return;
    }
    if (typeof message.method !== "string" || !message.method.endsWith("/requestApproval") || message.id === undefined)
      return;
    const nativeId = params.approvalId ?? params.itemId;
    if (typeof nativeId !== "string") return;
    const call: Record<string, unknown> = { method: message.method };
    for (const [key, value] of Object.entries(params))
      if (!CODEX_REQUEST_ONLY.has(key) && !codexTimeParam.test(key)) call[key] = value;
    if (message.method === "item/fileChange/requestApproval") {
      const itemChanges = typeof params.itemId === "string" ? changes.get(params.itemId) : undefined;
      if (itemChanges === undefined) return;
      call.changes = itemChanges;
    }
    calls.set(nativeId, call);
  };
  return {
    observe: (line) => {
      if (protocol === "none") return;
      const message = parseLine(line);
      if (message === undefined) return;
      if (protocol === "acp") observeAcp(message);
      else observeCodex(message);
    },
    callOf: (nativeId) => calls.get(nativeId),
  };
};
