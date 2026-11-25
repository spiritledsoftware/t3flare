// A parked Open change closed elsewhere (SPI-1404): when a CLI agent's turn parked on an Open change's card (park.ts),
// the change can still close without its park question: answered on its Change page (or that page's API), or expired.
// Nothing watches it then (the held call returned). At the close, an answer's decision is noted on the parked record
// (`noteChangeClosed`), so it outlives the change's row; then this reconcile brings the park question and its record in
// line, once t3 takes commands:
// - answered elsewhere, its question pending: the question is answered on the Owner's behalf with that decision, so t3
//   sends the agent its `async-answer` message and `answerText` tells it the outcome, as answering on the question does
//   (it reads the change already closed), and drops the record;
// - closed without an answer (expired, withdrawn, or no longer kept), its question pending: the question is dismissed,
//   which sends no message and starts no turn, and the record dropped;
// - its question already answered: left to `answerText`, whose message is on its way (the record is what it reads);
// - its question dismissed by hand, or gone: the record dropped, so the CLI session can be pruned again.
// Each step reads state again, so running it twice does nothing the second time. An answer or dismissal t3 refuses
// because the Owner resolved the question meanwhile is read again, unlogged: answered, it is left to `answerText`;
// dismissed or gone, its record is dropped. Any other failure is logged, and tried again while the question is pending
// (at the next boot, or the next close of a parked change).
import type { ChangeRecord, ChangeState } from "../../settings/changes.ts";
import type { ParkedCard, ParkedCards } from "./parked.ts";

/** A park question as t3 holds it: pending, resolved with answers, resolved without them (dismissed), or none. */
export type ParkQuestionState = "pending" | "answered" | "dismissed" | "gone";

export interface ParkedChangesDeps {
  readonly parked: ParkedCards;
  /** The Open change, as the changes table holds it now; undefined once it is no longer kept. */
  readonly change: (id: string) => Pick<ChangeRecord, "state"> | undefined;
  /** t3's park question `requestId`. */
  readonly question: (requestId: string) => ParkQuestionState;
  /** Answers `card`'s park question on the Owner's behalf with Approve or Decline. */
  readonly answer: (card: ParkedCard, approve: boolean) => Promise<void>;
  /** Dismisses `card`'s park question: no message, no turn. */
  readonly dismiss: (card: ParkedCard) => Promise<void>;
  readonly log: (event: Record<string, unknown>) => void;
}

export interface ParkedChangesCleared {
  readonly answered: number;
  readonly dismissed: number;
  readonly dropped: number;
}

/**
 * The decision an answer closed a change with, or undefined when it closed without one. A move or a failed apply
 * follows an approve: a decline closes as `declined` before either is checked (`answerOpenChange`).
 */
const decisionOf = (state: ChangeState): boolean | undefined => {
  switch (state) {
    case "applied":
    case "moved":
    case "failed":
      return true;
    case "declined":
      return false;
    default:
      return undefined;
  }
};

/**
 * An Open change closed as `state`: an answer's decision is noted on the change cards parked on it, before any
 * delivery.
 * Whether any card is parked on it.
 */
export const noteChangeClosed = (parked: ParkedCards, changeId: string, state: ChangeState): boolean => {
  const approve = decisionOf(state);
  return approve === undefined
    ? parked.changeCards(changeId).length > 0
    : parked.noteAnsweredElsewhere(changeId, approve) > 0;
};

/**
 * What reading a parked Open change again calls for (SPI-1435), after a new record on it was kept once the change was
 * read open: a close in between found no record to note. Open (or applying, whose close comes later): nothing. Closed:
 * its close path, `noteChangeClosed` then the reconcile. Gone (no longer kept): the reconcile, which dismisses its
 * question.
 */
export type ParkedChangeRecheck =
  | { readonly kind: "open" }
  | { readonly kind: "closed"; readonly state: ChangeState }
  | { readonly kind: "gone" };

/** What reading parked Open change `change` (undefined: gone) again calls for, as `ParkedChangeRecheck` says. */
export const parkedChangeRecheck = (change: Pick<ChangeRecord, "state"> | undefined): ParkedChangeRecheck =>
  change === undefined
    ? { kind: "gone" }
    : change.state === "open" || change.state === "applying"
      ? { kind: "open" }
      : { kind: "closed", state: change.state };

/** Brings every parked change card whose Open change has closed in line with it, as the header says. */
export const clearClosedParkedChanges = async (deps: ParkedChangesDeps): Promise<ParkedChangesCleared> => {
  let answered = 0;
  let dismissed = 0;
  let dropped = 0;
  for (const card of deps.parked.changeCards()) {
    try {
      const change = card.changeId === undefined ? undefined : deps.change(card.changeId);
      if (change !== undefined && (change.state === "open" || change.state === "applying")) continue;
      const question = deps.question(card.id);
      if (question === "answered") continue;
      if (question === "pending") {
        const approve =
          card.answeredElsewhere?.approve ?? (change === undefined ? undefined : decisionOf(change.state));
        // A refusal because the Owner resolved it meanwhile (t3 refuses a resolved request) reads it again: an answer
        // is left to `answerText`, a dismissal (or a request gone) drops the record as below.
        const outcome = await (approve === undefined ? deps.dismiss(card) : deps.answer(card, approve)).then(
          () => "settled" as const,
          (error: unknown) => {
            const now = deps.question(card.id);
            if (now === "pending") throw error;
            return now;
          },
        );
        if (outcome === "answered") continue;
        if (outcome === "settled" && approve !== undefined) {
          // `answerText` drops the record when the answer's message reaches the agent.
          answered++;
          continue;
        }
        if (outcome === "settled") dismissed++;
      }
      deps.parked.drop(card.id);
      dropped++;
    } catch (error) {
      deps.log({ t3flare: "cli-park-clear-failed", changeId: card.changeId, error: String(error) });
    }
  }
  return { answered, dismissed, dropped };
};
