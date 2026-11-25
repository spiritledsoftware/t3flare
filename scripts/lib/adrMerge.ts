// @effect-diagnostics nodeBuiltinImport:off
// The ADR merge (SPI-1401). ADRs are append-only: a change to a decision is a `## Refinement (SPI-<n>, <date>)` section
// appended at the end. Two branches that each append one conflict at the ADR's tail with an empty base, and a rebase
// stops on it. This joins such appends, ours then theirs (during a rebase ours is the upstream, which landed first, so
// the result is in landing order), and leaves every other conflict as git's own.
//
// Plain Node, no dependencies: git runs it as a merge driver (scripts/adr-merge.ts) in checkouts with nothing installed.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ConflictStyle = "merge" | "diff3" | "zdiff3";

export type AdrMergeOptions = {
  /** The conflict markers' length, git's %L. */
  readonly markerSize?: number;
  /** The conflict labels for ours, the base and theirs: git's %X, %S and %Y. */
  readonly labels?: readonly [ours: string, base: string, theirs: string];
  /** The repository's `merge.conflictStyle`, which a conflict is written in. */
  readonly conflictStyle?: ConflictStyle;
};

export type AdrMergeResult =
  | { readonly kind: "merged"; readonly merged: string }
  /** git's own conflict output, markers and all. */
  | { readonly kind: "conflict"; readonly conflict: string };

/** git's default conflict marker length. */
const DEFAULT_MARKER_SIZE = 7;
const MARKER_CHARS = ["<", "|", "=", ">"] as const;
/** A line git could read as a conflict marker: seven or more of one marker character, then a space or the line's end. */
const MARKER_LINE = /^(<{7,}|\|{7,}|={7,}|>{7,})( |$)/;

/** The longest run of one marker character that starts a line in any of `texts`. */
const longestMarkerRun = (texts: ReadonlyArray<string>) => {
  let longest = 0;
  for (const text of texts)
    for (const line of text.split("\n"))
      for (const char of MARKER_CHARS) {
        let run = 0;
        while (line[run] === char) run++;
        longest = Math.max(longest, run);
      }
  return longest;
};

/** Runs `git merge-file -p` over the three texts, through files in a scratch directory it removes. */
const mergeFile = (ours: string, base: string, theirs: string, args: ReadonlyArray<string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-merge-"));
  try {
    const files = { ours: path.join(dir, "ours"), base: path.join(dir, "base"), theirs: path.join(dir, "theirs") };
    fs.writeFileSync(files.ours, ours);
    fs.writeFileSync(files.base, base);
    fs.writeFileSync(files.theirs, theirs);
    // The style is pinned, then set by `args`: a conflictStyle in the config around would override the default.
    const result = spawnSync(
      "git",
      ["-c", "merge.conflictStyle=merge", "merge-file", "-p", ...args, files.ours, files.base, files.theirs],
      {
        encoding: "utf8",
        maxBuffer: 1 << 30,
      },
    );
    // merge-file exits with the number of conflicts, negative (above 127 here) on an error.
    if (result.status === null || result.status > 127)
      throw new Error(`git merge-file failed: ${result.error?.message ?? result.stderr}`);
    return { output: result.stdout, conflicts: result.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Joins every conflict hunk of a diff3 merge whose base is empty: ours, a blank line unless one side already brings
 * one, then theirs. Undefined when any hunk has a base, a real edit on both sides. The markers are `markerSize` long,
 * longer than any marker-like run in the inputs, so every marker line is git's.
 */
export const joinAppends = (diff3: string, markerSize: number): string | undefined => {
  const marker = (char: string) => (line: string) =>
    line.startsWith(char.repeat(markerSize)) && (line.length === markerSize || line[markerSize] === " ");
  const [isOurs, isBase, isSeparator, isTheirs] = MARKER_CHARS.map(marker) as [
    (line: string) => boolean,
    (line: string) => boolean,
    (line: string) => boolean,
    (line: string) => boolean,
  ];
  const out: Array<string> = [];
  let hunk: { ours: Array<string>; base: Array<string>; theirs: Array<string> } | undefined;
  let side: "ours" | "base" | "theirs" = "ours";
  for (const line of diff3.split("\n")) {
    if (hunk === undefined) {
      if (isOurs(line)) [hunk, side] = [{ ours: [], base: [], theirs: [] }, "ours"];
      else out.push(line);
    } else if (side === "ours" && isBase(line)) side = "base";
    else if (side === "base" && isSeparator(line)) side = "theirs";
    else if (side === "theirs" && isTheirs(line)) {
      if (hunk.base.length > 0) return undefined;
      const blank = hunk.ours.at(-1) === "" || hunk.theirs[0] === "" || hunk.ours.length === 0;
      out.push(...hunk.ours, ...(blank ? [] : [""]), ...hunk.theirs);
      hunk = undefined;
    } else hunk[side].push(line);
  }
  // An unclosed hunk is output this does not understand: leave it to git.
  return hunk === undefined ? out.join("\n") : undefined;
};

/**
 * Merges the three texts of an ADR. Clean as git merges it, or with only empty-base hunks (concurrent appends): merged,
 * with no marker line the inputs did not have. Anything else: git's own conflict output, in `conflictStyle` with
 * `labels` and `markerSize`.
 */
export const adrMerge = (
  ours: string,
  base: string,
  theirs: string,
  {
    markerSize = DEFAULT_MARKER_SIZE,
    labels = ["ours", "base", "theirs"],
    conflictStyle = "merge",
  }: AdrMergeOptions = {},
): AdrMergeResult => {
  const labelArgs = [`-L`, labels[0], `-L`, labels[1], `-L`, labels[2]];
  const asGit = (): AdrMergeResult => ({
    kind: "conflict",
    conflict: mergeFile(ours, base, theirs, [
      ...(conflictStyle === "merge" ? [] : [`--${conflictStyle}`]),
      `--marker-size=${markerSize}`,
      ...labelArgs,
    ]).output,
  });

  // Markers longer than any marker-like line in the inputs, so an ADR that quotes one is never misread.
  const parseSize = Math.max(DEFAULT_MARKER_SIZE, longestMarkerRun([ours, base, theirs]) + 1);
  const diff3 = mergeFile(ours, base, theirs, ["--diff3", `--marker-size=${parseSize}`, ...labelArgs]);
  const joined = diff3.conflicts === 0 ? diff3.output : joinAppends(diff3.output, parseSize);
  if (joined === undefined) return asGit();

  // Belt and braces: a merge never writes a marker line neither side had.
  const inputLines = new Set([...ours.split("\n"), ...theirs.split("\n")]);
  if (joined.split("\n").some((line) => MARKER_LINE.test(line) && !inputLines.has(line))) return asGit();
  return { kind: "merged", merged: joined };
};
