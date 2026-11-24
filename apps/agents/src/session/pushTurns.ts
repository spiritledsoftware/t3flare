// SPI-1377: which turns a push and a snapshot name, where their entries start, and how the entries are read. A long
// thread's settled turns stay in the Session's storage (`turnStore.ts`) but leave the wire: a push names the live turns
// and those settled since the last push the Environment took (its watermark, a settle sequence), and a snapshot names the
// live turns and those the adapter has open, from the oldest of them. The Environment's differ uses only the turns it
// has open, so neither loses it anything.
import type { PushedEntry, TurnState } from "@t3flare/session-protocol";

import { pushedEntry, pushPage, turnOfEntry } from "./state.ts";
import { isLiveTurn } from "./turnLimit.ts";

const pick = (
  turns: Readonly<Record<string, TurnState>>,
  keep: (id: string, turn: TurnState) => boolean,
): Record<string, TurnState> => Object.fromEntries(Object.entries(turns).filter(([id, turn]) => keep(id, turn)));

/**
 * A push's turns: the live ones, and those whose settle sequence (`settledSeq`) is past `settledThrough`, the sequence
 * as the last push the Environment took read it. Undefined (a Session's first push since it kept one): every turn, once.
 */
export const pushedTurns = (
  turns: Readonly<Record<string, TurnState>>,
  settledThrough: number | undefined,
): Record<string, TurnState> =>
  settledThrough === undefined
    ? { ...turns }
    : pick(turns, (_, turn) => isLiveTurn(turn) || (turn.settledSeq !== undefined && turn.settledSeq > settledThrough));

/** A snapshot's turns: the live ones, and those of `asked` (the adapter's open turns) the Session still has. */
export const snapshotTurns = (
  turns: Readonly<Record<string, TurnState>>,
  asked: ReadonlyArray<string>,
): Record<string, TurnState> => {
  const open = new Set(asked);
  return pick(turns, (id, turn) => isLiveTurn(turn) || open.has(id));
};

/**
 * Where a state's entries start, given the turns it reports. A number: that entry. Undefined: the conversation's first.
 * `"open"` (a snapshot of the open turns): the oldest reported turn's input entry, or `"last"` when none was placed
 * yet, for the conversation's last entry.
 */
export const entriesStart = (
  from: number | "open" | undefined,
  turns: Readonly<Record<string, TurnState>>,
): number | "last" | undefined => {
  if (from !== "open") return from;
  let start: number | undefined;
  for (const turn of Object.values(turns)) {
    if (turn.inputEntry === undefined) continue;
    const at = Number(turn.inputEntry);
    if (start === undefined || at < start) start = at;
  }
  return start ?? "last";
};

/** One page of the conversation's entries, ascending, as pi-durable answers them. */
export interface EntryPage<C> {
  readonly items: ReadonlyArray<Parameters<typeof pushedEntry>[0]>;
  readonly next?: C | undefined;
}

/**
 * The entries from `fromEntry` (every entry when undefined), read a page at a time by `read`, each with the turn it
 * belongs to among `turns` (every turn: a reported one's entries may follow an unreported one's), until they pass
 * `bound` (`more`). `lastEntry`: the last one taken.
 */
export const collectEntries = async <C>(
  read: (fromEntry: number | undefined, cursor: C | undefined) => Promise<EntryPage<C>>,
  fromEntry: number | undefined,
  turns: Readonly<Record<string, TurnState>>,
  bound: number,
): Promise<{ entries: Array<PushedEntry>; more: boolean; lastEntry: number | undefined }> => {
  const entries: Array<PushedEntry> = [];
  const room = pushPage(bound);
  let more = false;
  let lastEntry: number | undefined;
  let cursor: C | undefined;
  do {
    const page = await read(fromEntry, cursor);
    for (const entry of page.items) {
      const pushed = pushedEntry(entry, turnOfEntry(Number(entry.id), turns));
      if (!room.take(pushed)) {
        more = true;
        break;
      }
      entries.push(pushed);
      lastEntry = Number(entry.id);
    }
    cursor = more ? undefined : page.next;
  } while (cursor !== undefined);
  return { entries, more, lastEntry };
};
