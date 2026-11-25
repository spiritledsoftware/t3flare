// SPI-1404: a CLI turn's park question (`provider/cli/park.ts`) as t3 holds it, and the two commands that settle it on
// the Owner's behalf when its Open change closed elsewhere (`provider/cli/parkedChanges.ts`). Both are stock t3:
// - `runtime-request.respond` with the question's answer, which resolves it and sends the agent t3's `async-answer`
//   message, as the Owner answering it does;
// - `thread.user-input.dismiss`, which resolves it as cancelled with no message and no turn.
// What this leans on in t3 is upstream-fragility U110; `test/parkQuestions.test.ts` pins it to t3's schema and DDL.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { CommandId, type OrchestrationV2Command, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "t3/src/orchestration-v2/ThreadManagementService.ts";

import { changeOptionLabel, PARK_DECISION_QUESTION } from "../provider/cli/park.ts";
import type { ParkedCard } from "../provider/cli/parked.ts";
import type { ParkQuestionState } from "../provider/cli/parkedChanges.ts";

/**
 * t3's park question `requestId`, read from its projection in `sql` (the Environment DO's SQLite). A request resolved,
 * expired or cancelled with no answers recorded is read as dismissed: only an answer records them.
 */
export const parkQuestionOf = (sql: Pick<SqlStorage, "exec">, requestId: string): ParkQuestionState => {
  const row = sql
    .exec<{ status: string; answers: string | null }>(
      "SELECT status, json_extract(payload_json, '$.answers') AS answers FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ?",
      requestId,
    )
    .toArray()[0];
  if (row === undefined) return "gone";
  if (row.status === "pending") return "pending";
  return row.answers === null ? "dismissed" : "answered";
};

/** The command answering `card`'s park question with its Approve or Decline option, as the Owner would on it. */
export const parkAnswerCommand = (card: ParkedCard, approve: boolean) =>
  ({
    type: "runtime-request.respond",
    commandId: CommandId.make(`command:t3flare-park-change-answer:${card.id}`),
    threadId: ThreadId.make(card.thread),
    requestId: RuntimeRequestId.make(card.id),
    answers: { [PARK_DECISION_QUESTION]: changeOptionLabel(approve) },
  }) satisfies OrchestrationV2Command;

/** The command dismissing `card`'s park question: no message, no turn. */
export const parkDismissCommand = (card: ParkedCard) =>
  ({
    type: "thread.user-input.dismiss",
    commandId: CommandId.make(`command:t3flare-park-change-dismiss:${card.id}`),
    threadId: ThreadId.make(card.thread),
    requestId: RuntimeRequestId.make(card.id),
  }) satisfies OrchestrationV2Command;

/** Runs `command` through t3's thread management, as a client's command runs. */
export const dispatchParkCommand = Effect.fn("ParkQuestions.dispatch")(function* (command: OrchestrationV2Command) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.dispatch(command);
});
