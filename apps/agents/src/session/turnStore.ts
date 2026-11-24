// SPI-1373: the Session's turns, one KV key per turn (`t3flare:turn:<id>`) and one per turn's model record
// (`t3flare:turn-model:<id>`), with an index of the live turns' ids. A change to a turn reads and writes the turns it
// names and the index, so it costs O(live turns) however long the thread runs; before, one value held every turn and
// every change rewrote it, until a long thread passed the value limit and the Session stopped recording turns.
//
// Finished turns stay: a rollback and a fork find their entries by them (`branches.ts`), and a push or a snapshot finds
// which turn each entry it carries belongs to by them. Those reads list every turn, O(all turns): a push lists them each
// time, though it sends only the live turns and those settled since the last push, and a snapshot only the turns the
// adapter asks about (SPI-1377, `pushTurns.ts`). Each settle takes the next number of a settle sequence, kept here.
import type { ProxyRecord, TurnState } from "@t3flare/session-protocol";

import { isLiveTurn } from "./turnLimit.ts";

/** The part of `ctx.storage.kv` the store uses. */
export interface TurnStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options?: { readonly prefix?: string; readonly limit?: number }): Iterable<[string, T]>;
}

const TURN_PREFIX = "t3flare:turn:";
const MODEL_PREFIX = "t3flare:turn-model:";
/** The live turns' ids, unordered: `live()` sorts them by `startedAt`. */
const LIVE_KEY = "t3flare:live-turns";
/** SPI-1377: the settle sequence's last number, the `settledSeq` of the settled turn put last (0 before any). */
const LAST_SETTLE_SEQ_KEY = "t3flare:last-settle-seq";
/** Before SPI-1373: every turn in one value, and every turn's model record in another. Moved over at the first read. */
const LEGACY_TURNS_KEY = "t3flare:turns";
const LEGACY_MODELS_KEY = "t3flare:proxy";

export class TurnStore {
  readonly #kv: TurnStorage;

  constructor(kv: TurnStorage) {
    this.#kv = kv;
    this.#migrate();
  }

  get(id: string): TurnState | undefined {
    return this.#kv.get<TurnState>(TURN_PREFIX + id);
  }

