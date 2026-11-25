// @effect-diagnostics nodeBuiltinImport:off
// An exec seam that answers the way `@cloudflare/computer` 0.11.2's does (SPI-1375). The Container tests run their
// scripts through `spawnSync`, which answers every byte, so none of them saw computer keep only the last 2,000 lines or
// 64 KiB of each stream of an exec (`OutputWindow`, unless `output: false`): t3's git reads and the GREP root line were
// tailed in production while every test passed. A test that runs a Workspace script through this seam fails on a read
// the Workspace leaves tailed.
import { spawnSync } from "node:child_process";

import { execOutput } from "../src/workspace/execOutput.ts";

/** computer's default output window (`DEFAULT_OUTPUT_MAX_LINES`, `DEFAULT_OUTPUT_MAX_BYTES`). */
export const COMPUTER_OUTPUT_LINES = 2_000;
export const COMPUTER_OUTPUT_BYTES = 64 * 1024;

const NEWLINE = 10;

/**
 * What computer 0.11.2 keeps of a stream of `bytes` (its container-shell backend's `OutputWindow.read`, then
 * `takeTail`, ported from `dist/shared-DLn8-ZJ2.js`): all of it while it has at most 64 KiB and 2,000 lines, else its
 * end, which keeps whole lines where it can, so it drops the partial first line of its last 64 KiB and can be any size
 * (70,002 bytes of one long line and a short one keep only the short one).
 */
export const computerTail = (bytes: Buffer): Buffer => {
  let newlines = 0;
  for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) newlines += 1;
  const endsInNewline = bytes.length === 0 || bytes[bytes.length - 1] === NEWLINE;
  const totalLines = newlines + (endsInNewline ? 0 : 1);
  if (bytes.length <= COMPUTER_OUTPUT_BYTES && totalLines <= COMPUTER_OUTPUT_LINES) return bytes;
  // takeTail(window, totalLines, limits): the window is at least the last 64 KiB, so the whole output serves for it.
  const window = bytes;
  const end = window.length > 0 && window[window.length - 1] === NEWLINE ? window.length - 1 : window.length;
  let start = Math.max(0, window.length - COMPUTER_OUTPUT_BYTES);
  while (start < window.length && ((window[start] ?? 0) & 0xc0) === 0x80) start += 1;
  let lines = 1;
  let cut = start;
  for (let index = end - 1; index >= start; index -= 1) {
    if (window[index] !== NEWLINE) continue;
    if (lines === COMPUTER_OUTPUT_LINES) {
      cut = index + 1;
      break;
    }
    lines += 1;
  }
  if (cut > 0 && window[cut - 1] !== NEWLINE) {
    const next = window.indexOf(NEWLINE, cut);
    if (next !== -1 && next < end) cut = next + 1;
  }
  return window.subarray(cut);
};

export interface ComputerExecInput {
  readonly script: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** The Workspace DO's `ExecInput.wholeOutput`: computer's `output: false` (`execOutput`), else its default window. */
  readonly wholeOutput?: boolean;
}

/** Runs `input.script` with bash, answering its streams whole or tailed as computer would. */
export const computerExec = (input: ComputerExecInput) => {
  const ran = spawnSync("bash", ["-c", input.script], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: { ...process.env, ...input.env },
    ...(input.stdin === undefined ? {} : { input: input.stdin }),
    maxBuffer: 1024 * 1024 * 1024,
  });
  const whole = execOutput(input.wholeOutput === true) === false;
  const stream = (bytes: Buffer) => (whole ? bytes : computerTail(bytes)).toString("utf8");
  return {
    exitCode: ran.status ?? 128,
    status: ran.status === 0 ? "completed" : "failed",
    stdout: stream(ran.stdout),
    stderr: stream(ran.stderr),
  };
};
