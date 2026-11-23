// What one Durable Object KV value holds (SPI-1365): the Environment settings, the Model endpoints and the audit log are
// each one value, so their size, not a count of what is in them, is what a write can run out of.

/**
 * The most bytes one Durable Object KV value takes: Cloudflare refuses a key and value over 8 MB together
 * (developers.cloudflare.com/durable-objects/platform/limits, read 2026-11-23), read as 8,000,000 bytes, the lower of
 * 8 MB and 8 MiB. Less a margin for the key. A named constraint.
 */
export const DO_VALUE_BYTES = 8_000_000 - 1024;

/**
 * At most the bytes `value` takes stored: two per character of its JSON. The KV API stores a value with V8's serializer,
 * which keeps a string as one or two bytes per UTF-16 unit, an object's key as a string with a short tag, and a number
 * in at most nine bytes. Twice the JSON is above that for the values measured here, where every number is under an
 * object key: the key's quotes and colon, doubled, outweigh the most a number takes beyond twice its own JSON.
 */
export const storedBytes = (value: unknown): number => 2 * (JSON.stringify(value)?.length ?? 0);

/** Whether `value` fits one Durable Object KV value (`storedBytes` at most `DO_VALUE_BYTES`). */
export const fitsStoredValue = (value: unknown): boolean => storedBytes(value) <= DO_VALUE_BYTES;
