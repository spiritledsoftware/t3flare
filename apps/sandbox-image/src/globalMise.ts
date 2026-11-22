// The Global mise config's lay-down at a Container start (SPI-1150, ADR-0032's Global mise config refinement): the bash the Workspace DO runs on the
// Container through the platform's exec, under COMMAND_ENV, with the owner's text on stdin. No Node imports: the agents
// Worker imports it.
//
// It installs the owner's tools with the text as mise's global config (a staging file), keeps the file only when git
// and gh still run under it (an owner's file can otherwise break t3's git: invalid TOML fails every shim), and answers
// one JSON line. It is idempotent per Container disk: an answer for the same revision and text is printed again.
//
// With no text (ADR-0047 §10) the dotfiles' own mise config is the one installed and checked, staged as a link to it;
// kept, mise's global config is that link, so a later edit of the dotfiles' file reaches mise. Under a file that breaks
// git or gh nothing is kept: mise is back on t3flare's own (none). This run is never answered from the disk: the
// dotfiles' file may be new since the last (a Base snapshot's lay-down ran before the Image setup wrote it). Each such
// run keeps the SHA-256 of the dotfiles' file it saw (`none` without one), written only after its answer, so a run cut
// off mid-way leaves the last finished run's; a run in the mode `if-changed`, after the Container setup, does nothing
// when the file is still that one and answers that run's answer again, marked `unchanged`.
import { DOTFILES_MISE_CONFIG, GLOBAL_MISE_CONFIG, GLOBAL_MISE_DIR } from "./env.ts";

/**
 * The script's own bounds, in seconds, around the Owner's install time limit (`globalMiseInstallMinutes`, handed in by
 * argv). Each is fixed: t3flare's own robustness margins and correctness check, not a choice about the Owner's tools.
 * `timeout -k` sends TERM at a bound (exit 124) and KILL `…KillAfter` later (exit 137).
 *
 * - `installKillAfter`: KILL this long after the install's TERM, for an install that ignores TERM.
 * - `check`, `checkKillAfter`: each of the `git --version` and `gh --version` checks, t3flare's own proof that its git
 *   still runs under the Owner's file; a working binary answers in well under a second.
 * - `lockMargin`: a second lay-down waits for one holding the lock for that run's whole install, its KILL and both
 *   checks, and this long more for the script's own bookkeeping.
 * - `answerMargin`: the Workspace DO waits this long past every bound above for the answer to come back over the exec.
 */
export const GLOBAL_MISE_BOUNDS = {
  installKillAfter: 10,
  check: 20,
  checkKillAfter: 5,
  lockMargin: 30,
  answerMargin: 60,
} as const;

/** One run's install and checks at an install limit of `minutes`, each to its KILL, in seconds. */
const runSeconds = (minutes: number): number =>
  minutes * 60 + GLOBAL_MISE_BOUNDS.installKillAfter + 2 * (GLOBAL_MISE_BOUNDS.check + GLOBAL_MISE_BOUNDS.checkKillAfter);

/** How long a lay-down at an install limit of `minutes` waits for another's lock, in seconds: that run's whole time and a margin. */
export const globalMiseLockSeconds = (minutes: number): number => runSeconds(minutes) + GLOBAL_MISE_BOUNDS.lockMargin;

/** How long the Workspace DO waits for the whole exec at an install limit of `minutes`: the lock, its own run, a minute's margin. */
export const globalMiseDeadlineMs = (minutes: number): number => (globalMiseLockSeconds(minutes) + runSeconds(minutes) + GLOBAL_MISE_BOUNDS.answerMargin) * 1000;

/** Where an owner-pinned git gets the image's system gitconfig from (the credential helper, Dockerfile). */
export const SYSTEM_GITCONFIG = "/usr/local/share/t3flare/gitconfig";

