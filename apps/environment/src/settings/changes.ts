// The Settings server's changes table (plan D8, D16): `t3flare_settings_changes` in the Environment DO's SQLite, one row
// per change, the record as JSON, indexed by caller key and hash. It is the Open change table (M4, SPI-1199): an asked
// change waiting for its answer is a row in state `open` until it closes. A free change made through the server is kept
// as an already-closed row (state `applied`, tier `free`), so the caps count every change from one place.
//
// Kept in storage, not memory: the Environment resets after about 60 s idle (ADR-0003), which can fall between the ask
// and the owner's click. Rows expire and are pruned lazily, on every read and write of the table: an open row past its
// `expiresAt` closes as `expired`, and a closed row goes `keptMs` after it closed (the longest a cap looks back:
// a run of strikes and the lock after its last, or the declined repeat, at the Settings server's limits now). No alarm is added (ADR-0003: one alarm).
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import {
  DEFAULT_OWNER_ANSWER_MS,
  EMPTY_HARNESS,
  type SettingsServerLimits,
  settingsServerLimitsOf,
  withoutQuery,
} from "@t3flare/harness-registry";
import { sha256Hex } from "@t3flare/skills";

import { base64Url } from "../harness/keys.ts";
import { canonicalJson } from "../mcp/canonical.ts";
import type { ChangeEntity, ChangeView, PageReason } from "./types.ts";

export const CHANGES_TABLE = "t3flare_settings_changes";

/**
 * The Settings server's limits at their defaults (SPI-1322): what a table or a check without the stored ones judges by.
 * The limits themselves are its entry's settings (`SETTINGS_SERVER_LIMITS`), read at each request.
 */
export const DEFAULT_LIMITS: SettingsServerLimits = settingsServerLimitsOf(EMPTY_HARNESS);

/** The default run of strikes (`strikes`): this many in a row declined (or, for own agents, unanswered). */
export const STRIKES = DEFAULT_LIMITS.strikes;
/** The default strike window (`strikeWindowMinutes`): the least a run's strikes may span (plan D16). */
export const STRIKE_WINDOW_MS = DEFAULT_LIMITS.strikeWindowMinutes * 60_000;
/** The default strike lock (`strikeLockMinutes`): how long a run refuses asked changes after its last strike. */
export const STRIKE_LOCK_MS = DEFAULT_LIMITS.strikeLockMinutes * 60_000;
/** What a strike run's window has over its expiries' spacing: room for each next ask after an expiry. */
const STRIKE_RUN_SLACK_MS = 5 * 60_000;
/**
 * The least a closed row is kept: the hourly caps' window (`APPLIED_WINDOW_MS`, `OPENED_WINDOW_MS`), whatever the
 * strike and repeat limits are, so a lock of 0 still counts the last hour's changes.
 */
const KEPT_FLOOR_MS = 60 * 60_000;

/**
 * How far apart a run of strikes may fall (SPI-1316), for the longest Answer wait `answerMs` among the run's changes:
 * the strike window, or more when the wait is long. One Open change per thread means its unanswered strikes come at
 * least a wait apart, so a run of expiries spans `strikes - 1` waits; a fixed window would never see one past a
 * 30-minute wait.
 */
export const strikeWindowMs = (answerMs: number, limits: SettingsServerLimits = DEFAULT_LIMITS): number =>
  Math.max(limits.strikeWindowMinutes * 60_000, (limits.strikes - 1) * answerMs + STRIKE_RUN_SLACK_MS);

/**
 * How long a closed row is kept: the longest a check looks back (SPI-1322 review), for the longest Answer wait
 * `answerMs` a run may have. A run of strikes and the lock after it (plan D16), the declined repeat, and the hourly caps'
 * hour, whichever is longest. Two hours at the defaults. A limit lowered prunes sooner, and what was pruned is not
 * recovered when it is raised again.
 */
