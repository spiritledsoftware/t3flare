// A deploy's numeric override (a `T3FLARE_*_MS` variable the tests and the stage checks set): it wins over a setting
// only when it is a positive number; unset, empty or anything else is no override.

/** `value` as a positive, finite number, else undefined. */
export const positiveOverride = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