/** The script's answer: its last line of stdout (`BASH_ENV`'s EXIT trap prints on stderr). */
export interface GlobalMiseAnswer {
  readonly revision: number;
  readonly sha256: string;
  readonly source: string;
  /** The owner's file is mise's global config now. */
  readonly laid: boolean;
  /** The file was the dotfiles' own (`DOTFILES_MISE_CONFIG`): the start had no Global mise config text. */
  readonly dotfiles?: boolean;
  /** An `if-changed` run found the dotfiles' file as the last finished run saw it: nothing was done, the rest is that run's answer. */
  readonly unchanged?: boolean;
  /** `mise install`'s exit, or null when it did not run (no text). */
  readonly install: number | null;
  /** The install or a check was cut off (124 after TERM, 137 after KILL). */
  readonly timedOut: boolean;
  /** Another lay-down held the lock past its bound: nothing was done. */
  readonly locked?: boolean;
  readonly ms: number;
  readonly bytes: number;
}

const b = GLOBAL_MISE_BOUNDS;

/** The checks run with mise's auto-installs off, so a shim never starts an install of its own. */
const check = (tool: "git" | "gh") =>
  `MISE_GLOBAL_CONFIG_FILE="$stage" MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_NOT_FOUND_AUTO_INSTALL=false timeout -k ${b.checkKillAfter} ${b.check} ${tool} --version > /dev/null 2>&1 9>&-`;

/**
 * The lay-down: `bash -c <this> t3flare-global-mise <revision> <sha256> <source> <mode> <install seconds> <lock seconds>`,
 * the text on stdin (`globalMiseArgv`).
 */
export const GLOBAL_MISE_SCRIPT = `set -u
revision=$1 sha=$2 source=$3 mode=$4 install_seconds=$5 lock_seconds=$6
dir=${GLOBAL_MISE_DIR} global=${GLOBAL_MISE_CONFIG} dotfiles_config=${DOTFILES_MISE_CONFIG}
mkdir -p "$dir" && cd / || exit 1
started=$(date +%s%N)
answer() {
  printf '{"revision":%s,"sha256":"%s","source":"%s","laid":%s,"install":%s,"timedOut":%s,"ms":%s,"bytes":%s%s}\\n' \\
    "$revision" "$sha" "$source" "$1" "$2" "$3" "$(( ($(date +%s%N) - started) / 1000000 ))" "$4" "\${5:-}"
}
# One lay-down at a time on this disk (two Workspace DO instances across a deploy).
exec 9> "$dir/.lock"
if ! flock -w "$lock_seconds" 9; then answer false null false 0 ',"locked":true'; exit 0; fi
stage="$dir/config.$sha.$$.toml"
cat > "$stage"
bytes=$(wc -c < "$stage")
dotfiles=false notext=false
if [ "$bytes" -gt 0 ]; then
  # The same revision and text already laid down (or refused) on this disk: its answer again (a dotfiles run's answer
  # has the empty text's SHA-256, so it is never this).
  if [ -f "$dir/answer.json" ] && grep -q "\\"revision\\":$revision," "$dir/answer.json" && grep -q "\\"sha256\\":\\"$sha\\"" "$dir/answer.json"; then
    rm -f "$stage"; tail -n 1 "$dir/answer.json"; exit 0
  fi
else
  # No text: the dotfiles' own mise config, when there is one, staged as a link to it. After the Container setup
  # (if-changed), only when the file is not the one the last run saw.
  rm -f "$stage"
  notext=true
  seen=none; [ -f "$dotfiles_config" ] && seen=$(sha256sum < "$dotfiles_config" | cut -c1-64)
  if [ "$mode" = if-changed ] && [ -f "$dir/answer.json" ] && [ "$(cat "$dir/dotfiles.sha" 2>/dev/null)" = "$seen" ]; then
    tail -n 1 "$dir/answer.json" | sed 's/}$/,"unchanged":true}/'; exit 0
  fi
  if [ -f "$dotfiles_config" ]; then dotfiles=true; ln -s "$dotfiles_config" "$stage"; bytes=$(wc -c < "$stage"); fi
fi
if [ ! -L "$stage" ] && [ ! -f "$stage" ]; then
  rm -f "$global"
  line=$(answer false null false 0 ',"dotfiles":false')
else
  # The lock's fd is closed for the install and the checks: a child left after a timeout's KILL (uutils' timeout
  # kills the process, not its group) must not hold the lock for the next lay-down.
  MISE_GLOBAL_CONFIG_FILE="$stage" timeout -k ${b.installKillAfter} "$install_seconds" mise install > "$dir/install.log" 2>&1 9>&-
  install=$?
  timed=false
  case $install in 124|137) timed=true ;; esac
  laid=false
  ${check("git")}; git_rc=$?
  ${check("gh")}; gh_rc=$?
  for rc in $git_rc $gh_rc; do case $rc in 124|137) timed=true ;; esac; done
  if [ $git_rc = 0 ] && [ $gh_rc = 0 ] && mv -f "$stage" "$global"; then laid=true; fi
  # Not laid: no file of an earlier run stays mise's global config.
  [ $laid = true ] || rm -f "$global"
  rm -f "$stage"
  # A git the owner pinned is not the image's: it gets the image's system gitconfig (the credential helper), as the
  # Dockerfile gives the image's own.
  for git in "\${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/*/*/bin/git; do
    [ -x "$git" ] || continue
    prefix=$(dirname "$(dirname "$git")")
    grep -qs t3flare/git-credential "$prefix/etc/gitconfig" || { mkdir -p "$prefix/etc" && cp ${SYSTEM_GITCONFIG} "$prefix/etc/gitconfig"; }
  done
  line=$(answer $laid $install $timed "$bytes" ',"dotfiles":'$dotfiles)
fi
printf '%s\\n' "$line" > "$dir/answer.json.$$" && mv -f "$dir/answer.json.$$" "$dir/answer.json"
# The dotfiles' file this run checked, kept only now, after its answer: a run cut off before this leaves the last
# finished run's, so the next if-changed run checks the file again.
if [ $notext = true ]; then printf '%s' "$seen" > "$dir/dotfiles.sha.$$" && mv -f "$dir/dotfiles.sha.$$" "$dir/dotfiles.sha"; fi
printf '%s\\n' "$line"
`;

