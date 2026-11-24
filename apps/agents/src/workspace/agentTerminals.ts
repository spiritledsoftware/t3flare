// @effect-diagnostics globalTimers:off
// The agent's Terminals and Background jobs (SPI-1057), the Workspace DO's half: pi-termctrl's Terminals
// (ian-pascoe/pi-extensions@a5e15d1:packages/pi-termctrl, `termctrl-registry.ts` and the termctrl driver's screen) as
// PTYs in the Workspace's Container. They run under a second `TerminalHost` (ADR-0021's host: the platform's PTY exec,
// markers, the kill script, the Container's hold measured from input), whose output feeds a headless xterm per entry
// here instead of t3's terminal adapter: the Workspace DO renders the screen, as termctrl's driver does, and answers
// the Session's tools with it.
//
// Adapted, not redesigned:
// - termctrl's driver process is the xterm here; its `status`/`screen.capture`/`logs` are `view()`;
// - the settle wait (`terminal-tools.ts` `settleTerminal`) runs here, in slices, so a wait is a few RPCs, not one per poll;
// - entries are kept per owner (the Session that started them); ids `t<n>`/`b<n>` count per owner and are never reused;
// - any number run at once (SPI-1397: no count, as termctrl's 16 and ADR-0021's 8 were memory's); exited ones stay
//   readable until stopped, as in termctrl, up to `AGENT_EXITED_TERMINALS_KEPT` across the Workspace's Sessions,
//   those whose exit was seen forgotten first (`#bound`);
// - each running entry's xterm keeps its screen and `AGENT_TERMINAL_SPILL_LINES` above it: what scrolls off goes to the
//   Workspace DO's SQLite (`./agentScrollback.ts`, up to `AGENT_TERMINAL_HISTORY_BYTES` a Terminal), and reads of it
//   come from there; an exited one keeps its final screen there too, and holds no xterm;
// - they end when the Container stops, as t3's terminals do, and when this object restarts (a deploy).
import {
  AGENT_EXITED_TERMINALS_KEPT,
  AGENT_TERMINAL_SPILL_LINES,
  DEFAULT_TERMINAL_QUIET_MS,
  defaultSettings,
  STOP_GRACE_SECONDS,
} from "@t3flare/harness-registry";
import type { KillAnswer } from "@t3flare/sandbox-image/kill";
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import type {
  AgentCursor,
  AgentEntryInfo,
  AgentTail,
  AgentEntryKind,
  AgentExit,
  AgentSettleReason,
  AgentTerminalAnswers,
  AgentTerminalRequest,
  AgentTerminalResult,
  AgentView,
  AgentViewOptions,
  TerminalFrame,
} from "@t3flare/workspace-client";

import { DEFAULT_TOOL_OUTPUT_LIMITS, jobTailOf } from "../extensions/toolOutput.ts";
import type { Scrollback, ScrollbackStore } from "./agentScrollback.ts";
import { agentTerminalDropped } from "./agentTerminalDropped.ts";

export { agentTerminalDropped } from "./agentTerminalDropped.ts";

/** termctrl's settle poll (`terminal-tools.ts`). The quiet that settles a wait is the request's (`termctrl.quietMs`). */
const POLL_MS = 50;
/**
 * How long a stop waits for the exit frame once its kill saw every process die. Not a setting: the frame only has to
 * cross the host's batch (`BULK_BATCH_MS`, 100 ms) and its push; past this the stop reports the kill's own answer.
 */
const EXIT_FRAME_MS = 1_000;
/**
 * A Background job's output as a result shows it when a request names none (one from before SPI-1362): the default
 * Tool output limit's job tail. A request carries its Session's (`AgentTail`).
 */
export const DEFAULT_JOB_TAIL: AgentTail = jobTailOf(DEFAULT_TOOL_OUTPUT_LIMITS);
/**
 * The scrolled-off lines a view reads from each end when a request names none (one from before SPI-1397): termctrl's
 * default `scrollbackLines`, so no request reads more than a result can show.
 */
const DEFAULT_SCROLLED_LINES = defaultSettings("termctrl").scrollbackLines as number;
/** Where a Background job's whole output is kept, in the Container. */
export const JOB_LOG_DIR = "/tmp/t3flare-jobs";