export const closedKeptMs = (answerMs: number, limits: SettingsServerLimits = DEFAULT_LIMITS): number =>
  Math.max(
    KEPT_FLOOR_MS,
    strikeWindowMs(answerMs, limits) + limits.strikeLockMinutes * 60_000,
    limits.declinedRepeatMinutes * 60_000,
  );

/** The wait a change took when it opened (SPI-1316): its own deadline less its start; none for a free change. */
export const waitOf = (record: Pick<ChangeRecord, "createdAt" | "expiresAt">): number =>
  (record.expiresAt ?? record.createdAt) - record.createdAt;

/** A duration as the texts name it: "10 minutes", "an hour", "2 hours". */
export const durationText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "an hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
};

/** An apply that never closed (the Environment reset while it ran) is closed as failed this long after its expiry. */
export const APPLYING_GRACE_MS = 5 * 60_000;

/** Applied changes of any tier, per caller, per hour (plan D16): the default of `appliedPerHour`. */
export const APPLIED_CAP = DEFAULT_LIMITS.appliedPerHour;
/** Fixed: the hour the per-hour limits name. */
export const APPLIED_WINDOW_MS = 60 * 60_000;

/**
 * Asked changes opened per caller per hour, whatever their outcome (SPI-1195 review): a withdrawn change (a Stop, a
 * cancelled card, a cut stream) neither strikes nor counts as applied, so without this an agent could ask without end.
 */
export const OPENED_CAP = DEFAULT_LIMITS.askedPerHour;
/** Fixed: the hour `askedPerHour` names. */
export const OPENED_WINDOW_MS = 60 * 60_000;

/**
 * Reads of any kind, per caller (`capKeyOf`), per hour (SPI-1198 review: reads are bounded as changes are, D16-style):
 * the default of `readsPerHour`.
 */
export const READ_CAP = DEFAULT_LIMITS.readsPerHour;
/**
 * Reads that reach GitHub or an MCP server, per caller, per hour: they spend a token's or a server's limits. The default
 * of `networkReadsPerHour`.
 */
export const NETWORK_READ_CAP = DEFAULT_LIMITS.networkReadsPerHour;
/** Fixed: the hour the read limits name. */
export const READ_WINDOW_MS = 60 * 60_000;
/** The Settings server's reads that reach GitHub or an MCP server. */
export const NETWORK_READS: ReadonlySet<string> = new Set(["test_mcp_server", "preview_skills", "check_skill_updates"]);

/** The reads table: one row per read through the server, kept an hour, for the read caps. */
export const READS_TABLE = "t3flare_settings_reads";

/**
 * Every http(s) URL inside `text` without its query (plan D14): an error, a listing or a failed apply may quote a Direct
 * server's URL, whose query may hold a key. What a result, a closed change's record and its log line carry.
 */
