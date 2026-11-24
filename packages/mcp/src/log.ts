/**
 * Server logs: the entry an engine call hands the host, and the levels. Like everything in `./types`, this never loads
 * the SDK.
 */
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/** MCP's logging levels, least to most severe (RFC 5424), as `notifications/message` names them. */
export const MCP_LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

/** The level the core asks every server that declares `logging` for, in both eras. */
export const MCP_LOG_LEVEL = "warning";

/** How many of a call's last log entries the engine keeps and hands back when the target names none (`MCP_LOG_ENTRIES`). */
export const MCP_LOG_RING = 50;

/**
 * One `notifications/message` a server sent during a call: when the engine received it, its `level` (a string, so a
 * level this build does not know is kept), the server's `logger` name, and its `data` as JSON text, scrubbed of the
 * call's tokens and header values (the engine keeps at most 64 Ki characters of it). Never shown to the model.
 */
export const McpLogEntry = Schema.Struct({
  at: Schema.Finite,
  level: Schema.String,
  logger: Schema.optionalKey(Schema.String),
  data: Schema.String,
});

export type McpLogEntry = typeof McpLogEntry.Type;

const RANK: Readonly<Record<string, number>> = Record.fromEntries(
  Arr.map(MCP_LOG_LEVELS, (level, rank) => [level, rank] as const),
);

/** Whether `level` is `warning` or above: what becomes a span event. A level this build does not know counts as one. */
export const isWarningOrAbove = (level: string): boolean => (RANK[level] ?? Infinity) >= (RANK[MCP_LOG_LEVEL] ?? 0);
