// The retries a turn's start carries (SPI-1367): how many times the Durable agent tries a failed model request again
// (pi-durable's `settings.retry`, the Environment's `durableRetries`) and how many kills a stopped command's surviving
// processes get (`killAttempts`). Kept in the Session's storage, as the latest start carried them: pi-durable reads its
// settings at each use and a kill is retried from the alarm, both after the turn's start, and after a restart too.
import { DEFAULT_DURABLE_RETRIES, DEFAULT_KILL_ATTEMPTS } from "@t3flare/harness-registry";
import type { SubmitTurnInput } from "@t3flare/session-protocol";

const KEY = "t3flare:turn-retries";

export interface TurnRetries {
  readonly durableRetries: number;
  readonly killAttempts: number;
}

interface Storage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** What the latest turn's start carried, each else its default (an Environment before SPI-1367). */
export const keptTurnRetries = (kv: Storage): TurnRetries => ({
  durableRetries: DEFAULT_DURABLE_RETRIES,
  killAttempts: DEFAULT_KILL_ATTEMPTS,
  ...kv.get<Partial<TurnRetries>>(KEY),
});

/** Keeps what a turn's start carried; a value it does not carry stays as kept. */
export const keepTurnRetries = (kv: Storage, input: Pick<SubmitTurnInput, "durableRetries" | "killAttempts">): void => {
  const carried = {
    ...(input.durableRetries === undefined ? {} : { durableRetries: input.durableRetries }),
    ...(input.killAttempts === undefined ? {} : { killAttempts: input.killAttempts }),
  };
  if (Object.keys(carried).length > 0) kv.put(KEY, { ...kv.get<Partial<TurnRetries>>(KEY), ...carried });
};
