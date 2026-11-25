// @effect-diagnostics globalTimers:off runEffectInsideEffect:off cryptoRandomUUID:off
// (The park is armed and run from the relay's promise-based ask, outside any Effect services: a plain timeout, its own
// run of the park's Effect, and a question id from `crypto`.)
//
// Park and resume (SPI-1389): a CLI agent's process holds its Container while its turn waits on a card, so a card that has
// waited Park after (`parkAfterMinutes`, the value the process was spawned with) parks the turn:
// - each open card, the relay's and the CLI's own requests alike, is raised again as t3's non-blocking `user_input`
//   question, whose id carries `PARK_QUESTION_MARKER`: only the Owner answers it (`ownerOnly.ts`);
// - its record is kept (`parked.ts`) first, all of them or none: a record that cannot be kept leaves every card live;
// - held relay calls are answered with a complete tool result that names the limit, the CLI's own requests cancelled;
// - the turn is interrupted and the process ended, so nothing holds the Container. A card or a request raised while
//   the park ends the turn is parked the same way.
// t3 sends the Owner's answer as the message `async-answer:<request id>`, which starts a new turn (or is steered into a
// running one). Its text tells the agent what to repeat, and an allow is a one-time allowance for the same call: the
// relay's by its tool and arguments' hash (`relay.ts`), the CLI's own request by its whole call read off the process
// (`nativeCalls.ts`). An allowance lasts until it is used or its answer turn ends (a steered answer's, the turn after
// the steer's restart). A Turn limit hit while a card is open parks the turn too.
import { timeLimitHit } from "@t3flare/harness-registry";
import { PARK_QUESTION_MARKER } from "@t3flare/session-protocol";
import {
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  RuntimeRequestId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import { argsHashOf } from "../../mcp/canonical.ts";
import { workersLog } from "../../platform/workersLog.ts";
import { cardOf, type LiveTurn } from "./cardEvents.ts";
import type { CliAnswer, CliAsk } from "./cliAsk.ts";
import type { ParkedCall, ParkedCard, ParkedCards, ParkedChangeAnswer, ParkedDecision } from "./parked.ts";

/** t3's runtime request id of a parked card's question: t3 answers it as `async-answer:<id>`. */
export const parkRequestPrefix = (driver: string) => `runtime-request:${driver}:${PARK_QUESTION_MARKER}:`;

/** The id of the message t3 sends a non-blocking question's answer as (`Orchestrator.ts`, `async-answer:`). */
const ASYNC_ANSWER = "async-answer:";

/**
 * How long a park waits for the CLI to end its interrupted turn before it ends the process. Guards only t3flare's own
 * park, which kills the process after it either way: a named constant, not a setting.
 */
export const PARK_INTERRUPT_MS = 5_000;

/** What parked a turn: Park after, or the Turn limit hit while a card was open; and its value in minutes. */
export interface ParkCause {
  readonly by: "park" | "turn-limit";
  readonly minutes: number;
}

/** The limit a park names, with its value and where to change it (ADR-0049 §4). */
const limitOf = (cause: ParkCause): string => {
  const minutes = Math.max(1, Math.round(cause.minutes));
  return cause.by === "park"
    ? `Park after, ${timeLimitHit(minutes, "minute", { environment: "parkAfterMinutes" })}`
    : `the Turn limit, ${timeLimitHit(minutes, "minute", { environment: "turnLimitMinutes" })}`;
};

/**
 * What a held call is told when its turn parks: a complete tool result naming the limit. A call that opened an Open
 * change (`change`) is told the change stays open and its outcome comes as a message.
 */
export const parkedCallText = (cause: ParkCause, kind: ParkedCard["kind"]): string =>
  `Parked: the owner has not answered within ${limitOf(cause)}. This turn ends here${kind === "change" ? "" : " and nothing ran"}. ${
    kind === "change"
      ? "The change stays open, and its outcome comes to this thread as a message when the owner answers. Do not repeat the call."
      : "The owner's answer comes to this thread as a message; repeat this call then if they allow it. Do not try it another way."
  }`;

/** What the Owner reads on a parked card's question: why it parked, and what an answer does. */
const parkedNote = (cause: ParkCause): string =>
  `The turn parked: the card waited ${limitOf(cause)}. The agent's process ended so its Container can stop; your answer starts a new turn.`;

/** A parked approval's answers, as the question offers them. */
const PARK_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly description: string;
  readonly decision: ParkedDecision;
}> = [
  { label: "Allow", description: "The agent repeats it in a new turn, and it runs once.", decision: "accept" },
  {
    label: "Allow for this session",
    description: "As Allow, and the tool runs without asking for the rest of the session.",
    decision: "acceptForSession",
  },
  { label: "Decline", description: "The agent is told not to repeat it.", decision: "decline" },
];
const CHANGE_OPTIONS: typeof PARK_OPTIONS = [
  { label: "Approve", description: "The change applies, and the agent is told the outcome.", decision: "accept" },
  { label: "Decline", description: "The change closes, and the agent is told so.", decision: "decline" },
];

