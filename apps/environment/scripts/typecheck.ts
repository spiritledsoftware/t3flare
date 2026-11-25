// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// `pnpm --filter @t3flare/environment run typecheck`, or `node apps/environment/scripts/typecheck.ts` from anywhere:
// `effect-tsgo tsrs --noEmit` over two programs, failing only on errors in t3flare's own files (fragility U10,
// `lib/typecheckFilter.ts`). Errors in t3's files are printed under a heading, each labelled not failing, and pass. The package's program (tsconfig.json) checks src, scripts and the Node tests with Node's types; the
// workerd tests' program (test/tsconfig.workerd.json) checks the `workerd` Vitest project's files with the Workers
// globals, which clash with Node's across the rest, so it owns only those files.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import {
  type Diagnostic,
  type Ownership,
  t3ErrorsReport,
  typecheckVerdict,
  workerdOwnership,
} from "./lib/typecheckFilter.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const t3Root = path.resolve(cwd, "../../t3code");
/** The root's install of effect-tsgo, so the script runs without pnpm's `node_modules/.bin` on `PATH`. */
const effectTsgo = path.resolve(cwd, "../../node_modules/.bin/effect-tsgo");

/** Each program, and for one that reaches files it does not own, the program that checks those (`elsewhere`). */
const programs: ReadonlyArray<{
  readonly project: string;
  readonly ownership?: Ownership;
  readonly elsewhere?: string;
}> = [
  { project: "tsconfig.json" },
  { project: "test/tsconfig.workerd.json", ownership: workerdOwnership, elsewhere: "tsconfig.json" },
];

let ok = true;
const t3Errors = new Map<string, Diagnostic>();
for (const { project, ownership, elsewhere } of programs) {
  const result = spawnSync(
    effectTsgo,
    ["tsrs", "--noEmit", "--pretty", "false", "-p", project, ...process.argv.slice(2)],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    console.error(
      `typecheck: could not run ${effectTsgo}: ${String(result.error)}; run \`pnpm install --frozen-lockfile\` at the repo root`,
    );
    process.exit(1);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const verdict = typecheckVerdict(result.status, output, cwd, t3Root, ownership);
  for (const diagnostic of verdict.ours) console.log(diagnostic.text);
  for (const diagnostic of verdict.t3Errors) t3Errors.set(diagnostic.text, diagnostic);
  if (verdict.elsewhereErrors.length > 0) {
    console.log(
      `${project}: ${verdict.elsewhereErrors.length} error(s) in files it does not own, which ${elsewhere ?? "another program"} checks; not failing.`,
    );
  }
  if (!verdict.ok) {
    ok = false;
    if (verdict.reason !== undefined) console.error(`typecheck (${project}): ${verdict.reason}\n${output}`);
  }
}
if (t3Errors.size > 0) console.log(`\n${t3ErrorsReport([...t3Errors.values()])}`);
if (!ok) process.exit(1);
