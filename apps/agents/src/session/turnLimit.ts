// The Turn limit on the Durable agent (SPI-1315, ADR-0032's SPI-1315 refinement): the Environment reads the Owner's
// `turnLimitMinutes` at each turn's start and carries it with `submitTurn`; the Session keeps it on the turn's record
// (`TurnState.turnLimitMs`), so the alarm ends each turn at its own start plus its own limit, and a setting lowered
// while a turn runs reaches only the thread's next turn. The deploy's `T3FLARE_TURN_DEADLINE_MS` (tests and the stage's
// deadline check) wins over both.
import { TURN_DEADLINE_MS, type TurnState } from "@t3flare/session-protocol";

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/**
 * A turn's limit in ms: the deploy's override when set, else what the turn's start carried, else the default (a start
 * from an Environment before the setting, or a turn recorded before it). Validation keeps the alarm working only: the
 * Owner's bounds were checked when the setting was saved.
 */
export const turnLimitAt = (carried: unknown, override: string | undefined): number =>
  positive(override === undefined || override === "" ? undefined : Number(override)) ?? positive(carried) ?? TURN_DEADLINE_MS;

/** When the turn's limit ends it: its start plus the limit it started with. */
export const turnLimitEndsAt = (turn: Pick<TurnState, "startedAt" | "turnLimitMs">, override: string | undefined): number =>
  turn.startedAt + turnLimitAt(turn.turnLimitMs, override);

export const pastTurnLimit = (turn: Pick<TurnState, "startedAt" | "turnLimitMs">, now: number, override: string | undefined): boolean =>
  now >= turnLimitEndsAt(turn, override);
