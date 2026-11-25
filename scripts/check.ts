// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// `pnpm run check`'s run of vp's `check:all` (ADR-0030's SPI-1346 refinement). It forwards vp's output unchanged, as
// it arrives, and exits with vp's code. When the check fails it then asks vp for its last run's details and ends the
// output with a block naming the task that failed, and the tasks vp stopped as stopped (lib/checkFailure.ts), so a log
// cut short still has them. Plain node, no dependencies, like workspace-guard.ts; vp is on `PATH` under pnpm. The
// environment passes through to vp and its tasks.
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";

import { failureReport, type LastDetails } from "./lib/checkFailure.ts";

/**
 * The most of `vp run --last-details` read back. Its summary is about 300 bytes a task (13 KB for the 45 tasks in
 * lib/fixtures/check-run-test.details.txt), so this is room for far more tasks than `check:all` has; past it the read
 * fails with ENOBUFS and the block says the details could not be read.
 */
const LAST_DETAILS_MAX_BYTES = 64 * 1024 * 1024;

const child = spawn("vp", ["run", "--log", "grouped", "--concurrency-limit", "16", "check:all"], {
  stdio: ["inherit", "pipe", "pipe"],
});
const output: Array<Buffer> = [];
child.stdout.on("data", (chunk: Buffer) => {
  output.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  output.push(chunk);
  process.stderr.write(chunk);
});
// Exits by `process.exitCode`, not `process.exit()`, which could drop output still queued for a pipe.
child.on("error", (error) => {
  console.error(`check: could not run vp: ${String(error)}`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (code === 0) return;
  if (code === null) {
    // Node passes `close` a null code only with the signal that ended vp.
    console.error(`check: vp was stopped by ${signal}`);
    process.exitCode = 128 + os.constants.signals[signal!];
    return;
  }
  const details = spawnSync("vp", ["run", "--last-details"], { encoding: "utf8", maxBuffer: LAST_DETAILS_MAX_BYTES });
  const lastDetails: LastDetails =
    details.error === undefined ? `${details.stdout}${details.stderr}` : { unreadable: String(details.error) };
  console.error(`\n${failureReport(Buffer.concat(output).toString("utf8"), lastDetails, code)}`);
  process.exitCode = code;
});
