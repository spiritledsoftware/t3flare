// `ls`, `find` and `grep` over the Workspace's files (step 2a plan, section 4):
// three tools over the Workspace DO's searches (`ComputerFiles`, which reaches the Container only for a Container-only
// path), as plain Promise tools with text output. Each runs where the call's environment works (`api.env.cwd`), with
// relative paths resolved against it.
import type { ComputerFiles } from "@t3flare/computer-env";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { FIND_DEFAULT_LIMIT, GREP_DEFAULT_LIMIT, LS_DEFAULT_LIMIT } from "@t3flare/harness-registry";

import { DEFAULT_TOOL_OUTPUT_LIMITS, type ToolOutputLimits } from "./toolOutput.ts";

/** The file search of the Session's Workspace, or undefined when the Session has none. */
export type FilesOf = () => ComputerFiles | undefined;

export const FILES_EXTENSION = "files";

/**
 * A call's `limit`, as pi reads it: the call's own, else the tool's default (`LS_DEFAULT_LIMIT` and its siblings,
 * SPI-1388), at least 1. No cap of t3flare's: the Tool output limit bounds what the model reads.
 */
const limitOf = (asked: number | undefined, fallback: number): number => Math.max(1, Math.floor(asked ?? fallback));

/**
 * The note a result ends with when it stopped at its limit, naming the limit, its value and how to see more, as pi's
 * tools do ("500 entries limit reached. Use limit=1000 for more").
 */
export const limitReached = (limit: number, unit: string, asked: number | undefined, hint = ""): string =>
  `[${limit.toLocaleString("en-US")} ${unit} limit reached${asked === undefined ? " (the default)" : ""}. Use limit=${(limit * 2).toLocaleString("en-US")} for more${hint}]`;

const EXCLUDE = ["**/.git", "**/node_modules"];

const resolvePath = (cwd: string, path: string | undefined): string => {
  const raw = path === undefined || path === "" || path === "." ? cwd : path.startsWith("/") ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
};

const relativeTo = (directory: string, path: string): string =>
  path === directory ? "." : path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path;

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const need = (files: FilesOf): ComputerFiles => {
  const found = files();
  if (found === undefined) throw new Error("This conversation has no Workspace: there are no files to search.");
  return found;
};

const lsTool = (files: FilesOf, output: ToolOutputLimits) =>
  defineTool({
    name: "ls",
    description: `List a directory's entries, directories with a trailing "/". Up to ${LS_DEFAULT_LIMIT} entries unless limit says how many.`,
    parameters: obj({
      path: opt(str({ description: "Directory to list (default: the working directory)" })),
      limit: opt(num({ description: `Maximum number of entries (default ${LS_DEFAULT_LIMIT})` })),
    }),
    outputLimits: output,
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const entries = await need(files).readdir(directory);
      const limit = limitOf(args.limit, LS_DEFAULT_LIMIT);
      const names = entries
        .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
        .toSorted((left, right) => left.localeCompare(right));
      const shown = names.slice(0, limit);
      return text(
        shown.length === 0
          ? "(empty directory)"
          : `${shown.join("\n")}${names.length > limit ? `\n… ${names.length - limit} more\n\n${limitReached(limit, "entries", args.limit)}` : ""}`,
      );
    },
  });

const findTool = (files: FilesOf, output: ToolOutputLimits) =>
  defineTool({
    name: "find",
    description: `Find files by glob pattern, such as '*.ts' or 'src/**/*.test.ts'. Paths relative to the directory searched. Up to ${FIND_DEFAULT_LIMIT.toLocaleString("en-US")} results unless limit says how many; .git and node_modules are skipped.`,
    parameters: obj({
      pattern: str({ description: "Glob pattern to match files" }),
      path: opt(str({ description: "Directory to search in (default: the working directory)" })),
      limit: opt(num({ description: `Maximum number of results (default ${FIND_DEFAULT_LIMIT})` })),
    }),
    outputLimits: output,
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const limit = limitOf(args.limit, FIND_DEFAULT_LIMIT);
      const found = await need(files).find(directory, args.pattern, { limit: limit + 1, exclude: EXCLUDE });
      const paths = found
        .slice(0, limit)
        .map((entry) => `${relativeTo(directory, entry.path)}${entry.type === "dir" ? "/" : ""}`);
      return text(
        paths.length === 0
          ? "No files found."
          : `${paths.join("\n")}${found.length > limit ? `\n\n${limitReached(limit, "results", args.limit, ", or narrow the pattern")}` : ""}`,
      );
    },
  });

