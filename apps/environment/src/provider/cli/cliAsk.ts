// The MCP relay's tool cards on a CLI thread (ADR-0028, review M9). The CLI wrapper (`wrapper.ts`) registers an asker
// for each thread while its session lives; the asker raises t3's approval card on the thread's live turn and answers
// when the owner does. A thread with no live turn is refused. (Before the back-to-stock cut, owner 2026-11-12, the
// push gateway's cards came this way too; pushes no longer ask.) Since SPI-1079 an MCP server's question comes this way
// too (`cliQuestionAsker`): an `mcp-elicitation` approval card, or a `user_input` card for a form.
//
// A card waits until the Owner answers it (SPI-1389): no timer closes it. After Park after the wrapper parks the turn,
// and the card's ask resolves with `parked`, the text the held call is answered with.
import { SETTINGS_SERVER } from "@t3flare/harness-registry";
import { type ApprovalDecision, type McpAsker, type McpCardQuestion, PARKED_REASON } from "@t3flare/session-protocol";

import type { ParkedCall } from "./parked.ts";

/**
 * What a parked card's record keeps of an ask (SPI-1389): a relay tool card's call, which an allow lets run once; an MCP
 * server's question's server; the Settings server's card's Open change.
 */
export type CliAskPark =
  | { readonly kind: "tool"; readonly call: ParkedCall }
  | { readonly kind: "question"; readonly server: string }
  | {
      readonly kind: "change";
      readonly server: string;
      readonly changeId: string;
      /** The change is approved on its Change page only: its question's text, naming the page and why (SPI-1435). */
      readonly pagePrompt?: string;
    };

/** What the relay asks: the card's text, its buttons and title, and the ask's id. A tool card is t3's `permission` kind. */
export interface CliAsk {
  readonly askId: string;
  readonly summary: string;
  readonly detail: string;
  readonly options: ReadonlyArray<{
    readonly decision: ApprovalDecision;
    readonly label: string;
    readonly warning?: string;
  }>;
  readonly title: string;
  /** t3's request kind of an approval card: `permission` (a tool) unless set (`mcp-elicitation`, SPI-1079). */
  readonly requestKind?: "permission" | "mcp-elicitation";
  /** A form's questions (SPI-1079): the card is t3's `user_input` request, answered with `answers`. */
  readonly questions?: ReadonlyArray<McpCardQuestion>;
  /** What a parked card's record keeps of the ask (SPI-1389). */
  readonly park: CliAskPark;
}

export interface CliAnswer {
  readonly approved: boolean;
  /** The owner chose the card's "for the session" answer. */
  readonly forSession?: boolean;
  readonly reason?: string;
  /** The owner's decision as t3 gave it, and a `user_input` card's answers (SPI-1079). */
  readonly decision?: ApprovalDecision;
  readonly answers?: Readonly<Record<string, unknown>>;
  /** The turn parked (SPI-1389): the text the held call is answered with. The card stays up as a question. */
  readonly parked?: string;
}

/**
 * A live turn's way to ask: resolves with the owner's answer, a refusal when the turn ends or the ask is withdrawn, or
 * `parked` when the turn parks.
 */
export interface CliAsker {
  /** The thread's modes as its session last set them, and its Workspace (the relay's decision, review M7). */
  readonly state?: () => {
    readonly runtimeMode: string | undefined;
    readonly interactionMode: string | undefined;
    readonly workspace: string | null;
  };
  readonly ask: (ask: CliAsk, signal: AbortSignal) => Promise<CliAnswer>;
}

const askers = new Map<string, CliAsker>();
const withdrawals = new Map<string, AbortController>();

/** Registers the live session of `thread`; the returned function unregisters it (only if still the registered one). */
export const registerCliAsker = (thread: string, asker: CliAsker): (() => void) => {
  askers.set(thread, asker);
  return () => {
    if (askers.get(thread) === asker) askers.delete(thread);
  };
};

/** Withdraws the card of a call whose CLI went away. */
export const cancelCliAsk = (askId: string): void => withdrawals.get(askId)?.abort();

