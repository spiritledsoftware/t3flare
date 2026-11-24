// The agent's Terminals' scrollback (SPI-1397), kept in the Workspace DO's SQLite instead of each headless xterm: a line
// that scrolls off a Terminal's screen is appended here, and reads of what scrolled off come from here. The Workspace
// DO's memory holds each Terminal's screen and at most `FLUSH_BYTES` of lines on their way to a row, whatever the
// scrollback's length.
//
// - Lines are numbered as the Terminal numbers them: the absolute index of a line in its output.
// - Each Terminal keeps its last `AGENT_TERMINAL_HISTORY_BYTES` (stock t3's Terminal history, 8 MiB); older lines are
//   dropped, oldest first, and a read of them finds them missing.
// - A Terminal's rows are deleted when it is forgotten, and every row when the Workspace DO starts: its Terminals end
//   with the object.
// - The entries the Workspace's exited bound forgot are kept here too, by key, so an agent naming one is told why.
import { AGENT_TERMINAL_HISTORY_BYTES } from "@t3flare/harness-registry";

/** The part of `SqlStorage` this uses. */
export interface ScrollbackSql {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: Array<unknown>
  ): { toArray(): Array<T> };
}

const TABLE = "t3flare_agent_scrollback";
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  entry TEXT NOT NULL,
  first INTEGER NOT NULL,
  count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (entry, first)
)`;
const FORGOTTEN = "t3flare_agent_forgotten";
const FORGOTTEN_SCHEMA = `CREATE TABLE IF NOT EXISTS ${FORGOTTEN} (entry TEXT PRIMARY KEY)`;

/**
 * How many bytes of lines wait in memory before they go to a row: fewer, larger rows than one a line. Not a limit on
 * what is kept; well within a Durable Object SQLite row's 8 MiB (Cloudflare's "Maximum string, BLOB or table row
 * size"), with the one line that crosses it.
 */
export const FLUSH_BYTES = 64 * 1024;
/**
 * The longest line kept, in UTF-8 bytes. A named constraint: one line beside a full batch must still fit an 8 MiB
 * SQLite row (8,388,608 bytes); 1 MiB is left for the batch and the row's other columns. A terminal row is its columns'
 * cells, so only a cell carrying thousands of combining marks comes near; such a line is cut to a third of this in
 * UTF-16 units, which is within it.
 */
export const MAX_LINE_BYTES = 7 * 1024 * 1024;

/** UTF-8 bytes of `text`, without encoding it. */
export const utf8Bytes = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
};

const cut = (line: string): string => {
  if (utf8Bytes(line) <= MAX_LINE_BYTES) return line;
  let end = Math.floor(MAX_LINE_BYTES / 3);
  if (end > 0 && line.charCodeAt(end - 1) >= 0xd800 && line.charCodeAt(end - 1) <= 0xdbff) end--;
  return line.slice(0, end);
};

/** A stored line's size: its UTF-8 bytes and its newline. */
const sizeOf = (line: string): number => utf8Bytes(line) + 1;

/** One Terminal's scrollback. */
export interface Scrollback {
  /** The absolute index after the last line appended. */
  readonly end: number;
  /** The first line still kept (`end` when none is). */
  readonly first: number;
  /** Bytes kept, stored and waiting. */
  readonly bytes: number;
  /** Appends `text` as line `line`; a line past `end` leaves the ones between missing. */
  append(line: number, text: string): void;
  /** Lines `from` to `to` (exclusive), each null where it is not kept. */
  read(from: number, to: number): Array<string | null>;
  /** Deletes its rows. */
  drop(): void;
}

export interface ScrollbackStore {
  /** A new Terminal's scrollback, under `key` (unique within this object's life). */
  open(key: string): Scrollback;
  /** Entries the exited bound forgot, by key. */
  readonly forgotten: { add(key: string): void; has(key: string): boolean };
  /** Deletes every Terminal's rows and the forgotten keys (the object started: its Terminals ended with the last one). */
  clear(): void;
}

/** `maxBytes`: the most each Terminal keeps (`AGENT_TERMINAL_HISTORY_BYTES`); tests pass less. */
export const scrollbackStore = (
  sql: ScrollbackSql,
  maxBytes: number = AGENT_TERMINAL_HISTORY_BYTES,
): ScrollbackStore => {
  sql.exec(SCHEMA);
  sql.exec(FORGOTTEN_SCHEMA);
  return {
    clear: () => {
      sql.exec(`DELETE FROM ${TABLE}`);
      sql.exec(`DELETE FROM ${FORGOTTEN}`);
    },
    forgotten: {
      add: (key) => void sql.exec(`INSERT OR IGNORE INTO ${FORGOTTEN} (entry) VALUES (?)`, key),
      has: (key) => sql.exec(`SELECT 1 AS one FROM ${FORGOTTEN} WHERE entry = ?`, key).toArray().length > 0,
    },
    open: (key) => {
      let pending: Array<string> = [];
      let pendingFirst = 0;
      let pendingBytes = 0;
      let first = 0;
      let end = 0;
      let stored = 0;

      const flush = () => {
        if (pending.length === 0) return;
        sql.exec(
          `INSERT INTO ${TABLE} (entry, first, count, bytes, text) VALUES (?, ?, ?, ?, ?)`,
          key,
          pendingFirst,
          pending.length,
          pendingBytes,
          pending.join("\n"),
        );
        stored += pendingBytes;
        pending = [];
        pendingBytes = 0;
        trim();
      };

      /** Past `maxBytes`, the oldest lines go: whole rows, then the oldest row's first lines. */
      const trim = () => {
        while (stored > maxBytes) {
          const oldest = sql
            .exec<{ first: number; count: number; bytes: number; text: string }>(
              `SELECT first, count, bytes, text FROM ${TABLE} WHERE entry = ? ORDER BY first LIMIT 1`,
              key,
            )
            .toArray()[0];
          if (oldest === undefined) break;
          sql.exec(`DELETE FROM ${TABLE} WHERE entry = ? AND first = ?`, key, oldest.first);
          if (stored - oldest.bytes >= maxBytes) {
            stored -= oldest.bytes;
            continue;
          }
          const lines = oldest.text.split("\n");
          let bytes = oldest.bytes;
          let from = 0;
          while (stored - (oldest.bytes - bytes) > maxBytes) bytes -= sizeOf(lines[from++]!);
          stored -= oldest.bytes - bytes;
          if (from < lines.length)
            sql.exec(
              `INSERT INTO ${TABLE} (entry, first, count, bytes, text) VALUES (?, ?, ?, ?, ?)`,
              key,
              oldest.first + from,
              lines.length - from,
              bytes,
              lines.slice(from).join("\n"),
            );
        }
        const row = sql
          .exec<{ first: number }>(`SELECT first FROM ${TABLE} WHERE entry = ? ORDER BY first LIMIT 1`, key)
          .toArray()[0];
        first = row?.first ?? (pending.length > 0 ? pendingFirst : end);
      };

      return {
        get end() {
          return end;
        },
        get first() {
          return first;
        },
        get bytes() {
          return stored + pendingBytes;
        },
        append(line, text) {
          if (line < end) return;
          const kept = cut(text);
          const size = sizeOf(kept);
          if (line > end || pendingBytes + size > FLUSH_BYTES) flush();
          if (pending.length === 0) pendingFirst = line;
          if (stored === 0 && pending.length === 0) first = line;
          pending.push(kept);
          pendingBytes += size;
          end = line + 1;
          if (pendingBytes >= FLUSH_BYTES) flush();
        },
        read(from, to) {
          const lines: Array<string | null> = Array.from({ length: Math.max(0, to - from) }, () => null);
          if (to <= from) return lines;
          flush();
          const rows = sql
            .exec<{ first: number; text: string }>(
              `SELECT first, text FROM ${TABLE} WHERE entry = ? AND first < ? AND first + count > ? ORDER BY first`,
              key,
              to,
              from,
            )
            .toArray();
          for (const row of rows) {
            const text = row.text.split("\n");
            for (let index = Math.max(0, from - row.first); index < text.length && row.first + index < to; index++)
              lines[row.first + index - from] = text[index]!;
          }
          return lines;
        },
        drop() {
          pending = [];
          pendingBytes = 0;
          stored = 0;
          first = end;
          sql.exec(`DELETE FROM ${TABLE} WHERE entry = ?`, key);
        },
      };
    },
  };
};
