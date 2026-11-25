// Tool output (SPI-1362): the Harness settings' always-on entry (`tool-output`) whose setting, with the fixed
// `TOOL_OUTPUT_LINES` (SPI-1388), is the Tool output limit, what the model is shown of every tool's result. pi-durable
// cuts a result to its tool's `outputLimits`, and falls back to its own defaults (50 KiB, 2,000 lines) for a tool that
// names none; this extension gives every tool the setting instead. A tool that names its
// own `maxBytes` or `maxLines` keeps them (pi-durable's code mode, `todo`); the tools that size their own text to the
// limit (`ls`, `find`, `grep`, the web tools, the Terminals, `context_history`) are built with the same limits.
import { boundOutput } from "@earendil-works/chord/output";
import {
  defineExtension,
  type Extension,
  type ToolDiagnostic,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  defaultSettings,
  limitHit,
  type SettingRef,
  settingPlace,
  type SettingValue,
  TOOL_OUTPUT_LINES,
} from "@t3flare/harness-registry";

export const TOOL_OUTPUT_EXTENSION = "tool-output";

/** The most of one tool result the model reads, in bytes of UTF-8 and in lines. */
export interface ToolOutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

/** The `tool-output` extension's resolved settings as limits, its lines the fixed `TOOL_OUTPUT_LINES`. */
export const toolOutputLimits = (values: Readonly<Record<string, SettingValue>>): ToolOutputLimits => ({
  maxBytes: Number(values.outputKiB) * 1024,
  maxLines: TOOL_OUTPUT_LINES,
});

export const DEFAULT_TOOL_OUTPUT_LIMITS: ToolOutputLimits = toolOutputLimits(defaultSettings(TOOL_OUTPUT_EXTENSION));

/** Room a Background job's output leaves in a result for what is around it: its status, its exit, its log's path. */
const JOB_ROOM = { lines: 20, bytes: 1024 };

/**
 * A Background job's output as a result shows it, its last lines: what fits `limits` (the Tool output limit) beside
 * its status. The whole output stays in the job's log.
 */
export const jobTailOf = (limits: ToolOutputLimits): { readonly lines: number; readonly bytes: number } => ({
  lines: Math.max(1, limits.maxLines - JOB_ROOM.lines),
  bytes: Math.max(1, limits.maxBytes - JOB_ROOM.bytes),
});

/** The limits as a tool's description names them: `50 KiB or 2,000 lines`. */
export const outputSize = (limits: ToolOutputLimits): string =>
  `${limits.maxBytes / 1024} KiB or ${limits.maxLines.toLocaleString("en-US")} lines`;

/** The Tool output limit's setting (its KiB; the lines are the fixed `TOOL_OUTPUT_LINES`). */
const OUTPUT_KIB: SettingRef = { extension: TOOL_OUTPUT_EXTENSION, key: "outputKiB" };

/**
 * What a result the Harness cut says (ADR-0049 §4), as a diagnostic just before pi-durable's own "Output truncated…",
 * which pi-durable adds after the tool's diagnostics: the limits it was cut at, with their values, and where the Owner
 * changes the KiB. A tool that names its own limits says they are its own.
 */
export const outputCutNote = (cutAt: ToolOutputLimits, limits: ToolOutputLimits): string =>
  cutAt.maxBytes === limits.maxBytes && cutAt.maxLines === limits.maxLines
    ? limitHit(
        `The output was cut at the Tool output limit: ${cutAt.maxLines.toLocaleString("en-US")} lines, t3flare's fixed line limit, or ${cutAt.maxBytes / 1024} KiB, the Owner's setting under ${settingPlace(OUTPUT_KIB)}`,
        OUTPUT_KIB,
      )
    : `The output was cut at this tool's own limit: ${cutAt.maxLines.toLocaleString("en-US")} lines or ${cutAt.maxBytes / 1024} KiB.`;

/**
 * Whether pi-durable cuts `result` at `cutAt`: a result with its own output, by the same bound pi-durable applies
 * (`boundOutput`, its text joined; which end it keeps does not change whether it cuts); one whose output streamed (`output` absent), by what the call's retained output says.
 */
const cut = (
  result: ToolExecutionResult,
  cutAt: ToolOutputLimits,
  retained: (() => { readonly truncated: boolean }) | undefined,
): boolean =>
  result.output === undefined
    ? retained?.().truncated === true
    : boundOutput(result.output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join(""), {
        ...cutAt,
        retain: "head",
      }).droppedBytes > 0;

/**
 * `tool` with `limits` wherever its own `outputLimits` names none (its `retain` kept), and a result the limits cut
 * carrying a diagnostic that names them (`outputCutNote`), which the model reads after the result.
 */
export const withOutputLimits = (tool: ToolRegistration, limits: ToolOutputLimits): ToolRegistration => {
  const outputLimits = { ...limits, ...tool.outputLimits };
  const note: ToolDiagnostic = {
    severity: "warn",
    code: "output_limit",
    message: outputCutNote({ maxBytes: outputLimits.maxBytes, maxLines: outputLimits.maxLines }, limits),
  };
  return {
    ...tool,
    outputLimits,
    async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      // The call's api is live until `execute` returns (pi-durable's `run`), so its retained output can be read here.
      return cut(result, outputLimits, () => api.retainedOutput())
        ? { ...result, diagnostics: [...(result.diagnostics ?? []), note] }
        : result;
    },
  };
};

/**
 * Every tool in `names` cut to `limits`, but where its registration names its own. Wraps are pure: install a new one
 * over this (same name) when the settings or the tools change, as `offered-tools` is.
 */
export const toolOutputExtension = (names: ReadonlyArray<string>, limits: ToolOutputLimits): Extension =>
  defineExtension({
    name: TOOL_OUTPUT_EXTENSION,
    wraps: [...new Set(names)].map((name) => ({
      tool: name,
      wrap: (tool: ToolRegistration) => withOutputLimits(tool, limits),
    })),
  });
