// A CLI agent's process in the Container (step 4a, the process channel). No Node imports, so the agents Worker can
// import it: the Workspace DO runs `processCommand(…)` with `PROCESS_SHELL -c` under the platform's non-PTY exec.
//
// The launcher writes nothing to stdout (it is the CLI's JSON-RPC stream): its own notes go to stderr. It
//
// - turns core dumps off (`ulimit -c 0`, review F3: a dump of a CLI holding the key would land on disk);
// - makes t3's path of the Workspace (`/w/<id>`) the repo itself (a bind mount, else a symlink), as terminals do, so the
//   CLI sees t3's own paths;
// - removes the homes of CLI processes that no longer run, then writes this process's home fresh on the Container's own
//   disk (review F2: nothing a CLI loads at start comes from the synced, agent-writable Workspace): first a copy of the
//   Owner's own config for the CLI from their home (`OWNER_HOME`) when the profile seeds it (ADR-0047 §9, their dotfiles), then the
//   profile's files over it and its links;
// - runs the profile's check of the seeded config, when the seed copied one, and ends with a note naming that file when
//   the CLI cannot load it (ADR-0047 §9: the Owner's file broke their agent, and they can see why);
// - `cd`s to t3's cwd and becomes the CLI, leader of its own session (`setsid --wait`), so part 2's kill script takes
//   its whole tree by the marker.
//
// SPI-1209: it names every program it runs by its absolute path, as the Workspace DO names its shell
// (`PROCESS_SHELL`). The image puts mise's shims first on PATH and trusts /workspace's mise configuration, so a project
// could supply a `mkdir` or a `setsid`, which would get the process's model handle from this environment (or, as
// `setsid`, become its holder). setsid keeps its name in argv (`exec -a setsid`): the handle helpers and the holder
// lists find the holder by its command line, `setsid --wait <launcher> …`.

import { OWNER_HOME } from "./env.ts";

/** The shell the Workspace DO runs `processCommand`'s script with, by its absolute path (SPI-1209). */
export const PROCESS_SHELL = "/usr/bin/bash";

/** Where CLI homes live: the Container's own disk, never synced (not under /workspace). */
export const CLI_HOMES = "/var/lib/t3flare/cli";

/** `proc-<uuid>`: the kill script's id grammar (`[A-Za-z0-9-]+`). */
export const isProcessMarker = (value: string): boolean => /^proc-[A-Za-z0-9-]{1,80}$/.test(value);

/** A CLI process's home: `CLI_HOMES/<marker>`. */
export const cliHomeOf = (marker: string): string => `${CLI_HOMES}/${marker}`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export interface ProcessFile {
  /** Absolute; inside the process's home, or under `/workspace/.t3flare/` for the synced session directories. */
  readonly path: string;
  readonly text: string;
  readonly mode?: number;
  /** Written only when the seed left no file there (a placeholder the Owner's own file replaces). */
  readonly keep?: boolean;
}

/**
 * A copy of the Owner's config into the process's home before its files (ADR-0047 §9): `from` (under `OWNER_HOME`) is a
 * directory, whose entries are copied but those named in `skip` (the CLI's synced session directories), or a file.
 * Nothing when it is missing. Links are copied as what they point at, so the CLI's writes never reach the Owner's files.
 */
export interface ProcessSeed {
  readonly from: string;
  readonly to: string;
  readonly skip?: ReadonlyArray<string>;
  /**
   * After the copy, each entry of `to`/`dir` named as an entry of `by` is removed: `by`'s wins a name clash where the CLI
   * keeps the first of a name and reads the copy first (pi's Skills, which it reads before its `--skill` paths).
   */
  readonly shadow?: { readonly dir: string; readonly by: string };
}

/**
 * A symbolic link made before the start. `merge`: when the seed left a directory there (the Owner's own Skills), each
 * entry of `target` is linked into it instead, replacing the Owner's entry of its name.
 */
export interface ProcessLink {
  readonly path: string;
  readonly target: string;
  readonly merge?: boolean;
}

/**
 * A check of a seeded config before the start (ADR-0047 §9): when `when` exists (the Owner's file the seed copied),
 * `argv` (absolute) runs with the process's environment from `/`; when it fails, the launcher prints `failure` and the
 * check's first lines on stderr, and exits 78 without starting the CLI.
 */
export interface ProcessCheck {
  readonly when: string;
  readonly argv: ReadonlyArray<string>;
  readonly failure: string;
}

/** What the launcher exits with when a check fails: EX_CONFIG. */
export const CHECK_FAILED_EXIT = 78;

/**
 * How long a check may take, in seconds (then KILL 5 s later): a CLI loading its config takes about a second. Bounded so
 * a hung check never holds the spawn; one that runs out is no verdict on the file, and the CLI starts anyway.
 */
export const CHECK_TIMEOUT_SEC = 30;