/**
 * How a run goes: `lay-down` at a Container start; `if-changed` after the Container setup, with no text (ADR-0047 §10):
 * the dotfiles' mise file is checked and laid down again only when the setup changed or wrote it.
 */
export type GlobalMiseMode = "lay-down" | "if-changed";

/** The script's arguments after its name: what `GLOBAL_MISE_SCRIPT` reads as `$1` to `$6`, at an install limit of `minutes`. */
export const globalMiseArgs = (revision: number, sha256: string, source: string, mode: GlobalMiseMode, minutes: number): ReadonlyArray<string> => [
  String(revision),
  sha256,
  source,
  mode,
  String(minutes * 60),
  String(globalMiseLockSeconds(minutes)),
];

/** The argv the platform's exec runs; the text goes on stdin. */
export const globalMiseArgv = (revision: number, sha256: string, source: string, mode: GlobalMiseMode, minutes: number): ReadonlyArray<string> => [
  "bash",
  "-c",
  GLOBAL_MISE_SCRIPT,
  "t3flare-global-mise",
  ...globalMiseArgs(revision, sha256, source, mode, minutes),
];

/** The answer from the script's stdout (its last line), or undefined when it is not one, field by field. */
export const parseGlobalMiseAnswer = (stdout: string): GlobalMiseAnswer | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const answer = value as Record<string, unknown>;
  const count = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0;
  const ok =
    count(answer.revision) &&
    typeof answer.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(answer.sha256) &&
    typeof answer.source === "string" &&
    answer.source.length <= 32 &&
    typeof answer.laid === "boolean" &&
    (answer.install === null || (typeof answer.install === "number" && Number.isInteger(answer.install))) &&
    typeof answer.timedOut === "boolean" &&
    (answer.locked === undefined || typeof answer.locked === "boolean") &&
    (answer.dotfiles === undefined || typeof answer.dotfiles === "boolean") &&
    (answer.unchanged === undefined || typeof answer.unchanged === "boolean") &&
    count(answer.ms) &&
    count(answer.bytes);
  if (!ok) return undefined;
  return {
    revision: answer.revision as number,
    sha256: answer.sha256 as string,
    source: answer.source as string,
    laid: answer.laid as boolean,
    install: answer.install as number | null,
    timedOut: answer.timedOut as boolean,
    ...(answer.locked === undefined ? {} : { locked: answer.locked as boolean }),
    ...(answer.dotfiles === undefined ? {} : { dotfiles: answer.dotfiles as boolean }),
    ...(answer.unchanged === undefined ? {} : { unchanged: answer.unchanged as boolean }),
    ms: answer.ms as number,
    bytes: answer.bytes as number,
  };
};