/**
 * A parked change approved on its Change page only, raised again after an Approve on its question (SPI-1435): Approve
 * keeps its label, as an answer given on the Owner's behalf names it (SPI-1404).
 */
const PAGE_ONLY_OPTIONS: typeof PARK_OPTIONS = [
  {
    label: "Approve",
    description: "Approved on its Change page only: answering Approve here asks again.",
    decision: "accept",
  },
  CHANGE_OPTIONS[1]!,
];

/**
 * The question a parked change approved on its Change page only is raised again with after an Approve on it (SPI-1435):
 * `pageOnly` names the page and why.
 */
const pageOnlyQuestionText = (title: string, pageOnly: string): string =>
  `${title}\n\n${pageOnly} Approve it there, and the agent is told its outcome; Decline here closes it.`;

/**
 * What the agent is told when the Owner picked Approve on a parked change approved on its Change page only (SPI-1435):
 * nothing changed, and its outcome comes as a message when the change closes (`raised`), or, when its question could
 * not be raised again, is read from the settings.
 */
const pageOnlyTurnText = (title: string, pageOnly: string, raised: boolean): string =>
  `The owner picked Approve on the Open change that parked your turn (${title}), but nothing changed yet: ${pageOnly} ${
    raised
      ? "It stays open, and its outcome comes to this thread as a message when the owner answers it."
      : "It stays open; read the settings later to see whether it applied."
  } Do not repeat the change.`;

/** The id of a parked approval's one question (`decisionQuestion`): an answer given on the Owner's behalf names it. */
export const PARK_DECISION_QUESTION = "decision";

/** The option a parked change's question answers with for an approve or a decline (SPI-1404). */
export const changeOptionLabel = (approve: boolean): string =>
  CHANGE_OPTIONS.find((option) => option.decision === (approve ? "accept" : "decline"))!.label;

/** The decision of a parked approval's answer: the last line of t3's reply, an option's label. Anything else declines. */
export const parkedDecisionOf = (kind: ParkedCard["kind"], reply: string): ParkedDecision => {
  const answer = reply.trim().split("\n").at(-1)?.trim() ?? "";
  return (
    (kind === "change" ? CHANGE_OPTIONS : PARK_OPTIONS).find((option) => option.label === answer)?.decision ?? "decline"
  );
};

/** The answer turn's text: what the Owner answered, and what the agent repeats. */
export const answerTurnText = (
  card: ParkedCard,
  decision: ParkedDecision,
  reply: string,
  outcome: string | undefined,
): string => {
  const repeatOnce =
    card.call === undefined
      ? "Repeat it now; it asks again."
      : "Repeat it now exactly as before: it runs once without asking. Anything else asks again.";
  switch (card.kind) {
    case "tool":
      return decision === "decline"
        ? `The owner declined your parked call (${card.title}). Do not repeat it.`
        : `The owner allowed your parked call (${card.title})${decision === "acceptForSession" ? ", and the tool for the rest of the session" : ""}. ${repeatOnce}`;
    case "native":
      return decision === "decline"
        ? `The owner declined the request that parked your turn (${card.title}). Do not repeat it.`
        : `The owner allowed the request that parked your turn (${card.title}). ${repeatOnce}`;
    case "change":
      return `The owner answered the Open change that parked your turn (${card.title}): ${outcome ?? "read the settings to see whether it applied"}. Do not repeat the change.`;
    case "question":
      return `While your turn was parked, the owner answered the question of the MCP server ${card.server ?? "?"} (${card.title}):\n${reply.trim()}\nIf the call that asked still needs it, repeat the call; the server may ask again.`;
  }
};