export interface ProcessCommandInput {
  readonly marker: string;
  /** t3's path of the Workspace's repo, `/w/<id>`. */
  readonly t3Path: string;
  /** t3's cwd (at or below `t3Path`); the repo root when it does not exist. */
  readonly cwd: string;
  /** The binary (absolute) and its arguments. */
  readonly argv: ReadonlyArray<string>;
  /** Copies of the Owner's config made first (ADR-0047 §9). */
  readonly seed?: ReadonlyArray<ProcessSeed>;
  /** A check of what the seed copied, after the files and links (ADR-0047 §9). */
  readonly check?: ProcessCheck;
  /** Files written before the start (the CLI's home, its config), over the seed. */
  readonly files?: ReadonlyArray<ProcessFile>;
  /** Symbolic links made before the start: `{ path, target }` (Codex's `sessions/` into the synced directory). */
  readonly links?: ReadonlyArray<ProcessLink>;
  /** Session retention (review F2): files under `dir` (in the synced harness directory) untouched for `days` are removed. */
  readonly prune?: ReadonlyArray<{ readonly dir: string; readonly days: number }>;
}

/** Where a profile may write: the process's own home, or the synced harness directory (session directories only). */
const writable = (marker: string, path: string): boolean =>
  !path.includes("/../") &&
  !path.endsWith("/..") &&
  (path.startsWith(`${cliHomeOf(marker)}/`) || path.startsWith("/workspace/.t3flare/"));

/** Where a seed may copy: from the Owner's home into the process's own home, no `..` anywhere; a shadow names one directory. */
const seedable = (marker: string, seed: ProcessSeed): boolean =>
  ![seed.from, seed.to, ...(seed.shadow === undefined ? [] : [seed.shadow.by])].some(
    (path) => path.includes("/../") || path.endsWith("/.."),
  ) &&
  seed.from.startsWith(`${OWNER_HOME}/`) &&
  seed.to.startsWith(`${cliHomeOf(marker)}/`) &&
  (seed.shadow === undefined ||
    (/^[A-Za-z0-9._-]+$/.test(seed.shadow.dir) && seed.shadow.dir !== ".." && seed.shadow.by.startsWith("/")));

/**
 * The check's lines: nothing unless its file exists; the CLI's own loader, bounded, from `/`, its stdin closed (the
 * launcher's stdin is the CLI's protocol stream), its stdout dropped and its stderr kept for the note.
 */
const checkLines = (check: ProcessCheck): ReadonlyArray<string> => [
  `if [ -e ${quote(check.when)} ]; then`,
  `  t3flare_check=$(cd / && /usr/bin/timeout -k 5 ${CHECK_TIMEOUT_SEC} ${check.argv.map(quote).join(" ")} 2>&1 >/dev/null </dev/null); t3flare_rc=$?`,
  "  case $t3flare_rc in",
  "    0) ;;",
  `    124|137) printf 't3flare: the check of %s did not finish in ${CHECK_TIMEOUT_SEC} s; starting anyway\\n' ${quote(check.when)} ;;`,
  `    *) printf 't3flare: %s\\n' ${quote(check.failure)}; printf '%s\\n' "$t3flare_check" | /usr/bin/head -n 8; exit ${CHECK_FAILED_EXIT} ;;`,
  "  esac",
  "fi",
];

/** The seed's copy: a directory's entries (dotfiles too) but the skipped, or a file; nothing when it is missing. */
const seedLines = (seed: ProcessSeed): ReadonlyArray<string> => {
  const skip = (seed.skip ?? []).map(quote);
  return [
    `if [ -d ${quote(seed.from)} ]; then /usr/bin/mkdir -p ${quote(seed.to)}`,
    `  for e in ${quote(seed.from)}/* ${quote(seed.from)}/.[!.]* ${quote(seed.from)}/..?*; do [ -e "$e" ] || continue`,
    ...(skip.length === 0 ? [] : [`    case "\${e##*/}" in ${skip.join("|")}) continue ;; esac`]),
    `    /usr/bin/cp -RL -- "$e" ${quote(seed.to)}/ || :`,
    "  done",
    ...(seed.shadow === undefined
      ? []
      : [
          `  if [ -d ${quote(`${seed.to}/${seed.shadow.dir}`)} ]; then for e in ${quote(seed.shadow.by)}/* ${quote(seed.shadow.by)}/.[!.]* ${quote(seed.shadow.by)}/..?*; do [ -e "$e" ] || continue`,
          `    /usr/bin/rm -rf -- ${quote(`${seed.to}/${seed.shadow.dir}`)}/"\${e##*/}"; done; fi`,
        ]),
    `elif [ -f ${quote(seed.from)} ]; then /usr/bin/mkdir -p "$(/usr/bin/dirname ${quote(seed.to)})" && /usr/bin/cp -L -- ${quote(seed.from)} ${quote(seed.to)} || :; fi`,
  ];
};