/** The context grep always allows: the clamp it had before SPI-1361, so a high limit never takes context away. */
export const GREP_CONTEXT_FLOOR = 10;

/**
 * The context a grep asks for: what the call names, as far as `matches` matches each with 2 × context + 1 lines and a
 * `--` fit the result's `maxLines` (the Tool output limit), and never less than `GREP_CONTEXT_FLOOR`. More is never seen, and the Workspace copies
 * each match's context whole, so it would only cost memory and the answer's bytes. Past the share, the result is cut at
 * its lines as it is built, so fewer matches show.
 */
export const grepContext = (
  requested: number,
  matches: number,
  maxLines: number = DEFAULT_TOOL_OUTPUT_LIMITS.maxLines,
): number => {
  const asked = Math.max(0, Math.floor(requested));
  const share = Math.floor((maxLines / Math.max(1, matches) - 2) / 2);
  return Math.min(asked, Math.max(GREP_CONTEXT_FLOOR, share));
};

const grepTool = (files: FilesOf, output: ToolOutputLimits) =>
  defineTool({
    name: "grep",
    description: `Search file contents for a pattern. Returns matching lines as path:line: text. Up to ${GREP_DEFAULT_LIMIT} matches unless limit says how many; .git and node_modules are skipped.`,
    parameters: obj({
      pattern: str({ description: "Search pattern (a regular expression unless literal is true)" }),
      path: opt(str({ description: "Directory or file to search (default: the working directory)" })),
      glob: opt(str({ description: "Filter files by glob pattern, such as '*.ts'" })),
      ignoreCase: opt(bool({ description: "Case-insensitive search (default false)" })),
      literal: opt(bool({ description: "Treat the pattern as a literal string (default false)" })),
      context: opt(
        num({
          description: `Lines of context before and after each match (default 0); lowered, to no less than ${GREP_CONTEXT_FLOOR}, so every match's context fits the result's ${output.maxLines} lines`,
        }),
      ),
      limit: opt(num({ description: `Maximum number of matches (default ${GREP_DEFAULT_LIMIT})` })),
    }),
    outputLimits: output,
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const limit = limitOf(args.limit, GREP_DEFAULT_LIMIT);
      const matches = await need(files).grep(args.pattern, directory, {
        ignoreCase: args.ignoreCase === true,
        regex: args.literal !== true,
        context: grepContext(args.context ?? 0, limit + 1, output.maxLines),
        limit: limit + 1,
        include: args.glob,
        exclude: EXCLUDE,
      });
      const base = api.env?.cwd ?? directory;
      // Built only as far as the result's lines, less one for the note after them.
      const room = output.maxLines - 1;
      const lines: string[] = [];
      let full = false;
      for (const match of matches.slice(0, limit)) {
        const path = relativeTo(base, match.path);
        const shown =
          match.context === undefined || match.context.length === 0
            ? [`${path}:${match.line}: ${match.text}`]
            : [
                ...match.context.map(
                  (line) => `${path}${line.isMatch ? ":" : "-"}${line.line}${line.isMatch ? ":" : "-"} ${line.text}`,
                ),
                "--",
              ];
        if (lines.length + shown.length > room) {
          lines.push(...shown.slice(0, room - lines.length));
          full = true;
          break;
        }
        lines.push(...shown);
      }
      // Cut at the result's lines, the Tool output limit's; else stopped at the match limit, which names itself.
      const more = full
        ? "\n… more matches; narrow the search"
        : matches.length > limit
          ? `\n\n${limitReached(limit, "matches", args.limit, ", or narrow the search")}`
          : "";
      return text(lines.length === 0 ? "No matches found." : `${lines.join("\n")}${more}`);
    },
  });

/** `ls`, `find` and `grep`, their results within `output` (the Tool output limit). */
export const fileTools = (files: FilesOf, output: ToolOutputLimits = DEFAULT_TOOL_OUTPUT_LIMITS): Extension =>
  defineExtension({
    name: FILES_EXTENSION,
    tools: [lsTool(files, output), findTool(files, output), grepTool(files, output)],
  });
