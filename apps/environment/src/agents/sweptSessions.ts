// The deleted threads' Sessions already destroyed (SPI-1366), kept in the Environment DO's key-value storage so neither
// the Sweep nor a Purge now destroys or counts one twice across runs: one key a thread, written at each destroy, and
// forgotten once t3's projection no longer holds the thread, so no count bounds it.
import type { SweptSessions } from "./deletion.ts";

/** The part of DO key-value storage this needs, so a test can pass a Map-backed fake. */
export interface SweptKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
  list<T>(options: { readonly prefix: string }): Iterable<[string, T]>;
}

/** The swept Sessions as one list, before SPI-1366: read once, to move them into their own keys. */
export const SWEPT_SESSIONS_KEY = "t3flare:swept-sessions";
/** One key per deleted thread whose Session the Sweep or a Purge destroyed (SPI-1366). */
export const SWEPT_SESSION_PREFIX = "t3flare:swept-session:";

export const sweptSessionsIn = (kv: SweptKv): SweptSessions => {
  const keyOf = (threadId: string) => `${SWEPT_SESSION_PREFIX}${threadId}`;
  // A list kept under the old single key (at most 5,000 threads) moves into the keys at first use.
  const moveOldList = () => {
    const old = kv.get<ReadonlyArray<string>>(SWEPT_SESSIONS_KEY);
    if (old === undefined) return;
    for (const threadId of old) kv.put(keyOf(threadId), 1);
    kv.delete(SWEPT_SESSIONS_KEY);
  };
  return {
    has: (threadId) => {
      moveOldList();
      return kv.get(keyOf(threadId)) !== undefined;
    },
    add: (threadId) => {
      moveOldList();
      kv.put(keyOf(threadId), 1);
    },
    keepOnly: (threadIds) => {
      moveOldList();
      // The keys first, then the deletes: a delete never runs inside the list's own cursor.
      const gone = [...kv.list<unknown>({ prefix: SWEPT_SESSION_PREFIX })]
        .map(([key]) => key)
        .filter((key) => !threadIds.has(key.slice(SWEPT_SESSION_PREFIX.length)));
      for (const key of gone) kv.delete(key);
    },
  };
};
