// SPI-1373: the Session's turns, one KV key per turn (`t3flare:turn:<id>`) and one per turn's model record
// (`t3flare:turn-model:<id>`), with an index of the live turns' ids. A change reads and writes the turns it names and
// the index, so it costs O(live turns) however long the thread runs; before, one value held every turn and every change
// rewrote it, until a long thread passed the value limit and the Session stopped recording turns.
//
// Finished turns stay: a rollback and a fork find their entries by them (`branches.ts`), and each push names them for the
// Environment, which settles a turn it tracks once a push shows it settled. Only those whole reads list every turn.
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

  /** Records `turn` under `id`, and keeps the live index in step with it. */
  put(id: string, turn: TurnState): void {
    this.#kv.put(TURN_PREFIX + id, turn);
    const ids = this.#liveIds();
    const listed = ids.includes(id);
    if (isLiveTurn(turn) && !listed) this.#kv.put(LIVE_KEY, [...ids, id]);
    else if (!isLiveTurn(turn) && listed)
      this.#kv.put(
        LIVE_KEY,
        ids.filter((other) => other !== id),
      );
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
   * fork and a push only.
   */
  all(): Record<string, TurnState> {
    const entries = [...this.#kv.list<TurnState>({ prefix: TURN_PREFIX })]
      .map(([key, turn]): [string, TurnState] => [key.slice(TURN_PREFIX.length), turn])
      .sort(([, a], [, b]) => a.startedAt - b.startedAt);
    return Object.fromEntries(entries);
  }

  /** Every turn with its model record (`proxy`, a kept wire name). */
  allWithModel(): Record<string, TurnState> {
    const turns = this.all();
    for (const [key, proxy] of this.#kv.list<ProxyRecord>({ prefix: MODEL_PREFIX })) {
      const id = key.slice(MODEL_PREFIX.length);
      const turn = turns[id];
      if (turn !== undefined) turns[id] = { ...turn, proxy };
    }
    return turns;
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
