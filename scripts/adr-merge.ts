// @effect-diagnostics globalConsole:off nodeBuiltinImport:off
// git's merge driver for `docs/adr/*.md` (SPI-1401; .gitattributes, scripts/lib/adrMerge.ts): concurrent appends to an
// ADR's tail join, ours then theirs; any other conflict is git's own. `node scripts/worktree-setup.ts` configures it as
// `merge.adr-append.driver`; git runs it from the worktree's top level.
//
//   node scripts/adr-merge.ts %O %A %B %L %P %S %X %Y
//     writes the merge to %A; exit 0 when merged, 1 on a conflict, 255 when the merge itself failed
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

import { adrMerge, type ConflictStyle } from "./lib/adrMerge.ts";

const [basePath, oursPath, theirsPath, markerSize, file, baseLabel, oursLabel, theirsLabel] = process.argv.slice(2);
if (basePath === undefined || oursPath === undefined || theirsPath === undefined) {
  console.error("usage: node scripts/adr-merge.ts %O %A %B %L %P %S %X %Y");
  process.exit(255);
}

/** The repository's conflict style, which git's own text merge would use. */
const conflictStyle = (): ConflictStyle => {
  const style = spawnSync("git", ["config", "--get", "merge.conflictStyle"], { encoding: "utf8" }).stdout?.trim();
  return style === "diff3" || style === "zdiff3" ? style : "merge";
};

try {
  const read = (target: string) => fs.readFileSync(target, "utf8");
  const result = adrMerge(read(oursPath), read(basePath), read(theirsPath), {
    ...(Number(markerSize) > 0 ? { markerSize: Number(markerSize) } : {}),
    labels: [oursLabel ?? "ours", baseLabel ?? "base", theirsLabel ?? "theirs"],
    conflictStyle: conflictStyle(),
  });
  fs.writeFileSync(oursPath, result.kind === "merged" ? result.merged : result.conflict);
  process.exit(result.kind === "merged" ? 0 : 1);
} catch (error) {
  // Above 128: git reports a failed merge, not a conflict, so %A (still ours) is never mistaken for a resolution.
  console.error(`adr-merge: ${file ?? oursPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(255);
}