  /**
   * Records `turn` under `id`, and keeps the live index in step with it. Every put of a settled turn (one settling here,
   * one recorded settled, or a settled one changed again) takes the next settle sequence number (`settledSeq`), in the
   * same synchronous writes, so the next push names it once (SPI-1377).
   */
  put(id: string, turn: TurnState): void {
    const ids = this.#liveIds();
    const listed = ids.includes(id);
    if (isLiveTurn(turn)) {
      this.#kv.put(TURN_PREFIX + id, turn);
      if (!listed) this.#kv.put(LIVE_KEY, [...ids, id]);
      return;
    }
    const settledSeq = this.lastSettleSeq() + 1;
    this.#kv.put(LAST_SETTLE_SEQ_KEY, settledSeq);
    this.#kv.put(TURN_PREFIX + id, { ...turn, settledSeq });
    if (listed)
      this.#kv.put(
        LIVE_KEY,
        ids.filter((other) => other !== id),
      );
  }

  /** The settle sequence's last number: every settled turn put since it was kept has a `settledSeq` at or below it. */
  lastSettleSeq(): number {
    return this.#kv.get<number>(LAST_SETTLE_SEQ_KEY) ?? 0;
  }

  /**
   * Changes the turn `id` by `patch`, when it is recorded; a patch that answers undefined leaves it. Answers the turn as
   * it now stands, or undefined when there is none.
   */
  update(id: string, patch: (turn: TurnState) => TurnState | undefined): TurnState | undefined {
    const turn = this.get(id);
    if (turn === undefined) return undefined;
    const next = patch(turn);
    if (next === undefined) return turn;
    this.put(id, next);
    return next;
  }

  /** The live turns, the one started first first. */
  live(): Array<[string, TurnState]> {
    return this.#liveIds()
      .flatMap((id): Array<[string, TurnState]> => {
        const turn = this.get(id);
        return turn !== undefined && isLiveTurn(turn) ? [[id, turn]] : [];
      })
      .sort(([, a], [, b]) => a.startedAt - b.startedAt);
  }

  /** The turn the Session runs now (the asking turn of an approval or a question), or null. */
  liveTurn(): string | null {
    return this.live()[0]?.[0] ?? null;
  }

  /** Whether a turn is live: the Session is busy. */
  busy(): boolean {
    return this.liveTurn() !== null;
  }

  /** Whether the Session has recorded any turn. */
  any(): boolean {
    return [...this.#kv.list({ prefix: TURN_PREFIX, limit: 1 })].length > 0;
  }

  /**
   * Every turn, the one started first first, as `live()` orders them: whoever takes the first running turn from it
   * (the push's live turn, the Environment's differ) names the turn `liveTurn()` does. O(all turns), for a rollback, a
   * fork, and a push's or a snapshot's entries' turns only.
   */
  all(): Record<string, TurnState> {
    const entries = [...this.#kv.list<TurnState>({ prefix: TURN_PREFIX })]
      .map(([key, turn]): [string, TurnState] => [key.slice(TURN_PREFIX.length), turn])
      .sort(([, a], [, b]) => a.startedAt - b.startedAt);
    return Object.fromEntries(entries);
  }

  /** `turns` with their model records (`proxy`, a kept wire name; SPI-1377): one read per turn it names. */
  withModels(turns: Readonly<Record<string, TurnState>>): Record<string, TurnState> {
    return Object.fromEntries(
      Object.entries(turns).map(([id, turn]) => {
        const proxy = this.#kv.get<ProxyRecord>(MODEL_PREFIX + id);
        return [id, proxy === undefined ? turn : { ...turn, proxy }];
      }),
    );
  }

  /** Updates the model record of the turn running now: the live turn started first (a follow-up waits for it). */
  noteModel(update: (record: ProxyRecord) => ProxyRecord): void {
    const running = this.liveTurn();
    if (running === null) return;
    const key = MODEL_PREFIX + running;
    this.#kv.put(key, update(this.#kv.get<ProxyRecord>(key) ?? { requests: 0 }));
  }

  /** Forgets `ids` and their model records (a rollback's dropped turns). */
  drop(ids: Iterable<string>): void {
    const dropped = new Set(ids);
    for (const id of dropped) {
      this.#kv.delete(TURN_PREFIX + id);
      this.#kv.delete(MODEL_PREFIX + id);
    }
    const live = this.#liveIds();
    if (live.some((id) => dropped.has(id)))
      this.#kv.put(
        LIVE_KEY,
        live.filter((id) => !dropped.has(id)),
      );
  }

  /** Forgets every turn and model record (a test's fault); answers how many turns it forgot. */
  clear(): number {
    // The keys first, then the deletes: never a delete under an open listing.
    const turns = [...this.#kv.list({ prefix: TURN_PREFIX })].map(([key]) => key);
    const models = [...this.#kv.list({ prefix: MODEL_PREFIX })].map(([key]) => key);
    for (const key of [...turns, ...models]) this.#kv.delete(key);
    this.#kv.delete(LIVE_KEY);
    return turns.length;
  }

  #liveIds(): ReadonlyArray<string> {
    return this.#kv.get<ReadonlyArray<string>>(LIVE_KEY) ?? [];
  }

  /** An existing Session's single-value maps, moved to one key per turn; a Session without them reads one key. */
  #migrate(): void {
    const turns = this.#kv.get<Record<string, TurnState>>(LEGACY_TURNS_KEY);
    const models = this.#kv.get<Record<string, ProxyRecord>>(LEGACY_MODELS_KEY);
    if (turns === undefined && models === undefined) return;
    const live: Array<string> = [...this.#liveIds()];
    for (const [id, turn] of Object.entries(turns ?? {})) {
      this.#kv.put(TURN_PREFIX + id, turn);
      if (isLiveTurn(turn) && !live.includes(id)) live.push(id);
    }
    for (const [id, record] of Object.entries(models ?? {})) this.#kv.put(MODEL_PREFIX + id, record);
    this.#kv.put(LIVE_KEY, live);
    this.#kv.delete(LEGACY_TURNS_KEY);
    this.#kv.delete(LEGACY_MODELS_KEY);
  }
}
