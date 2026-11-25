// t3's git runs answer the head of each stream (SPI-1375). computer keeps, by default, only the last 2,000 lines or
// 64 KiB of an exec's output, without a word; t3 caps git's output itself (GitVcsDriverCore's `maxOutputBytes`, 1 MB
// unless a call sets another) and, past it, fails or keeps the head and marks it (`appendTruncationMarker`). So every git
// run answers whole (`output: false`), cut in the Container to its head just past t3's cap (`gitOutputCut`), and t3's
// own rule applies to it as it does locally. A run t3 sets no cap on answers whole up to `GIT_WHOLE_OUTPUT_BYTES`, and
// past it fails, naming the bound.
import { type GitRun, GIT_WHOLE_OUTPUT_BYTES, gitOutputCut, headBytes, utf8AtLeast } from "@t3flare/workspace-client";

import { shellWord } from "./checkpointScripts.ts";

/** A git answer's streams, as the read cache keeps them. */
export interface GitAnswerStreams {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Where the Container cut its streams (`gitOutputCut`) when one reached it; null when both are whole. Absent only in a
   * row the read cache kept before SPI-1375, whose streams computer may have tailed: `keptFor` answers nothing from it.
   */
  readonly cut?: number | null;
}

/**
 * The Container's `git` with `argv`, each stream cut to its first `bytes` bytes (`head -c`). git runs to its end, the
 * rest of its stdout read and dropped, so its exit status is its own, as t3 reads it locally. stderr waits in a temporary
 * file: git's is short, and a cut pipe would end git early.
 *
 * Its status never rests on `wait`'s answer after a trap: a runner subshell, which a TERM does not end, runs git in the
 * foreground and writes git's status to a file; the script waits for the runner by pid until it is gone, and a missing
 * status (the runner ended by a KILL) reads as 143.
 *
 * Ending it: a TERM to the script (a cancel, the exec's time limit, or one to its whole group) is passed to git, which
 * can drop its locks. git's pid and the cancel meet in files: the wrapper that becomes git writes its pid, then gives up
 * if a cancel (or a kill, below) is marked, or its pid could not be written; the trap marks the cancel, then signals any
 * pid written; so a TERM before, during or after git's start ends it, and a TERM before the folder is made ends the
 * script before git starts. The runner makes the same
 * cancel on a TERM of its own, so a TERM to the whole group reaches git through either.
 *
 * bash 5.2 can lose a trapped signal that lands while it starts a process. Measured on Debian bookworm's bash 5.2.15
 * with a TERM 0–10 ms in: about 1 in 50 runs for a command or process substitution, and about 1 in 1,000 for a
 * background subshell. So once the trap is set the script runs no substitution at all (the folder is made by `mkdir` at
 * a name of its own, never `$(mktemp -d)`; the watcher reads a FIFO, never `>(…)`), and the rest is bounded by the KILL
 * that follows a TERM (`CANCEL_KILL_AFTER_MS`): a KILL to the script cannot be trapped, so the watcher reads a FIFO only
 * the script holds open for writing, and when the script is gone without saying it is done, its read ends: it marks
 * the script killed, kills the pid the wrapper wrote (waiting up to 2 s for one, so the mark outlives any wrapper that
 * has not yet looked for it), and removes the folder (retrying for up to 2 s). A wrapper that writes its pid after the
 * mark sees the mark and gives up, one after the folder is gone cannot write it, and the runner writes no status into
 * the folder once it is marked. Once git has ended, TERM and
 * SIGPIPE are ignored, so the cleanup always runs.
 *
 * Only the script opens a FIFO, and only while it holds its write end: each for reading and writing (fds 4 and 5, held
 * until it is done), then for reading (fds 6 and 7). The watcher, the reader and git use those descriptors, never a name,
 * so no open ever waits for the other side, and a reader sees the end of its input once every write end has closed. The
 * script's last word to the watcher goes into a FIFO it holds for reading too, so it never blocks or fails.
 */
