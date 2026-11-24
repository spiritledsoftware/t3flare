// A setting's schema and its validation, shared by the Harness settings' extension registry (index.ts) and the
// Environment settings (environment.ts): the panel renders a form from each and the API validates against it.
import { normalizeVariables, type StoredVariable, variablesProblem } from "./variables.ts";

/** A setting's schema: the JSON Schema subset the panel renders as a form and the API validates against. */
export type FieldSchema =
  | { readonly type: "boolean"; readonly default: boolean }
  /**
   * `maximum`: a named constraint or a sanity bound (ADR-0048 §1); absent only where no value breaks anything (the
   * SPI-1368 refinement), and then any safe integer from `minimum` is taken.
   */
  | { readonly type: "integer"; readonly minimum: number; readonly maximum?: number; readonly default: number }
  /**
   * A number with no maximum of t3flare's (a custom Container size's resources, SPI-1365: Cloudflare's account limits
   * bound them, and refuse a start past them); `whole`: an integer only.
   */
  | { readonly type: "number"; readonly minimum: number; readonly whole?: boolean; readonly default: number }
  /**
   * `labels`: what the panel shows for a value, where its stored name is not words; the value itself otherwise.
   * `integers`: a whole number of at least `minimum`, written in digits, is a value too (the Advisor's cadence, SPI-1365).
   */
  | {
      readonly type: "enum";
      readonly values: ReadonlyArray<string>;
      readonly default: string;
      readonly labels?: Readonly<Record<string, string>>;
      readonly integers?: { readonly minimum: number };
    }
  /**
   * Free text (SPI-1058: guardian's rules and policy, typed as pi-guardian's menu takes them); `multiline` is a text area.
   * `maxLength`, in characters, only where a constraint sets one; without it the value that stores the setting bounds it
   * (SPI-1368).
   */
  | { readonly type: "text"; readonly maxLength?: number; readonly default: string; readonly multiline?: boolean }
  /**
   * The text of a file a Container gets (SPI-1150: the Global mise config): at most `maxBytes` of UTF-8, no NUL, line
   * ends stored as LF (`normalizeField`). The panel renders it as a monospace text area without `maxlength`, which would
   * count UTF-16 units; this check is the limit.
   */
  | { readonly type: "file"; readonly maxBytes: number; readonly default: string };

/**
 * An Environment setting's schema: a field's, or Variables (SPI-1152, ADR-0046): a list of `{ name, value, secret }`,
 * checked by `variablesProblem`, which the panel renders as a list. Harness settings hold scalars only.
 */
export type EnvironmentFieldSchema =
  | FieldSchema
  | { readonly type: "variables"; readonly default: ReadonlyArray<StoredVariable> }
  /**
   * A list of TCP ports (SPI-1364: the Container preview ports): 1 to `maxCount` distinct ports from 1 to 65535, none of
   * `reserved`. Stored ascending; the panel edits it as text ("3000, 5173"), which `normalizeField` reads.
   */
  | {
      readonly type: "ports";
      readonly maxCount: number;
      readonly reserved: ReadonlyArray<number>;
      readonly default: ReadonlyArray<number>;
    };

export type SettingValue = boolean | number | string;

/**
 * A value an Environment setting may hold: a Harness setting's, or a set of Variables (SPI-1152; ADR-0046's list, or the
 * old `{ NAME: "value" }` set a store may still hold).
 */
export type EnvironmentValue =
  | SettingValue
  | ReadonlyArray<StoredVariable>
  | Readonly<Record<string, string>>
  | ReadonlyArray<number>;

/**
 * A setting's Change tier rule (ADR-0035 §3, plan D5): `free` in either direction; `down-free` free when a boolean is
 * set to false or an integer lowered, asked the other way; `up-free` free when an integer is raised, asked when it is
 * lowered (ADR-0043 §6: the Grace, which destroys sooner when shorter). Absent: every change to it is asked.
 */
export type SettingTier = "free" | "down-free" | "up-free";

export interface SettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: FieldSchema;
  readonly tier?: SettingTier;
}

/** An Environment setting: a `SettingEntry` whose schema may also be Variables. */
export interface EnvironmentSettingEntry {
  readonly title: string;
  readonly description: string;
  readonly schema: EnvironmentFieldSchema;
  readonly tier?: SettingTier;
  /** The setting whose row on the Settings page this one joins (a file's own row), rather than the Containers row. */
  readonly row?: string;
}