/** termctrl's key names, as the bytes a terminal reads. */
const KEYS: Readonly<Record<string, string>> = {
  Enter: "\r",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Tab: "\t",
  "Shift+Tab": "\x1b[Z",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `Control+${String.fromCharCode(65 + index)}`,
      String.fromCharCode(index + 1),
    ]),
  ),
};
export const KEY_NAMES: ReadonlyArray<string> = Object.keys(KEYS);

/** The part of `TerminalHost` this uses. */
export interface AgentTerminalHost {
  open(input: {
    readonly key: string;
    readonly t3Path: string;
    readonly cwd: string;
    readonly cols: number;
    readonly rows: number;
    readonly env: Readonly<Record<string, string>>;
    readonly command: string;
  }): Promise<unknown>;
  input(key: string, data: string): Promise<unknown>;
  /** Closes `key` (the kill script on its marker), and gives the script's answer; undefined when no kill ran. */
  closeAnswered(key: string): Promise<KillAnswer | undefined>;
  /** The kill script on `key` again, and its answer; undefined when the Container is not running. */
  kill(key: string): Promise<KillAnswer | undefined>;
}

export interface AgentTerminalsDeps {
  readonly host: AgentTerminalHost;
  readonly now: () => number;
  /** The next id number of `kind` for `owner`, kept in storage so a restart never reuses one. */
  readonly nextId: (owner: string, kind: AgentEntryKind) => number;
  /** The env an entry's command runs with on top of the host's base (mise through `BASH_ENV`). */
  readonly env: Readonly<Record<string, string>>;
  /** The Workspace's repo in the Container. */
  readonly repo: string;
  /** Where each entry's scrollback is kept, and which entries the exited bound forgot (SPI-1397): the DO's SQLite. */
  readonly store: ScrollbackStore<ForgottenExit>;
}

interface Entry {
  readonly id: string;
  readonly owner: string;
  readonly marker: string;
  readonly kind: AgentEntryKind;
  readonly command: string;
  readonly cwd: string;
  readonly notify: boolean;
  readonly startedAt: number;
  /** Its screen's rows. */
  readonly rows: number;
  /** Why it was forgotten, stopped or the bound; its rows are gone, and a call that waited on it is answered so. */
  forgotten: "stopped" | "bound" | null;
  /** Its xterm while it runs; null once it exited and its final screen is in storage (`final`). */
  term: Terminal | null;
  /** The exited entry's final screen's place and cursor; its rows are in storage (`Scrollback.screen`). */
  final: Omit<Screen, "screen"> | null;
  readonly logPath?: string;
  endedAt: number | null;
  exit: AgentExit | null;
  /** The owner saw the exit in a result, or was told of it. */
  exitSeen: boolean;
  /** Lines the xterm dropped from above its screen so far: a line's absolute index is this plus its buffer index. */
  trimmed: number;
  /** The normal buffer's line list `trimmed` counts; a reset (RIS) gives the xterm a new one. */
  lines: object | undefined;
  /** What scrolled off, in storage. */
  readonly scrollback: Scrollback;
  lastOutputAt: number;
  /** Writes into the xterm still being parsed. */
  writing: Promise<void>;
  /**
   * The owner's previous view: the normal screen's top line's absolute index then (kept across views of the alternate
   * screen, so what scrolled off is told from there), the screen's own top for its shift, its rows and cursor row.
   */
  seen: {
    readonly top: number;
    readonly screenTop: number;
    readonly screen: string;
    readonly cursorRow: number | null;
  } | null;
  /** Calls to this entry, one at a time in arrival order (termctrl's Call queue). */
  queue: Promise<unknown>;
}

/** The visible rows (trailing blank rows trimmed), the cursor (null while hidden) and where the screen is. */
interface Screen {
  readonly screen: string;
  readonly cursor: AgentCursor | null;
  /** The active screen's top line: absolute on the normal screen, the alternate screen's own on that. */
  readonly top: number;
  /** The normal screen's top line's absolute index, whichever screen is active. */
  readonly normalTop: number;
  readonly normal: boolean;
}

/** An entry's key among the Workspace's: its owner and id. */
const keyOf = (owner: string, id: string): string => `${owner}\u0000${id}`;

