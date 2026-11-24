// The `.git`-only passive reads that may run for real once, and are primed (step 2b; root's ruling on M2's deviation,
// recorded as an ADR-0009 refinement). Step 2a ruled that a passive read never starts a stopped Container: it gets its
// last answer, patched where it can be. A worktree launch is an explicit action, but t3 asks the project a few `.git`
// reads before anything else starts its Container, and a read never answered before has no last answer. So:
//
// - only the reads below may start the Container when they have no answer at all (each is logged in the router trace);
// - whenever the Container is up (a clone, a worktree's provisioning, a routed action), they are answered then
//   (`primeScript`), so a later launch finds real answers and starts nothing;
// - their cache key ignores the command's env and a `--git-dir` naming the Workspace's own repo, so primed answers match.

export const UPSTREAM_FORMAT = "--format=%(refname)\t%(upstream:remotename)\t%(upstream:remoteref)";

export interface AllowedRead {
  readonly name: string;
  /** The t3 code that sends it. */
  readonly caller: string;
  readonly matches: (args: ReadonlyArray<string>) => boolean;
}

const equals = (args: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  args.length === expected.length && args.every((arg, at) => arg === expected[at]);

const COMMIT_GIT_PATHS = ["rev-parse", "--git-path", "index", "--git-path", "objects"];
const COUNT_OBJECTS_ARGV = ["count-objects", "-v"];

export const FIRST_READ_ALLOWED: ReadonlyArray<AllowedRead> = [
  {
    name: "git-common-dir",
    caller: "GitVcsDriverCore.readGitCommonDir (createWorktree's directory hash, the shared-config lock)",
    matches: (args) => equals(args, ["rev-parse", "--git-common-dir"]),
  },
  {
    name: "remotes",
    caller: "GitVcsDriverCore.listRemoteNames (resolveWorktreeBaseRemote; also emulated from the DO's files)",
    matches: (args) => equals(args, ["remote"]),
  },
  {
    name: "base-upstream",
    caller: "GitVcsDriverCore.resolveWorktreeBaseRemote (a worktree launch's base branch and its upstream)",
    matches: (args) =>
      args.length === 3 &&
      args[0] === "for-each-ref" &&
      args[1] === UPSTREAM_FORMAT &&
      args[2]!.startsWith("refs/heads/"),
  },
  {
    name: "remote-commit",
    caller: "GitVcsDriverCore.fetchWorktreeBaseCommit (the launch's base commit after its fetch)",
    matches: (args) =>
      args.length === 4 &&
      equals(args.slice(0, 3), ["rev-parse", "--verify", "--quiet"]) &&
      /^refs\/remotes\/.+\^\{commit\}$/.test(args[3]!),
  },
  {
    name: "checkout-workers",
    caller: "GitVcsDriverCore.createWorktree (readConfigValue checkout.workers)",
    matches: (args) => equals(args, ["config", "--get", "checkout.workers"]),
  },
  // SPI-1186: t3's commit action (the git panel's Commit) drafts its commit with these two reads before its first
  // write; a Workspace whose Container stopped before it was ever primed would otherwise refuse the commit.
  {
    name: "commit-git-paths",
    caller: "GitVcsDriverCore.prepareCommitContext.gitPaths (the draft's index and objects)",
    matches: (args) => equals(args, COMMIT_GIT_PATHS),
  },
  {
    name: "commit-alternates",
    caller: "GitVcsDriverCore.prepareCommitContext.alternates (the draft's alternates list)",
    matches: (args) => equals(args, COUNT_OBJECTS_ARGV),
  },
];

/** The argv without a `--git-dir` naming the Workspace's own repo (t3 sends both forms). */
export const withoutOwnGitDir = (args: ReadonlyArray<string>, repo: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--git-dir" && args[at + 1] === `${repo}/.git`) at++;
    else if (args[at] === `--git-dir=${repo}/.git`) continue;
    else out.push(args[at]!);
  }
  return out;
};

/** The allow-listed read `args` is, if any. */
export const allowedRead = (args: ReadonlyArray<string>, repo: string): AllowedRead | undefined => {
  const plain = withoutOwnGitDir(args, repo);
  return FIRST_READ_ALLOWED.find((read) => read.matches(plain));
};

/** What a passive read does: answered from the cache, served stale, or run (and whether that run starts the Container). */
export type PassiveDecision = "cache" | "stale" | "run" | "run-starting-container";

/**
 * The rule, kept pure: a cached answer at the current revision wins; a running Container answers; a stopped one is
 * started only by an allow-listed `.git` read with no answer at all. Everything else gets its last answer (stale).
 */
export const passiveDecision = (input: {
  readonly cachedNow: boolean;
  readonly running: boolean;
  readonly hasLastAnswer: boolean;
  readonly allowed: boolean;
  readonly emulated: boolean;
}): PassiveDecision => {
  if (input.cachedNow) return "cache";
  if (input.running) return "run";
  if (!input.hasLastAnswer && input.allowed && !input.emulated) return "run-starting-container";
  return "stale";
};