/** A CLI thread's modes, for the relay: the call follows its own thread's (undefined when it has no live session). */
export const cliThreadState = (
  thread: string,
): { readonly runtimeMode: string | undefined; readonly interactionMode: string | undefined } | undefined =>
  askers.get(thread)?.state?.();

/**
 * The relay's question about one tool call (ADR-0028), on the calling thread's live turn, linked threads included
 * (owner, 2026-11-12, back to stock: no per-call rule).
 */
export const approveCliTool = async (input: {
  readonly thread: string;
  readonly askId: string;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
  /** The call, its tool `server/upstream` and its arguments' hash: a parked card's record (SPI-1389). */
  readonly call: ParkedCall;
}): Promise<CliAnswer> => {
  const asker = askers.get(input.thread);
  if (asker === undefined) return { approved: false, reason: `no live turn to ask on (thread ${input.thread})` };
  const options: CliAsk["options"] = [
    { decision: "accept", label: "Allow" },
    { decision: "acceptForSession", label: "Allow this tool for the rest of the session" },
    { decision: "decline", label: "Decline" },
  ];
  const withdrawn = new AbortController();
  withdrawals.set(input.askId, withdrawn);
  try {
    const answer = await asker.ask(
      {
        askId: input.askId,
        summary: input.summary,
        detail: input.detail,
        options,
        title: input.title,
        park: { kind: "tool", call: input.call },
      },
      withdrawn.signal,
    );
    if (answer.parked !== undefined) return { approved: false, parked: answer.parked };
    if (answer.reason === "withdrawn") return { approved: false, reason: "the agent went away" };
    if (!answer.approved) return { approved: false, reason: answer.reason ?? "declined" };
    return { approved: true, forSession: answer.forSession === true };
  } finally {
    withdrawals.delete(input.askId);
  }
};

/**
 * The cards of an MCP server's questions on `thread`'s live turn (SPI-1079): the MCP host makes each card, this raises it
 * as the relay's tool cards are raised, and hands back the owner's answer. No live turn: cancelled, nothing shown. A
 * parked turn (SPI-1389) is a cancel for `PARKED_REASON`.
 */
export const cliQuestionAsker = (thread: string): McpAsker => {
  return {
    ask: async (card) => {
      const asker = askers.get(thread);
      if (asker === undefined) return { decision: "cancel", reason: `no live turn to ask on (thread ${thread})` };
      const withdrawn = new AbortController();
      withdrawals.set(card.id, withdrawn);
      try {
        const answer = await asker.ask(
          {
            askId: card.id,
            title: card.title,
            summary: card.prompt,
            detail: "",
            options: card.options ?? [],
            requestKind: "mcp-elicitation",
            ...(card.kind === "form" && card.questions !== undefined ? { questions: card.questions } : {}),
            park:
              card.server === SETTINGS_SERVER && card.changeId !== undefined
                ? {
                    kind: "change",
                    server: card.server,
                    changeId: card.changeId,
                    ...(card.pagePrompt === undefined ? {} : { pagePrompt: card.pagePrompt }),
                  }
                : { kind: "question", server: card.server },
          },
          withdrawn.signal,
        );
        // The held call is answered with the parked text, whatever the server makes of the cancel (`relay.ts`).
        if (answer.parked !== undefined) return { decision: "cancel", reason: PARKED_REASON, parked: answer.parked };
        if (answer.reason === "withdrawn") return { decision: "cancel", reason: "withdrawn" };
        // No decision from t3 means no owner answered (no live turn, the session ended): a cancel, never a decline.
        const decision = answer.decision ?? (answer.approved ? "accept" : "cancel");
        return {
          decision,
          ...(answer.answers === undefined ? {} : { answers: answer.answers }),
          ...(answer.approved || answer.reason === undefined ? {} : { reason: answer.reason }),
        };
      } finally {
        withdrawals.delete(card.id);
      }
    },
    withdraw: (cardId) => cancelCliAsk(cardId),
  };
};
