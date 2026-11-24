// SPI-1377: which turns a push and a snapshot name, and where a snapshot's entries start. A long thread's settled turns
// stay in the Session's storage (`turnStore.ts`) but leave the wire: a push names the live turns and those settled since
// the last push the Environment took (its watermark), and a snapshot names the live turns and those the adapter has open,
// from the oldest of them. The Environment's differ uses only the turns it has open, so neither loses it anything.
import type { TurnState } from "@t3flare/session-protocol";

import { isLiveTurn } from "./turnLimit.ts";

const pick = (
  turns: Readonly<Record<string, TurnState>>,
  keep: (id: string, turn: TurnState) => boolean,
): Record<string, TurnState> => Object.fromEntries(Object.entries(turns).filter(([id, turn]) => keep(id, turn)));

/**
 * A push's turns: the live ones, and those settled at or after `settledSince` (the read time of the last push the
 * Environment took). Undefined (a Session's first push since it kept one): every turn, once.
 */
export const pushedTurns = (
  turns: Readonly<Record<string, TurnState>>,
  settledSince: number | undefined,
): Record<string, TurnState> =>
  settledSince === undefined
    ? { ...turns }
    : pick(turns, (_, turn) => isLiveTurn(turn) || (turn.settledAt !== undefined && turn.settledAt >= settledSince));

/** A snapshot's turns: the live ones, and those of `asked` (the adapter's open turns) the Session still has. */
export const snapshotTurns = (
  turns: Readonly<Record<string, TurnState>>,
  asked: ReadonlyArray<string>,
): Record<string, TurnState> => {
  const open = new Set(asked);
  return pick(turns, (id, turn) => isLiveTurn(turn) || open.has(id));
};

/**
 * The entry a snapshot of `turns` starts at: the oldest one's input entry. Undefined when none was placed yet: the
 * snapshot starts at the conversation's last entry.
 */
export const snapshotStart = (turns: Readonly<Record<string, TurnState>>): number | undefined => {
  let start: number | undefined;
  for (const turn of Object.values(turns)) {
    if (turn.inputEntry === undefined) continue;
    const at = Number(turn.inputEntry);
    if (start === undefined || at < start) start = at;
  }
  return start;
};