const utf8 = new TextEncoder();

/** Why `text` cannot be a `file` field of at most `maxBytes`, or undefined. */
const fileProblem = (text: string, maxBytes: number): string | undefined => {
  if (text.includes("\u0000")) return "contains a NUL character";
  // A UTF-16 unit is at most 3 bytes of UTF-8 (a surrogate pair 4 for 2 units): only a long text needs encoding.
  if (text.length > maxBytes / 3 && utf8.encode(text).length > maxBytes)
    return `is longer than ${maxBytes} bytes of UTF-8`;
  return undefined;
};

/**
 * `value` as it is stored: a `file` field's line ends as LF, so a browser's CRLF round trip is never a change; the old
 * `{ NAME: "value" }` set of Variables as ADR-0046's list.
 */
export const normalizeField = (schema: EnvironmentFieldSchema, value: unknown): unknown => {
  if (schema.type === "file" && typeof value === "string") return value.replaceAll("\r\n", "\n");
  if (schema.type === "ports") return normalizePorts(value);
  return schema.type === "variables" ? normalizeVariables(value) : value;
};

/** Whether `value` is a whole number an enum with `integers` takes: digits, no leading zero, at least its minimum. */
const enumInteger = (schema: { readonly integers?: { readonly minimum: number } }, value: string): boolean =>
  schema.integers !== undefined &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= schema.integers.minimum;

/** Why `value` does not fit `schema`, or undefined. */
export const fieldProblem = (schema: EnvironmentFieldSchema, value: unknown): string | undefined => {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "true or false";
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return "an integer";
      if (value < schema.minimum) return `at least ${schema.minimum}`;
      return schema.maximum !== undefined && value > schema.maximum ? `at most ${schema.maximum}` : undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "a number";
      if (schema.whole === true && !Number.isSafeInteger(value)) return "a whole number";
      return value < schema.minimum ? `at least ${schema.minimum}` : undefined;
    case "enum":
      if (typeof value === "string" && (schema.values.includes(value) || enumInteger(schema, value))) return undefined;
      return schema.integers === undefined
        ? `one of ${schema.values.join(", ")}`
        : `one of ${schema.values.join(", ")}, or a whole number of at least ${schema.integers.minimum}`;
    case "text":
      if (typeof value !== "string") return "text";
      return schema.maxLength === undefined || value.length <= schema.maxLength
        ? undefined
        : `text of at most ${schema.maxLength} characters`;
    case "variables":
      return variablesProblem(value);
    case "file":
      return typeof value === "string" ? fileProblem(value, schema.maxBytes) : "text";
    case "ports":
      return portsProblem(value, schema.maxCount, schema.reserved);
  }
};

/**
 * A ports value as stored: text ("3000, 5173" or "3000 5173") read as its numbers, a list sorted ascending without
 * repeats. A word that is not a whole number stays as it is, for `portsProblem` to refuse.
 */
const normalizePorts = (value: unknown): unknown => {
  const words =
    typeof value === "string"
      ? value.split(/[\s,]+/).filter((word) => word !== "")
      : Array.isArray(value)
        ? (value as ReadonlyArray<unknown>)
        : undefined;
  if (words === undefined) return value;
  const read = words.map((word) => (typeof word === "string" && /^\d+$/.test(word) ? Number(word) : word));
  if (!read.every((port) => typeof port === "number")) return read;
  return [...new Set(read as ReadonlyArray<number>)].sort((a, b) => a - b);
};

/** Why `value` is not a list of 1 to `maxCount` ports, none of `reserved`, or undefined. */
const portsProblem = (value: unknown, maxCount: number, reserved: ReadonlyArray<number>): string | undefined => {
  if (!Array.isArray(value) || value.length === 0) return "a list of at least one port";
  for (const port of value as ReadonlyArray<unknown>) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
      return `ports from 1 to 65535, not ${String(port)}`;
    if (reserved.includes(port)) return `not ${port}, which t3flare uses itself`;
  }
  if (new Set(value).size !== value.length) return "each port once";
  return value.length > maxCount ? `at most ${maxCount} ports` : undefined;
};
