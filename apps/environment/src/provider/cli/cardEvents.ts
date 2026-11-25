// The cards the CLI wrapper raises on a thread's live turn as t3 shows them (ADR-0028, SPI-1389): one runtime request, its
// node and its turn item. A relay card is a live approval or `user_input` request the wrapper answers; a parked card's
// question is a non-blocking `user_input` request t3 answers with a message.
import {
  type NodeId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderRequestKind,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

/** The live turn a card is raised on: what `startTurn` said, and the provider turn id its events gave. */
export interface LiveTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  providerTurnId: ProviderTurnId | undefined;
  /** The highest turn item ordinal seen on the turn; a card takes the next. */
  ordinal: number;
}

/** What a card asks: an approval (its kind, text and buttons), or `user_input` questions. */
export type CardBody =
  | {
      readonly type: "approval_request";
      readonly requestKind: ProviderRequestKind;
      readonly prompt: string;
      readonly options?: ReadonlyArray<{ readonly decision: string; readonly label: string }>;
    }
  | { readonly type: "user_input_request"; readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> };

export interface CardShape {
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  /** The three events that raise it, in t3's order. */
  readonly events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
}

/**
 * A card `id` on `turn`, titled `title`: answered live through the session (`providerSessionId`), or as a message
 * (`"message"`: a parked card's question). Takes the turn's next item ordinal.
 */
export const cardOf = (input: {
  readonly driver: ProviderAdapter.ProviderAdapterV2Event["driver"];
  readonly turn: LiveTurn;
  readonly id: RuntimeRequestId;
  readonly title: string;
  readonly answeredBy: { readonly providerSessionId: string } | "message";
  readonly body: CardBody;
}): CardShape => {
  const { driver, turn, id, body } = input;
  const form = body.type === "user_input_request";
  const nodeId = IdAllocator.derive.approvalNode({ requestId: id });
  const nativeItemRef = { driver, nativeId: id, strength: "weak" as const };
  const now = DateTime.nowUnsafe();
  turn.ordinal += 1;
  const providerTurnId = turn.providerTurnId ?? null;
  const runtimeRequest = {
    id,
    nodeId,
    providerTurnId,
    nativeRequestRef: nativeItemRef,
    kind: form ? "user_input" : body.requestKind,
    status: "pending",
    responseCapability:
      input.answeredBy === "message"
        ? { type: "message" }
        : { type: "live", providerSessionId: input.answeredBy.providerSessionId, supportsFeedback: false },
    createdAt: now,
    resolvedAt: null,
  } as OrchestrationV2RuntimeRequest;
  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: turn.threadId,
    runId: turn.runId,
    parentNodeId: turn.rootNodeId,
    rootNodeId: turn.rootNodeId,
    kind: form ? "user_input_request" : "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: turn.providerThreadId,
    providerTurnId,
    nativeItemRef,
    runtimeRequestId: id,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
  const turnItem = {
    id: IdAllocator.derive.approvalTurnItem({ requestId: id }),
    threadId: turn.threadId,
    runId: turn.runId,
    nodeId,
    providerThreadId: turn.providerThreadId,
    providerTurnId,
    nativeItemRef,
    parentItemId: null,
    ordinal: turn.ordinal,
    status: "waiting",
    title: input.title,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...(form
      ? {
          type: "user_input_request" as const,
          requestId: id,
          questions: body.questions.map((question) => ({ ...question, options: [...question.options] })),
        }
      : {
          type: "approval_request" as const,
          requestId: id,
          requestKind: body.requestKind,
          prompt: body.prompt,
          ...(body.options === undefined || body.options.length === 0 ? {} : { options: body.options }),
        }),
  } as OrchestrationV2TurnItem;
  return {
    runtimeRequest,
    node,
    turnItem,
    events: [
      { type: "runtime_request.updated", driver, threadId: turn.threadId, runtimeRequest },
      { type: "node.updated", driver, node },
      { type: "turn_item.updated", driver, turnItem },
    ],
  };
};