/** A link's lines: a seeded directory at its path is merged into (`merge`) or replaced; one elsewhere is left as it was. */
const linkLines = (home: string, link: ProcessLink): ReadonlyArray<string> => {
  const make = [
    `/usr/bin/mkdir -p ${quote(link.target)} "$(/usr/bin/dirname ${quote(link.path)})"`,
    `/usr/bin/ln -sfn ${quote(link.target)} ${quote(link.path)}`,
  ];
  if (!link.path.startsWith(`${home}/`)) return make;
  const seeded = `[ -d ${quote(link.path)} ] && [ ! -L ${quote(link.path)} ]`;
  if (link.merge !== true) return [`${seeded} && /usr/bin/rm -rf -- ${quote(link.path)}`, ...make];
  return [
    `if ${seeded}; then`,
    `  for e in ${quote(link.target)}/* ${quote(link.target)}/.[!.]* ${quote(link.target)}/..?*; do [ -e "$e" ] || continue`,
    `    /usr/bin/rm -rf -- ${quote(link.path)}/"\${e##*/}"; /usr/bin/ln -s -- "$e" ${quote(link.path)}/"\${e##*/}"`,
    "  done",
    "else",
    ...make.map((line) => `  ${line}`),
    "fi",
  ];
};

/** The wrapper `bash -c` runs; it ends by becoming the CLI. */
export const processCommand = (input: ProcessCommandInput): string => {
  if (!isProcessMarker(input.marker)) throw new Error(`t3flare: bad process marker ${input.marker}`);
  if (input.argv.length === 0 || !input.argv[0]!.startsWith("/"))
    throw new Error("t3flare: a process's binary must be an absolute path");
  for (const file of [
    ...(input.files ?? []),
    ...(input.links ?? []),
    ...(input.prune ?? []).map((entry) => ({ path: `${entry.dir}/x` })),
  ]) {
    if (!writable(input.marker, file.path)) throw new Error(`t3flare: a process may not write ${file.path}`);
  }
  if (input.check !== undefined && !input.check.argv[0]?.startsWith("/"))
    throw new Error("t3flare: a check's program must be an absolute path");
  for (const seed of input.seed ?? []) {
    if (!seedable(input.marker, seed)) throw new Error(`t3flare: a process may not copy ${seed.from} to ${seed.to}`);
  }
  const home = cliHomeOf(input.marker);
  return [
    "set -u",
    "exec 3>&1 1>&2", // the launcher's own output goes to stderr; fd 3 is the CLI's stdout
    "ulimit -c 0",
    "unset BASH_ENV",
    `if ! /usr/bin/mountpoint -q ${quote(input.t3Path)} 2>/dev/null && [ ! -L ${quote(input.t3Path)} ]; then`,
    `  /usr/bin/mkdir -p ${quote(input.t3Path)} && /usr/bin/mount --bind /workspace/repo ${quote(input.t3Path)} 2>/dev/null ||`,
    `  { /usr/bin/rmdir ${quote(input.t3Path)} 2>/dev/null; /usr/bin/mkdir -p "$(/usr/bin/dirname ${quote(input.t3Path)})"; /usr/bin/ln -sfn /workspace/repo ${quote(input.t3Path)}; }`,
    "fi",
    // Homes of processes that no longer run (none carries their marker).
    `/usr/bin/mkdir -p ${CLI_HOMES} && for d in ${CLI_HOMES}/proc-*; do [ -d "$d" ] || continue; k=$(/usr/bin/basename "$d");`,
    `  /usr/bin/grep -lqa "T3FLARE_EXEC=$k" /proc/[0-9]*/environ 2>/dev/null || /usr/bin/rm -rf -- "$d"; done`,
    `/usr/bin/rm -rf -- ${quote(home)} && /usr/bin/mkdir -p -m 700 ${quote(home)}`,
    ...(input.seed ?? []).flatMap(seedLines),
    ...(input.files ?? []).flatMap((file) => {
      const write = [
        `/usr/bin/mkdir -p "$(/usr/bin/dirname ${quote(file.path)})"`,
        `printf %s ${quote(base64(file.text))} | /usr/bin/base64 -d > ${quote(file.path)}`,
        `/usr/bin/chmod ${(file.mode ?? 0o600).toString(8)} ${quote(file.path)}`,
      ];
      return file.keep === true
        ? [`if [ ! -e ${quote(file.path)} ]; then`, ...write.map((line) => `  ${line}`), "fi"]
        : write;
    }),
    ...(input.links ?? []).flatMap((link) => linkLines(home, link)),
    ...(input.check === undefined ? [] : checkLines(input.check)),
    ...(input.prune ?? []).map(
      (entry) =>
        `[ -d ${quote(entry.dir)} ] && /usr/bin/find ${quote(entry.dir)} -type f -mtime +${Math.max(1, Math.floor(entry.days))} -delete 2>/dev/null`,
    ),
    `cd -- ${quote(input.cwd)} 2>/dev/null || cd -- ${quote(input.t3Path)}`,
    `exec 1>&3 3>&-`,
    `exec -a setsid /usr/bin/setsid --wait ${input.argv.map(quote).join(" ")}`,
  ].join("\n");
};
