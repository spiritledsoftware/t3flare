// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// Repairs this checkout's `t3code/.git` when it points nowhere (ADR-0030's SPI-1335 refinement; scripts/lib/worktreeSetup.ts).
// Run it first in a new git worktree; `pnpm run check` runs it first too. Plain node, no dependencies: nothing is
// installed yet.
//
//   node scripts/worktree-setup.ts    silent when healthy; one line when it repaired, or when t3code needs
//                                     `git submodule update --init t3code` (exit 0); exit 1 when a repair failed
//
// The checkout is the one this script is in, not the working directory: inside a broken t3code, git cannot tell.
import * as path from "node:path";

import { worktreeSetup } from "./lib/worktreeSetup.ts";

const PREFIX = "t3code setup:";
const result = worktreeSetup(path.resolve(import.meta.dirname, ".."));
if (result.kind === "repaired") console.log(`${PREFIX} ${result.message}`);
if (result.kind === "uninitialised") console.error(`${PREFIX} ${result.message}`);
if (result.kind === "failed") {
  console.error(`${PREFIX} ${result.message}`);
  process.exit(1);
}
