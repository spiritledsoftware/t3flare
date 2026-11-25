// A CLI agent's parked cards (SPI-1389): when a card has waited Park after (`parkAfterMinutes`) on a live turn, the CLI
// wrapper parks the turn (`park.ts`). The card stays up as a non-blocking question, its record is kept here, and the
// process ends so the Container can stop. The Owner's answer comes back as t3's `async-answer:<request id>` message,
// which starts a new turn. An allow leaves a one-time allowance for the call it asked about, keyed by the tool and its
// arguments' hash, so the repeated call runs without a second card.
//
// Kept in the Environment DO's SQLite, not memory: the answer can come days later, after the Environment reset (ADR-0003).
// A record goes when it is answered, or, for a change card, when its Open change closed elsewhere and its question is
// dismissed or gone (`parkedChanges.ts`); an allowance when it is taken, when its answer turn ends without the call, or when
// the Environment boots (its answer turn's process is gone with the old instance).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";

export const PARKED_TABLE = "t3flare_parked_cards";
export const ALLOWANCES_TABLE = "t3flare_park_allowances";

/**
 * What a parked card asked about:
 * - `tool`: the MCP relay's tool card;
 * - `native`: the CLI's own approval request;
 * - `question`: an MCP server's question;
 * - `change`: the Settings server's card for an Open change, which stays open on its Change page.
 */
export type ParkedKind = "tool" | "native" | "question" | "change";

/**
 * One call as a park keeps it and an allowance matches it: its tool (`server/upstream` for the relay's, the request's
 * kind for the CLI's own) and the SHA-256 of its whole arguments as canonical JSON (`argsHashOf`).
 */
export interface ParkedCall {
  readonly tool: string;
  readonly argsHash: string;
}

export interface ParkedCard {
  /** The park question's runtime request id: t3's answer message is `async-answer:<id>`. */
  readonly id: string;
  /** t3's thread the card was raised on. */
  readonly thread: string;
  readonly kind: ParkedKind;
  /** The card's title, as the answer turn names it to the agent. */
  readonly title: string;
  /**
   * The call an allow lets run once: a tool card's always; a CLI request's when its whole call was read off the process
   * (`nativeCalls.ts`); else none, and the repeat asks again.
   */
  readonly call?: ParkedCall;
  /** A question's MCP server. */
  readonly server?: string;
  /** A change card's Open change. */
  readonly changeId?: string;
  /** The CLI's own session id for the thread (its native thread id): kept from session pruning while parked. */
  readonly nativeSession?: string;
  readonly parkedAt: number;
}

export type ParkedDecision = "accept" | "acceptForSession" | "decline";

export interface ParkedCards {
  park(card: ParkedCard): void;
  /** Keeps every card or, when a write fails, none (one transaction); throws then. */
  parkAll(cards: ReadonlyArray<ParkedCard>): void;
  /** Removes a card that was never shown (its park was abandoned). */
  discard(id: string): void;
  /** The change cards parked on Open change `changeId`, or on any Open change when it is omitted (SPI-1404). */
  changeCards(changeId?: string): ReadonlyArray<ParkedCard>;
  /** Removes a change card whose Open change closed elsewhere and whose question is dealt with (SPI-1404). */
  drop(id: string): void;
  get(id: string): ParkedCard | undefined;
  /** The Owner's answer: the record goes, and an allow leaves one allowance for its call. Undefined if none is parked. */
  answer(id: string, decision: ParkedDecision): ParkedCard | undefined;
  /** Takes the allowance for `call` of `kind` on `thread`, once: its "for the session" flag, or undefined when none matches. */
  take(thread: string, kind: "tool" | "native", call: ParkedCall): { readonly forSession: boolean } | undefined;
  /** Drops `thread`'s allowances its answer turn did not use. */
  dropAllowances(thread: string): void;
  /** Drops every thread's allowances: at the Environment's boot, when no answer turn of the old instance runs on. */
  dropAllAllowances(): void;
  /** The CLI sessions parked cards wait on, which session pruning keeps. */
  nativeSessions(): ReadonlyArray<string>;
}

const parse = (text: string): ParkedCard | undefined => {
  try {
    return JSON.parse(text) as ParkedCard;
  } catch {
    return undefined;
  }
};

/**
 * The store over `sql`. `transaction` runs a function as one SQLite transaction (the Environment DO's
 * `ctx.storage.transactionSync`), which `parkAll` writes in.
 */
export const parkedCards = (sql: Pick<SqlStorage, "exec">, transaction: <T>(run: () => T) => T): ParkedCards => {
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
  const remove = (id: string) => {
    prepare();
    sql.exec(`DELETE FROM ${PARKED_TABLE} WHERE id = ?`, id);
  };
  const park = (card: ParkedCard) => {
    prepare();
    sql.exec(
      `INSERT OR REPLACE INTO ${PARKED_TABLE} (id, thread, parked_at, record) VALUES (?, ?, ?, ?)`,
      card.id,
      card.thread,
      card.parkedAt,
      JSON.stringify(card),
    );
  };
  return {
    park,
    parkAll: (cards) => {
      prepare();
      transaction(() => {
        for (const card of cards) park(card);
      });
    },
    discard: remove,
    changeCards: (changeId) => {
      prepare();
      const kind = `json_valid(record) AND json_extract(record, '$.kind') = 'change'`;
      return (
        changeId === undefined
          ? sql.exec<{ record: string }>(`SELECT record FROM ${PARKED_TABLE} WHERE ${kind}`)
          : sql.exec<{ record: string }>(
              `SELECT record FROM ${PARKED_TABLE} WHERE ${kind} AND json_extract(record, '$.changeId') = ?`,
              changeId,
            )
      )
        .toArray()
        .flatMap((row) => {
          const card = parse(row.record);
          return card === undefined ? [] : [card];
        });
    },
    drop: remove,
    get,
    answer: (id, decision) => {
      const card = get(id);
      if (card === undefined) return undefined;
      remove(id);
      if (decision !== "decline" && card.call !== undefined && (card.kind === "tool" || card.kind === "native"))
        sql.exec(
          `INSERT INTO ${ALLOWANCES_TABLE} (thread, kind, tool, args_hash, for_session) VALUES (?, ?, ?, ?, ?)`,
          card.thread,
          card.kind,
          card.call.tool,
          card.call.argsHash,
          decision === "acceptForSession" ? 1 : 0,
        );
      return card;
    },
    take: (thread, kind, call) => {
      prepare();
      const row = sql
        .exec<{ rowid: number; for_session: number }>(
          `SELECT rowid, for_session FROM ${ALLOWANCES_TABLE} WHERE thread = ? AND kind = ? AND tool = ? AND args_hash = ? LIMIT 1`,
          thread,
          kind,
          call.tool,
          call.argsHash,
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
    dropAllAllowances: () => {
      prepare();
      sql.exec(`DELETE FROM ${ALLOWANCES_TABLE}`);
    },
    nativeSessions: () => {
      prepare();
      return sql
        .exec<{ session: string | null }>(
          `SELECT DISTINCT json_extract(record, '$.nativeSession') AS session FROM ${PARKED_TABLE} WHERE json_valid(record)`,
        )
        .toArray()
        .flatMap((row) => (typeof row.session === "string" ? [row.session] : []));
    },
  };
};
