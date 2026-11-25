// A parked Open change closed elsewhere (SPI-1404): when a CLI agent's turn parked on an Open change's card (`park.ts`),
// the change can still close without its park question: answered on its Change page (or that page's API), or expired.
// Nothing watches it then (the held call returned), so this reconcile brings the park question and its record in line,
// once t3 takes commands:
// - answered on the page, its question pending: the question is answered on the Owner's behalf with the page's decision,
//   so t3 sends the agent its `async-answer` message and `answerText` tells it the outcome, as answering on the question
//   does (it reads the change already closed), and drops the record;
// - closed without an answer (expired, withdrawn, or no longer kept), its question pending: the question is dismissed,
//   which sends no message and starts no turn, and the record dropped;
// - its question already answered: left to `answerText`, whose message is on its way (the record is what it reads);
// - its question dismissed by hand, or gone: the record dropped, so the CLI session can be pruned again.
// Each step reads state again, so running it twice does nothing the second time. A failure is logged and left for the
// next run (the next boot, or the next close of a parked change).
import type { ChangeRecord } from "../../settings/changes.ts";
import type { ParkedCard, ParkedCards } from "./parked.ts";

/** A park question as t3 holds it: pending, resolved with the Owner's answers, resolved without (dismissed), or none. */
export type ParkQuestion = "pending" | "answered" | "dismissed" | "gone";

export interface ParkedChangesDeps {
  readonly parked: ParkedCards;
  /** The Open change, as the changes table holds it now; undefined once it is no longer kept. */
  readonly change: (id: string) => Pick<ChangeRecord, "state"> | undefined;
  /** t3's park question `requestId`. */
  readonly question: (requestId: string) => ParkQuestion;
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
 * The page's decision on a closed change, or undefined when it closed without an answer. A move or a failed apply
 * follows an approve: a decline closes as `declined` before either is checked (`answerOpenChange`).
 */
const pageDecisionOf = (state: ChangeRecord["state"]): boolean | undefined => {
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
        const approve = change === undefined ? undefined : pageDecisionOf(change.state);
        if (approve !== undefined) {
          // `answerText` drops the record when the answer's message reaches the agent.
          await deps.answer(card, approve);
          answered++;
          continue;
        }
        await deps.dismiss(card);
        dismissed++;
      }
      deps.parked.drop(card.id);
      dropped++;
    } catch (error) {
      deps.log({ t3flare: "cli-park-clear-failed", changeId: card.changeId, error: String(error) });
    }
  }
  return { answered, dismissed, dropped };
};