/** A new parked card's question id. */
const newParkId = (driver: string): RuntimeRequestId =>
  RuntimeRequestId.make(`${parkRequestPrefix(driver)}${crypto.randomUUID()}`);

const decisionQuestion = (
  text: string,
  options: ReadonlyArray<{ readonly label: string; readonly description: string }>,
): OrchestrationV2UserInputQuestion =>
  ({
    id: PARK_DECISION_QUESTION,
    header: "Parked",
    question: text,
    options: options.map(({ label, description }) => ({ label, description })),
    allowCustomAnswer: false,
    required: true,
  }) as OrchestrationV2UserInputQuestion;

/** A card on the live turn, as the park reads it: what was asked. */
export interface ParkableCard {
  readonly ask: CliAsk;
}

/** One of the CLI's own requests pending on the live turn: a park cancels it and raises it again. */
interface NativeRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  title: string | undefined;
  prompt: string | undefined;
}

export interface ParkerDeps {
  readonly driver: ProviderAdapter.ProviderAdapterV2Event["driver"];
  readonly providerSessionId: string;
  /** t3's thread of the session. */
  readonly thread: string;
  readonly live: () => LiveTurn | undefined;
  /** The relay's open cards, by request id. */
  readonly cards: ReadonlyMap<string, ParkableCard>;
  /** Closes a relay card with `answer` (cancelled for t3); its events. */
  readonly closeCard: (id: string, answer: CliAnswer) => ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
  readonly offer: (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => void;
  readonly runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "respondToRuntimeRequest" | "interruptTurn">;
  /** Park after in ms (0: never park). */
  readonly parkAfterMs: () => number;
  readonly parked: () => ParkedCards | undefined;
  readonly answerParkedChange: (changeId: string, approve: boolean) => Promise<ParkedChangeAnswer>;
  /** The CLI's own request's whole call by its native id (`nativeCalls.ts`), or undefined. */
  readonly nativeCallOf: (nativeId: string) => unknown;
  /** Ends the session's process. */
  readonly kill: () => void;
  readonly processKey: () => string | null;
  readonly now: () => number;
  /** Whether `id` is one of the wrapper's own requests (a relay card's), never the CLI's. */
  readonly ours: (id: string) => boolean;
  /**
   * The answers t3 recorded on the question `requestId` when the Owner answered it, by question id; undefined when t3
   * holds none (it is not answered, or its store cannot be read).
   */
  readonly recordedAnswerOf: (requestId: string) => Readonly<Record<string, unknown>> | undefined;
  /** Whether the CLI takes a steer as an interrupt and a restart (Claude Code, OpenCode), not in place (Codex, pi). */
  readonly steerRestartsTurn: boolean;
}

/** A recorded answer's text, one line per question: an option's label, or the answers chosen, comma-separated. */
const replyOf = (answers: Readonly<Record<string, unknown>>): string =>
  Object.values(answers)
    .map((answer) => (Array.isArray(answer) ? answer.join(", ") : String(answer)))
    .join("\n");

/** The park of one CLI session: its timer, its parks, the CLI's own requests, and the answers that come back. */
export const parker = (deps: ParkerDeps) => {
  const natives = new Map<string, NativeRequest>();
  /** The CLI requests the live turn's park has parked or is parking: each parks once. */
  const parkedNatives = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The park ending the live turn, if any: what raises a card meanwhile parks it too. */
  let parking: ParkCause | undefined;
  /** How many more turn ends drop the thread's allowances (an answer's turn; a steered answer's, the restart's too). */
  let allowanceTurns = 0;

  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const disarmIfNone = () => {
    if (deps.cards.size === 0 && natives.size === 0) disarm();
  };
  /** Arms the park at the first open card: the turn parks once a card has waited Park after. Off (0) arms nothing. */
  const arm = () => {
    if (timer !== undefined || deps.live() === undefined || parking !== undefined) return;
    const ms = deps.parkAfterMs();
    if (ms <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void Effect.runPromise(park({ by: "park", minutes: ms / 60_000 }));
    }, ms);
  };

