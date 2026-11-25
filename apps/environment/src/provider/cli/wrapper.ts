// @effect-diagnostics effectFnOpportunity:off cryptoRandomUUID:off
// The CLI adapters' wrapper (step 4a, plan §3 with review F1, F7, F10): t3's own Codex and Pi adapters, with what the
// Cloud Environment changes around them.
//
// - One process per provider session, so one Workspace per session (review F1): t3 reuses a live session for a second
//   thread when the adapter says `supportsMultipleProviderThreadsPerSession` (Orchestrator.ts `providerSessionIdFor`,
//   ProviderSessionManager `open`), which would run another project's thread in this Workspace's Container. The flag is
//   false both in `getCapabilities()` and on the session entity t3 keeps.
// - A fork into another Workspace is refused: the fork runs in the source's process, so in the source's Container.
// - t3's tools through the MCP relay (SPI-1039, `relayedMcp.ts`; OD-3 lifted); MCP apps and feedback uploads (to the
//   vendor) are gone.
// - The turn's state reaches the Workspace (`processTurn`): the Container's hold (review F7).
// - The Turn limit (ADR-0015, SPI-1315: `turnLimitMinutes`, read at each turn's start): a turn still running at the
//   limit it started with ends its process, and with it the session.
// - Events can be filtered (pi's "t3-code MCP unavailable" notice, review F10).
// - The thread's Workspace takes the Environment skill set before each turn (SPI-1153).
// - A tool call the MCP relay asks about (ADR-0028) is raised as t3's approval card on the thread's live turn: the
//   wrapper injects the request's events and answers it itself (`respondToRuntimeRequest`), never the CLI.
// - Park and resume (SPI-1389, `park.ts`): a card that has waited Park after on a live turn parks it, so the Container can
//   stop; the Owner's answer starts a new turn, which repeats the call it allowed once. A Turn limit hit while a card is
//   open parks too.
// - A failed turn on a Model endpoint shows the model relay's classification of the process's last answer, by the
//   endpoint's API and auth (SPI-1172, `relayFailure.ts`), in its terminal and its error items. A failed open (Claude
//   Code checks its key at open) carries the process's relay record too, as t3's open error's setup cause (SPI-1223).
import type { EndpointFailureRecord } from "@t3flare/session-protocol";
import { newHandle, toWorkspace } from "@t3flare/workspace-client";
import {
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderSessionId,
  ProviderSetupError,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { environmentServices, parkAfterMsNow, parkedCardsNow, turnLimitMsNow } from "../../agents/bindings.ts";
import type { ChannelProcess } from "../../agents/processChannel.ts";
import { type CliAnswer, type CliAsk, registerCliAsker } from "./cliAsk.ts";
import { takeEnvironmentSkillsAt } from "./environmentSkillsTake.ts";
import { cardOf, type LiveTurn } from "./cardEvents.ts";
import { parker, parkRequestPrefix } from "./park.ts";
import type { ParkedCards, ParkedChangeAnswer } from "./parked.ts";
import { failureOf, withRelayFailure } from "./relayFailure.ts";
import { workersLog } from "../../platform/workersLog.ts";

/** What t3flare knows of one CLI provider session: its process (the client factory's) and the thread's policy. */
export interface CliSession {
  /** t3's thread that opened the session. */
  readonly thread: string;
  process: ChannelProcess | undefined;
  runtimeMode: string | undefined;
  interactionMode: string | undefined;
  /** The Workspace the session's process runs in. */
  readonly workspace: string | null;
  turnActive: boolean;
  limitFiber: Fiber.Fiber<void> | undefined;
  /** The session's process's tool handle for the MCP relay (ADR-0028): 256 random bits, never logged. */
  readonly toolHandle: string;
  /** The model the session was opened with (SPI-1167: Codex's process provider is its model's). */
  model?: string;
}

/** Sessions of one driver instance, by provider session id: shared by its client factory and its wrapper. */
export type CliSessions = Map<string, CliSession>;

/**
 * The session whose adapter is opening now, for the spawner (`agents/cliProcess.ts`): t3's adapters spawn inside
 * `openSession`, so the spawn learns its thread and records its process on the session.
 */
export const CliSpawn = Context.Reference<CliSession | undefined>("t3flare/CliSpawn", {
  defaultValue: () => undefined,
});

export const sessionFor = (
  sessions: CliSessions,
  providerSessionId: string,
  cwd: string | null,
  thread: string,
): CliSession => {
  let session = sessions.get(providerSessionId);
  if (session === undefined) {
    session = {
      thread,
      process: undefined,
      runtimeMode: undefined,
      interactionMode: undefined,
      workspace: cwd === null ? null : (toWorkspace(cwd)?.id ?? null),
      turnActive: false,
      limitFiber: undefined,
      // One handle per session: were two of its processes ever live at once, the Workspace DO's `toolCaller` would name
      // the older.
      toolHandle: newHandle(),
    };
    sessions.set(providerSessionId, session);
  }
  return session;
};

/** The capabilities t3 sees for a CLI agent here. */
export const cliCapabilities = (
  capabilities: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities => ({
  ...capabilities,
  sessions: { ...capabilities.sessions, supportsMultipleProviderThreadsPerSession: false },
  // SPI-1039: t3's tools reach CLI agents through the relay (relayedMcp.ts), never with t3's bearer.
  tools: { ...capabilities.tools, supportsMcpTools: true },
});

const workspaceOf = (cwd: string | null | undefined): string | null =>
  cwd === null || cwd === undefined ? null : (toWorkspace(cwd)?.id ?? null);

export interface WrapOptions {
  readonly sessions: CliSessions;
  /** Drops an event before t3 sees it. */
  readonly dropEvent?: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean;
  /** SPI-1151: the turn's text as the CLI gets it, from the text and the thread's cwd (Claude Code's Skill mentions). */
  readonly rewriteTurnText?: (text: string, cwd: string | null) => Effect.Effect<string>;
  /**
   * SPI-1153: has the thread's Workspace take the Environment skill set before the turn, bounded and never failing it,
   * so the mount behind the CLI's link holds the current set when the turn runs (a running CLI process still lists
   * what it read at its start). The Environment's own take
   * (`takeEnvironmentSkillsAt`) unless a test replaces it: every CLI driver gets it without asking.
   */
  readonly takeEnvironmentSkills?: (cwd: string | null) => Effect.Effect<void>;
  /**
   * SPI-1315 (ADR-0015): the Turn limit in ms, read at each turn's start; a turn longer than the limit it started with
   * ends its process. Default: the Environment's `turnLimitMinutes` (`turnLimitMsNow`).
   */
  readonly turnLimitMs?: () => number;
  /** SPI-1172: the clock a usage limit's reset is held against (tests). */
  readonly now?: () => number;
  /** SPI-1172: the session's process's last model relay failure this turn. Default: asked of its Workspace DO. */
  readonly relayFailure?: (session: CliSession) => Promise<EndpointFailureRecord | null>;
  /**
   * SPI-1389: Park after in ms (0: never park). Default: the value the session's process was spawned with, which its MCP
   * tool timeout was made from, else Park after now.
   */
  readonly parkAfterMs?: (session: CliSession) => number;
  /** SPI-1389: where parked cards are kept. Default: the Environment DO's (`EnvironmentServices.parked`). */
  readonly parked?: () => ParkedCards | undefined;
  /** SPI-1389: answers a parked Open change. Default: the Environment DO's (`EnvironmentServices.answerParkedChange`). */
  readonly answerParkedChange?: (changeId: string, approve: boolean) => Promise<ParkedChangeAnswer>;
  /**
   * SPI-1435: reads a parked Open change again and, closed, brings its parked cards in line. Default: the Environment
   * DO's (`EnvironmentServices.recheckParkedChange`).
   */
  readonly recheckParkedChange?: (changeId: string) => Promise<void>;
  /**
   * SPI-1389: the CLI's own request's whole call by its native id. Default: what the session's process's stdout gave
   * (`ChannelProcess.nativeCalls`).
   */
  readonly nativeCallOf?: (session: CliSession, nativeId: string) => unknown;
  /**
   * SPI-1389: the answers t3 recorded on a parked card's question. Default: t3's own record of the request
   * (`recordedAnswerOf`), in the Environment DO's SQLite.
   */
  readonly recordedAnswerOf?: (requestId: string) => Readonly<Record<string, unknown>> | undefined;
  /**
   * SPI-1389: whether the CLI takes a steer as an interrupt and a restart (the ACP CLIs: Claude Code and OpenCode), so a
   * steered answer's allowance outlives the interrupted turn. Default: it steers in place.
   */
  readonly steerRestartsTurn?: boolean;
}

/**
 * The answers t3 recorded on its runtime request `requestId` when it was answered (t3's projection of the request, in
 * the Environment DO's SQLite, written with the answer's message in one transaction); undefined when it holds none.
 */
export const recordedAnswerOf = (requestId: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const row = environmentServices()
      .sql.exec<{ status: string; answers: string | null }>(
        "SELECT status, json_extract(payload_json, '$.answers') AS answers FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ?",
        requestId,
      )
      .toArray()[0];
    if (row === undefined || row.status !== "resolved" || row.answers === null) return undefined;
    const answers = JSON.parse(row.answers) as unknown;
    return typeof answers === "object" && answers !== null ? (answers as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The turn t3's adapter is starting now (SPI-1151): its thread's cwd, for a prompt builder that t3's adapter gives no
 * cwd (OpenCode's Skill embed, its flavor's `rewriteUserText`). Set around the adapter's `startTurn`.
 */
export const CliTurn = Context.Reference<{ readonly cwd: string | null } | undefined>("t3flare/CliTurn", {
  defaultValue: () => undefined,
});

/** A relay card waiting on the owner (ADR-0028). */
interface OpenCard {
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  readonly answer: (answer: CliAnswer) => void;
  /** A `user_input` card (an MCP server's form, SPI-1079): answered with `answers`. */
  readonly form: boolean;
  /** What was asked: a park raises it again as a question (SPI-1389). */
  readonly ask: CliAsk;
}

/** t3's runtime request id of a card: never one of the CLI's own (its adapter answers those). */
const cardRequestPrefix = (driver: string) => `runtime-request:${driver}:t3flare-ask:`;

const answerOf = (decision: ProviderApprovalDecision): CliAnswer =>
  decision === "acceptForSession"
    ? { approved: true, forSession: true, decision }
    : decision === "accept" || decision === "acceptAlways"
      ? { approved: true, decision: "accept" }
      : { approved: false, reason: decision, decision: decision === "decline" ? "decline" : "cancel" };

/**
 * A spawn the Environment refused (`cliProcess.ts` `refused`: a `PermissionDenied` spawn error, `t3flare: <why>`) anywhere
 * in an error's cause chain: its reason, our own text (SPI-1176: no Model endpoint serves the CLI). Else undefined.
 */
export const spawnRefusalOf = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  let node = error;
  // To the chain's end: a finite chain ends, and `seen` ends a cycle (SPI-1366: no depth bound).
  while (typeof node === "object" && node !== null && !seen.has(node)) {
    seen.add(node);
    const reason = (node as { reason?: { _tag?: unknown; module?: unknown; method?: unknown; description?: unknown } })
      .reason;
    if (
      (node as { _tag?: unknown })._tag === "PlatformError" &&
      reason?._tag === "PermissionDenied" &&
      reason.module === "ChildProcess" &&
      reason.method === "spawn" &&
      typeof reason.description === "string" &&
      reason.description.startsWith("t3flare: ")
    ) {
      return reason.description.slice("t3flare: ".length);
    }
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * t3's open error with `detail` as its failure text: a `ProviderSetupError` under it, a cause t3's failure text reads
 * through (`knownProviderFailureMessage`), not "Failed to open ... session" (U85).
 */
const underSetupError = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  providerSessionId: ProviderSessionId,
  detail: string,
  cause: unknown,
): ProviderAdapter.ProviderAdapterV2Error =>
  new ProviderAdapter.ProviderAdapterOpenSessionError({
    driver,
    providerSessionId,
    cause: new ProviderSetupError({ instanceId, operation: "open-session", detail, cause }),
  });

/** An open that failed on a refused spawn, as t3 shows it: with the refusal as its failure text. Any other failure as it was. */
export const withSpawnRefusal =
  (instanceId: ProviderInstanceId, driver: ProviderDriverKind, providerSessionId: ProviderSessionId) =>
  (error: ProviderAdapter.ProviderAdapterV2Error): ProviderAdapter.ProviderAdapterV2Error => {
    const refusal = spawnRefusalOf(error);
    if (refusal === undefined) return error;
    const detail = /[.!?]$/.test(refusal) ? refusal : `${refusal}.`;
    return underSetupError(instanceId, driver, providerSessionId, detail, error);
  };

/** t3's adapter, as the Cloud Environment runs it. */
export const wrapCliAdapter = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  options: WrapOptions,
): ProviderAdapter.ProviderAdapterV2["Service"] => {
  const { sessions } = options;
  const takeEnvironmentSkills = options.takeEnvironmentSkills ?? ((cwd: string | null) => takeEnvironmentSkillsAt(cwd));
  const now = options.now ?? Date.now;
  const turnLimitMs = options.turnLimitMs ?? turnLimitMsNow;
  const relayFailure =
    options.relayFailure ?? (async (session: CliSession) => (await session.process?.modelFailure()) ?? null);
  const parkAfterMs =
    options.parkAfterMs ?? ((session: CliSession) => session.process?.parkAfterMs ?? parkAfterMsNow());
  const parked = options.parked ?? parkedCardsNow;
  const nativeCallOf =
    options.nativeCallOf ?? ((session: CliSession, nativeId: string) => session.process?.nativeCalls?.callOf(nativeId));
  const answerParkedChange =
    options.answerParkedChange ??
    (async (changeId: string, approve: boolean): Promise<ParkedChangeAnswer> => {
      const answer = environmentServices().answerParkedChange;
      if (answer === undefined) return { kind: "outcome", text: "read the settings to see whether it applied" };
      return answer(changeId, approve);
    });
  const recheckParkedChange =
    options.recheckParkedChange ??
    (async (changeId: string) => {
      await environmentServices().recheckParkedChange?.(changeId);
    });
  /** SPI-1172: a failed turn's terminal or error item, with the relay's classification of the process's last answer. */
  const relayedEvent = (
    session: CliSession,
    event: ProviderAdapter.ProviderAdapterV2Event,
  ): Effect.Effect<ProviderAdapter.ProviderAdapterV2Event> =>
    failureOf(event) === undefined
      ? Effect.succeed(event)
      : Effect.promise(async () => withRelayFailure(event, await relayFailure(session), now()));
  const turnEnded = (session: CliSession) =>
    Effect.gen(function* () {
      if (!session.turnActive) return;
      session.turnActive = false;
      session.process?.turn(false);
      if (session.limitFiber !== undefined) yield* Fiber.interrupt(session.limitFiber);
      session.limitFiber = undefined;
    });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapter.instanceId,
    driver: adapter.driver,
    getCapabilities: () => adapter.getCapabilities().pipe(Effect.map(cliCapabilities)),
    planSelectionTransition: (input) => adapter.planSelectionTransition(input),
    openSession: (input) =>
      Effect.gen(function* () {
        const session = sessionFor(sessions, input.providerSessionId, input.runtimePolicy.cwd, input.threadId);
        session.runtimeMode = input.runtimePolicy.runtimeMode;
        session.interactionMode = input.runtimePolicy.interactionMode;
        session.model = input.modelSelection.model;
        // SPI-1223: an earlier open of this session that failed left its process here (the session leaves the map only
        // after a good open); this open's relay record is its own process's, so it starts with none.
        session.process = undefined;
        const runtime = yield* adapter.openSession(input).pipe(
          Effect.provideService(CliSpawn, session),
          // SPI-1223: a refused spawn shows its refusal (it has no process, so no relay record); any other failed open
          // shows its process's relay record, if any. Only a failed open asks the Workspace, and `relayFailure` never
          // rejects.
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (spawnRefusalOf(error) !== undefined)
                return yield* withSpawnRefusal(adapter.instanceId, adapter.driver, input.providerSessionId)(error);
              const record = yield* Effect.promise(() => relayFailure(session));
              if (record === null) return yield* error;
              return yield* underSetupError(
                adapter.instanceId,
                adapter.driver,
                input.providerSessionId,
                record.message,
                error,
              );
            }),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(input.providerSessionId)));
        // G11: `mcpApps` passes through (Codex's App rendering, MCP apps through the relay); upload feedback stays off.
        const { uploadFeedback: _feedback, ...rest } = runtime;
        // ADR-0028: the relay's cards, raised on the live turn and closed by the owner's answer, the ask's withdrawal or the turn's end.
        const injected = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const cards = new Map<string, OpenCard>();
        let live: LiveTurn | undefined;
        const closeCard = (
          id: string,
          decision: ProviderApprovalDecision | null,
          answer: CliAnswer,
        ): Array<ProviderAdapter.ProviderAdapterV2Event> => {
          const card = cards.get(id);
          if (card === undefined) return [];
          cards.delete(id);
          park.cardClosed();
          card.answer(answer);
          const now = DateTime.nowUnsafe();
          const resolved = decision !== null;
          return [
            {
              type: "runtime_request.updated",
              driver: adapter.driver,
              threadId: card.node.threadId,
              runtimeRequest: {
                ...card.runtimeRequest,
                status: resolved ? "resolved" : "cancelled",
                resolvedAt: now,
                ...(decision === null ? {} : { decision }),
              },
            },
            {
              type: "node.updated",
              driver: adapter.driver,
              node: { ...card.node, status: resolved ? "completed" : "cancelled", completedAt: now },
            },
            {
              type: "turn_item.updated",
              driver: adapter.driver,
              turnItem: {
                ...card.turnItem,
                status: resolved ? "completed" : "cancelled",
                completedAt: now,
                updatedAt: now,
              } as OrchestrationV2TurnItem,
            },
          ];
        };
        const offer = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
          for (const event of events) Queue.offerUnsafe(injected, event);
        };
        const ours = (id: string) =>
          id.startsWith(cardRequestPrefix(adapter.driver)) || id.startsWith(parkRequestPrefix(adapter.driver));
        // SPI-1389: the park of this session's turns (`park.ts`).
        const park = parker({
          driver: adapter.driver,
          providerSessionId: input.providerSessionId,
          thread: session.thread,
          live: () => live,
          cards,
          closeCard: (id, answer) => closeCard(id, null, answer),
          offer,
          runtime,
          parkAfterMs: () => parkAfterMs(session),
          parked,
          answerParkedChange,
          recheckParkedChange,
          nativeCallOf: (nativeId) => nativeCallOf(session, nativeId),
          kill: () => session.process?.kill(),
          processKey: () => session.process?.key ?? null,
          now,
          ours,
          recordedAnswerOf: options.recordedAnswerOf ?? recordedAnswerOf,
          steerRestartsTurn: options.steerRestartsTurn === true,
        });
        const ask = (card: CliAsk, signal: AbortSignal): Promise<CliAnswer> =>
          new Promise((resolve) => {
            const turn = live;
            if (turn === undefined || turn.providerTurnId === undefined || !session.turnActive)
              return resolve({ approved: false, reason: "no live turn to ask on" });
            if (signal.aborted) return resolve({ approved: false, reason: "withdrawn" });
            // An MCP question's card keeps its id (`t3flare-elicit-…`, SPI-1079): the Environment refuses an agent's
            // `t3_pending_request` on it. A tool card's id is new.
            const id = RuntimeRequestId.make(
              `${cardRequestPrefix(adapter.driver)}${card.requestKind === "mcp-elicitation" ? card.askId : crypto.randomUUID()}`,
            );
            const form = card.questions !== undefined && card.questions.length > 0;
            const shape = cardOf({
              driver: adapter.driver,
              turn,
              id,
              title: card.title,
              answeredBy: { providerSessionId: input.providerSessionId },
              body: form
                ? {
                    type: "user_input_request",
                    questions: card.questions as ReadonlyArray<OrchestrationV2UserInputQuestion>,
                  }
                : {
                    type: "approval_request",
                    requestKind: card.requestKind ?? "permission",
                    prompt: card.detail === "" ? card.summary : `${card.summary}\n\n${card.detail}`,
                    options: card.options,
                  },
            });
            const onAbort = () => offer(closeCard(id, null, { approved: false, reason: "withdrawn" }));
            const answer = (value: CliAnswer) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            };
            const { runtimeRequest, node, turnItem } = shape;
            cards.set(id, { runtimeRequest, node, turnItem, answer, form, ask: card });
            signal.addEventListener("abort", onAbort, { once: true });
            offer(shape.events);
            park.cardOpened(id);
          });
        const unregister = registerCliAsker(session.thread, {
          ask,
          state: () => ({
            runtimeMode: session.runtimeMode,
            interactionMode: session.interactionMode,
            workspace: session.workspace,
          }),
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unregister();
            park.dispose();
            for (const id of cards.keys()) closeCard(id, null, { approved: false, reason: "the session ended" });
          }),
        );
        /** Follows the live turn's ids; at its end, its open cards close (before t3 sees the terminal). */
        const track = (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> => {
          const turn = live;
          if (turn === undefined) return [event];
          if (event.type === "provider_turn.updated" && event.providerTurn.nodeId === turn.rootNodeId)
            turn.providerTurnId = event.providerTurn.id;
          if (event.type === "turn_item.updated" && event.turnItem.runId === turn.runId)
            turn.ordinal = Math.max(turn.ordinal, event.turnItem.ordinal);
          park.noteNative(event);
          if (
            event.type !== "turn.terminal" ||
            (turn.providerTurnId !== undefined && event.providerTurnId !== turn.providerTurnId)
          )
            return [event];
          live = undefined;
          park.turnEnded();
          return [
            ...[...cards.keys()].flatMap((id) => closeCard(id, null, { approved: false, reason: "the turn ended" })),
            event,
          ];
        };
        const events = runtime.events.pipe(
          Stream.flatMap((event) => Stream.fromIterable(track(event))),
          Stream.tap((event) => park.allowNative(event).pipe(Effect.forkDetach)),
          Stream.mapEffect((event) => relayedEvent(session, event)),
          Stream.tap((event) => (event.type === "turn.terminal" ? turnEnded(session) : Effect.void)),
          Stream.filter((event) => options.dropEvent?.(event) !== true),
          Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
        );
        return {
          ...rest,
          providerSession: {
            ...runtime.providerSession,
            capabilities: cliCapabilities(runtime.providerSession.capabilities),
          },
          events,
          startTurn: (turn) =>
            Effect.gen(function* () {
              const cwd = turn.runtimePolicy.cwd ?? null;
              // SPI-1153: before the turn's hold and Turn limit, so an interrupt during the take's wait leaves neither behind.
              yield* takeEnvironmentSkills(cwd);
              session.runtimeMode = turn.runtimePolicy.runtimeMode;
              session.interactionMode = turn.runtimePolicy.interactionMode;
              session.turnActive = true;
              live = {
                threadId: turn.threadId,
                runId: turn.runId,
                rootNodeId: turn.rootNodeId,
                providerThreadId: turn.providerThread.id,
                providerThread: turn.providerThread,
                providerTurnId: undefined,
                // Wrapped adapters number their items from `providerTurnOrdinal * 100 + 1`; a card takes the highest emitted
                // plus one, and t3's position store orders items by first-seen.
                ordinal: turn.providerTurnOrdinal * 100,
              };
              session.process?.turn(true);
              if (session.limitFiber !== undefined) yield* Fiber.interrupt(session.limitFiber);
              session.limitFiber = undefined;
              // The Turn limit as it is now, kept by this turn's timer: a change reaches only the thread's next turn. At
              // most MAX_TIMED_MINUTES (7 days), under the 24.8 days past which a JS timer overflows. Off (0, the
              // default, SPI-1386): no timer is started. A card open at the limit parks the turn instead (SPI-1389).
              const limitMs = turnLimitMs();
              if (limitMs > 0)
                session.limitFiber = yield* Effect.sleep(limitMs).pipe(
                  Effect.andThen(
                    Effect.suspend(() => {
                      workersLog("warn", {
                        t3flare: "cli-turn-limit",
                        providerSessionId: input.providerSessionId,
                        key: session.process?.key ?? null,
                        parks: park.anyOpen(),
                      });
                      if (park.anyOpen()) return park.park({ by: "turn-limit", minutes: limitMs / 60_000 });
                      session.process?.kill();
                      return Effect.void;
                    }),
                  ),
                  Effect.forkDetach,
                );
              // SPI-1389: an answer to a parked card tells the agent what to repeat.
              const answered = yield* park.answerText(turn.message, false);
              const text =
                options.rewriteTurnText === undefined ? answered : yield* options.rewriteTurnText(answered, cwd);
              const sent = text === turn.message.text ? turn : { ...turn, message: { ...turn.message, text } };
              // A turn that never started ends here: no `turn.terminal` follows, and the hold and the Turn limit's timer would stay.
              yield* runtime.startTurn(sent).pipe(
                Effect.provideService(CliTurn, { cwd }),
                Effect.onError(() => turnEnded(session)),
              );
            }),
          // SPI-1389: a parked card's answer steered into a running turn tells the agent the same.
          steerTurn: (steer) =>
            Effect.gen(function* () {
              const text = yield* park.answerText(steer.message, true);
              yield* runtime.steerTurn(
                text === steer.message.text ? steer : { ...steer, message: { ...steer.message, text } },
              );
            }),
          respondToRuntimeRequest: (response) => {
            if (!response.requestId.startsWith(cardRequestPrefix(adapter.driver)))
              return runtime.respondToRuntimeRequest(response);
            if (!cards.has(response.requestId))
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: adapter.driver,
                  requestId: response.requestId,
                }),
              );
            // A form's card (SPI-1079) is answered with `answers`; t3 sends no decision with them.
            if (cards.get(response.requestId)?.form === true && response.answers !== undefined) {
              const answers = response.answers;
              return Effect.sync(() =>
                offer(closeCard(response.requestId, "accept", { approved: true, decision: "accept", answers })),
              );
            }
            const decision = response.decision ?? "cancel";
            return Effect.sync(() => offer(closeCard(response.requestId, decision, answerOf(decision))));
          },
          forkThread: (fork) => {
            const target = workspaceOf(fork.runtimePolicy?.cwd);
            if (target !== null && session.workspace !== null && target !== session.workspace) {
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: adapter.driver,
                  providerThreadId: fork.sourceProviderThread.id,
                  cause: `t3flare: a ${adapter.driver} thread forks only within its own Workspace (${session.workspace}), not into ${target}: each Workspace's CLI runs in its own Container`,
                }),
              );
            }
            return runtime.forkThread(fork);
          },
          // t3's ACP adapter rolls back by starting a replacement agent process (SPI-1037): it is spawned as the session's,
          // with its thread and tool handle, as `openSession`'s is.
          rollbackThread: (rollback) => runtime.rollbackThread(rollback).pipe(Effect.provideService(CliSpawn, session)),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
};
