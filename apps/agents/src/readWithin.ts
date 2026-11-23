// @effect-diagnostics globalTimers:off
// A read of another object bounded by a wait (SPI-1314): a turn's reads of the newest settings, a Container start's read
// of the Environment settings and of the Builder. The timer is cleared when the read wins, so a long wait leaves no
// timer pending after the read answered.

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