  /** A record of one card, and the question raising it again, not yet shown. */
  interface Planned {
    readonly card: ParkedCard;
    readonly title: string;
    readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
    /** Answers the card or request that parks: closes a relay card, cancels a CLI request. */
    readonly settle: Effect.Effect<void>;
  }

  const planCard = (id: string, card: ParkableCard, cause: ParkCause, parkedAt: number, nativeSession?: string) => {
    const { ask } = card;
    const note = parkedNote(cause);
    const body = ask.detail === "" ? ask.summary : `${ask.summary}\n\n${ask.detail}`;
    const questions =
      ask.questions !== undefined && ask.questions.length > 0
        ? ask.questions.map((question, index) =>
            index === 0 ? { ...question, question: `${question.question}\n\n${note}` } : question,
          )
        : [
            decisionQuestion(
              `${body}\n\n${note}`,
              ask.park.kind === "tool"
                ? PARK_OPTIONS
                : ask.park.kind === "change"
                  ? CHANGE_OPTIONS
                  : ask.options.map((option) => ({ label: option.label, description: option.label })),
            ),
          ];
    const parkedCard: ParkedCard = {
      id: newParkId(deps.driver),
      thread: deps.thread,
      kind: ask.park.kind,
      title: ask.title,
      ...(ask.park.kind === "tool" ? { call: ask.park.call } : { server: ask.park.server }),
      ...(ask.park.kind === "change" ? { changeId: ask.park.changeId } : {}),
      ...(nativeSession === undefined ? {} : { nativeSession }),
      parkedAt,
    };
    return {
      card: parkedCard,
      title: ask.title,
      questions,
      settle: Effect.sync(() =>
        deps.offer(deps.closeCard(id, { approved: false, parked: parkedCallText(cause, ask.park.kind) })),
      ),
    } satisfies Planned;
  };

  const planNative = Effect.fn("Park.planNative")(function* (
    requestId: string,
    native: NativeRequest,
    cause: ParkCause,
    parkedAt: number,
    nativeSession?: string,
  ) {
    const nativeId = native.request.nativeRequestRef?.nativeId ?? undefined;
    const whole = nativeId === undefined ? undefined : deps.nativeCallOf(nativeId);
    const call: ParkedCall | undefined =
      whole === undefined
        ? undefined
        : { tool: native.request.kind, argsHash: yield* Effect.promise(() => argsHashOf(whole)) };
    const title = native.title ?? `The agent's ${native.request.kind} request`;
    const prompt = native.prompt ?? "";
    return {
      card: {
        id: newParkId(deps.driver),
        thread: deps.thread,
        kind: "native",
        title,
        ...(call === undefined ? {} : { call }),
        ...(nativeSession === undefined ? {} : { nativeSession }),
        parkedAt,
      },
      title,
      questions: [
        decisionQuestion(`${prompt === "" ? title : `${title}\n\n${prompt}`}\n\n${parkedNote(cause)}`, PARK_OPTIONS),
      ],
      settle: Effect.gen(function* () {
        natives.delete(requestId);
        yield* deps.runtime
          .respondToRuntimeRequest({ requestId: RuntimeRequestId.make(requestId), decision: "cancel" })
          .pipe(Effect.ignore);
      }),
    } satisfies Planned;
  });

  /** Keeps every planned record in one transaction, or none: false when a write failed (logged). */
  const keepAll = (planned: ReadonlyArray<Planned>): boolean => {
    try {
      const store = deps.parked();
      if (store === undefined) throw new Error("no parked-card store");
      store.parkAll(planned.map((entry) => entry.card));
      return true;
    } catch (error) {
      workersLog("error", {
        t3flare: "cli-park-unkept",
        providerSessionId: deps.providerSessionId,
        cards: planned.length,
        error: String(error),
      });
      return false;
    }
  };

