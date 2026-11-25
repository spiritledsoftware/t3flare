// @effect-diagnostics nodeBuiltinImport:off
// Configures the ADR merge driver (SPI-1401; scripts/adr-merge.ts, scripts/lib/adrMerge.ts) that `.gitattributes`
// names for `docs/adr/*.md`. `node scripts/worktree-setup.ts` runs it, so every checkout that ran setup has it.
//
// Plain Node, no dependencies: it runs before anything is installed.
import { git } from "./worktreeSetup.ts";

/**
 * The ADR merge driver (SPI-1401) that `.gitattributes` names for `docs/adr/*.md`. git runs a merge driver through the
 * shell from the worktree's top level, so the relative path is that worktree's own script, and every worktree shares
 * the one config. A checkout without the script (an older commit) gets git's own text merge, as with no driver.
 */
export const ADR_MERGE_DRIVER = {
  name: "ADR append: two appends at an ADR's end join, ours then theirs (scripts/adr-merge.ts)",
  driver:
    "if [ -f scripts/adr-merge.ts ]; then node scripts/adr-merge.ts %O %A %B %L %P %S %X %Y; else git merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B; fi",
} as const;

export type MergeDriverResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "configured"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** Sets `merge.adr-append.*` in the repository config of the checkout at `root`. Already set: writes nothing. */
export const configureAdrMergeDriver = (root: string): MergeDriverResult => {
  const wanted = Object.entries(ADR_MERGE_DRIVER).filter(
    ([key, value]) => git(["-C", root, "config", "--local", "--get", `merge.adr-append.${key}`]).out !== value,
  );
  if (wanted.length === 0) return { kind: "unchanged" };
  for (const [key, value] of wanted) {
    const set = git(["-C", root, "config", "--local", `merge.adr-append.${key}`, value]);
    if (!set.ok) return { kind: "failed", message: `could not set merge.adr-append.${key}: ${set.err}` };
  }
  return {
    kind: "configured",
    message: "set merge.adr-append for docs/adr/*.md: two appends at an ADR's end now join in a rebase",
  };
};
