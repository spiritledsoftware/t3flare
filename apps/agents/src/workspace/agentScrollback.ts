// The agent's Terminals' scrollback (SPI-1397), kept in the Workspace DO's SQLite instead of each headless xterm: a line
// that scrolls off a Terminal's screen is appended here, and reads of what scrolled off come from here. The Workspace
// DO's memory holds each running Terminal's screen and at most `FLUSH_BYTES` of lines on their way to a row, whatever
// the scrollback's length; an exited one's final screen is kept here too, and its xterm is let go.
//
// - Lines are numbered as the Terminal numbers them: the absolute index of a line in its output.
// - Each Terminal keeps its last `AGENT_TERMINAL_HISTORY_BYTES` (stock t3's Terminal history, 8 MiB); older lines are
//   dropped, oldest first, and a read of them finds them missing.
// - A Terminal's rows are deleted when it is forgotten, and every row when the Workspace DO starts: its Terminals end
//   with the object.
// - The entries the Workspace's exited bound forgot are kept here too, by key, so an agent naming one is told why: the
//   newest `AGENT_EXITED_TERMINALS_KEPT` of them. One whose exit its owner had not seen is kept until its owner's next
//   exit notice reports it once (then deleted), or its next wait (then kept as a key, for the read that follows).
import { AGENT_EXITED_TERMINALS_KEPT, AGENT_TERMINAL_HISTORY_BYTES } from "@t3flare/harness-registry";

/** The part of `SqlStorage` this uses. */
export interface ScrollbackSql {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: Array<unknown>
  ): { toArray(): Array<T> };
}

