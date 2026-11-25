// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// `pnpm run check`'s run of vp's `check:all` (ADR-0030's SPI-1346 refinement). It forwards vp's output unchanged, as
// it arrives, and exits with vp's code. When the check fails it then asks vp for its last run's details and ends the
// output with a block naming the task that failed, and the tasks vp stopped as stopped (lib/checkFailure.ts), so a log
// cut short still has them. Plain node, no dependencies, like workspace-guard.ts; vp is on `PATH` under pnpm. The
// environment passes through to vp and its tasks.
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";

import { failureReport } from "./lib/checkFailure.ts";

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
    console.error(`check: vp was stopped by ${signal ?? "a signal"}`);
    process.exitCode = 128 + (signal === null ? 0 : os.constants.signals[signal]);
    return;
  }
  const details = spawnSync("vp", ["run", "--last-details"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const summary = details.error === undefined ? `${details.stdout}${details.stderr}` : undefined;
  console.error(`\n${failureReport(Buffer.concat(output).toString("utf8"), summary)}`);
  process.exitCode = code;
});
