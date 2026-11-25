// What the owner-only guard (`ownerOnly.ts`) reads of t3's state (SPI-1389), from t3's projections in the Environment
// DO's SQLite: which message a queued run will send, and whether a delegated task's threads hold a queued answer to a
// parked question. Each reads nothing before t3 has made its tables, or when they cannot be read: the guard then lets
// the call through to t3, as it did before t3flare parked anything.
import type { SqlStorage } from "@cloudflare/workers-types/index.ts";
import { PARK_QUESTION_MARKER } from "@t3flare/session-protocol";

import type { OwnerOnlyLookups } from "./ownerOnly.ts";

export const ownerOnlyLookupsOf = (sql: Pick<SqlStorage, "exec">): Required<OwnerOnlyLookups> => ({
  queuedMessageOf: (queuedRunId) => {
    try {
      const row = sql
        .exec<{ message: string | null }>(
          "SELECT json_extract(payload_json, '$.userMessageId') AS message FROM orchestration_v2_projection_runs WHERE run_id = ?",
          queuedRunId,
        )
        .toArray()[0];
      return row?.message ?? undefined;
    } catch {
      return undefined;
    }
  },
  // The task's thread and every thread under it (`task_cancel` stops them all), and a queued run among them whose message
  // answers a parked question.
  taskHoldsParkAnswer: (taskId) => {
    try {
      const row = sql
        .exec<{ held: number }>(
          `WITH RECURSIVE threads(id) AS (
             SELECT child_thread_id FROM orchestration_v2_projection_subagents
               WHERE subagent_id = ? AND child_thread_id IS NOT NULL
             UNION
             SELECT s.child_thread_id FROM orchestration_v2_projection_subagents s JOIN threads t ON s.thread_id = t.id
               WHERE s.child_thread_id IS NOT NULL
           )
           SELECT COUNT(*) AS held FROM orchestration_v2_projection_runs r JOIN threads t ON r.thread_id = t.id
           WHERE r.status = 'queued' AND json_extract(r.payload_json, '$.userMessageId') LIKE ?`,
          taskId,
          `async-answer:%${PARK_QUESTION_MARKER}%`,
        )
        .toArray()[0];
      return (row?.held ?? 0) > 0;
    } catch {
      return false;
    }
  },
});