const LINES = "t3flare_agent_scrollback";
const SCREENS = "t3flare_agent_screens";
const FORGOTTEN = "t3flare_agent_forgotten";
const SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS ${LINES} (
  entry TEXT NOT NULL,
  first INTEGER NOT NULL,
  count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (entry, first)
)`,
  `CREATE TABLE IF NOT EXISTS ${SCREENS} (entry TEXT PRIMARY KEY, screen TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${FORGOTTEN} (
  entry TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  unseen TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ${FORGOTTEN}_owner ON ${FORGOTTEN} (owner)`,
];

/**
 * How many bytes of lines wait in memory before they go to a row: fewer, larger rows than one a line. Provisional, not
 * a limit on what is kept. A line that would take a batch past it goes to the next row, so a row holds at most this, or
 * one longer line alone: well within a Durable Object SQLite row's 8 MB (Cloudflare's "Maximum string, BLOB or table row
 * size").
 */
export const FLUSH_BYTES = 64 * 1024;
/**
 * The longest line kept, in UTF-8 bytes. A named constraint: a line longer than `FLUSH_BYTES` sits alone in its row,
 * which must fit an 8 MB (8,000,000-byte) SQLite row; this leaves about 660 KB for the row's other columns. A terminal
 * row is its columns' cells, so only a cell carrying thousands of combining marks comes near; such a line is cut to a
 * third of this in UTF-16 units, which is within it.
 */
export const MAX_LINE_BYTES = 7 * 1024 * 1024;

const encoder = new TextEncoder();
/** A stored line's size: its UTF-8 bytes and its newline. */
const sizeOf = (line: string): number => encoder.encode(line).byteLength + 1;

const cut = (line: string): string => {
  // A UTF-16 unit is at most 3 UTF-8 bytes: only a line that long can be over.
  if (line.length * 3 <= MAX_LINE_BYTES || sizeOf(line) - 1 <= MAX_LINE_BYTES) return line;
  let end = Math.floor(MAX_LINE_BYTES / 3);
  if (line.charCodeAt(end - 1) >= 0xd800 && line.charCodeAt(end - 1) <= 0xdbff) end--;
  return line.slice(0, end);
};

/** The last lines `readBack` found: the absolute index of the first, and whether blank lines alone ran out its budget. */
export interface ReadBack {
  readonly from: number;
  readonly lines: ReadonlyArray<string>;
  /** Trailing blank lines left out (`skipBlank`); with no `lines`, the budget ended among them. */
  readonly blank: number;
}

/** One Terminal's scrollback. */
export interface Scrollback {
  /** The absolute index after the last line appended. */
  readonly end: number;
  /** The first line still kept (`end` when none is). */
  readonly first: number;
  /** Appends `text` as line `line`; a line past `end` leaves the ones between missing. */
  append(line: number, text: string): void;
  /** Lines `from` to `to` (exclusive), each null where it is not kept. */
  read(from: number, to: number): Array<string | null>;
  /**
   * The newest kept lines before `end`, up to `lines` of them and about `bytes` (whole rows, newest first, so at most a
   * row more), every line read counting, blank or not. `skipBlank`: trailing blank lines are left out, and counted.
   */
  readBack(limits: { readonly lines: number; readonly bytes: number }, skipBlank: boolean): ReadBack;
  /** Keeps the Terminal's final screen (its xterm is let go). */
  keepScreen(screen: string): void;
  /** The final screen `keepScreen` kept; "" before. */
  screen(): string;
  /** Deletes its rows. */
  drop(): void;
}

/** `U`: what the exited bound keeps of an entry whose exit its owner had not seen, to report it once (JSON). */
export interface ScrollbackStore<U> {
  /** A new Terminal's scrollback, under `key` (unique within this object's life). */
  open(key: string): Scrollback;
  /** Entries the exited bound forgot, by key; `unseen`: one whose exit its owner had not seen, to report once. */
  readonly forgotten: {
    add(key: string, owner: string, unseen: U | null): void;
    has(key: string): boolean;
    /**
     * `owner`'s forgotten unseen exits that `take` accepts, oldest first, each answered once. `keepKey`: its key stays,
     * so a read of it that follows (a wait's) is answered with the bound; else it is deleted (an exit notice names the
     * bound itself).
     */
    takeUnseen(owner: string, take: (unseen: U) => boolean, keepKey: boolean): Array<U>;
  };
  /** Deletes every Terminal's rows and the forgotten keys (the object started: its Terminals ended with the last one). */
  clear(): void;
}

/** `maxBytes`: the most each Terminal keeps (`AGENT_TERMINAL_HISTORY_BYTES`); tests pass less. */
export const scrollbackStore = <U>(
  sql: ScrollbackSql,
  maxBytes: number = AGENT_TERMINAL_HISTORY_BYTES,
): ScrollbackStore<U> => {
  for (const schema of SCHEMAS) sql.exec(schema);
  return {
    clear: () => {
      for (const table of [LINES, SCREENS, FORGOTTEN]) sql.exec(`DELETE FROM ${table}`);
    },
    forgotten: {
      add: (key, owner, unseen) => {
        sql.exec(
          `INSERT OR REPLACE INTO ${FORGOTTEN} (entry, owner, unseen) VALUES (?, ?, ?)`,
          key,
          owner,
          unseen === null ? null : JSON.stringify(unseen),
        );
        // Keys only (no unseen exit to report): the newest that many, as many as the bound keeps exited entries.
        sql.exec(
          `DELETE FROM ${FORGOTTEN} WHERE unseen IS NULL AND rowid NOT IN
            (SELECT rowid FROM ${FORGOTTEN} WHERE unseen IS NULL ORDER BY rowid DESC LIMIT ?)`,
          AGENT_EXITED_TERMINALS_KEPT,
        );
      },
      has: (key) => sql.exec(`SELECT 1 AS one FROM ${FORGOTTEN} WHERE entry = ?`, key).toArray().length > 0,
      takeUnseen: (owner, take, keepKey) => {
        const taken = sql
          .exec<{ entry: string; unseen: string }>(
            `SELECT entry, unseen FROM ${FORGOTTEN} WHERE owner = ? AND unseen IS NOT NULL ORDER BY rowid`,
            owner,
          )
          .toArray()
          .map((row) => ({ entry: row.entry, unseen: JSON.parse(row.unseen) as U }))
          .filter((row) => take(row.unseen));
        for (const row of taken)
          sql.exec(
            keepKey
              ? `UPDATE ${FORGOTTEN} SET unseen = NULL WHERE entry = ?`
              : `DELETE FROM ${FORGOTTEN} WHERE entry = ?`,
            row.entry,
          );
        return taken.map((row) => row.unseen);
      },
    },
    open: (key) => {
      let pending: Array<string> = [];
      let pendingFirst = 0;
      let pendingBytes = 0;
      let first = 0;
      let end = 0;
      let stored = 0;

      const insert = (from: number, lines: ReadonlyArray<string>, bytes: number) =>
        sql.exec(
          `INSERT INTO ${LINES} (entry, first, count, bytes, text) VALUES (?, ?, ?, ?, ?)`,
          key,
          from,
          lines.length,
          bytes,
          lines.join("\n"),
        );

      const flush = () => {
        if (pending.length === 0) return;
        insert(pendingFirst, pending, pendingBytes);
        stored += pendingBytes;
        pending = [];
        pendingBytes = 0;
        trim();
      };

      /** Past `maxBytes`, the oldest lines go: whole rows, then the oldest row's first lines. */
      const trim = () => {
        while (stored > maxBytes) {
          const oldest = sql
            .exec<{ first: number; bytes: number; text: string }>(
              `SELECT first, bytes, text FROM ${LINES} WHERE entry = ? ORDER BY first LIMIT 1`,
              key,
            )
            .toArray()[0];
          if (oldest === undefined) break;
          sql.exec(`DELETE FROM ${LINES} WHERE entry = ? AND first = ?`, key, oldest.first);
          if (stored - oldest.bytes >= maxBytes) {
            stored -= oldest.bytes;
            continue;
          }
          const lines = oldest.text.split("\n");
          let bytes = oldest.bytes;
          let from = 0;
          while (stored - (oldest.bytes - bytes) > maxBytes) bytes -= sizeOf(lines[from++]!);
          stored -= oldest.bytes - bytes;
          if (from < lines.length) insert(oldest.first + from, lines.slice(from), bytes);
        }
        const row = sql
          .exec<{ first: number }>(`SELECT first FROM ${LINES} WHERE entry = ? ORDER BY first LIMIT 1`, key)
          .toArray()[0];
        first = row?.first ?? end;
      };

      return {
        get end() {
          return end;
        },
        get first() {
          return first;
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
              `SELECT first, text FROM ${LINES} WHERE entry = ? AND first < ? AND first + count > ? ORDER BY first`,
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
        readBack(limits, skipBlank) {
          flush();
          let lines: Array<string> = [];
          let from = end;
          let blank = 0;
          let read = 0;
          let readBytes = 0;
          let skipping = skipBlank;
          while (read < limits.lines && readBytes < limits.bytes) {
            // One row at a time, newest first: a read holds at most the budget and one row.
            const row = sql
              .exec<{ first: number; bytes: number; text: string }>(
                `SELECT first, bytes, text FROM ${LINES} WHERE entry = ? AND first < ? ORDER BY first DESC LIMIT 1`,
                key,
                from,
              )
              .toArray()[0];
            if (row === undefined) break;
            const text = row.text.split("\n");
            const room = limits.lines - read;
            const taken = text.slice(Math.max(0, text.length - room));
            read += taken.length;
            readBytes += row.bytes;
            from = row.first + text.length - taken.length;
            if (skipping) {
              let last = taken.length;
              while (last > 0 && taken[last - 1] === "") last--;
              blank += taken.length - last;
              if (last === 0) continue;
              skipping = false;
              lines = taken.slice(0, last);
            } else lines = [...taken, ...lines];
          }
          return { from, lines, blank };
        },
        keepScreen(screen) {
          sql.exec(`INSERT OR REPLACE INTO ${SCREENS} (entry, screen) VALUES (?, ?)`, key, screen);
        },
        screen() {
          return (
            sql.exec<{ screen: string }>(`SELECT screen FROM ${SCREENS} WHERE entry = ?`, key).toArray()[0]?.screen ??
            ""
          );
        },
        drop() {
          pending = [];
          pendingBytes = 0;
          stored = 0;
          first = end;
          sql.exec(`DELETE FROM ${LINES} WHERE entry = ?`, key);
          sql.exec(`DELETE FROM ${SCREENS} WHERE entry = ?`, key);
        },
      };
    },
  };
};
