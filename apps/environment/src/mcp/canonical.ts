// Canonical JSON: object keys sorted at every depth, so equal values hash equally. One helper for the MCP host's tool
// definition hash and the Settings server's change hash and call digest, and a parked call's arguments' hash.
import { sha256Hex } from "@t3flare/skills";

/**
 * `value` as canonical JSON. A key whose value is `undefined` is dropped, as `JSON.stringify` drops it, unless
 * `keepUndefined`: then it is written `"key":undefined` (not JSON). Only the MCP host's `definitionHash` keeps them,
 * because the hashes it stored with every kept inventory were made that way, and a changed hash would ask the owner
 * again about every tool.
 */
export const canonicalJson = (value: unknown, keepUndefined = false): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map((item) => canonicalJson(item, keepUndefined)).join(",")}]`
      : `{${Object.keys(value as object)
          .sort()
          .filter((key) => keepUndefined || (value as Record<string, unknown>)[key] !== undefined)
          .map(
            (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], keepUndefined)}`,
          )
          .join(",")}}`;

/**
 * The hash a call's whole arguments are matched by (SPI-1389: a parked call's allowance): SHA-256 over their canonical
 * JSON, so key order does not matter and every value does.
 */
export const argsHashOf = (args: unknown): Promise<string> => sha256Hex(canonicalJson(args));
