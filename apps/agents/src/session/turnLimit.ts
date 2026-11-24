// The Turn limit on the Durable agent (SPI-1315, ADR-0032's SPI-1315 refinement): the Environment reads the Owner's
// `turnLimitMinutes` at each turn's start and carries it with `submitTurn`; the Session keeps it on the turn's record
// (`TurnState.turnLimitMs`), so the alarm ends each turn at its own start plus its own limit, and a setting lowered
// while a turn runs reaches only the thread's next turn. A limit of 0 is off (the default, SPI-1386): the turn arms no
// alarm and is never ended for its length. The deploy's `T3FLARE_TURN_DEADLINE_MS` (tests and the stage's Turn limit
// check) wins over both.
//
// The Session's three steps live here, and SessionDO calls them as they are: the record `submitTurn` keeps
// (`turnRecord`), the times `#arm` adds to the alarm's candidates (`turnLimitAlarms`), and the turns the alarm's
// housekeeping ends (`turnsPastLimit`). The agents Worker has no workerd harness for a whole SessionDO.
import { DEFAULT_TURN_LIMIT_MS } from "@t3flare/harness-registry";
import type { TurnState } from "@t3flare/session-protocol";

import { positiveOverride } from "../envOverride.ts";

/** A turn the Session still runs or waits to run. */
export const isLiveTurn = (turn: TurnState): boolean => turn.status === "queued" || turn.status === "running";

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** A turn's limit that is off (SPI-1386, the setting's 0): the turn arms no alarm and is never ended for its length. */
export const TURN_LIMIT_OFF = 0;

/** A carried limit as the turn keeps it: off when it says off, its value when positive, else the default (itself off). */
const carriedLimit = (carried: unknown): number =>
  carried === TURN_LIMIT_OFF ? TURN_LIMIT_OFF : (positive(carried) ?? DEFAULT_TURN_LIMIT_MS);

/**
 * A turn's limit in ms, `TURN_LIMIT_OFF` when off: the deploy's override when set, else what the turn's start carried,
 * else the default (off; a start from an Environment before the setting, or a turn recorded before it). Validation keeps
 * the alarm working only: the Owner's bounds were checked when the setting was saved.
 */
export const turnLimitAt = (carried: unknown, override: string | undefined): number =>
  positiveOverride(override) ?? carriedLimit(carried);

/** When the turn's limit ends it: its start plus the limit it started with; undefined when its limit is off. */
export const turnLimitEndsAt = (
  turn: Pick<TurnState, "startedAt" | "turnLimitMs">,
  override: string | undefined,
): number | undefined => {
  const limit = turnLimitAt(turn.turnLimitMs, override);
  return limit === TURN_LIMIT_OFF ? undefined : turn.startedAt + limit;
};

/** When a live turn's limit ends it; undefined for a turn not live or whose limit is off. */
const liveTurnEndsAt = (turn: TurnState, override: string | undefined): number | undefined =>
  isLiveTurn(turn) ? turnLimitEndsAt(turn, override) : undefined;

/** The record `submitTurn` keeps for a new turn, before its submission: queued, with the limit its start carried. */
export const turnRecord = (
  input: { readonly runId: string; readonly attemptId: string; readonly turnLimitMs?: number },
  startedAt: number,
  override: string | undefined,
): TurnState => ({
  submissionId: "",
  runId: input.runId,
  attemptId: input.attemptId,
  status: "queued",
  startedAt,
  turnLimitMs: turnLimitAt(input.turnLimitMs, override),
});

/** A Session's turns as `[id, turn]` pairs: the live ones (`TurnStore.live`), or any others. */
export type TurnEntries = ReadonlyArray<readonly [string, TurnState]>;

/** When each live turn's own limit ends it, for those whose limit is on: what `#arm` adds to the alarm's candidates. */
export const turnLimitAlarms = (turns: TurnEntries, override: string | undefined): Array<number> =>
  turns.flatMap(([, turn]) => {
    const endsAt = liveTurnEndsAt(turn, override);
    return endsAt === undefined ? [] : [endsAt];
  });

/** The live turns past their own limit at `now`: what the alarm's housekeeping ends (`turn_deadline`). */
export const turnsPastLimit = (turns: TurnEntries, now: number, override: string | undefined): Array<string> =>
  turns
    .filter(([, turn]) => {
      const endsAt = liveTurnEndsAt(turn, override);
      return endsAt !== undefined && now >= endsAt;
    })
    .map(([id]) => id);
