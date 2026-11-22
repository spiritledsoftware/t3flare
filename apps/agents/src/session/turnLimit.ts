// The Turn limit on the Durable agent (SPI-1315, ADR-0032's SPI-1315 refinement): the Environment reads the Owner's
// `turnLimitMinutes` at each turn's start and carries it with `submitTurn`; the Session keeps it on the turn's record
// (`TurnState.turnLimitMs`), so the alarm ends each turn at its own start plus its own limit, and a setting lowered
// while a turn runs reaches only the thread's next turn. The deploy's `T3FLARE_TURN_DEADLINE_MS` (tests and the stage's
// Turn limit check) wins over both.
//
// The Session's three steps live here, and SessionDO calls them as they are: the record `submitTurn` keeps
// (`turnRecord`), the times `#arm` adds to the alarm's candidates (`turnLimitAlarms`), and the turns the alarm's
// housekeeping ends (`turnsPastLimit`). The agents Worker has no workerd harness for a whole SessionDO.
import { DEFAULT_TURN_LIMIT_MS } from "@t3flare/harness-registry";
import type { TurnState } from "@t3flare/session-protocol";

/** A turn the Session still runs or waits to run. */
export const isLiveTurn = (turn: TurnState): boolean => turn.status === "queued" || turn.status === "running";

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/**
 * A turn's limit in ms: the deploy's override when set, else what the turn's start carried, else the default (a start
 * from an Environment before the setting, or a turn recorded before it). Validation keeps the alarm working only: the
 * Owner's bounds were checked when the setting was saved.
 */
export const turnLimitAt = (carried: unknown, override: string | undefined): number =>
  positive(override === undefined || override === "" ? undefined : Number(override)) ?? positive(carried) ?? DEFAULT_TURN_LIMIT_MS;

/** When the turn's limit ends it: its start plus the limit it started with. */
export const turnLimitEndsAt = (turn: Pick<TurnState, "startedAt" | "turnLimitMs">, override: string | undefined): number =>
  turn.startedAt + turnLimitAt(turn.turnLimitMs, override);

/** The record `submitTurn` keeps for a new turn, before its submission: queued, with the limit its start carried. */
export const turnRecord = (
  input: { readonly runId: string; readonly attemptId: string; readonly turnLimitMs?: number },
  startedAt: number,
  override: string | undefined,
): TurnState => ({ submissionId: "", runId: input.runId, attemptId: input.attemptId, status: "queued", startedAt, turnLimitMs: turnLimitAt(input.turnLimitMs, override) });

/** When each live turn's own limit ends it: what `#arm` adds to the alarm's candidates. */
export const turnLimitAlarms = (turns: Readonly<Record<string, TurnState>>, override: string | undefined): Array<number> =>
  Object.values(turns)
    .filter(isLiveTurn)
    .map((turn) => turnLimitEndsAt(turn, override));

/** The live turns past their own limit at `now`: what the alarm's housekeeping ends (`turn_deadline`). */
export const turnsPastLimit = (turns: Readonly<Record<string, TurnState>>, now: number, override: string | undefined): Array<string> =>
  Object.entries(turns)
    .filter(([, turn]) => isLiveTurn(turn) && now >= turnLimitEndsAt(turn, override))
    .map(([id]) => id);
