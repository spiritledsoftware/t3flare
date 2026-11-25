// SPI-1404: a CLI turn's park question (`provider/cli/park.ts`) as t3 holds it, and the two commands that settle it on
// the Owner's behalf when its Open change closed elsewhere (`provider/cli/parkedChanges.ts`). Both are stock t3:
// - `runtime-request.respond` with the question's answer, which resolves it and sends the agent t3's `async-answer`
//   message, as the Owner answering it does;
// - `thread.user-input.dismiss`, which resolves it as cancelled with no message and no turn.
import type { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagementService from "t3/src/orchestration-v2/ThreadManagementService.ts";

import { changeOptionLabel, PARK_DECISION_QUESTION } from "../provider/cli/park.ts";
import type { ParkedCard } from "../provider/cli/parked.ts";
import type { ParkQuestion } from "../provider/cli/parkedChanges.ts";
import { environmentServices } from "./bindings.ts";

/** t3's park question `requestId`, read from its projection in the Environment DO's SQLite. */
export const parkQuestionOf = (requestId: string): ParkQuestion => {
  const row = environmentServices()
    .sql.exec<{ status: string; answers: string | null }>(
      "SELECT status, json_extract(payload_json, '$.answers') AS answers FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ?",
      requestId,
    )
    .toArray()[0];
  if (row === undefined) return "gone";
  if (row.status === "pending") return "pending";
  return row.answers === null ? "dismissed" : "answered";
};

/** Answers `card`'s park question with its Approve or Decline option, as the Owner would on the question. */
export const answerParkQuestion = Effect.fn("ParkQuestions.answer")(function* (card: ParkedCard, approve: boolean) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.dispatch({
    type: "runtime-request.respond",
    commandId: `command:t3flare-park-change-answer:${card.id}` as CommandId,
    threadId: card.thread as ThreadId,
    requestId: card.id as RuntimeRequestId,
    answers: { [PARK_DECISION_QUESTION]: changeOptionLabel(approve) },
  } as never);
});

/** Dismisses `card`'s park question: no message, no turn. */
export const dismissParkQuestion = Effect.fn("ParkQuestions.dismiss")(function* (card: ParkedCard) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.user-input.dismiss",
    commandId: `command:t3flare-park-change-dismiss:${card.id}` as CommandId,
    threadId: card.thread as ThreadId,
    requestId: card.id as RuntimeRequestId,
  } as never);
});
