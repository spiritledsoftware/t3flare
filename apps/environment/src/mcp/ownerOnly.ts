// An MCP server's question, and a parked card's question (SPI-1389), are the owner's to answer (SPI-1079). Its approval cards
// cannot be answered by an agent (t3's `t3_pending_request` answers `user_input` requests only), but its form cards are
// `user_input` requests, which t3 lets an agent answer, and even tells a parent agent to (a delegated child's
// question). So every request to t3's own `/mcp` (a CLI's, a linked laptop's, and a Durable Session's through
// `EnvironmentDO.mcp`) is read here first: a `t3_pending_request` naming a card of ours (its id carries
// `MCP_QUESTION_MARKER`) is answered with a tool error, and t3 never sees it. `list` still lists the id (t3's answer);
// `read` and `respond` on it are refused. A parked card's question (`PARK_QUESTION_MARKER`) is a plain `user_input`
// request too, whose answer would mint a call's allowance or approve an Open change: refused the same way. Its answer, a
// queued `async-answer:` message, is not the agent's to edit or cancel in t3's queue (`t3_queue`) either: the park
// reads the Owner's decision from t3's record of the answer, and this keeps the message whole as well.
import { MCP_QUESTION_MARKER, PARK_QUESTION_MARKER } from "@t3flare/session-protocol";

export const OWNER_ONLY_REFUSAL =
  "Refused: this question comes from an MCP server, and only the owner answers it, on its card in a t3 client. Tell the owner it is waiting; do not answer it for them.";

export const QUEUED_ANSWER_REFUSAL =
  "Refused: this queued message is the owner's answer to a parked approval; it is not an agent's to edit or cancel.";

/** What the guard reads of t3's state: the message a queued run will send, by the run's id. */
export interface OwnerOnlyLookups {
  readonly queuedMessageOf?: (queuedRunId: string) => string | undefined;
}

/** `t3_queue`'s actions that change or drop a queued message. */
const QUEUE_WRITES = new Set(["edit", "cancel"]);

export const PARKED_OWNER_ONLY_REFUSAL =
  "Refused: this question is a parked approval, and only the owner answers it, in a t3 client. Tell the owner it is waiting; do not answer it for them.";

/** The refusal for a `t3_pending_request` naming `requestId`, or undefined when t3 may have it. */
const refusalOf = (requestId: string): string | undefined =>
  requestId.includes(MCP_QUESTION_MARKER)
    ? OWNER_ONLY_REFUSAL
    : requestId.includes(PARK_QUESTION_MARKER)
      ? PARKED_OWNER_ONLY_REFUSAL
      : undefined;

/**
 * The refusal of one JSON-RPC message, when it reads or answers an owner-only question, or edits or cancels the Owner's
 * queued answer to a parked one; else undefined.
 */
const refusalOfMessage = (message: unknown, lookups: OwnerOnlyLookups): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (method !== "tools/call") return undefined;
  if (params?.name === "t3_queue") {
    const args = (params.arguments ?? {}) as { action?: unknown; queuedRunId?: unknown };
    if (typeof args.action !== "string" || !QUEUE_WRITES.has(args.action) || typeof args.queuedRunId !== "string")
      return undefined;
    const queued = lookups.queuedMessageOf?.(args.queuedRunId);
    return queued !== undefined && queued.startsWith("async-answer:") && queued.includes(PARK_QUESTION_MARKER)
      ? QUEUED_ANSWER_REFUSAL
      : undefined;
  }
  if (params?.name !== "t3_pending_request") return undefined;
  const args = (params.arguments ?? {}) as { action?: unknown; requestId?: unknown };
  return args.action !== "list" && typeof args.requestId === "string" ? refusalOf(args.requestId) : undefined;
};

/**
 * The JSON-RPC answer refusing `body` (one message or a batch) when it calls `t3_pending_request` on an MCP question's
 * card or a parked card's question, or `t3_queue` edit or cancel on the Owner's queued answer to a parked one (by
 * `lookups`); undefined when t3 may have it. A batch with one such call is refused whole, each
 * message with its own refusal (another message's, the first one's).
 */
export const refuseOwnerOnly = (body: string, lookups: OwnerOnlyLookups = {}): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const first = messages.map((message) => refusalOfMessage(message, lookups)).find((refusal) => refusal !== undefined);
  if (first === undefined) return undefined;
  const answers = messages
    .filter((message): message is { id: unknown } => typeof message === "object" && message !== null && "id" in message)
    .map((message) => ({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: refusalOfMessage(message, lookups) ?? first }], isError: true },
    }));
  return JSON.stringify(Array.isArray(parsed) ? answers : answers[0]);
};
