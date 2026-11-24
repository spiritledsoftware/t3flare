// SPI-1377: the snapshot the adapter pulls names the turns it has open, so the Session answers their states and the
// entries from the oldest of them, never the whole thread. A turn it asked about that the Session no longer has (dropped
// by the fault-injection hook, or a lost Session) is gone: the adapter ends it as lost, so it cannot keep a t3 run open
// (the lost-turn guard).
import type { SessionState, SnapshotInput, TurnState } from "@t3flare/session-protocol";

/** The snapshot the adapter asks for, given the turns it has open. */
export const snapshotRequest = (open: Iterable<string>): SnapshotInput => ({ turns: [...open] });

/** Of `asked`, the turns `state` does not have. */
export const goneTurns = (state: SessionState, asked: Iterable<string>): Array<string> =>
  [...asked].filter((id) => state.turns[id] === undefined);

/** Of `open` (the adapter's open turns), those `state` names: the Session has recorded them. */
export const namedIn = (state: SessionState, open: Iterable<string>): Array<string> =>
  [...open].filter((id) => state.turns[id] !== undefined);

/**
 * Of `asked`, the turns a gap's snapshot fails as lost: those it lacks that a push or a snapshot named before (`named`).
 * One never named may still be on its way in: the adapter registers a turn before the Session's `submitTurn` records it.
 */
export const lostOnGap = (state: SessionState, asked: Iterable<string>, named: ReadonlySet<string>): Array<string> =>
  goneTurns(state, asked).filter((id) => named.has(id));

/** `state` with each of `gone` as a turn that failed because the Session lost it, under its run (`runIdOf`). */
export const withLostTurns = (
  state: SessionState,
  gone: Iterable<string>,
  runIdOf: (providerTurnId: string) => string,
): SessionState => {
  const lost = [...gone];
  if (lost.length === 0) return state;
  const turns: Record<string, TurnState> = { ...state.turns };
  for (const id of lost)
    turns[id] = { submissionId: "", runId: runIdOf(id), attemptId: "", status: "failed", reason: "lost", startedAt: 0 };
  return { ...state, turns };
};
