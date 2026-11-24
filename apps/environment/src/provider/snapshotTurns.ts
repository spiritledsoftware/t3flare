// SPI-1377: the snapshot the adapter pulls names the turns it has open, so the Session answers their states and the
// entries from the oldest of them, never the whole thread. A turn it asked about that the Session no longer has (a test's
// fault, a lost Session) is gone: the adapter ends it as lost, so it cannot keep a t3 run open (the lost-turn guard).
import type { SessionState, SnapshotInput, TurnState } from "@t3flare/session-protocol";

/** The snapshot the adapter asks for, given the turns it has open. */
export const snapshotRequest = (open: Iterable<string>): SnapshotInput => ({ turns: [...open] });

/** Of `asked`, the turns `state` does not have. */
export const goneTurns = (state: SessionState, asked: Iterable<string>): Array<string> =>
  [...asked].filter((id) => state.turns[id] === undefined);

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