/** An entry's marker: its PTY's key in the host, and its Background job log's name. */
const markerOf = (owner: string, id: string): string => `term-agent-${shortHash(owner)}-${id}`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** FNV-1a, as a short marker part: Session names are longer than a marker may be. */
const shortHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** The xterm's internals this reads: the normal buffer's trims and whether the program hid the cursor. */
interface XtermCore {
  readonly _core?: {
    readonly _bufferService?: {
      readonly buffers?: {
        readonly normal?: { readonly lines?: { onTrim?: (listener: (amount: number) => void) => unknown } };
      };
    };
    readonly coreService?: { readonly isCursorHidden?: boolean };
  };
}

/**
 * `data` in pieces that each scroll the screen less than `margin` lines, so the lines one piece pushes above the screen
 * still fit the xterm's `AGENT_TERMINAL_SPILL_LINES` when it has been parsed and they are stored. Counted from above:
 * each line feed (LF, VT, FF) a row, and each character two cells (a wide one's), every `cols` cells a wrapped row, one
 * row spare for where the cursor starts; `ESC D` and `ESC E` (and their C1 forms) count as line feeds. `CSI S`, which
 * scrolls by a count, is not counted: the lines it pushes past the margin are found missing, never misnumbered.
 */
export const piecesOf = (data: string, cols: number, margin: number): Array<string> => {
  const budget = Math.max(1, margin - 1);
  const pieces: Array<string> = [];
  let from = 0;
  let scrolled = 0;
  let cells = 0;
  for (let index = 0; index < data.length; index++) {
    const unit = data.charCodeAt(index);
    const next = data.charCodeAt(index + 1);
    if (unit === 0x1b && (next === 0x44 || next === 0x45)) {
      // IND, NEL: the line feed's scroll without a line feed's byte.
      scrolled++;
      cells = 0;
      index++;
    } else if (unit === 10 || unit === 11 || unit === 12 || unit === 0x84 || unit === 0x85) {
      scrolled++;
      cells = 0;
    } else if (unit === 13) cells = 0;
    else {
      cells += 2;
      if (cells >= cols) {
        scrolled++;
        cells -= cols;
      }
    }
    if (scrolled >= budget) {
      // Never between a surrogate pair's halves.
      const end = unit >= 0xd800 && unit <= 0xdbff ? index + 2 : index + 1;
      pieces.push(data.slice(from, end));
      from = end;
      index = end - 1;
      scrolled = 0;
    }
  }
  if (from < data.length) pieces.push(data.slice(from));
  return pieces;
};

const encoder = new TextEncoder();

/** The last `limits.lines` of `text`'s lines within `limits.bytes` (at least one line), each line measured once. */
const lastLines = (text: string, limits: AgentTail): string => {
  const kept = text.split("\n").slice(-limits.lines);
  let bytes = -1;
  let from = kept.length;
  while (from > 0) {
    const size = encoder.encode(kept[from - 1]!).length + 1;
    if (from < kept.length && bytes + size > limits.bytes) break;
    bytes += size;
    from--;
  }
  return kept.slice(from).join("\n");
};

export class AgentTerminals {
  readonly #deps: AgentTerminalsDeps;
  readonly #entries = new Map<string, Entry>();
  readonly #byMarker = new Map<string, Entry>();

  constructor(deps: AgentTerminalsDeps) {
    this.#deps = deps;
  }

  /** The host's output: each frame into its entry's screen; an exit frame ends it. Unknown markers are answered. */
  frames(frames: ReadonlyArray<TerminalFrame>): ReadonlyArray<string> {
    const unknown = new Set<string>();
    for (const frame of frames) {
      const entry = this.#byMarker.get(frame.key);
      if (entry === undefined) {
        unknown.add(frame.key);
        continue;
      }
      if (frame.data !== undefined && frame.data !== "") {
        entry.lastOutputAt = this.#deps.now();
        this.#feed(entry, frame.data);
      }
      if (frame.exit !== undefined && entry.exit === null) {
        // 129 is the host's code for a shell the Container took with it (`containerStopped`, a kill before the start).
        this.#ended(entry, frame.exit.code === 129 ? CONTAINER_STOPPED : { code: frame.exit.code, signal: null });
        this.#bound();
      }
    }
    return [...unknown];
  }

