// The Environment ↔ Workspace contract (ADR-0008, ADR-0009; step 2a plan, section 2). Plain types and the path
// translation: t3 sees a Workspace's repo at `/w/<id>`; inside the Workspace (its Durable Object's files, the Worker
// Shell, the Container) the repo is at `/workspace/repo`, because `@cloudflare/computer` fixes `/workspace`.

/** t3's root of every Workspace. */
export const W_ROOT = "/w";
/** Inside a Workspace: computer's root, the repo, and the harness's own files beside it. */
export const WORKSPACE_ROOT = "/workspace";
export const REPO_ROOT = "/workspace/repo";
export const HARNESS_ROOT = "/workspace/.t3flare";

/** A project Workspace id: the one path segment under `/w` (ADR-0008). */
export const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isWorkspaceId = (value: string): boolean => WORKSPACE_ID.test(value) && value !== "." && value !== "..";

/** Where worktree Workspaces live (t3's `worktreesDir`, step 2b): `/w/.wt/<project dir>/<worktree dir>`. */
export const WORKTREES_SEGMENT = ".wt";
export const WORKTREES_ROOT = `${W_ROOT}/${WORKTREES_SEGMENT}`;

/** One path segment t3 may make from a branch name: no `/`, NUL or control character, not `.`/`..`, at most 100 bytes. */
export const isWorktreeDir = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
  !/[/\x00-\x1f\x7f]/.test(value) &&
  new TextEncoder().encode(value).byteLength <= 100;

/** A worktree Workspace id: its path below `/w`, `.wt/<project dir>/<dir>` (step 2b). */
export const isWorktreeId = (value: string): boolean => {
  const parts = value.split("/");
  return parts.length === 3 && parts[0] === WORKTREES_SEGMENT && isWorkspaceId(parts[1]!) && isWorktreeDir(parts[2]!);
};

/** Any Workspace id: a project's or a worktree's. */
export const isAnyWorkspaceId = (value: string): boolean => isWorkspaceId(value) || isWorktreeId(value);

/** The directories t3 sees above worktree Workspaces (`/w/.wt`, `/w/.wt/<project dir>`), which hold no files of their own. */
export const worktreeDirOf = (path: string): { readonly project: string | null } | null => {
  const normal = normalize(path);
  if (normal === WORKTREES_ROOT) return { project: null };
  const match = /^\/w\/\.wt\/([^/]+)$/.exec(normal);
  return match !== null && isWorkspaceId(match[1]!) ? { project: match[1]! } : null;
};

/**
 * `/w/<id>/rest` → `{ id, inner: "/workspace/repo/rest" }`, for a project (`/w/<p>/…`) or a worktree
 * (`/w/.wt/<p>/<dir>/…`, id `.wt/<p>/<dir>`); null for a path outside one Workspace.
 */
export const toWorkspace = (path: string): { readonly id: string; readonly inner: string } | null => {
  const normal = normalize(path);
  const worktree = /^\/w\/(\.wt\/[^/]+\/[^/]+)(\/.*)?$/.exec(normal);
  if (worktree !== null) {
    if (!isWorktreeId(worktree[1]!)) return null;
    return { id: worktree[1]!, inner: `${REPO_ROOT}${worktree[2] ?? ""}` };
  }
  const match = /^\/w\/([^/]+)(\/.*)?$/.exec(normal);
  if (match === null || !isWorkspaceId(match[1]!)) return null;
  const rest = match[2] ?? "";
  return { id: match[1]!, inner: `${REPO_ROOT}${rest === "/" ? "" : rest}` };
};

/** `/workspace/repo/rest` in Workspace `id` → `/w/<id>/rest`; other paths are returned unchanged. */
export const fromWorkspace = (id: string, inner: string): string =>
  inner === REPO_ROOT || inner.startsWith(`${REPO_ROOT}/`) ? `${W_ROOT}/${id}${inner.slice(REPO_ROOT.length)}` : inner;

