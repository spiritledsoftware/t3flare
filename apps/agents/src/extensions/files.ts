// `ls`, `find` and `grep` over the Workspace's files (step 2a plan, section 4):
// three tools over the Workspace DO's searches (`ComputerFiles`, which reaches the Container only for a Container-only
// path), as plain Promise tools with text output. Each runs where the call's environment works (`api.env.cwd`), with
// relative paths resolved against it.
import type { ComputerFiles } from "@t3flare/computer-env";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { EMPTY_HARNESS, extensionOf, resolveHarness, type SettingValue } from "@t3flare/harness-registry";

/** The file search of the Session's Workspace, or undefined when the Session has none. */
export type FilesOf = () => ComputerFiles | undefined;

/** The `files` extension's settings (SPI-1321): each tool's most results, and its default. */
export interface FileLimits {
  readonly lsLimit: number;
  readonly findLimit: number;
  readonly grepLimit: number;
}

/** The `files` extension's resolved settings as limits. */
export const fileLimits = (values: Readonly<Record<string, SettingValue>>): FileLimits => ({
  lsLimit: Number(values.lsLimit),
  findLimit: Number(values.findLimit),
  grepLimit: Number(values.grepLimit),
});

export const FILES_EXTENSION = "files";

export const DEFAULT_FILE_LIMITS: FileLimits = fileLimits(
  extensionOf(resolveHarness(EMPTY_HARNESS), FILES_EXTENSION).settings,
);

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

const lsTool = (files: FilesOf, max: number) =>
  defineTool({
    name: "ls",
    description: `List a directory's entries, directories with a trailing "/". Up to ${max} entries.`,
    parameters: obj({
      path: opt(str({ description: "Directory to list (default: the working directory)" })),
      limit: opt(num({ description: `Maximum number of entries (default ${max})` })),
    }),
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const entries = await need(files).readdir(directory);
      const limit = Math.min(args.limit ?? max, max);
      const names = entries
        .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
        .toSorted((left, right) => left.localeCompare(right));
      const shown = names.slice(0, limit);
      return text(
        shown.length === 0
          ? "(empty directory)"
          : `${shown.join("\n")}${names.length > limit ? `\n… ${names.length - limit} more` : ""}`,
      );
    },
  });

const findTool = (files: FilesOf, max: number) =>
  defineTool({
    name: "find",
    description: `Find files by glob pattern, such as '*.ts' or 'src/**/*.test.ts'. Paths relative to the directory searched. Up to ${max} results; .git and node_modules are skipped.`,
    parameters: obj({
      pattern: str({ description: "Glob pattern to match files" }),
      path: opt(str({ description: "Directory to search in (default: the working directory)" })),
      limit: opt(num({ description: `Maximum number of results (default ${max})` })),
    }),
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const limit = Math.min(args.limit ?? max, max);
      const found = await need(files).find(directory, args.pattern, { limit: limit + 1, exclude: EXCLUDE });
      const paths = found
        .slice(0, limit)
        .map((entry) => `${relativeTo(directory, entry.path)}${entry.type === "dir" ? "/" : ""}`);
      return text(
        paths.length === 0
          ? "No files found."
          : `${paths.join("\n")}${found.length > limit ? `\n… more results; narrow the pattern` : ""}`,
      );
    },
  });

const grepTool = (files: FilesOf, max: number) =>
  defineTool({
    name: "grep",
    description: `Search file contents for a pattern. Returns matching lines as path:line: text. Up to ${max} matches; .git and node_modules are skipped.`,
    parameters: obj({
      pattern: str({ description: "Search pattern (a regular expression unless literal is true)" }),
      path: opt(str({ description: "Directory or file to search (default: the working directory)" })),
      glob: opt(str({ description: "Filter files by glob pattern, such as '*.ts'" })),
      ignoreCase: opt(bool({ description: "Case-insensitive search (default false)" })),
      literal: opt(bool({ description: "Treat the pattern as a literal string (default false)" })),
      context: opt(num({ description: "Lines of context before and after each match (default 0)" })),
      limit: opt(num({ description: `Maximum number of matches (default ${max})` })),
    }),
    replay: "safe",
    async execute(args, api) {
      const directory = resolvePath(api.env?.cwd ?? "/workspace", args.path);
      const limit = Math.min(args.limit ?? max, max);
      const matches = await need(files).grep(args.pattern, directory, {
        ignoreCase: args.ignoreCase === true,
        regex: args.literal !== true,
        context: Math.max(0, Math.min(args.context ?? 0, 10)),
        limit: limit + 1,
        include: args.glob,
        exclude: EXCLUDE,
      });
      const base = api.env?.cwd ?? directory;
      const lines = matches.slice(0, limit).flatMap((match) => {
        const path = relativeTo(base, match.path);
        if (match.context === undefined || match.context.length === 0) return [`${path}:${match.line}: ${match.text}`];
        return [
          ...match.context.map(
            (line) => `${path}${line.isMatch ? ":" : "-"}${line.line}${line.isMatch ? ":" : "-"} ${line.text}`,
          ),
          "--",
        ];
      });
      return text(
        lines.length === 0
          ? "No matches found."
          : `${lines.join("\n")}${matches.length > limit ? "\n… more matches; narrow the search" : ""}`,
      );
    },
  });

/** `ls`, `find` and `grep`, within `limits`. */
export const fileTools = (files: FilesOf, limits: FileLimits = DEFAULT_FILE_LIMITS): Extension =>
  defineExtension({
    name: FILES_EXTENSION,
    tools: [lsTool(files, limits.lsLimit), findTool(files, limits.findLimit), grepTool(files, limits.grepLimit)],
  });