  /** Output into the entry's xterm in pieces, storing what each piece scrolled off before the next is parsed. */
  #feed(entry: Entry, data: string): void {
    const term = entry.term;
    if (term === null || entry.exit !== null) return;
    for (const piece of piecesOf(data, term.cols, AGENT_TERMINAL_SPILL_LINES))
      entry.writing = entry.writing
        .then(() => new Promise<void>((resolve) => term.write(piece, resolve)))
        .then(() => this.#spill(entry, term));
  }

  /**
   * The entry ended: its exit, and once the output before it is parsed, its final screen to storage and its xterm let
   * go, so an exited entry holds no xterm.
   */
  #ended(entry: Entry, exit: AgentExit): void {
    entry.exit = exit;
    entry.endedAt = this.#deps.now();
    entry.writing = entry.writing.then(() => {
      const term = entry.term;
      if (term === null) return;
      this.#spill(entry, term);
      const { screen, ...final } = this.#screenOf(entry, term);
      entry.scrollback.keepScreen(screen);
      entry.final = final;
      entry.term = null;
      term.dispose();
    });
  }

  /** The normal buffer's lines above its screen not yet stored go to storage. */
  #spill(entry: Entry, term: Terminal): void {
    // Forgotten meanwhile: its rows are gone, and stay gone.
    if (entry.term !== term) return;
    this.#watchTrims(entry, term);
    const normal = term.buffer.normal;
    const top = entry.trimmed + normal.baseY;
    for (let line = Math.max(entry.scrollback.end, entry.trimmed); line < top; line++)
      entry.scrollback.append(line, normal.getLine(line - entry.trimmed)?.translateToString(true) ?? "");
  }

  /**
   * Counts the normal buffer's trims, through the xterm's internals. A reset (RIS) replaces the buffer: its lines are
   * numbered on from the last one stored or seen, never again from 0.
   */
  #watchTrims(entry: Entry, term: Terminal): void {
    const lines = (term as unknown as XtermCore)._core?._bufferService?.buffers?.normal?.lines;
    if (lines === undefined || lines === entry.lines) return;
    if (entry.lines !== undefined) entry.trimmed = Math.max(entry.scrollback.end, entry.seen?.top ?? 0, entry.trimmed);
    entry.lines = lines;
    lines.onTrim?.((amount) => {
      if (entry.lines === lines) entry.trimmed += amount;
    });
  }

  /**
   * Past `AGENT_EXITED_TERMINALS_KEPT` exited entries in the Workspace, across its Sessions, one is forgotten (never a
   * running one), and naming it later says why: first those whose exit their owner saw, oldest exit first (then oldest
   * start); then, whenever more than that many are still unseen, the oldest unseen. Unseen exits gather at once (a
   * Container stop) or over time (entries that do not notify, a Session that never asks again); the owner's next exit
   * notice or wait still reports each forgotten one, naming the bound.
   */
  #bound(): void {
    const exited = [...this.#entries.values()].filter((entry) => entry.exit !== null);
    const over = exited.length - AGENT_EXITED_TERMINALS_KEPT;
    if (over <= 0) return;
    exited.sort(
      (a, b) =>
        Number(!a.exitSeen) - Number(!b.exitSeen) || (a.endedAt ?? 0) - (b.endedAt ?? 0) || a.startedAt - b.startedAt,
    );
    for (const entry of exited.slice(0, over)) {
      const unseen: ForgottenExit | null = entry.exitSeen ? null : { info: this.#info(entry), notify: entry.notify };
      this.#forget(entry, "bound");
      this.#deps.store.forgotten.add(keyOf(entry.owner, entry.id), entry.owner, unseen);
    }
  }

  /**
   * `owner`'s exits the bound forgot unseen, each taken once: for `exits`, only those that notify, whose notice names
   * the bound; for a wait, all, keeping their keys so the tool's read of each is answered with the bound.
   */
  #forgottenExits(owner: string, op: "exits" | "wait"): Array<ForgottenExit> {
    return this.#deps.store.forgotten.takeUnseen(owner, (unseen) => op === "wait" || unseen.notify, op === "wait");
  }

  async handle<R extends AgentTerminalRequest>(request: R): Promise<AgentTerminalResult<R["op"]>> {
    try {
      const value = await this.#dispatch(request);
      return { ok: true, value } as AgentTerminalResult<R["op"]>;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #dispatch(request: AgentTerminalRequest): Promise<AgentTerminalAnswers[AgentTerminalRequest["op"]]> {
    switch (request.op) {
      case "start":
        return this.#start(request);
      case "settle": {
        const entry = this.#entry(request.owner, request.id);
        return this.#queued(entry, () => this.#settle(entry, request));
      }
      case "stop": {
        const entry = this.#entry(request.owner, request.id);
        return this.#queued(entry, () => this.#stop(entry, request.graceMs ?? STOP_GRACE_SECONDS * 1000, request));
      }
      case "list":
        return { entries: this.#owned(request.owner).map((entry) => this.#info(entry)) };
      case "wait":
        return this.#wait(request);
      case "exits": {
        const exits = this.#owned(request.owner).filter(
          (entry) => entry.exit !== null && !entry.exitSeen && entry.notify,
        );
        for (const entry of exits) entry.exitSeen = true;
        const forgotten = this.#forgottenExits(request.owner, "exits").map((exit) => ({
          ...exit.info,
          tail: agentTerminalDropped(exit.info.id, exit.info.logPath),
        }));
        return {
          exits: [
            ...forgotten,
            ...(await Promise.all(
              exits.map(async (entry) => ({
                ...this.#info(entry),
                tail: await this.#tail(entry, request.tail ?? DEFAULT_JOB_TAIL),
              })),
            )),
          ],
        };
      }
    }
  }

  #owned(owner: string): Array<Entry> {
    return [...this.#entries.values()].filter((entry) => entry.owner === owner);
  }

  #entry(owner: string, id: string): Entry {
    const entry = this.#entries.get(keyOf(owner, id));
    if (entry !== undefined) return entry;
    if (this.#deps.store.forgotten.has(keyOf(owner, id)))
      throw new Error(
        agentTerminalDropped(id, id.startsWith("b") ? `${JOB_LOG_DIR}/${markerOf(owner, id)}.log` : undefined),
      );
    const ids = this.#owned(owner).map((known) => known.id);
    throw new Error(
      `Unknown terminal or Background job ${id}.${ids.length === 0 ? " There are none." : ` Known: ${ids.join(", ")}.`}`,
    );
  }

  #queued<T>(entry: Entry, run: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(run, run);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  #info(entry: Entry): AgentEntryInfo {
    return {
      id: entry.id,
      kind: entry.kind,
      command: entry.command,
      cwd: entry.cwd,
      state: entry.exit === null ? "running" : "exited",
      exit: entry.exit,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      ...(entry.logPath === undefined ? {} : { logPath: entry.logPath }),
    };
  }

  async #start(request: Extract<AgentTerminalRequest, { op: "start" }>): Promise<AgentTerminalAnswers["start"]> {
    const prefix = request.kind === "terminal" ? "t" : "b";
    const id = `${prefix}${this.#deps.nextId(request.owner, request.kind)}`;
    const marker = markerOf(request.owner, id);
    const logPath = request.kind === "background_job" ? `${JOB_LOG_DIR}/${marker}.log` : undefined;
    const term = new Terminal({
      cols: request.cols,
      rows: request.rows,
      scrollback: AGENT_TERMINAL_SPILL_LINES,
      allowProposedApi: true,
    });
    const now = this.#deps.now();
    const entry: Entry = {
      id,
      owner: request.owner,
      marker,
      kind: request.kind,
      command: request.command,
      cwd: request.cwd,
      notify: request.notify,
      startedAt: now,
      rows: request.rows,
      forgotten: null,
      term,
      final: null,
      ...(logPath === undefined ? {} : { logPath }),
      endedAt: null,
      exit: null,
      exitSeen: false,
      trimmed: 0,
      lines: undefined,
      scrollback: this.#deps.store.open(keyOf(request.owner, id)),
      lastOutputAt: now,
      writing: Promise.resolve(),
      seen: null,
      queue: Promise.resolve(),
    };
    this.#watchTrims(entry, term);
    this.#entries.set(keyOf(request.owner, id), entry);
    this.#byMarker.set(marker, entry);
    // A Background job's whole output also goes to its log, which the agent can `read` (pi-termctrl's job log).
    const command =
      logPath === undefined
        ? request.command
        : `mkdir -p ${JOB_LOG_DIR} && set -o pipefail && { ${request.command}\n} 2>&1 | tee -a ${quote(logPath)}`;
    await this.#deps.host.open({
      key: marker,
      t3Path: this.#deps.repo,
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: this.#deps.env,
      command,
    });
    return { entry: this.#info(entry) };
  }

  #forget(entry: Entry, why: "stopped" | "bound"): void {
    entry.forgotten = why;
    this.#entries.delete(keyOf(entry.owner, entry.id));
    this.#byMarker.delete(entry.marker);
    entry.term?.dispose();
    entry.term = null;
    entry.scrollback.drop();
  }

  async #type(entry: Entry, text: string | undefined, keys: ReadonlyArray<string> | undefined): Promise<void> {
    if ((text === undefined || text === "") && (keys === undefined || keys.length === 0)) return;
    if (entry.exit !== null) {
      throw new Error(
        `${entry.id} has exited (${describeExit(entry.exit)}); it takes no input. Poll it without text or keys for its final screen.`,
      );
    }
    const unknown = (keys ?? []).filter((key) => !(key in KEYS));
    if (unknown.length > 0)
      throw new Error(
        `Unknown key${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. Keys: ${KEY_NAMES.join(", ")}.`,
      );
    const data = (text ?? "") + (keys ?? []).map((key) => KEYS[key]).join("");
    await this.#deps.host.input(entry.marker, data);
  }

  async #settle(
    entry: Entry,
    request: Extract<AgentTerminalRequest, { op: "settle" }>,
  ): Promise<AgentTerminalAnswers["settle"]> {
    await entry.writing;
    const startScreen = request.since ?? this.#screen(entry).screen;
    // Input goes first, in the slice that starts the wait.
    if (request.since === undefined) await this.#type(entry, request.text, request.keys);
    const typedAt = this.#deps.now();
    const sliceEnd = Math.min(request.deadline, this.#deps.now() + request.chunkMs);
    const matches = request.pattern === undefined ? undefined : patternOf(request.pattern);
    const quietMs = request.quietMs ?? DEFAULT_TERMINAL_QUIET_MS;
    let reason: AgentSettleReason | undefined;
    for (;;) {
      await entry.writing;
      const now = this.#deps.now();
      const screen = this.#screen(entry).screen;
      const changed = screen !== startScreen;
      if (matches !== undefined && changed && matches(screen)) reason = "matched";
      else if (entry.exit !== null) reason = "exited";
      // With a pattern, quiet alone never ends the wait; a poll settles on quiet only after new output.
      else if (
        matches === undefined &&
        now - entry.lastOutputAt >= quietMs &&
        now - typedAt >= quietMs &&
        (request.mode !== "poll" || entry.lastOutputAt > typedAt || changed)
      )
        reason = "quiet";
      else if (now >= request.deadline) reason = "timeout";
      else if (now >= sliceEnd) reason = "chunk";
      if (reason !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return {
      view: await this.#view(entry, request.view && reason !== "chunk", request),
      reason,
      startScreen,
    };
  }

  /**
   * Closes the entry (the host's kill script), and kills it again when it has not exited within `graceMs` (the Owner's
   * `termctrl.stopGraceSeconds`; with no deadline, a process that ignores the close would keep the stop waiting) or the close's
   * kill left survivors (SPI-1372). The exit is what happened: the host's exit frame; else the kill's own answer
   * (`exitWithoutFrame`). Survivors of a running entry are no exit: the stop fails, and the entry stays running; survivors
   * of an exited one are noted on its exit.
   */
  async #stop(entry: Entry, graceMs: number, options: AgentViewOptions): Promise<AgentTerminalAnswers["stop"]> {
    let closed: KillAnswer | undefined;
    if (entry.exit === null) {
      closed = await this.#deps.host.closeAnswered(entry.marker);
      await this.#exitWithin(entry, graceMs);
    }
    if (entry.exit === null || (closed?.survivors ?? 0) > 0) {
      const answer = await this.#deps.host.kill(entry.marker);
      const survivors = answer?.survivors ?? 0;
      const survived = `${survivors} of its processes survived SIG${answer?.signal ?? "KILL"} and still ${survivors === 1 ? "runs" : "run"} in the Workspace's Container`;
      if (survivors === 0) await this.#exitWithin(entry, EXIT_FRAME_MS);
      // An exit frame can arrive during the kill: what the entry says by now decides.
      if (entry.exit === null && survivors > 0)
        throw new Error(
          `${entry.id}: ${survived}. It stays listed as running; stop it again, or it ends when the Container stops.`,
        );
      if (entry.exit === null) {
        this.#ended(entry, exitWithoutFrame(answer));
        this.#bound();
      } else if (survivors > 0) entry.exit = { ...entry.exit, note: `its shell ended, but ${survived}` };
    }
    await entry.writing;
    const view = await this.#view(entry, true, options);
    const stopped = this.#info(entry);
    this.#forget(entry, "stopped");
    return { stopped, view };
  }

  /** Waits up to `ms` for the entry's exit frame. */
  async #exitWithin(entry: Entry, ms: number): Promise<void> {
    const deadline = this.#deps.now() + ms;
    while (entry.exit === null && this.#deps.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  async #wait(request: Extract<AgentTerminalRequest, { op: "wait" }>): Promise<AgentTerminalAnswers["wait"]> {
    const owned = this.#owned(request.owner);
    if (request.ids !== null) for (const id of request.ids) this.#entry(request.owner, id);
    const targets =
      request.ids === null
        ? owned.filter((entry) => entry.exit === null)
        : owned.filter((entry) => request.ids!.includes(entry.id));
    const sliceEnd = Math.min(request.deadline, this.#deps.now() + request.chunkMs);
    for (;;) {
      const exited = targets.filter((entry) => entry.exit !== null);
      if (exited.length > 0 || targets.length === 0 || this.#deps.now() >= sliceEnd) {
        // Every exit by then, also of entries not waited on (termctrl's `terminal_wait`); they are not notified again.
        const all = owned.filter((entry) => entry.exit !== null && !entry.exitSeen);
        const reported = [...new Set([...exited, ...all])];
        for (const entry of reported) entry.exitSeen = true;
        return {
          // Exits the bound forgot unseen too: the tool's read of each answers the bound.
          exited: [
            ...this.#forgottenExits(request.owner, "wait").map((exit) => exit.info),
            ...reported.map((entry) => this.#info(entry)),
          ],
          running: owned.filter((entry) => entry.exit === null).map((entry) => this.#info(entry)),
          timedOut: exited.length === 0 && targets.length > 0 && this.#deps.now() >= request.deadline,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  /** The entry's screen: its xterm's, or once it exited, its final one from storage. */
  #screen(entry: Entry): Screen {
    // Forgotten while a call on it waited (a stop's own view comes before it forgets).
    if (entry.forgotten === "bound") throw new Error(agentTerminalDropped(entry.id, entry.logPath));
    if (entry.forgotten === "stopped") throw new Error(`${entry.id} was stopped and is no longer kept.`);
    if (entry.term !== null) return this.#screenOf(entry, entry.term);
    return { screen: entry.scrollback.screen(), ...entry.final! };
  }

  #screenOf(entry: Entry, term: Terminal): Screen {
    const buffer = term.buffer.active;
    const rows: Array<string> = [];
    for (let row = 0; row < term.rows; row++)
      rows.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "");
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    const hidden = (term as unknown as XtermCore)._core?.coreService?.isCursorHidden === true;
    const normal = buffer.type === "normal";
    const normalTop = entry.trimmed + term.buffer.normal.baseY;
    return {
      screen: rows.join("\n"),
      cursor: hidden ? null : { x: buffer.cursorX, y: buffer.cursorY },
      top: normal ? normalTop : buffer.baseY,
      normalTop,
      normal,
    };
  }

  /**
   * The screen, what scrolled off since the owner's previous view (from storage), and that view; `record`: this is the
   * owner's view now. Only the scrolled-off lines a result can show are read: the first `scrolledLines`, beside the
   * screen's rows the result may drop as already seen, and the last `scrolledLines`.
   */
  async #view(entry: Entry, record: boolean, options: AgentViewOptions): Promise<AgentView> {
    await entry.writing;
    const { screen, cursor, top, normalTop, normal } = this.#screen(entry);
    let scrolledOff: Array<string> = [];
    let omitted: AgentView["scrolledOffOmitted"];
    let outputMissing = false;
    if (normal) {
      const firstKept = entry.scrollback.first;
      const since = entry.seen?.top ?? firstKept;
      if (since < firstKept) outputMissing = true;
      const start = Math.max(since, firstKept);
      const kept = (from: number, to: number): Array<string> => {
        const lines = entry.scrollback.read(from, to);
        if (lines.includes(null)) outputMissing = true;
        return lines.filter((line): line is string => line !== null);
      };
      const shown = options.scrolledLines ?? DEFAULT_SCROLLED_LINES;
      const headLines = shown + entry.rows;
      if (normalTop - start <= headLines + shown) scrolledOff = kept(start, normalTop);
      else {
        const head = kept(start, start + headLines);
        scrolledOff = [...head, ...kept(normalTop - shown, normalTop)];
        omitted = { beforeIndex: head.length, count: normalTop - start - headLines - shown };
      }
    }
    const previous = entry.seen === null ? null : { screen: entry.seen.screen, cursorRow: entry.seen.cursorRow };
    const shift =
      entry.seen === null || outputMissing || top < entry.seen.screenTop ? null : top - entry.seen.screenTop;
    if (record) {
      entry.seen = { top: normalTop, screenTop: top, screen, cursorRow: cursor?.y ?? null };
      if (entry.exit !== null) entry.exitSeen = true;
    }
    return {
      id: entry.id,
      state: entry.exit === null ? "running" : "exited",
      exit: entry.exit,
      screen,
      cursor,
      scrolledOff,
      ...(omitted === undefined ? {} : { scrolledOffOmitted: omitted }),
      outputMissing,
      previous,
      shift,
      ...(entry.kind === "background_job" ? { output: await this.#tail(entry, options.tail ?? DEFAULT_JOB_TAIL) } : {}),
      ...(entry.logPath === undefined ? {} : { logPath: entry.logPath }),
    };
  }

  /**
   * The entry's last lines of output (scrollback and screen), within `tail`: the screen's, and before them stored lines
   * read back newest first, never more than `tail` takes. When the screen is blank, trailing blank lines are passed
   * over within that same budget; one spent on blank lines alone says so.
   */
  async #tail(entry: Entry, tail: AgentTail): Promise<string> {
    await entry.writing;
    const { screen, normal } = this.#screen(entry);
    const live = screen === "" ? [] : screen.split("\n");
    if (!normal || live.length >= tail.lines) return lastLines(live.join("\n"), tail);
    const back = entry.scrollback.readBack({ lines: tail.lines - live.length, bytes: tail.bytes }, live.length === 0);
    if (live.length === 0 && back.lines.length === 0 && back.blank > 0 && back.from > entry.scrollback.first)
      return `[The last ${back.blank.toLocaleString("en-US")} lines of output are blank; earlier output was not read.]`;
    return lastLines([...back.lines, ...live].join("\n"), tail);
  }

  /** The Container stopped or this object ends: every running entry ended with it (the host's exit frames say so too). */
  containerStopped(): void {
    for (const entry of this.#entries.values()) if (entry.exit === null) this.#ended(entry, CONTAINER_STOPPED);
    this.#bound();
  }
}

/** An exit the bound forgot before its owner saw it: what its next exit notice or wait reports. */
export interface ForgottenExit {
  readonly info: AgentEntryInfo;
  readonly notify: boolean;
}

const CONTAINER_STOPPED: AgentExit = { code: null, signal: null, note: "the Workspace's Container stopped" };

/**
 * A stopped entry's exit when no exit frame came, from the kill's answer: the signal it sent once every marked process
 * died, or what is known when it found none (a process that dropped its marker, `exec env -i …`, may still run).
 */
export const exitWithoutFrame = (answer: KillAnswer | undefined): AgentExit =>
  answer === undefined
    ? CONTAINER_STOPPED
    : answer.signal === null
      ? { code: null, signal: null, note: "its stop found no marked process left to kill; its exit went unreported" }
      : { code: null, signal: `SIG${answer.signal}` };

/** termctrl's `wait_for_text`: a literal substring, or a regex written `/source/flags`. */
export const patternOf = (pattern: string): ((screen: string) => boolean) => {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (regex !== null) {
    const compiled = new RegExp(regex[1]!, regex[2]!.replaceAll("g", ""));
    return (screen) => compiled.test(screen);
  }
  return (screen) => screen.includes(pattern);
};

export const describeExit = (exit: AgentExit): string => {
  const how =
    exit.code !== null ? `exit code ${exit.code}` : exit.signal !== null ? `ended by ${exit.signal}` : "ended";
  return exit.note === undefined ? how : `${how}: ${exit.note}`;
};
