// An MCP server's question, and a parked card's question (SPI-1389), are the owner's to answer (SPI-1079). Its approval cards
// cannot be answered by an agent (t3's `t3_pending_request` answers `user_input` requests only), but its form cards are
// `user_input` requests, which t3 lets an agent answer, and even tells a parent agent to (a delegated child's
// question). So every request to t3's own `/mcp` (a CLI's, a linked laptop's, and a Durable Session's through
// `EnvironmentDO.mcp`) is read here first: a `t3_pending_request` naming a card of ours (its id carries
// `MCP_QUESTION_MARKER`) is answered with a tool error, and t3 never sees it. `list` still lists the id (t3's answer);
// `read` and `respond` on it are refused. A parked card's question (`PARK_QUESTION_MARKER`) is a plain `user_input`
// request too, whose answer would mint a call's allowance or approve an Open change: refused the same way.
import { MCP_QUESTION_MARKER, PARK_QUESTION_MARKER } from "@t3flare/session-protocol";

export const OWNER_ONLY_REFUSAL =
  "Refused: this question comes from an MCP server, and only the owner answers it, on its card in a t3 client. Tell the owner it is waiting; do not answer it for them.";

export const PARKED_OWNER_ONLY_REFUSAL =
  "Refused: this question is a parked approval, and only the owner answers it, in a t3 client. Tell the owner it is waiting; do not answer it for them.";

/** The refusal for a `t3_pending_request` naming `requestId`, or undefined when t3 may have it. */
const refusalOf = (requestId: string): string | undefined =>
  requestId.includes(MCP_QUESTION_MARKER)
    ? OWNER_ONLY_REFUSAL
    : requestId.includes(PARK_QUESTION_MARKER)
      ? PARKED_OWNER_ONLY_REFUSAL
      : undefined;

/** The refusal of one JSON-RPC message, when it reads or answers an owner-only question; else undefined. */
const refusalOfMessage = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (method !== "tools/call" || params?.name !== "t3_pending_request") return undefined;
  const args = (params.arguments ?? {}) as { action?: unknown; requestId?: unknown };
  return args.action !== "list" && typeof args.requestId === "string" ? refusalOf(args.requestId) : undefined;
};

/**
 * The JSON-RPC answer refusing `body` (one message or a batch) when it calls `t3_pending_request` on an MCP question's
 * card or a parked card's question; undefined when t3 may have it. A batch with one such call is refused whole, each
 * message with its own refusal (another message's, the first one's).
 */
export const refuseOwnerOnly = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const first = messages.map(refusalOfMessage).find((refusal) => refusal !== undefined);
  if (first === undefined) return undefined;
  const answers = messages
    .filter((message): message is { id: unknown } => typeof message === "object" && message !== null && "id" in message)
    .map((message) => ({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: refusalOfMessage(message) ?? first }], isError: true },
    }));
  return JSON.stringify(Array.isArray(parsed) ? answers : answers[0]);
};
