// A CLI's own approval requests as its process sent them (SPI-1389), by the native id t3's adapter gives the runtime
// request (`nativeRequestRef.nativeId`). A parked request's allowance matches the repeat by its whole call, read here off
// the process's stdout: t3's approval item carries only a title and a prompt, which a model-written reason or a tool's
// title can stand in for.
// - ACP (Claude Code, OpenCode): `session/request_permission`'s tool call, by its `toolCallId`: its kind and raw input
//   (a command and its arguments; a file path and the edit's content), merged over the tool call's earlier updates, as
//   t3's adapter merges them.
// - Codex: an `item/…/requestApproval` request's method and the params that are the call (`CODEX_CALL_PARAMS`: a
//   command and its cwd, the permissions asked, a file change's root and the item's changes from its `item/started`), by
//   `approvalId ?? itemId`; never its ids, timestamps or the model's reason.
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
const CODEX_CALL_PARAMS = ["command", "cwd", "permissions", "grantRoot"] as const;

export const nativeCallRecorder = (protocol: NativeProtocol): NativeCallRecorder => {
  const calls = bounded<unknown>();
  // ACP: each tool call's kind and raw input as its updates gave them. Codex: each file-change item's changes.
  const tools = bounded<{ readonly kind?: unknown; readonly rawInput?: unknown }>();
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
    calls.set(toolCall.toolCallId, { kind: toolCall.kind ?? known.kind ?? null, rawInput });
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
    for (const key of CODEX_CALL_PARAMS) if (params[key] !== undefined) call[key] = params[key];
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
