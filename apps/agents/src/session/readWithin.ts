// @effect-diagnostics globalTimers:off
// A turn's start reads of the newest settings (SPI-1314): each waits at most the settings read wait, and its timer is
// cleared when the read wins, so a long wait leaves no timer pending after the turn has what it asked for.
import { DEFAULT_SETTINGS_READ_MS } from "@t3flare/harness-registry";
import type { SubmitTurnInput } from "@t3flare/session-protocol";

/** A turn's settings read wait: what its start carried, else the default (an Environment before SPI-1314). */
export const turnReadMs = (input: Pick<SubmitTurnInput, "settingsReadMs">): number =>
  input.settingsReadMs ?? DEFAULT_SETTINGS_READ_MS;

/** `read`'s answer, or undefined when it does not settle within `ms`. A failed read rejects, as `read` does. */
export const readWithin = async <T>(read: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