export const scrubUrls = (text: string): string => text.replace(/https?:\/\/[^\s"'<>`]+/gi, (url) => withoutQuery(url));

/** A change's state (plan D8). `open` and `applying` are open; the rest are closed. */
export type ChangeState = "open" | "applying" | "applied" | "declined" | "withdrawn" | "expired" | "moved" | "failed";

/** An Owner client's Elicitation modes (plan D12): set per client on the Settings page (clients.ts), or `?elicitation_mode=`. */
export const OWNER_MODES = ["browser", "native", "model"] as const;
export type OwnerMode = (typeof OWNER_MODES)[number];

/** How an Open change is answered: on the owner-only card (own agents), or an Owner client's Elicitation mode (M5). */
export type ChangeMode = "card" | OwnerMode;

/** What answered a change (plan D8): the card, the Change page, an Owner client's form (`native`), its agent's `resume` (`model`). */
export type AnsweredBy = "card" | "page" | "client" | "agent";

/** What answered or closed a change: an answerer, or `stop` (the caller's Stop, turn end or going away, plan D9). */
export type ClosedBy = AnsweredBy | "stop";

/** Who asked, as a change records it (plan D8's `caller`). */
export interface ChangeCaller {
  readonly door: "own" | "owner";
  /** The cap's key: the thread id for an own agent, the Access `sub` for an Owner client. */
  readonly key: string;
  readonly principal: "agent" | "owner" | "service-token";
  readonly thread?: string;
  readonly agent?: string;
  /** An Owner client's own label, unverified. */
  readonly client?: { readonly name: string; readonly source: string };
}

/** A change as the table keeps it: an Open change (tier `asked`), or a free change already applied. */
export interface ChangeRecord {
  readonly id: string;
  /** Whose revision: a settings entity's, or the Workspaces' (a Purge, always 0, ADR-0044 §5). */
  readonly entity: ChangeEntity;
  readonly expectedRevision?: number;
  /** The write tool's name. */
  readonly tool: string;
  /** The call's arguments, canonical JSON (never a secret: none is ever in them). */
  readonly args: unknown;
  /** SHA-256 of the tool and its canonical arguments without `expectedRevision`. */
  readonly hash: string;
  readonly tier: "free" | "asked";
  /** What the card and the Change page render (an asked change's). */
  readonly shown?: ChangeView;
  readonly needsPage?: PageReason;
  readonly mode?: ChangeMode;
  readonly caller: ChangeCaller;
  readonly createdAt: number;
  /** When an open change expires; a free row's is its creation. */
  readonly expiresAt?: number;
  readonly state: ChangeState;
  /** `cut`: a `native` stream the client ended unanswered withdrew it (plan D12). */
  readonly closed?: {
    readonly at: number;
    readonly by?: ClosedBy;
    readonly revision?: number;
    readonly error?: string;
    readonly cut?: true;
  };
}

export const isOpen = (record: Pick<ChangeRecord, "state">): boolean =>
  record.state === "open" || record.state === "applying";

/**
 * The key a caller's caps, open changes and reads are counted under (plan D16): its door and its own key, so a thread id
 * that happens to equal an Access `sub` is another caller (SPI-1201 review). Every `key` of `SettingsChanges` is one.
 */
export const capKeyOf = (door: ChangeCaller["door"], key: string): string => `${door}:${key}`;

export interface SettingsChanges {
  /** Applied changes by `key` since `since`, of any tier. */
  appliedSince(key: string, since: number): number;
  /** Asked changes `key` opened since `since`, in any state now. */
  openedSince(key: string, since: number): number;
  /** Keeps a free change made through the server, already closed. */
  recordApplied(record: ChangeRecord): void;
  /** Keeps a new Open change. */
  insert(record: ChangeRecord): void;
  /** A change by id (expired first when its time is up), or undefined when unknown or pruned. */
  get(id: string): ChangeRecord | undefined;
  /** Every open change, oldest first. */
  open(): ReadonlyArray<ChangeRecord>;
  /** The open changes of `key`, oldest first. */
  openBy(key: string): ReadonlyArray<ChangeRecord>;
  /** The closed asked changes of `key` that closed since `since`, newest first. */
  closedBy(key: string, since: number): ReadonlyArray<ChangeRecord>;
  /**
   * Replaces `id`'s record with `next` when its state is still one of `from`, in one synchronous block; answers whether
   * it did. Only this moves a change's state, so a second answer finds it already moved (plan D8: one answer).
   */
  replace(id: string, from: ReadonlyArray<ChangeState>, next: ChangeRecord): boolean;
  /** Counts one read by `key` (`network`: one that reaches GitHub or an MCP server; it counts as a read too). */
  noteRead(key: string, kind: "read" | "network", at: number): void;
  /** Reads by `key` since `since`: every read for `read`, those that reach the network for `network`. */
  readsSince(key: string, kind: "read" | "network", since: number): number;
  /** The Answer wait now (SPI-1316), in ms. */
  answerMs(): number;
  /** The Settings server's limits now (SPI-1322), as stored. */
  limits(): SettingsServerLimits;
  /**
   * How long a closed row is kept (SPI-1316): `closedKeptMs` of the limits now and the longest wait a run may have, the
   * wait now or the longest any kept change took (a CLI agent's change takes the wait its process was spawned with).
   */
  keptMs(): number;
}

/**
 * A change's hash (plan D8): SHA-256 of the tool and its change, canonical, without `expectedRevision`. The Settings
 * server passes the change as its planner normalized it (only the fields the change takes, SPI-1199 review), never the
 * raw arguments, so an extra key cannot make a declined change look new.
 */
export const changeHash = async (tool: string, args: Readonly<Record<string, unknown>>): Promise<string> => {
  const { expectedRevision: _expected, ...rest } = args;
  return sha256Hex(canonicalJson({ tool, args: rest }));
};

/** A change's id (plan D8): `chg_` and 32 random bytes, base64url. */
export const newChangeId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `chg_${base64Url(bytes)}`;
};

/** A well-formed change id, so a page path or a `resume` cannot name anything else. */
export const isChangeId = (id: string): boolean => /^chg_[A-Za-z0-9_-]{43}$/.test(id);

const parse = (text: unknown): ChangeRecord | undefined => {
  try {
    return typeof text === "string" ? (JSON.parse(text) as ChangeRecord) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The one log line of a closed change (plan D15): `settings-change` when it applied or expired (a change's own end),
 * `settings-refused` when it was declined, withdrawn, moved or failed. Never a value.
 */
export const closedLine = (record: ChangeRecord): Record<string, unknown> => ({
  t3flare: record.state === "applied" || record.state === "expired" ? "settings-change" : "settings-refused",
  via: "mcp",
  door: record.caller.door,
  tool: record.tool,
  change: record.id,
  tier: record.tier,
  mode: record.mode ?? null,
  outcome: record.state,
  answeredBy: record.closed?.by ?? null,
  ...(record.closed?.revision === undefined ? {} : { revision: record.closed.revision }),
  ...(record.closed?.error === undefined ? {} : { error: scrubUrls(record.closed.error) }),
  ...(record.closed?.cut === true ? { cut: true } : {}),
});

/**
 * The table over `sql`. `log` gets the line of each change the table itself closes (an expiry, or an apply the
 * Environment's restart cut off), since no answerer is there to write it. `answerMs` is the Answer wait now (SPI-1316),
 * and `limits` the Settings server's limits now (SPI-1322), both of which a closed row's keeping covers (`keptMs`).
 */
export const settingsChanges = (
  sql: Pick<SqlStorage, "exec">,
  now: () => number = Date.now,
  log?: (event: Record<string, unknown>) => void,
  answerMs: () => number = () => DEFAULT_OWNER_ANSWER_MS,
  limits: () => SettingsServerLimits = () => DEFAULT_LIMITS,
): SettingsChanges => {
  let ready = false;
  const write = (record: ChangeRecord) =>
    sql.exec(
      `INSERT OR REPLACE INTO ${CHANGES_TABLE} (id, caller_key, hash, state, created_at, closed_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      capKeyOf(record.caller.door, record.caller.key),
      record.hash,
      record.state,
      record.createdAt,
      record.closed?.at ?? null,
      JSON.stringify(record),
    );
  const rows = (where: string, ...params: Array<unknown>): Array<ChangeRecord> =>
    sql
      .exec<{ record: string }>(`SELECT record FROM ${CHANGES_TABLE} WHERE ${where}`, ...params)
      .toArray()
      .flatMap((row) => {
        const record = parse(row.record);
        return record === undefined ? [] : [record];
      });
  /** The longest wait a kept change took, or the wait now, whichever is longer (SPI-1316). */
  const longestWait = (): number => {
    const row = sql
      .exec<{ longest: number | null }>(
        // A malformed row is skipped, as `parse` skips it: `json_extract` would throw on it and break every read.
        `SELECT MAX(json_extract(record, '$.expiresAt') - created_at) AS longest FROM ${CHANGES_TABLE} WHERE json_valid(record)`,
      )
      .toArray()[0];
    return Math.max(answerMs(), Number(row?.longest ?? 0));
  };
  const keptMs = (): number => closedKeptMs(longestWait(), limits());
  /** Creates the table once, closes what has expired, and prunes what closed over `keptMs` ago. */
  const prepare = () => {
    if (!ready) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${CHANGES_TABLE} (id TEXT PRIMARY KEY, caller_key TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER, record TEXT NOT NULL)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_caller ON ${CHANGES_TABLE} (caller_key, state, closed_at)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${CHANGES_TABLE}_hash ON ${CHANGES_TABLE} (hash)`);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${READS_TABLE} (caller_key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS ${READS_TABLE}_caller ON ${READS_TABLE} (caller_key, at)`);
      ready = true;
    }
    const at = now();
    // At most the Environment-wide cap of open rows (plan D16), so reading them all is cheap.
    for (const record of rows(`state IN ('open', 'applying')`)) {
      const expiresAt = record.expiresAt ?? record.createdAt;
      const closed: ChangeRecord | undefined =
        record.state === "open" && expiresAt <= at
          ? { ...record, state: "expired", closed: { at: expiresAt } }
          : record.state === "applying" && expiresAt + APPLYING_GRACE_MS <= at
            ? {
                ...record,
                state: "failed",
                closed: {
                  at,
                  error: "the Environment restarted while the change applied; read the settings to see whether it did",
                },
              }
            : undefined;
      if (closed === undefined) continue;
      write(closed);
      log?.(closedLine(closed));
    }
    sql.exec(`DELETE FROM ${CHANGES_TABLE} WHERE closed_at IS NOT NULL AND closed_at < ?`, at - keptMs());
    sql.exec(`DELETE FROM ${READS_TABLE} WHERE at < ?`, at - READ_WINDOW_MS);
  };
  return {
    appliedSince: (key, since) => {
      prepare();
      const row = sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${CHANGES_TABLE} WHERE caller_key = ? AND state = 'applied' AND closed_at >= ?`,
          key,
          since,
        )
        .toArray()[0];
      return Number(row?.count ?? 0);
    },
    openedSince: (key, since) => {
      prepare();
      // Closed rows are kept an hour at least (`closedKeptMs`), as long as any window this is asked about.
      return rows(`caller_key = ? AND created_at >= ?`, key, since).filter((record) => record.tier === "asked").length;
    },
    recordApplied: (record) => {
      prepare();
      write(record);
    },
    insert: (record) => {
      prepare();
      write(record);
    },
    get: (id) => {
      prepare();
      return rows(`id = ?`, id)[0];
    },
    open: () => {
      prepare();
      return rows(`state IN ('open', 'applying') ORDER BY created_at, id`);
    },
    openBy: (key) => {
      prepare();
      return rows(`caller_key = ? AND state IN ('open', 'applying') ORDER BY created_at, id`, key);
    },
    closedBy: (key, since) => {
      prepare();
      return rows(
        `caller_key = ? AND closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at DESC, created_at DESC`,
        key,
        since,
      ).filter((record) => record.tier === "asked");
    },
    noteRead: (key, kind, at) => {
      prepare();
      sql.exec(`INSERT INTO ${READS_TABLE} (caller_key, kind, at) VALUES (?, ?, ?)`, key, kind, at);
    },
    answerMs,
    limits,
    keptMs: () => {
      prepare();
      return keptMs();
    },
    readsSince: (key, kind, since) => {
      prepare();
      const row = sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${READS_TABLE} WHERE caller_key = ? AND at >= ?${kind === "network" ? " AND kind = 'network'" : ""}`,
          key,
          since,
        )
        .toArray()[0];
      return Number(row?.count ?? 0);
    },
    replace: (id, from, next) => {
      prepare();
      const current = rows(`id = ?`, id)[0];
      if (current === undefined || !from.includes(current.state)) return false;
      write(next);
      return true;
    },
  };
};
