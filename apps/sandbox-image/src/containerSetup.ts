// The Container setup's wrapper (ADR-0047 §7): the bash the Workspace DO runs on each new Container through the
// platform's exec, after the Global mise lay-down, under COMMAND_ENV and every Variable, with the Owner's script on
// stdin. No Node imports: the agents Worker imports it.
//
// It runs the Owner's script as root in `/` with HOME=/root, bounded by the Owner's time limit, and answers the end of
// its output and one marked JSON line. It runs a script once per Container disk: the same script again (an exec that
// broke after the script started, retried; two Workspace DO instances across a deploy) answers the first run again.
import { CONTAINER_SETUP_DIR } from "./env.ts";

/**
 * The wrapper's own bounds, in seconds; the Owner's time limit is the script's. `timeout -k` sends TERM at the limit
 * (exit 124) and KILL `killAfter` later (exit 137). The lock waits for a whole run that holds it, and `lockMargin` more.
 */
export const CONTAINER_SETUP_BOUNDS = { killAfter: 10, lockMargin: 30 } as const;

/**
 * How much more of the output than the report keeps the wrapper answers, in bytes: the most one Variable's value can
 * take in UTF-8 (4096 characters), so a secret value that crosses the report's cut is whole here and blanked before it.
 */
export const SECRET_MARGIN_BYTES = 16 * 1024;

/** How long the Workspace DO waits for the whole exec at a limit of `minutes`: the lock, the run, its KILL, a minute's margin. */
export const containerSetupDeadlineMs = (minutes: number): number => {
  const seconds = minutes * 60;
  const lock = seconds + CONTAINER_SETUP_BOUNDS.killAfter + CONTAINER_SETUP_BOUNDS.lockMargin;
  return (lock + seconds + CONTAINER_SETUP_BOUNDS.killAfter + 60) * 1000;
};

/** What divides the output from the answer: the answer follows the last one. */
const MARK = "@@t3flare-container-setup@@";

/** The wrapper's answer: the JSON after the last mark. */
export interface ContainerSetupAnswer {
  readonly sha256: string;
  /** The script's exit, or null when it did not run (`locked`). */
  readonly exitCode: number | null;
  /** The time limit stopped it (124 after TERM, 137 after KILL). */
  readonly timedOut: boolean;
  /** Another run held the lock past its bound: nothing was run. */
  readonly locked?: boolean;
  readonly ms: number;
}

const b = CONTAINER_SETUP_BOUNDS;

/** The wrapper: `bash -c <this> t3flare-container-setup <sha256> <seconds> <window bytes>`, the Owner's script on stdin. */
export const CONTAINER_SETUP_SCRIPT = `set -u
sha=$1 seconds=$2 window=$3
dir=${CONTAINER_SETUP_DIR}
mkdir -p "$dir" && cd / || exit 1
export HOME=/root
started=$(date +%s%N)
answer() {
  printf '{"sha256":"%s","exitCode":%s,"timedOut":%s,"ms":%s%s}' "$sha" "$1" "$2" "$(( ($(date +%s%N) - started) / 1000000 ))" "\${3:-}"
}
# One run at a time on this disk; a run that holds the lock may take its whole limit.
exec 9> "$dir/.lock"
if ! flock -w $((seconds + ${b.killAfter} + ${b.lockMargin})) 9; then printf '\\n${MARK}%s\\n' "$(answer null false ',"locked":true')"; exit 0; fi
# The same script already ran on this disk: its answer again.
if [ -f "$dir/answer.json" ] && grep -q "\\"sha256\\":\\"$sha\\"" "$dir/answer.json"; then
  tail -c "$window" "$dir/output.log" 2>/dev/null
  printf '\\n${MARK}%s\\n' "$(tail -n 1 "$dir/answer.json")"; exit 0
fi
cat > "$dir/setup.sh"
# The lock's fd is closed for the script: a child it leaves running must not hold the lock.
timeout -k ${b.killAfter} "$seconds" bash "$dir/setup.sh" > "$dir/output.log" 2>&1 < /dev/null 9>&-
code=$?
timed=false
case $code in 124|137) timed=true ;; esac
line=$(answer $code $timed)
printf '%s\\n' "$line" > "$dir/answer.json.$$" && mv -f "$dir/answer.json.$$" "$dir/answer.json"
tail -c "$window" "$dir/output.log"
printf '\\n${MARK}%s\\n' "$line"
`;

/**
 * The argv the platform's exec runs for a script of SHA-256 `sha256` at a limit of `seconds`, answering the last
 * `windowBytes` of its output; the script goes on stdin.
 */
export const containerSetupArgv = (sha256: string, seconds: number, windowBytes: number): ReadonlyArray<string> => ["bash", "-c", CONTAINER_SETUP_SCRIPT, "t3flare-container-setup", sha256, String(seconds), String(windowBytes)];

/** The output and the answer from the wrapper's stdout, or undefined when it holds no answer, field by field. */
export const parseContainerSetupAnswer = (stdout: string): { readonly output: string; readonly answer: ContainerSetupAnswer } | undefined => {
  const at = stdout.lastIndexOf(`\n${MARK}`);
  if (at < 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdout.slice(at + 1 + MARK.length).trim());
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const answer = value as Record<string, unknown>;
  const count = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field >= 0;
  const ok =
    typeof answer.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(answer.sha256) &&
    (answer.exitCode === null || (typeof answer.exitCode === "number" && Number.isInteger(answer.exitCode))) &&
    typeof answer.timedOut === "boolean" &&
    (answer.locked === undefined || typeof answer.locked === "boolean") &&
    count(answer.ms);
  if (!ok) return undefined;
  return {
    output: stdout.slice(0, at),
    answer: {
      sha256: answer.sha256 as string,
      exitCode: answer.exitCode as number | null,
      timedOut: answer.timedOut as boolean,
      ...(answer.locked === undefined ? {} : { locked: answer.locked as boolean }),
      ms: answer.ms as number,
    },
  };
};
