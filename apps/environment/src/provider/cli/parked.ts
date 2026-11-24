// A CLI agent's parked cards (SPI-1389): when a card has waited Park after (`parkAfterMinutes`) on a live turn, the CLI
// wrapper parks the turn. The card stays up as a non-blocking question, its record is kept here, and the process ends so
// the Container can stop. The Owner's answer comes back as t3's `async-answer:<request id>` message, which starts a new
// turn. An allow leaves a one-time allowance for the call it asked about, keyed by the tool and its arguments' hash, so
// the repeated call runs without a second card.
//
// Kept in the Environment DO's SQLite, not memory: the answer can come days later, after the Environment reset (ADR-0003).
// A record goes when it is answered; an allowance when it is taken, or when the answer turn ends without the call.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { sha256Hex } from "@t3flare/skills";

import { canonicalJson } from "../../mcp/canonical.ts";

export const PARKED_TABLE = "t3flare_parked_cards";
export const ALLOWANCES_TABLE = "t3flare_park_allowances";

/**
 * What a parked card asked about:
 * - `tool`: the MCP relay's tool card (`tool` is `server/upstream`);
 * - `native`: the CLI's own approval request (`tool` is the request's kind);
 * - `question`: an MCP server's question (`tool` is the server);
 * - `change`: the Settings server's card for an Open change (`changeId`), which stays open on its Change page.
 */
export type ParkedKind = "tool" | "native" | "question" | "change";

export interface ParkedCard {
  /** The park question's runtime request id: t3's answer message is `async-answer:<id>`. */
  readonly id: string;
  /** t3's thread the card was raised on. */
  readonly thread: string;
  readonly kind: ParkedKind;
  readonly tool: string;
  /** The SHA-256 of the call's arguments as canonical JSON (`argsHashOf`); of the request's text for a native one. */
  readonly argsHash: string;
  /** The card's title, as the answer turn names it to the agent. */
  readonly title: string;
  readonly changeId?: string;
  readonly parkedAt: number;
}

export type ParkedDecision = "accept" | "acceptForSession" | "decline";

export interface ParkedCards {
  park(card: ParkedCard): void;
  get(id: string): ParkedCard | undefined;
  /** The Owner's answer: the record goes, and an allow leaves one allowance for its call. Undefined if none is parked. */
  answer(id: string, decision: ParkedDecision): ParkedCard | undefined;
  /** Takes the allowance for one call on `thread`, once: its "for the session" flag, or undefined when none matches. */
  take(
    thread: string,
    kind: "tool" | "native",
    tool: string,
    argsHash: string,
  ): { readonly forSession: boolean } | undefined;
  /** Drops `thread`'s allowances its answer turn did not use. */
  dropAllowances(thread: string): void;
  /** The threads with a parked card. */
  threads(): ReadonlyArray<string>;
}

/** The hash a call's arguments are matched by: SHA-256 over their canonical JSON, so key order does not matter. */
export const argsHashOf = (args: unknown): Promise<string> => sha256Hex(canonicalJson(args));

const parse = (text: string): ParkedCard | undefined => {
  try {
    return JSON.parse(text) as ParkedCard;
  } catch {
    return undefined;
  }
};

export const parkedCards = (sql: Pick<SqlStorage, "exec">): ParkedCards => {
  let ready = false;
  const prepare = () => {
    if (ready) return;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${PARKED_TABLE} (id TEXT PRIMARY KEY, thread TEXT NOT NULL, parked_at INTEGER NOT NULL, record TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ALLOWANCES_TABLE} (thread TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT NOT NULL, args_hash TEXT NOT NULL, for_session INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS ${ALLOWANCES_TABLE}_call ON ${ALLOWANCES_TABLE} (thread, kind, tool, args_hash)`,
    );
    ready = true;
  };
  const get = (id: string): ParkedCard | undefined => {
    prepare();
    const row = sql.exec<{ record: string }>(`SELECT record FROM ${PARKED_TABLE} WHERE id = ?`, id).toArray()[0];
    return row === undefined ? undefined : parse(row.record);
  };
  return {
    park: (card) => {
      prepare();
      sql.exec(
        `INSERT OR REPLACE INTO ${PARKED_TABLE} (id, thread, parked_at, record) VALUES (?, ?, ?, ?)`,
        card.id,
        card.thread,
        card.parkedAt,
        JSON.stringify(card),
      );
    },
    get,
    answer: (id, decision) => {
      const card = get(id);
      if (card === undefined) return undefined;
      sql.exec(`DELETE FROM ${PARKED_TABLE} WHERE id = ?`, id);
      if (decision !== "decline" && (card.kind === "tool" || card.kind === "native"))
        sql.exec(
          `INSERT INTO ${ALLOWANCES_TABLE} (thread, kind, tool, args_hash, for_session) VALUES (?, ?, ?, ?, ?)`,
          card.thread,
          card.kind,
          card.tool,
          card.argsHash,
          decision === "acceptForSession" ? 1 : 0,
        );
      return card;
    },
    take: (thread, kind, tool, argsHash) => {
      prepare();
      const row = sql
        .exec<{ rowid: number; for_session: number }>(
          `SELECT rowid, for_session FROM ${ALLOWANCES_TABLE} WHERE thread = ? AND kind = ? AND tool = ? AND args_hash = ? LIMIT 1`,
          thread,
          kind,
          tool,
          argsHash,
        )
        .toArray()[0];
      if (row === undefined) return undefined;
      sql.exec(`DELETE FROM ${ALLOWANCES_TABLE} WHERE rowid = ?`, row.rowid);
      return { forSession: row.for_session === 1 };
    },
    dropAllowances: (thread) => {
      prepare();
      sql.exec(`DELETE FROM ${ALLOWANCES_TABLE} WHERE thread = ?`, thread);
    },
    threads: () => {
      prepare();
      return sql
        .exec<{ thread: string }>(`SELECT DISTINCT thread FROM ${PARKED_TABLE} ORDER BY thread`)
        .toArray()
        .map((row) => row.thread);
    },
  };
};
