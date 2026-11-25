// A failed `pnpm run check`'s detail in the bump report (SPI-1293): its first error lines, then its tail. The tail alone
// is vp's per-task summary, which can miss the error that failed the check, however long it is.
import { T3_ERRORS_COUNT, T3_NOT_FAILING_LABEL } from "../../apps/environment/scripts/lib/typecheckFilter.ts";

/** test:docker's, the acceptance test's and check's failures each carry a long record; 4000 characters held barely one. */
export const LONG_DETAIL_CHARS = 24_000;

/**
 * The lines that name an error, in the forms check's tools print them (checked against real `pnpm run check` failures,
 * scripts/lib/fixtures/): tsc's `error TS2322`, oxlint's `file:1:2: error rule`, vitest's `×` and ` FAIL `, node --test's
 * `✖`, any `…Error:`, and vp fmt's summary.
 */
export const ERROR_LINE = /error TS\d+|: error |^\s*[×✗✖] |^\s*FAIL\b|Error:|Format issues found/;
/** vp's `--log grouped` header, naming the task whose output follows. */
export const TASK_HEADER = /^── \[(.+)\] ──$/;

/** The first line of vp's summary after a run. */
const VP_SUMMARY = /^vp run: \d+\/\d+ successful/;

/** A line of a check's output, read with the `--log grouped` section it is in. */
export interface CheckLine {
  readonly text: string;
  /** A section's header; one of t3's errors the typecheck reports as not failing, or their heading; any other line. */
  readonly kind: "header" | "notFailing" | "line";
  /** The task whose section holds the line (a header's own task), if any. */
  readonly task: string | undefined;
  /** That section's header line. */
  readonly header: string | undefined;
  /** Which header the line follows, counting from 0; -1 before the first. */
  readonly section: number;
}

/**
 * Each line of a check's output, with its section. t3's errors are not failing from the typecheck's heading over them
 * to the blank line or header that ends the list (typecheckFilter.ts), and wherever a line carries their label.
 */
export const checkLines = (output: string): Array<CheckLine> => {
  const lines: Array<CheckLine> = [];
  let task: string | undefined;
  let headerLine: string | undefined;
  let section = -1;
  let notFailing = false;
  for (const text of output.split("\n")) {
    // vp's closing summary, `---` then `vp run: 11/27 successful…`, and pnpm's line after it end the last section.
    if (VP_SUMMARY.test(text)) {
      if (lines.at(-1)?.text === "---")
        lines[lines.length - 1] = { ...lines.at(-1)!, task: undefined, header: undefined };
      task = undefined;
      headerLine = undefined;
    }
    const header = TASK_HEADER.exec(text);
    if (header !== null) {
      task = header[1];
      headerLine = text;
      section++;
      notFailing = false;
      lines.push({ text, kind: "header", task, header: headerLine, section });
      continue;
    }
    if (T3_ERRORS_COUNT.test(text)) notFailing = true;
    else if (text.trim() === "") notFailing = false;
    const kind = notFailing || text.startsWith(T3_NOT_FAILING_LABEL) ? "notFailing" : "line";
    lines.push({ text, kind, task, header: headerLine, section });
  }
  return lines;
};

/** How many error lines the detail leads with. */
export const FIRST_ERROR_LINES = 60;
const SEPARATOR = "\n\n── tail ──\n";

/**
 * At most `maxChars` of `output`: the whole of it when it fits; else its first {@link FIRST_ERROR_LINES} error lines,
 * each under its task's header and leaving out t3's errors the typecheck reports as not failing, given at most half of `maxChars`, then the output's tail in the rest.
 */
export const checkDetail = (output: string, maxChars: number): string => {
  if (output.length <= maxChars) return output;
  const first: Array<string> = [];
  let shown = -1;
  let errors = 0;
  for (const { text, kind, header, section } of checkLines(output)) {
    if (kind !== "line" || !ERROR_LINE.test(text)) continue;
    if (header !== undefined && section !== shown) first.push(header);
    shown = section;
    first.push(text);
    if (++errors === FIRST_ERROR_LINES) break;
  }
  if (first.length === 0) return output.slice(-maxChars);
  const head = `first errors:\n${first.join("\n")}`.slice(0, Math.floor(maxChars / 2));
  return `${head}${SEPARATOR}${output.slice(-(maxChars - head.length - SEPARATOR.length))}`;
};
