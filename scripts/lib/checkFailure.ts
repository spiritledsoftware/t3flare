// The block a failed `pnpm run check` ends with (SPI-1346). vp fails fast: when one task fails it kills the tasks still
// running, which then exit 137 and count as failed too, and its summary names none of them. The block names the task
// that failed by itself, with its error lines from its `--log grouped` section, and lists the killed ones as stopped.
// Read from `vp run --last-details`, which lists every task that ran in the order it finished (scripts/lib/fixtures/).
// Dependency-free: check.ts runs it before anything but pnpm is set up.
import { checkLines, ERROR_LINE } from "./checkDetail.ts";

/** A task of the last run, as `vp run --last-details` lists it. */
export interface TaskResult {
  readonly name: string;
  /** 0 for a task that passed (`✓`). */
  readonly exitCode: number;
}

/** How many lines of the failing task's section the block shows. */
export const FAILURE_LINES = 40;

/** 128 + SIGKILL, 128 + SIGTERM: a task stopped by a signal, as vp stops the rest when one fails. */
const SIGNALLED = new Set([137, 143]);

/** A task in `--last-details`: `  [12] @t3flare/skills#lint: ~/packages/skills$ oxlint … ✗ (exit code: 1)`, or `✓`. */
const TASK_LINE = /^\s*\[\d+\] (.+?): .* (?:✓|✗ \(exit code: (\d+)\))\s*$/;

/** Every task `vp run --last-details` lists, in its order; none when the output is not its summary. */
export const parseLastDetails = (details: string): Array<TaskResult> =>
  details.split("\n").flatMap((line) => {
    const task = TASK_LINE.exec(line);
    return task === null ? [] : [{ name: task[1]!, exitCode: task[2] === undefined ? 0 : Number(task[2]) }];
  });

/**
 * `task`'s section of the log, without blank lines or t3's not-failing errors: all of it when it fits in
 * {@link FAILURE_LINES}, else its error lines, else its first lines.
 */
const sectionExcerpt = (log: string, task: string): Array<string> => {
  const lines = checkLines(log)
    .filter((l) => l.task === task && l.kind === "line" && l.text.trim() !== "")
    .map((l) => l.text);
  if (lines.length <= FAILURE_LINES) return lines;
  const errors = lines.filter((line) => ERROR_LINE.test(line));
  const shown = (errors.length > 0 ? errors : lines).slice(0, FAILURE_LINES);
  return [...shown, `(${lines.length - shown.length} more lines in its section of the log above)`];
};

const indent = (lines: ReadonlyArray<string>) => lines.map((line) => `  ${line}`);
const names = (tasks: ReadonlyArray<TaskResult>) => tasks.map((t) => t.name).join(", ");
const codes = (tasks: ReadonlyArray<TaskResult>) => [...new Set(tasks.map((t) => t.exitCode))].join("/");

/**
 * The block for a failed check, from its output and `vp run --last-details` (`undefined` when that could not be run).
 * Without the details, it names the first task whose section of the log holds an error line.
 */
export const failureReport = (log: string, details: string | undefined): string => {
  const failed = parseLastDetails(details ?? "").filter((t) => t.exitCode !== 0);
  if (failed.length === 0) {
    const first = checkLines(log).find((l) => l.kind === "line" && l.task !== undefined && ERROR_LINE.test(l.text));
    if (first === undefined)
      return "check FAILED: no task's section of the log holds an error line, and `vp run --last-details` named none";
    return [
      `check FAILED: first task with an error in the log: ${first.task}`,
      ...indent(sectionExcerpt(log, first.task!)),
    ].join("\n");
  }
  const own = failed.filter((t) => !SIGNALLED.has(t.exitCode));
  const stopped = failed.filter((t) => SIGNALLED.has(t.exitCode));
  if (own.length === 0)
    return (
      `check FAILED: no task failed by itself; ${stopped.length} tasks were killed (exit ${codes(stopped)}), ` +
      `which can be the machine running out of memory: ${names(stopped)}`
    );
  const [first, ...others] = own;
  const block = [`check FAILED: first failing task: ${first!.name} (exit ${first!.exitCode})`];
  block.push(...indent(sectionExcerpt(log, first!.name)));
  if (stopped.length > 0)
    block.push(
      `stopped by vp when it failed (not failures): ${stopped.length} tasks (exit ${codes(stopped)}): ${names(stopped)}`,
    );
  if (others.length > 0)
    block.push(`other failed tasks: ${others.map((t) => `${t.name} (exit ${t.exitCode})`).join(", ")}`);
  return block.join("\n");
};
