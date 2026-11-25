// Tool output (SPI-1362): the Harness settings' always-on entry (`tool-output`) whose setting, with the fixed
// `TOOL_OUTPUT_LINES` (SPI-1388), is the Tool output limit, what the model is shown of every tool's result. pi-durable
// cuts a result to its tool's `outputLimits`, and falls back to its own defaults (50 KiB, 2,000 lines) for a tool that
// names none; this extension gives every tool the setting instead. A tool that names its
// own `maxBytes` or `maxLines` keeps them (pi-durable's code mode, `todo`); the tools that size their own text to the
// limit (`ls`, `find`, `grep`, the web tools, the Terminals, `context_history`) are built with the same limits.
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { defaultSettings, type SettingValue, TOOL_OUTPUT_LINES } from "@t3flare/harness-registry";

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

/** `tool` with `limits` wherever its own `outputLimits` names none (its `retain` kept). */
export const withOutputLimits = (tool: ToolRegistration, limits: ToolOutputLimits): ToolRegistration => ({
  ...tool,
  outputLimits: { ...limits, ...tool.outputLimits },
});

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
