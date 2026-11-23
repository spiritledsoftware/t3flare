// How much of a Container command's output the Workspace DO's `exec` answers (SPI-1364). computer keeps, by default,
// only the last 2,000 lines or 64 KiB of each stream of an exec, saving the whole in the Workspace's own files, and its
// result says which it cut (`truncated`), a flag the Workspace DO's `exec` does not pass on.
//
// A script that bounds its own output runs whole (`output: false`): the Container file tools' scripts (`LISTING_BYTES`,
// `GREP_OUTPUT_BYTES`), a leak dump's slices (`DUMP_SLICE_BYTES`) and a checkpoint diff cut to the size t3 asks for.
// Every other command (t3's git reads and actions among them) keeps computer's default and is still tailed to 64 KiB
// without a word, as before SPI-1364; a follow-up ticket owns that.
import { shellWord } from "./checkpointScripts.ts";

/**
 * computer's `output` option for an exec: `false` for a script that bounds its own output (no cut, and nothing saved in
 * the Workspace's files), else none, so computer's default applies. Whole, the output is held about 3 to 4 times its
 * size at its peak (computer's chunks and their joined copy, the decoded string, and its copy crossing DO RPC), so each
 * such script's bound is chosen for the Workspace DO's 128 MB isolate.
 */
export const execOutput = (whole: boolean): false | undefined => (whole ? false : undefined);

/**
 * The Container's `git` with `argv`, its output cut to `maxBytes` when given (`head -c`): git ended by the cut (SIGPIPE,
 * 141) counts as success, and any other status is git's own. With no size, git runs alone.
 */
export const diffScript = (argv: ReadonlyArray<string>, maxBytes: number | undefined): string => {
  const git = `git ${argv.map(shellWord).join(" ")}`;
  if (maxBytes === undefined) return `exec ${git}`;
  return `${git} | head -c ${Math.max(0, Math.floor(maxBytes))}\nrc=\${PIPESTATUS[0]}\n[ "$rc" = 141 ] && rc=0\nexit "$rc"`;
};