/** The allow-listed reads to answer now, for the repo's branches and remote-tracking refs. */
export const primeArgvs = (refs: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => [
  ["rev-parse", "--git-common-dir"],
  ["remote"],
  ["config", "--get", "checkout.workers"],
  COMMIT_GIT_PATHS,
  COUNT_OBJECTS_ARGV,
  ...refs.filter((ref) => ref.startsWith("refs/heads/")).map((ref) => ["for-each-ref", UPSTREAM_FORMAT, ref]),
  ...refs
    .filter((ref) => ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
    .map((ref) => ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
];

const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The most bytes of output the prime's ref listing, and then its answers, may each take. A sanity bound (ADR-0048) under
 * the named constraint, the Workspace DO's 128 MB isolate, which holds a whole output 3 to 4 times at its peak
 * (`execOutput.ts`). Both run whole, not tailed by computer (its last 2,000 lines or 64 KiB would drop the head), and
 * both list the most needed first: the fixed reads, then the local branches, then the remote-tracking refs. So a cut
 * drops only the last remote refs, whose reads then start the Container as an unprimed read does.
 */
export const PRIME_OUTPUT_BYTES = 4 * 1024 * 1024;

/** `command`'s output cut to `bytes` (`head -c`); a command ended by the cut (SIGPIPE, 141) counts as success. */
const cutTo = (command: string, bytes: number): string =>
  `${command} | head -c ${bytes}\nrc=\${PIPESTATUS[0]}\n[ "$rc" = 141 ] && rc=0\nexit "$rc"`;

/** The repo's branches, then its remote-tracking refs (`for-each-ref` sorts by name), at most `bytes` of them. */
export const listRefsScript = (bytes: number): string =>
  cutTo("git for-each-ref --format='%(refname)' refs/heads refs/remotes", bytes);

/**
 * The command that runs a prime script given on its stdin (`primeScript`), never as the script itself: Linux caps one
 * argument at 128 KiB (MAX_ARG_STRLEN), and the script grows with the repo's refs. Its answers are cut at `bytes`; the
 * script stops at the cut.
 */
export const primeRunner = (bytes: number): string =>
  `p=$(mktemp); cat > "$p"; bash "$p" | head -c ${bytes}; rm -f "$p"; exit 0`;

/**
 * One script answering every argv: `T3P <index> <exit> <stdout base64>` per read, in order. Run by `primeRunner`: when its
 * cut closes the pipe, the next answer fails to write and the script ends, its temporary file removed.
 */
export const primeScript = (argvs: ReadonlyArray<ReadonlyArray<string>>): string =>
  [
    `t=$(mktemp); trap 'rm -f "$t"' EXIT; trap '' PIPE`,
    ...argvs.map(
      (argv, index) =>
        `git ${argv.map(word).join(" ")} >"$t" 2>/dev/null; echo "T3P ${index} $? $(base64 -w0 <"$t")" || exit 0`,
    ),
  ].join("\n");

/** `stdout`'s lines that ended: the last, when a cut fell inside it, is dropped. */
const wholeLines = (stdout: string): Array<string> => stdout.split("\n").slice(0, -1);

export const parsePrimed = (
  stdout: string,
): ReadonlyArray<{ readonly index: number; readonly exitCode: number; readonly stdout: string }> =>
  wholeLines(stdout)
    .filter((line) => line.startsWith("T3P "))
    .map((line) => {
      const [, index, exit, data = ""] = line.split(" ");
      return {
        index: Number(index),
        exitCode: Number(exit),
        stdout: new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0))),
      };
    });

/** A passive exec in the repo, its output whole (the scripts above bound their own). */
export type PrimeExec = (input: {
  readonly script: string;
  readonly stdin?: string;
}) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

/**
 * The allow-listed reads' answers, read now: the refs listed, then every read for them answered in one script. Throws
 * when the refs cannot be listed, or `running` says the Container stopped meanwhile.
 */
export const primeReads = async (
  exec: PrimeExec,
  running: () => boolean,
  bytes: number = PRIME_OUTPUT_BYTES,
): Promise<
  ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly exitCode: number; readonly stdout: string }>
> => {
  const listed = await exec({ script: listRefsScript(bytes) });
  if (listed.exitCode !== 0 || !running()) throw new Error("the refs could not be listed");
  const argvs = primeArgvs(wholeLines(listed.stdout).filter((line) => line !== ""));
  const primed = await exec({ script: primeRunner(bytes), stdin: primeScript(argvs) });
  return parsePrimed(primed.stdout).flatMap((answer) => {
    const argv = argvs[answer.index];
    return argv === undefined ? [] : [{ argv, exitCode: answer.exitCode, stdout: answer.stdout }];
  });
};