export const gitHeadScript = (argv: ReadonlyArray<string>, bytes: number): string => {
  const cut = Math.max(0, Math.floor(bytes));
  return [
    "cancelled=0",
    "d=",
    "cancel() {",
    "  cancelled=1",
    '  [ -n "$d" ] && [ -d "$d" ] || return 0',
    '  : >"$d/cancel"',
    '  g=; [ -s "$d/git" ] && read -r g <"$d/git"',
    '  [ -n "$g" ] && kill -TERM "$g" 2>/dev/null',
    "  return 0",
    "}",
    "trap cancel TERM INT",
    "tries=0",
    "while :; do",
    '  d="${TMPDIR:-/tmp}/t3flare-git.$$.$RANDOM$RANDOM"',
    '  mkdir -m 700 "$d" 2>/dev/null && break',
    // A TERM can end `mkdir` after it made the folder (and the trap then marks the cancel in it): its name is ours.
    '  [ "$cancelled" = 1 ] && { rm -rf "$d"; exit 143; }',
    "  tries=$((tries + 1))",
    `  [ "$tries" -lt 5 ] || { echo "t3flare: no temporary folder for git's output in \${TMPDIR:-/tmp}" >&2; exit 1; }`,
    "done",
    'mkfifo "$d/out" "$d/alive" 2>/dev/null || { [ "$cancelled" = 1 ] || echo "t3flare: no FIFO for git\'s output" >&2; rm -rf "$d"; [ "$cancelled" = 1 ] && exit 143; exit 1; }',
    'if [ "$cancelled" = 1 ]; then rm -rf "$d"; exit 143; fi',
    "exec 3<&0",
    'exec 4<>"$d/alive"',
    'exec 5<>"$d/out"',
    // The read ends, opened by the script while it holds the write ends, so neither open waits.
    'exec 6<"$d/alive"',
    'exec 7<"$d/out"',
    `( trap '' TERM INT; exec 3<&- 4<&- 5<&- 7<&- >/dev/null 2>&1; read -r _ <&6 && exit 0; : >"$d/killed"; n=0; while [ ! -e "$d/status" ] && [ "$n" -lt 40 ]; do g=; [ -s "$d/git" ] && read -r g <"$d/git"; [ -n "$g" ] && { kill -KILL "$g"; break; }; sleep 0.05; n=$((n + 1)); done; n=0; while [ -e "$d" ] && [ "$n" -lt 20 ]; do rm -rf "$d"; [ -e "$d" ] && sleep 0.1; n=$((n + 1)); done ) &`,
    `{ head -c ${cut}; cat >/dev/null; } <&7 3<&- 4<&- 5<&- 6<&- 7<&- & reader=$!`,
    // The runner makes the same cancel on a TERM of its own (a TERM to the whole group reaches it too).
    "( trap cancel TERM INT",
    `  sh -c 'd=$1; shift; echo $$ >"$d/git" || exit 143; { [ -e "$d/cancel" ] || [ -e "$d/killed" ]; } && exit 143; exec "$@"' sh "$d" git ${argv.map(shellWord).join(" ")} <&3 3<&- >&5 5<&- 2>"$d/err"`,
    // Once the watcher has marked the script killed, the folder is its to remove: no status is written into it.
    '  rc=$?; [ -e "$d/killed" ] || echo "$rc" >"$d/status" 2>/dev/null ) 4<&- 6<&- 7<&- & runner=$!',
    "exec 3<&- 6<&- 7<&-",
    'while kill -0 "$runner" 2>/dev/null; do wait "$runner" 2>/dev/null; done',
    "trap '' TERM INT PIPE",
    'rc=; [ -s "$d/status" ] && read -r rc <"$d/status"',
    '[ -n "$rc" ] || rc=143',
    "exec 5<&-",
    "echo done >&4 2>/dev/null",
    "exec 4<&-",
    'while kill -0 "$reader" 2>/dev/null; do wait "$reader" 2>/dev/null; done',
    `head -c ${cut} "$d/err" >&2`,
    'rm -rf "$d"',
    'exit "$rc"',
  ].join("\n");
};

/** The exec of git run `run`: its head script, answered whole (`ExecInput.wholeOutput`). */
export const gitExecOf = (run: Pick<GitRun, "argv" | "maxOutputBytes">) => ({
  script: gitHeadScript(run.argv, gitOutputCut(run.maxOutputBytes)),
  wholeOutput: true as const,
});

export type GitOutcome =
  | { readonly ok: true; readonly answer: GitAnswerStreams & { readonly cut: number | null } }
  | { readonly ok: false; readonly detail: string };

/** Whether a cap of t3's is held to `GIT_WHOLE_OUTPUT_BYTES`: none, or one above it. */
const heldToBound = (maxOutputBytes: number | undefined) =>
  maxOutputBytes === undefined || maxOutputBytes > GIT_WHOLE_OUTPUT_BYTES;

