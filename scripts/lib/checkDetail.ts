// A failed `pnpm run check`'s detail in the bump report (SPI-1293): its first error lines, then its tail. The tail alone
// is vp's per-task summary, which can miss the error that failed the check, however long it is.
import { T3_ERRORS_COUNT } from "../../apps/environment/scripts/lib/typecheckFilter.ts";

/** test:docker's, the acceptance test's and check's failures each carry a long record; 4000 characters held barely one. */
export const LONG_DETAIL_CHARS = 24_000;

/**
 * The lines that name an error, in the forms check's tools print them (checked against real `pnpm run check` failures,
 * scripts/lib/fixtures/): tsc's `error TS2322`, oxlint's `file:1:2: error rule`, vitest's `×` and ` FAIL `, node --test's
 * `✖`, any `…Error:`, and vp fmt's summary.
 */
const ERROR_LINE = /error TS\d+|: error |^\s*[×✗✖] |^\s*FAIL\b|Error:|Format issues found/;
/** vp's `--log grouped` header, naming the task whose output follows. */
const TASK_HEADER = /^── \[.+\] ──$/;
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
  let header: string | undefined;
  let errors = 0;
  // Inside the typecheck's list of t3's own errors, which it reports without failing (typecheckFilter.ts).
  let notFailing = false;
  for (const line of output.split("\n")) {
    if (TASK_HEADER.test(line)) {
      header = line;
      notFailing = false;
    } else if (T3_ERRORS_COUNT.test(line)) notFailing = true;
    else if (line.trim() === "") notFailing = false;
    else if (!notFailing && ERROR_LINE.test(line)) {
      if (header !== undefined) first.push(header);
      header = undefined;
      first.push(line);
      if (++errors === FIRST_ERROR_LINES) break;
    }
  }
  if (first.length === 0) return output.slice(-maxChars);
  const head = `first errors:\n${first.join("\n")}`.slice(0, Math.floor(maxChars / 2));
  return `${head}${SEPARATOR}${output.slice(-(maxChars - head.length - SEPARATOR.length))}`;
};