  /**
   * Keeps every planned record, then shows each question and settles each card; or, when the records cannot be kept,
   * none of them (the cards stay live) and false.
   */
  const commit = Effect.fn("Park.commit")(function* (turn: LiveTurn, planned: ReadonlyArray<Planned>) {
    if (!keepAll(planned)) return false;
    for (const entry of planned) {
      deps.offer(
        cardOf({
          driver: deps.driver,
          turn,
          id: RuntimeRequestId.make(entry.card.id),
          title: entry.title,
          answeredBy: "message",
          body: { type: "user_input_request", questions: entry.questions },
        }).events,
      );
      yield* entry.settle;
    }
    return true;
  });

  /**
   * The CLI's session a parked card waits on, as its files are named: Claude Code's native thread id is its session id;
   * pi's is its session file's path, whose base name (less `.jsonl`) names it.
   */
  const nativeSessionOf = (turn: LiveTurn): string | undefined => {
    const nativeId = turn.providerThread.nativeThreadRef?.nativeId;
    return nativeId === undefined || nativeId === null
      ? undefined
      : nativeId
          .split("/")
          .at(-1)!
          .replace(/\.jsonl$/, "");
  };

  /** Parks the turn's open cards and CLI requests, as `park` does; false when nothing was parked. */
  const parkOpen = Effect.fn("Park.parkOpen")(function* (turn: LiveTurn, cause: ParkCause) {
    const parkedAt = deps.now();
    const session = nativeSessionOf(turn);
    // Snapshots: a request raised while a call's hash is worked out is `noteNative`'s to park, once.
    const cards = Array.from(deps.cards);
    const requests = Array.from(natives);
    const planned: Array<Planned> = cards.map(([id, card]) => planCard(id, card, cause, parkedAt, session));
    for (const [requestId] of requests) parkedNatives.add(requestId);
    for (const [requestId, native] of requests)
      planned.push(yield* planNative(requestId, native, cause, parkedAt, session));
    return yield* commit(turn, planned);
  });

  /**
   * Parks the live turn: every open card and pending CLI request, then the turn and the process. Nothing is parked when a
   * record cannot be kept: every card stays live.
   */
  const park = Effect.fn("Park.park")(function* (cause: ParkCause) {
    disarm();
    const turn = deps.live();
    if (turn === undefined || parking !== undefined || (deps.cards.size === 0 && natives.size === 0)) return;
    // From here, a card or request raised before the turn ends is parked too (`cardOpened`, `noteNative`). A park that
    // keeps nothing, or fails on the way, lets them be again (`parking` cleared).
    parking = cause;
    const parked = yield* parkOpen(turn, cause).pipe(Effect.exit);
    if (parked._tag === "Failure" || !parked.value) {
      parking = undefined;
      parkedNatives.clear();
      return;
    }
    workersLog("log", {
      t3flare: "cli-parked",
      by: cause.by,
      providerSessionId: deps.providerSessionId,
      key: deps.processKey(),
    });
    // The turn ends, and the process with it (not after the idle hold), so nothing holds the Container. The
    // interrupt only lets the CLI end its turn cleanly first; the kill ends it either way.
    if (turn.providerTurnId !== undefined)
      yield* deps.runtime
        .interruptTurn({ providerThread: turn.providerThread, providerTurnId: turn.providerTurnId })
        .pipe(Effect.timeout(PARK_INTERRUPT_MS), Effect.ignore);
    deps.kill();
  });

  /**
   * Raises a parked card's question again on the live turn as `questions`, a new parked card, and drops the old record
   * if it is still kept: false when no turn is live or the new record cannot be kept (the old record stays then).
   */
  const raiseAgain = Effect.fn("Park.raiseAgain")(function* (
    card: ParkedCard,
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  ) {
    const turn = deps.live();
    if (turn === undefined) return false;
    const asked = yield* commit(turn, [
      { card: { ...card, id: newParkId(deps.driver) }, title: card.title, questions, settle: Effect.void },
    ]);
    if (!asked) return false;
    // A record that cannot be dropped stays: its question was answered, and nothing answers it again.
    yield* Effect.try({ try: () => deps.parked()?.discard(card.id), catch: () => "undropped" }).pipe(Effect.ignore);
    return true;
  });