/** The refusal of an answer past `GIT_WHOLE_OUTPUT_BYTES`, for t3's cap `maxOutputBytes` (none, or one above it). */
const boundRefusal = (maxOutputBytes: number | undefined): string =>
  `git's output passed ${GIT_WHOLE_OUTPUT_BYTES / 1024 / 1024} MiB (${GIT_WHOLE_OUTPUT_BYTES} bytes), the most the Workspace answers of one git command ${
    maxOutputBytes === undefined ? "t3 does not cap" : `t3 caps higher (this one at ${maxOutputBytes} bytes)`
  }; it is fixed by the Workspace's 128 MB of memory`;

/**
 * What git run `gitExecOf` made answers, for t3's cap `maxOutputBytes`: git's answer, with the cut it reached (`cut`:
 * null when both streams came back whole); or, when t3's cap is held to `GIT_WHOLE_OUTPUT_BYTES` and a stream passed it,
 * a refusal naming the bound.
 */
export const gitOutcome = (
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  maxOutputBytes: number | undefined,
): GitOutcome => {
  const passed = (bytes: number) => utf8AtLeast(result.stdout, bytes) || utf8AtLeast(result.stderr, bytes);
  if (heldToBound(maxOutputBytes)) {
    if (passed(GIT_WHOLE_OUTPUT_BYTES + 1)) return { ok: false, detail: boundRefusal(maxOutputBytes) };
    return { ok: true, answer: { ...streamsOf(result), cut: null } };
  }
  const cut = gitOutputCut(maxOutputBytes);
  return { ok: true, answer: { ...streamsOf(result), cut: passed(cut) ? cut : null } };
};

const streamsOf = (result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }) => ({
  exitCode: result.exitCode,
  stdout: result.stdout,
  stderr: result.stderr,
});

/** Which of `answer`'s streams the Container cut (`GitAnswer.cut`); undefined when neither. */
export const cutStreams = (
  answer: GitAnswerStreams,
): { readonly stdout: boolean; readonly stderr: boolean } | undefined => {
  if (answer.cut === null || answer.cut === undefined) return undefined;
  return { stdout: utf8AtLeast(answer.stdout, answer.cut), stderr: utf8AtLeast(answer.stderr, answer.cut) };
};

/**
 * Kept answer `kept`, for a read with t3's cap `maxOutputBytes`: cut to that cap's head (`gitOutputCut`). A whole answer
 * serves any cap; one cut in the Container only a cap whose head it holds whole, and never a cap held to
 * `GIT_WHOLE_OUTPUT_BYTES`. (A row cut past that bound, kept for a cap at it, would hold more than 16 MiB: over a row's
 * 8 MiB (`MAX_ANSWER_BYTES`), it is never kept.) A row from before SPI-1375 has
 * no `cut` and serves none: computer's tail (`takeTail`) drops the partial first line of its 64 KiB window, so a tail can
 * be any size, and no length tells it from a whole answer.
 */
export const keptFor = (kept: GitAnswerStreams, maxOutputBytes: number | undefined): GitAnswerStreams | undefined => {
  if (kept.cut === undefined) return undefined;
  const cut = gitOutputCut(maxOutputBytes);
  if (kept.cut !== null && (heldToBound(maxOutputBytes) || cut > kept.cut)) return undefined;
  const stdout = headBytes(kept.stdout, cut);
  const stderr = headBytes(kept.stderr, cut);
  if (stdout === kept.stdout && stderr === kept.stderr) return kept;
  return { exitCode: kept.exitCode, stdout, stderr, cut };
};

/** Kept answer `kept` for t3's cap `maxOutputBytes` (`keptFor`) only when no stream of it was cut: one a patch may change. */
export const keptWhole = (kept: GitAnswerStreams, maxOutputBytes: number | undefined): GitAnswerStreams | undefined => {
  const answer = keptFor(kept, maxOutputBytes);
  return answer === undefined || cutStreams(answer) !== undefined ? undefined : answer;
};

/** A kept or fresh git answer's streams for the router, with the streams the Container cut flagged (`GitAnswer.cut`). */
export const gitAnswerOf = (answer: GitAnswerStreams) => {
  const cut = cutStreams(answer);
  return {
    exitCode: answer.exitCode,
    stdout: answer.stdout,
    stderr: answer.stderr,
    ...(cut === undefined ? {} : { cut }),
  };
};
