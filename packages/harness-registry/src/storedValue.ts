// What one Durable Object KV value holds (SPI-1365): the Environment settings, the Model endpoints and the audit log are
// each one value, so their size, not a count of what is in them, is what a write can run out of.

/**
 * The most bytes one Durable Object KV value takes: Cloudflare refuses a key and value over 8 MB together
 * (developers.cloudflare.com/durable-objects/platform/limits, read 2026-11-23), read as 8,000,000 bytes, the lower of
 * 8 MB and 8 MiB. Less a margin for the key. A named constraint.
 */
export const DO_VALUE_BYTES = 8_000_000 - 1024;

/**
 * At most the bytes `value` takes stored, three per character of its JSON, whichever way it is stored:
 *
 * - as JSON text in a SQLite row (an Open change's record) or a request body: UTF-8 takes at most three bytes for a
 *   UTF-16 unit;
 * - as a KV value, which V8's serializer stores: a string as one or two bytes per UTF-16 unit, an object's key as a
 *   string with a short tag, a number in at most nine bytes. Three times the JSON is above that for the values measured
 *   here, where every number is under an object key: the key's quotes and colon outweigh what a number takes beyond its
 *   own JSON.
 */
export const storedBytes = (value: unknown): number => 3 * (JSON.stringify(value)?.length ?? 0);

/** What one character of a list's JSON (a bracket, a separating comma) adds to its `storedBytes`. */
export const STORED_CHARACTER_BYTES = 3;

/**
 * Why `value` cannot be stored as one Durable Object value (`what` names it: "the Environment settings"), or undefined
 * when it fits `DO_VALUE_BYTES`.
 */
export const storedValueProblem = (what: string, value: unknown): string | undefined => {
  const bytes = storedBytes(value);
  return bytes > DO_VALUE_BYTES
    ? `${what} would take ${bytes} bytes stored, past the ${DO_VALUE_BYTES} one Durable Object value holds`
    : undefined;
};