/** Replaces every `/workspace/repo` path prefix in `text` with `/w/<id>` (git's printed paths). */
export const fromWorkspaceText = (id: string, text: string): string =>
  text.replace(/\/workspace\/repo(?=\/|$|\s|"|')/g, `${W_ROOT}/${id}`);

/** POSIX normalization: `.` and `..` resolved, duplicate slashes removed. */
export const normalize = (path: string): string => {
  const out: Array<string> = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

export const isUnderW = (path: string): boolean => {
  const normal = normalize(path);
  return normal === W_ROOT || normal.startsWith(`${W_ROOT}/`);
};

// ---------------------------------------------------------------------------------------------------------------------
// RPC shapes (methods of WorkspaceDO); paths here are inside the Workspace.

export type FileKind = "file" | "directory" | "symlink";

export interface FileStat {
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: FileKind;
}

export interface FsError {
  readonly error: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "EIO";
  readonly message: string;
}

export type FsAnswer<A> = { readonly ok: A } | FsError;

export interface FoundEntry {
  readonly path: string;
  readonly kind: FileKind;
}

/** A Workspace's file index (FsOp `index`, SPI-1364): its entries, and whether they were cut to fit `maxBytes`. */
export interface FoundIndex {
  readonly entries: ReadonlyArray<FoundEntry>;
  readonly truncated: boolean;
}

/**
 * What an entry of `FoundIndex` may take crossing DO RPC, in bytes, to count against `maxBytes`: its path at 2 bytes a
 * character (a string with any character past Latin-1 crosses as UTF-16) and 64 for its keys and kind.
 */
export const foundEntryBytes = (entry: FoundEntry): number => entry.path.length * 2 + 64;

/** The first of `entries` whose `foundEntryBytes` fit in `maxBytes`, and whether any were left out. */
export const fitFoundEntries = (entries: ReadonlyArray<FoundEntry>, maxBytes: number): FoundIndex => {
  let bytes = 0;
  for (let at = 0; at < entries.length; at++) {
    bytes += foundEntryBytes(entries[at]!);
    if (bytes > maxBytes) return { entries: entries.slice(0, at), truncated: true };
  }
  return { entries, truncated: false };
};

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface GitRun {
  readonly argv: ReadonlyArray<string>;
  /** Inside the Workspace. */
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** May start a stopped Container (the router's allow-list); else a passive read, answered from the read cache when it can. */
  readonly startContainer: boolean;
  /** What a passive read's answer depends on: `.git` alone, or the whole repo (working tree included). */
  readonly readScope?: "git-dir" | "repo";
  /** The caller's id for this run, by which `cancelRun` ends it when t3 gives up on it (SPI-1364). */
  readonly runId?: string;
  /**
   * The Environment's epoch (its boot count) when a run with a `runId` was sent: once the Environment is at a newer one,
   * the t3 that could cancel the run is gone, and the Workspace ends it (SPI-1382).
   */
  readonly environmentEpoch?: number;
}

export type GitAnswer =
  | {
      readonly ran: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly ms: number;
      readonly cached?: boolean;
      /** A passive read answered while the Container was stopped: the last real answer, patched with the write journal where its shape allows. */
      readonly stale?: "patched" | "last-answer";
      /** Step 2b: an allow-listed `.git` read with no answer at all started the stopped Container (its name). */
      readonly startedContainer?: string;
    }
  | { readonly ran: false; readonly reason: "container_stopped" | "container_refused"; readonly detail: string };

export interface CloneInput {
  /** The Workspace's id, which the object keeps (the credential helper asks for its repo's token by it). */
  readonly id?: string;
  /** An https URL with no credentials; the credential helper asks the Workspace DO for the repo's token (ADR-0013). */
  readonly url: string;
  /** The clone time limit (`cloneMinutes`, SPI-1324) in ms, carried by the Environment DO; absent, the default. */
  readonly timeoutMs?: number;
}

export interface ProvisionInfo {
  readonly provisioned: boolean;
  readonly repo: boolean;
  readonly containerRunning: boolean;
  /** The repo's revision in the Workspace's change log, and how many passive reads are kept (diagnosis). */
  readonly revision?: number;
  readonly gitRevision?: number;
  readonly cachedReads?: number;
  /** The Workspace id the object knows itself by (the credential helper's token is for its repo). */
  readonly id?: string | null;
  /** Step 2b: purged (`destroy()`); every RPC but provisioning refuses. */
  readonly destroyed?: boolean;
}

/** t3's checkpoint operations (`VcsCheckpointOps`), answered by the Workspace DO (ADR-0009; step 2a M3). Refs are git refs. */
export type CheckpointOp =
  | { readonly op: "capture"; readonly ref: string }
  | { readonly op: "has"; readonly ref: string }
  | {
      readonly op: "diff";
      readonly from: string;
      readonly to: string;
      readonly fallbackFromToHead: boolean;
      readonly ignoreWhitespace: boolean;
      readonly format: "patch" | "numstat";
      readonly filePaths?: ReadonlyArray<string>;
      readonly maxOutputBytes?: number;
    }
  | { readonly op: "authored"; readonly from: string; readonly to: string }
  | { readonly op: "delete"; readonly refs: ReadonlyArray<string> }
  | { readonly op: "restore"; readonly ref: string; readonly fallbackToHead: boolean };

/** A checkpoint operation's answer, and which side made it (the DO's isomorphic-git, or the Container's git). */
export type CheckpointAnswer =
  | { readonly ok: true; readonly value: unknown; readonly by: "do" | "container" | "alias" }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------------------------------------------------
// Terminals (step 2b, ADR-0021): the Environment's PTY adapter ⇄ the Workspace DO's terminal host. Keys are made by the
// adapter (`term-<hex>`), and are also the shell's marker in the Container.

export interface TerminalOpenInput {
  readonly key: string;
  /** t3's path of the Workspace's repo (`/w/<id>`) and t3's cwd at or below it. */
  readonly t3Path: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** Already allowlisted by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  /** A worktree's project (`/w/<project>`): linked to the worktree's project-root view in its Container (step 2b). */
  readonly projectRoot?: string;
  /** An agent's Terminal or Background job (SPI-1057): this command under `bash -c`, not an interactive bash. */
  readonly command?: string;
}

/** Every answer names the Workspace DO instance (its epoch): a new epoch means the old one's terminals are gone. */
export interface TerminalAnswer {
  readonly epoch: string;
  /** Keys this instance does not hold (an exited or unknown terminal). */
  readonly unknown: ReadonlyArray<string>;
}

/** One terminal's output, in order (`seq`); `busy` is the foreground's state after the data; `exit` ends it. */
export interface TerminalFrame {
  readonly key: string;
  readonly seq: number;
  readonly data?: string;
  readonly busy?: boolean;
  readonly exit?: { readonly code: number };
}

/** A batch of frames a Workspace DO pushes to the Environment DO. */
export interface TerminalPush {
  readonly workspace: string;
  readonly epoch: string;
  readonly frames: ReadonlyArray<TerminalFrame>;
}

/** The Environment's answer: keys it does not know (it restarted, or the terminal was closed): kill them. */
export interface TerminalPushAnswer {
  readonly unknown: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The process channel (step 4a, ADR-0015's refinement): t3's spawns of `codex app-server` and `pi --mode rpc` run in a
// Workspace's Container under the platform's non-PTY exec. The Environment's spawner ⇄ the Workspace DO's process host.
// Keys are made by the spawner (`proc-<uuid>`) and are also the process's marker in the Container (`T3FLARE_EXEC`).
// Data is bytes end to end (review F6): JSON lines split across frames are joined by t3's own line decoder.

/** The CLI a process runs; `probe` is M1's test program, refused unless the stage allows faults. */
export type ProcessCli = "codex" | "pi" | "probe" | "claude" | "opencode";

export interface ProcessStartInput {
  readonly key: string;
  /** The Environment DO's boot counter (durable): processes of any other epoch in this Workspace are killed first. */
  readonly environmentEpoch: number;
  readonly cli: ProcessCli;
  /** t3's path of the Workspace's repo (`/w/<id>`) and t3's cwd at or below it: the launcher makes them resolve. */
  readonly t3Path: string;
  readonly cwd: string;
  /** The binary (absolute, in the image) and its arguments, as the CLI profile built them. */
  readonly argv: ReadonlyArray<string>;
  /** The profile's allowlisted environment; the host adds `T3FLARE_EXEC` and the key nonce. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Copies of the Owner's config for the CLI from their home into its home, made first (ADR-0047 §9; `process.ts`
   * `ProcessSeed`): a directory's entries but `skip`, or a file.
   */
  readonly seed?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly skip?: ReadonlyArray<string>;
    readonly shadow?: { readonly dir: string; readonly by: string };
  }>;
  /**
   * A check of what the seed copied (`process.ts` `ProcessCheck`): when `when` exists, `argv` runs first, and its failure
   * ends the launch with `failure` on stderr.
   */
  readonly check?: { readonly when: string; readonly argv: ReadonlyArray<string>; readonly failure: string };
  /** Files the profile writes on the Container's own disk before the start (the CLI's home), by absolute path; `keep`: only where the seed left none. */
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly text: string;
    readonly mode?: number;
    readonly keep?: boolean;
  }>;
  /** Symbolic links made before the start (Codex's `sessions/` into the synced directory); `merge`: into a seeded directory, entry by entry. */
  readonly links?: ReadonlyArray<{ readonly path: string; readonly target: string; readonly merge?: boolean }>;
  /** Session retention: files under `dir` untouched for `days` are removed before the start. */
  readonly prune?: ReadonlyArray<{ readonly dir: string; readonly days: number }>;
  /** t3's thread, for the MCP relay and the logs. */
  readonly thread?: string;
  /**
   * The process's tool handle (ADR-0028): what the CLI sends the MCP relay (`/t3flare/mcp/*`) as its bearer. Kept only
   * while the process lives; never logged.
   */
  readonly toolHandle?: string;
  /**
   * The Model endpoints the process reaches through the model relay (SPI-1167), by id: with any, the Workspace DO makes
   * it a model handle, puts it in the process's environment (`MODEL_HANDLE_ENV`) and redeems it at the relay
   * (`/t3flare/model/<endpointId>/*`) for these endpoints only, while the process lives. The handle never leaves the
   * Workspace DO and the process.
   */
  readonly modelRelay?: ReadonlyArray<string>;
}

/** A Tool handle or a model handle: 32 random bytes, hex. */
export const HANDLE = /^[0-9a-f]{64}$/;

/** A new Tool handle or model handle (`HANDLE`). */
export const newHandle = (): string =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Whether two handles are equal, in time that does not depend on where they differ. */
export const sameHandle = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let at = 0; at < a.length; at++) difference |= a.charCodeAt(at) ^ b.charCodeAt(at);
  return difference === 0;
};

/** Every answer names the Workspace DO's boot counter: another value means the processes it held are gone. */
export interface ProcessAnswer {
  readonly epoch: number;
  readonly unknown: ReadonlyArray<string>;
}

export type ProcessStartAnswer =
  | {
      readonly ok: true;
      readonly epoch: number;
      /** Whether bubblewrap works in this Container (probed at each Container start, review F5): Codex's sandbox. */
      readonly sandbox?: boolean;
    }
  | { readonly ok: false; readonly epoch: number; readonly reason: string };

/** One process's output in order (`seq`, one counter per process across both streams); `exit` comes last. */
export interface ProcessFrame {
  readonly key: string;
  readonly seq: number;
  readonly stream: "stdout" | "stderr" | "exit";
  readonly data?: Uint8Array;
  readonly code?: number;
}

/**
 * The Environment's read of a Workspace's output (a long poll; the channel pulls, it never pushes: a push answered
 * inside the Environment's own calls nests one level deeper per round trip, up to the platform's subrequest depth
 * limit). `keys` are the Environment's live processes there (the read is their heartbeat); `ack` is the last batch it
 * received, so a batch whose answer was lost is sent again.
 */
export interface ProcessReadInput {
  readonly keys: ReadonlyArray<string>;
  readonly ack: number;
  readonly waitMs: number;
}

export interface ProcessReadAnswer extends ProcessAnswer {
  /** 0 when no frames came. */
  readonly batch: number;
  readonly frames: ReadonlyArray<ProcessFrame>;
}

/** `processInput`'s answer: `gap` and `failed` end the process (a write is never skipped, review F6). */
export type ProcessInputAnswer = ProcessAnswer & {
  readonly accepted: "written" | "duplicate" | "gap" | "failed" | "unknown";
};

// ---------------------------------------------------------------------------------------------------------------------
// The agent's Terminals and Background jobs (SPI-1057, pi-termctrl): PTYs in the Workspace's Container that a Durable
// agent's tools drive, beside t3's own terminals and under the same host (ADR-0021). The Workspace DO renders each one's
// screen; the Session's tools ask for it. Ids are the owner Session's (`t1`, `b1`, …), never reused for that Session.

export type AgentEntryKind = "terminal" | "background_job";

/** How an entry's process ended: an exit code or a signal name (`SIGKILL`), and what else is known of its end. */
export interface AgentExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** What else is known, in words: the Container stopped, the exit went unreported, processes survived the stop. */
  readonly note?: string;
}

/** A zero-based screen position. */
export interface AgentCursor {
  readonly x: number;
  readonly y: number;
}

/** One entry as `list` and `wait` report it. */
export interface AgentEntryInfo {
  readonly id: string;
  readonly kind: AgentEntryKind;
  readonly command: string;
  readonly cwd: string;
  readonly state: "running" | "exited";
  readonly exit: AgentExit | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** A Background job's log in the Container. */
  readonly logPath?: string;
}

/** Why a settle wait ended (pi-termctrl's `settle_reason`); `chunk`: the Workspace's slice of the wait ran out, ask again. */
export type AgentSettleReason = "matched" | "timeout" | "quiet" | "exited" | "chunk";

/**
 * A Terminal's screen and what scrolled off it since the owner's previous view, with that previous view (the rows it
 * showed and its cursor row) so the tool can show only what changed.
 */
export interface AgentView {
  readonly id: string;
  readonly state: "running" | "exited";
  readonly exit: AgentExit | null;
  /** The visible rows, trailing blank rows trimmed. */
  readonly screen: string;
  readonly cursor: AgentCursor | null;
  /** Lines that scrolled off the screen since the previous view, oldest first. */
  readonly scrolledOff: ReadonlyArray<string>;
  /** Lines the owner never saw were dropped from the scrollback, or the screen was cleared. */
  readonly outputMissing: boolean;
  readonly previous: { readonly screen: string; readonly cursorRow: number | null } | null;
  /** How many rows the screen scrolled since the previous view; null when unknown (no previous view, or a gap). */
  readonly shift: number | null;
  /** A Background job's recent output (its last lines). */
  readonly output?: string;
  readonly logPath?: string;
}

/**
 * The last lines of a Background job's output a request's answer carries (`AgentView.output`, an exit's `tail`): the
 * Session's Tool output limit less the room around them (SPI-1362). Absent in a request from before it: the Workspace's
 * own default.
 */
export interface AgentTail {
  readonly lines: number;
  readonly bytes: number;
}

export type AgentTerminalRequest =
  | {
      readonly op: "start";
      readonly owner: string;
      readonly kind: AgentEntryKind;
      readonly command: string;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly notify: boolean;
    }
  | {
      readonly op: "settle";
      readonly owner: string;
      readonly id: string;
      /** Typed before the wait: text, then termctrl key names. */
      readonly text?: string;
      readonly keys?: ReadonlyArray<string>;
      readonly mode: "start" | "input" | "poll";
      /** The whole wait's deadline (epoch ms); the Workspace answers `chunk` after at most `chunkMs`. */
      readonly deadline: number;
      readonly chunkMs: number;
      readonly pattern?: string;
      /** The screen at the wait's start, when an earlier chunk began it. */
      readonly since?: string;
      /** Record this answer as the owner's view (a final answer); a chunk is not. */
      readonly view: boolean;
      readonly tail?: AgentTail;
      /** How long the screen must be quiet to settle (`termctrl.quietMs`, SPI-1364); absent, termctrl's 250 ms. */
      readonly quietMs?: number;
    }
  | {
      readonly op: "stop";
      readonly owner: string;
      readonly id: string;
      readonly tail?: AgentTail;
      /** How long the stop waits for the exit after the close (`termctrl.stopGraceSeconds`, SPI-1364); absent, 3 s. */
      readonly graceMs?: number;
    }
  | { readonly op: "list"; readonly owner: string }
  | {
      readonly op: "wait";
      readonly owner: string;
      readonly ids: ReadonlyArray<string> | null;
      readonly deadline: number;
      readonly chunkMs: number;
    }
  /** Exits the owner has not seen in a result, with their last lines; taken ones are not reported again. */
  | { readonly op: "exits"; readonly owner: string; readonly tail?: AgentTail };

/** What each request answers. */
export interface AgentTerminalAnswers {
  readonly start: { readonly entry: AgentEntryInfo };
  readonly settle: { readonly view: AgentView; readonly reason: AgentSettleReason; readonly startScreen: string };
  readonly stop: { readonly stopped: AgentEntryInfo; readonly view: AgentView };
  readonly list: { readonly entries: ReadonlyArray<AgentEntryInfo> };
  readonly wait: {
    readonly exited: ReadonlyArray<AgentEntryInfo>;
    readonly running: ReadonlyArray<AgentEntryInfo>;
    readonly timedOut: boolean;
  };
  readonly exits: { readonly exits: ReadonlyArray<AgentEntryInfo & { readonly tail: string }> };
}

/** A request's answer, or why it failed (an unknown id, the cap, a refused Container start). */
export type AgentTerminalResult<Op extends AgentTerminalRequest["op"]> =
  | { readonly ok: true; readonly value: AgentTerminalAnswers[Op] }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------------------------------------------------
// Container previews (G11, ADR-0031): Browser Run routes at most eight hosts, HTTP on port 80, each to the Workspace the
// browser was acquired for. Which ports is the Owner's Environment setting `previewPorts` (SPI-1364); t3flare's own
// (`RESERVED_CONTAINER_PORTS`, @t3flare/harness-registry) are never one of them.
export const CONTAINER_PREVIEW_DOMAIN = "t3flare.internal";
export const containerPreviewHost = (port: number): string => `${port}.${CONTAINER_PREVIEW_DOMAIN}`;
/** Where the carried sockets' endpoints are on every Container preview host, and the header their requests carry. */
export const CONTAINER_PREVIEW_SOCKET_PATH = "/__t3flare/ws/";
export const CONTAINER_PREVIEW_HEADER = "x-t3flare-preview";

export { describeFailure, failureMessage, startRefusal } from "./startRefusal.ts";
export * from "./skillsLock.ts";