  /** Asks a parked card's question again when its answer could not be read (`raiseAgain`). */
  const askAgain = (card: ParkedCard) => {
    const text = `${card.title}\n\nYour earlier answer to this parked card could not be read: answer it again.`;
    return raiseAgain(
      card,
      card.kind === "question"
        ? [
            {
              id: "answer",
              header: "Parked",
              question: text,
              options: [],
              allowCustomAnswer: true,
              required: true,
            } as unknown as OrchestrationV2UserInputQuestion,
          ]
        : [decisionQuestion(text, card.kind === "change" ? CHANGE_OPTIONS : PARK_OPTIONS)],
    );
  };

  /** A card or request raised while the park ends the turn: parked as the others were. */
  const parkLate = Effect.fn("Park.parkLate")(function* (
    planned: (turn: LiveTurn, cause: ParkCause) => Effect.Effect<Planned>,
  ) {
    const turn = deps.live();
    const cause = parking;
    if (turn === undefined || cause === undefined) return;
    yield* commit(turn, [yield* planned(turn, cause)]);
  });

  return {
    park,
    /** A relay card opened: parked at once while a park ends the turn, else the park's timer armed. */
    cardOpened: (id: string) => {
      const card = deps.cards.get(id);
      if (parking === undefined || card === undefined) return arm();
      void Effect.runPromise(
        parkLate((turn, cause) => Effect.succeed(planCard(id, card, cause, deps.now(), nativeSessionOf(turn)))),
      );
    },
    cardClosed: disarmIfNone,
    /** Whether a card or request is open: a Turn limit then parks instead of only ending the process. */
    anyOpen: () => deps.cards.size + natives.size > 0,
    /** Follows the CLI's own requests: a pending one arms the park (or is parked, while a park ends the turn). */
    noteNative: (event: ProviderAdapter.ProviderAdapterV2Event) => {
      if (event.type === "runtime_request.updated" && !deps.ours(event.runtimeRequest.id)) {
        const request = event.runtimeRequest;
        if (request.status === "pending" && request.responseCapability.type === "live") {
          const known = natives.get(request.id);
          const native: NativeRequest = { request, title: known?.title, prompt: known?.prompt };
          natives.set(request.id, native);
          if (parking === undefined) arm();
          else if (!parkedNatives.has(request.id)) {
            parkedNatives.add(request.id);
            void Effect.runPromise(
              parkLate((turn, cause) => planNative(request.id, native, cause, deps.now(), nativeSessionOf(turn))),
            );
          }
        } else {
          natives.delete(request.id);
          disarmIfNone();
        }
      }
      if (
        event.type === "turn_item.updated" &&
        event.turnItem.type === "approval_request" &&
        !deps.ours(event.turnItem.requestId)
      ) {
        const native = natives.get(event.turnItem.requestId);
        if (native !== undefined) {
          native.title = event.turnItem.title ?? undefined;
          native.prompt = event.turnItem.prompt;
        }
      }
    },
    /**
     * A CLI request the Owner allowed on its parked question: answered as allowed, once, when the repeat's whole call
     * (read off the process) matches the parked one's. A request whose call cannot be read is the Owner's again.
     */
    allowNative: Effect.fn("Park.allowNative")(function* (event: ProviderAdapter.ProviderAdapterV2Event) {
      if (event.type !== "runtime_request.updated" || deps.ours(event.runtimeRequest.id)) return;
      const request = event.runtimeRequest;
      if (request.status !== "pending" || request.responseCapability.type !== "live") return;
      const nativeId = request.nativeRequestRef?.nativeId ?? undefined;
      const whole = nativeId === undefined ? undefined : deps.nativeCallOf(nativeId);
      const store = deps.parked();
      if (whole === undefined || store === undefined) return;
      const call: ParkedCall = { tool: request.kind, argsHash: yield* Effect.promise(() => argsHashOf(whole)) };
      const allowed = store.take(deps.thread, "native", call);
      if (allowed === undefined) return;
      workersLog("log", { t3flare: "cli-park-allowance", providerSessionId: deps.providerSessionId, native: true });
      yield* deps.runtime
        .respondToRuntimeRequest({
          requestId: request.id,
          decision: allowed.forSession ? "acceptForSession" : "accept",
        })
        .pipe(Effect.ignore);
    }),
    /**
     * The text an answer message gives the agent: a parked card's answer becomes what to repeat, and its allow a
     * one-time allowance. Any other message as it is. `steered`: the answer goes into a running turn.
     *
     * The answer is the one t3 recorded on the question (`recordedAnswerOf`), never the message's text: a queued
     * message's text can be edited before its turn starts. A parked question whose answer t3 holds no readable record of
     * is asked again as a new parked question (`askAgain`), and the message passes as it is when that cannot be done.
     */
    answerText: Effect.fn("Park.answerText")(function* (
      message: { readonly messageId: string; readonly text: string },
      steered: boolean,
    ) {
      const id = message.messageId.startsWith(ASYNC_ANSWER) ? message.messageId.slice(ASYNC_ANSWER.length) : "";
      if (!id.startsWith(parkRequestPrefix(deps.driver))) return message.text;
      const store = deps.parked();
      const card = store?.get(id);
      if (store === undefined || card === undefined) return message.text;
      const answers = deps.recordedAnswerOf(id);
      if (answers === undefined) {
        // t3 resolved the question (its answer message is here) but its answer cannot be read: the card is asked again on
        // the live turn. With no live turn, or a new record that cannot be kept, it stays parked against the question t3
        // already resolved, and the message passes as it is (logged, `asked: false`).
        const asked = yield* askAgain(card);
        workersLog("warn", { t3flare: "cli-park-answer-unread", providerSessionId: deps.providerSessionId, asked });
        return asked
          ? `The owner's answer to what parked your turn (${card.title}) could not be read, so they are asked again. Do not repeat it until their answer comes.`
          : message.text;
      }
      const reply = replyOf(answers);
      const decision: ParkedDecision = card.kind === "question" ? "decline" : parkedDecisionOf(card.kind, reply);
      store.answer(id, decision);
      // A steered answer reaches a CLI that restarts on a steer (Claude Code, OpenCode) as an interrupt and a restart:
      // its allowance outlives the interrupted turn's end, for the restarted turn. Codex and pi steer in place.
      allowanceTurns = Math.max(allowanceTurns, steered && deps.steerRestartsTurn ? 2 : 1);
      const changed =
        card.kind === "change" && card.changeId !== undefined
          ? yield* Effect.promise(() =>
              deps
                .answerParkedChange(card.changeId!, decision !== "decline")
                .catch((error: unknown): ParkedChangeAnswer => ({
                  kind: "outcome",
                  text: `it could not be answered (${String(error)})`,
                })),
            )
          : undefined;
      if (changed?.kind === "page-only") {
        // SPI-1435: an Approve on a change approved on its Change page only changed nothing. Its question is raised
        // again, a new parked record on the same change, so the Owner can still answer, and a page answer reaches the
        // agent once through it (`parkedChanges.ts`). The record answered above is gone already.
        const raised = yield* raiseAgain(card, [
          decisionQuestion(pageOnlyQuestionText(card.title, changed.text), PAGE_ONLY_OPTIONS),
        ]);
        workersLog(raised ? "log" : "warn", { t3flare: "cli-park-page-only", kind: card.kind, raised });
        return pageOnlyTurnText(card.title, changed.text, raised);
      }
      workersLog("log", { t3flare: "cli-park-answered", kind: card.kind, decision });
      return answerTurnText(card, decision, reply, changed?.text);
    }),
    /** The live turn ended: its park is done, and an answer turn's unused allowance goes once its turns are over. */
    turnEnded: () => {
      parking = undefined;
      natives.clear();
      parkedNatives.clear();
      disarm();
      if (allowanceTurns === 0) return;
      allowanceTurns -= 1;
      if (allowanceTurns > 0) return;
      try {
        deps.parked()?.dropAllowances(deps.thread);
      } catch {
        // A store that cannot be read drops nothing; the thread's next answer turn's end tries again.
      }
    },
    dispose: disarm,
  };
};
