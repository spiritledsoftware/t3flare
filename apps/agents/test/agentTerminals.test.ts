// The Workspace DO's half of the agent's Terminals (SPI-1057): entries over a fake PTY host that echoes like a REPL,
// rendered by the headless xterm, with termctrl's settle reasons, scrolled-off lines (from storage, SPI-1397), exits,
// stops, waits and the Workspace's exited bound.
// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import v8 from "node:v8";
import vm from "node:vm";

import type { KillAnswer } from "@t3flare/sandbox-image/kill";
import { terminalCommand } from "@t3flare/sandbox-image/terminal";
import { describe, expect, it } from "vitest";

import { AGENT_EXITED_TERMINALS_KEPT, AGENT_TERMINAL_SPILL_LINES } from "@t3flare/harness-registry";
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";

import { DEFAULT_TERMCTRL_LIMITS, terminalResult } from "../src/extensions/termctrl/tools.ts";
import type { ScrollbackStore } from "../src/workspace/agentScrollback.ts";
import { AgentTerminals, agentTerminalDropped } from "../src/workspace/agentTerminals.ts";
import { nodeScrollbackStore } from "./nodeSql.ts";

/** A host whose "programs" answer input as `program` says, pushing frames back as the real host does. */
const fakeHost = (
  program: (data: string, emit: (data: string) => void, exit: (code: number) => void) => void,
  /** What a close and a kill do to a key's process, and their kills' answers; by default a close ends it with 130. */
  stops: {
    readonly close?: (key: string, exit: (code: number) => void) => KillAnswer | undefined;
    readonly kill?: (key: string, exit: (code: number) => void) => KillAnswer | undefined;
  } = {},
  store: ScrollbackStore = nodeScrollbackStore(),
) => {
  const opened: Array<{ key: string; command: string; cwd: string }> = [];
  const closed: Array<string> = [];
  const killed: Array<{ key: string; at: number }> = [];
  let terminals: AgentTerminals | undefined;
  const seq = new Map<string, number>();
  const emitTo = (key: string) => (data: string) => {
    const n = seq.get(key) ?? 0;
    seq.set(key, n + 1);
    terminals!.frames([{ key, seq: n, data }]);
  };
  const exitTo = (key: string) => (code: number) => terminals!.frames([{ key, seq: 0, exit: { code } }]);
  const host = {
    open: (input: { key: string; command: string; cwd: string }) => {
      opened.push(input);
      if (input.command.includes("tee")) setTimeout(() => emitTo(input.key)("job line 1\r\njob line 2\r\n"), 5);
      else setTimeout(() => emitTo(input.key)("> "), 5);
      return Promise.resolve();
    },
    input: (key: string, data: string) => {
      program(data, emitTo(key), exitTo(key));
      return Promise.resolve();
    },
    closeAnswered: (key: string) => {
      closed.push(key);
      if (stops.close !== undefined) return Promise.resolve(stops.close(key, exitTo(key)));
      setTimeout(() => exitTo(key)(130), 5);
      return Promise.resolve<KillAnswer>({ signalled: 1, survivors: 0, signal: "TERM" });
    },
    kill: (key: string) => {
      killed.push({ key, at: Date.now() });
      return Promise.resolve(stops.kill?.(key, exitTo(key)));
    },
  };
  let n = 0;
  terminals = new AgentTerminals({
    host,
    now: () => Date.now(),
    nextId: () => ++n,
    env: {},
    repo: "/workspace/repo",
    store,
  });
  return { terminals, opened, closed, killed, emitTo, exitTo };
};

/** Output for `key` straight into `terminals`, as one host frame. */
const fakeEmit = (terminals: AgentTerminals, key: string, data: string) => {
  terminals.frames([{ key, seq: 0, data }]);
};

const repl = (data: string, emit: (data: string) => void, exit: (code: number) => void) => {
  if (data === "exit\r") return exit(0);
  emit(`${data.replace("\r", "")}\r\n= ${data.replace("\r", "").toUpperCase()}\r\n> `);
};

const owner = "session-a";
const start = async (terminals: AgentTerminals, kind: "terminal" | "background_job" = "terminal") => {
  const started = await terminals.handle({
    op: "start",
    owner,
    kind,
    command: "node",
    cwd: "/workspace/repo",
    cols: 40,
    rows: 6,
    notify: true,
  });
  if (!started.ok) throw new Error(started.error);
  return started.value.entry.id;
};
const settle = async (
  terminals: AgentTerminals,
  id: string,
  input: { text?: string; mode?: "start" | "input" | "poll"; pattern?: string; waitMs?: number } = {},
) => {
  const answer = await terminals.handle({
    op: "settle",
    owner,
    id,
    ...(input.text === undefined ? {} : { text: input.text }),
    mode: input.mode ?? "input",
    deadline: Date.now() + (input.waitMs ?? 2_000),
    chunkMs: 5_000,
    ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
    view: true,
  });
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

describe("agent terminals", () => {
  it("starts a Terminal, types into it, and settles on quiet with the rendered screen and cursor", async () => {
    const { terminals, opened } = fakeHost(repl);
    const id = await start(terminals);
    expect(id).toBe("t1");
    expect(opened[0]?.key).toMatch(/^term-agent-[a-z0-9]+-t1$/);
    const first = await settle(terminals, id, { mode: "start" });
    expect(first.reason).toBe("quiet");
    expect(first.view.screen).toBe("> ");
    const typed = await settle(terminals, id, { text: "abc\r" });
    expect(typed.reason).toBe("quiet");
    expect(typed.view.screen).toBe("> abc\n= ABC\n> ");
    expect(typed.view.cursor).toEqual({ x: 2, y: 2 });
    expect(typed.view.previous).toEqual({ screen: "> ", cursorRow: 0 });
  });

  it("matches wait_for_text, reports lines that scrolled off once, and settles exited", async () => {
    const { terminals } = fakeHost(repl);
    const id = await start(terminals);
    await settle(terminals, id, { mode: "start" });
    const matched = await settle(terminals, id, { text: "one\r", pattern: "/= O.E/" });
    expect(matched.reason).toBe("matched");
    for (const word of ["two", "three"]) await settle(terminals, id, { text: `${word}\r` });
    const after = await settle(terminals, id, { text: "four\r" });
    // 6 rows: "> one" left with `three`; `four` pushes out the next two, and only those are new.
    expect(after.view.scrolledOff).toEqual(["= ONE", "> two"]);
    expect(after.view.outputMissing).toBe(false);
    const exited = await settle(terminals, id, { text: "exit\r" });
    expect(exited.reason).toBe("exited");
    expect(exited.view.exit).toEqual({ code: 0, signal: null });
    const typing = await terminals.handle({
      op: "settle",
      owner,
      id,
      text: "x",
      mode: "input",
      deadline: Date.now() + 100,
      chunkMs: 100,
      view: true,
    });
    expect(typing.ok ? "" : typing.error).toContain("t1 has exited (exit code 0)");
  });

  it("stops and forgets an entry; waits for exits; runs any number at once; keeps owners apart", async () => {
    const { terminals, closed } = fakeHost(repl);
    const id = await start(terminals);
    const stopped = await terminals.handle({ op: "stop", owner, id });
    expect(stopped.ok && stopped.value.stopped.exit).toEqual({ code: 130, signal: null });
    expect(closed).toHaveLength(1);
    const list = await terminals.handle({ op: "list", owner });
    expect(list.ok && list.value.entries).toEqual([]);
    const other = await terminals.handle({ op: "list", owner: "session-b" });
    expect(other.ok && other.value.entries).toEqual([]);

    const waited = await start(terminals);
    setTimeout(
      () =>
        void terminals.handle({
          op: "settle",
          owner,
          id: waited,
          text: "exit\r",
          mode: "input",
          deadline: Date.now() + 500,
          chunkMs: 500,
          view: false,
        }),
      50,
    );
    const wait = await terminals.handle({ op: "wait", owner, ids: null, deadline: Date.now() + 2_000, chunkMs: 2_000 });
    expect(wait.ok && wait.value.exited.map((entry) => entry.id)).toEqual([waited]);
    const exits = await terminals.handle({ op: "exits", owner, tail: { lines: 5, bytes: 16_384 } });
    expect(exits.ok && exits.value.exits).toEqual([]); // reported by the wait, so not notified again

    // SPI-1397: no count of their own, past ADR-0021's old 8 and the provisional 32.
    for (let index = 0; index < 40; index++) await start(terminals, index % 2 === 0 ? "terminal" : "background_job");
    const running = await terminals.handle({ op: "list", owner });
    expect(running.ok && running.value.entries.filter((entry) => entry.state === "running")).toHaveLength(40);
    expect(closed).toHaveLength(1);
  });

  // SPI-1372: what outlives the close's kill is killed again, and the stop says what happened.
  it("kills what outlives a Terminal's close, and reports what the kills did", { timeout: 15_000 }, async () => {
    const KILL = (survivors: number): KillAnswer => ({ signalled: 1, survivors, signal: "KILL" });
    const which = (key: string) => key.slice(key.lastIndexOf("-") + 1);
    const { terminals, opened, killed } = fakeHost(repl, {
      close: (key, exit) => {
        // t4's shell exits at its close, but a marked child survives KILL.
        if (which(key) === "t4") {
          exit(130);
          return KILL(1);
        }
        return KILL(1); // the rest trap the hangup, TERM and KILL alike
      },
      kill: (key, exit) => {
        switch (which(key)) {
          case "t1":
            setTimeout(() => exit(137), 5); // its shell's exit follows the kill
            return KILL(0);
          case "t2":
            return KILL(0); // dead, its exit frame lost
          case "t3":
          case "t4":
            return KILL(1);
          case "t5":
            exit(137); // the shell's exit arrives during the kill, a child survives
            return KILL(1);
          case "t6":
            return { signalled: 0, survivors: 0, signal: null };
          default:
            return undefined; // the Container stopped
        }
      },
    });
    const ids: Array<string> = [];
    for (let index = 0; index < 7; index++) ids.push(await start(terminals));
    const began = Date.now();
    const results = await Promise.all(ids.map((id) => terminals.handle({ op: "stop", owner, id })));
    const exitOf = (index: number) => {
      const result = results[index]!;
      return result.ok ? result.value.stopped.exit : result.error;
    };

    expect(killed.map((kill) => kill.key).toSorted()).toEqual(opened.map((open) => open.key).toSorted());
    // Each is killed again after the grace, but t4 at once: its shell exited, so there is no exit to wait for.
    for (const kill of killed)
      if (which(kill.key) === "t4") expect(kill.at - began).toBeLessThan(1_000);
      else expect(kill.at - began).toBeGreaterThanOrEqual(3_000);
    const survived = "1 of its processes survived SIGKILL and still runs in the Workspace's Container";
    // The shell's own exit, as the host reported it.
    expect(exitOf(0)).toEqual({ code: 137, signal: null });
    // No exit frame, but the kill saw its processes die: the signal it sent.
    expect(exitOf(1)).toEqual({ code: null, signal: "SIGKILL" });
    // Still running: not reported as killed, and still listed.
    expect(exitOf(2)).toBe(
      `t3: ${survived}. It stays listed as running; stop it again, or it ends when the Container stops.`,
    );
    // The shell exited, before the kill or during it, and a child outlived it: noted on the exit.
    expect(exitOf(3)).toEqual({ code: 130, signal: null, note: `its shell ended, but ${survived}` });
    expect(exitOf(4)).toEqual({ code: 137, signal: null, note: `its shell ended, but ${survived}` });
    // Nothing marked was found: what is known, no signal.
    expect(exitOf(5)).toEqual({
      code: null,
      signal: null,
      note: "its stop found no marked process left to kill; its exit went unreported",
    });
    expect(exitOf(6)).toEqual({ code: null, signal: null, note: "the Workspace's Container stopped" });
    const list = await terminals.handle({ op: "list", owner });
    expect(list.ok && list.value.entries.map((entry) => [entry.id, entry.state])).toEqual([["t3", "running"]]);
    expect(terminals.live).toBe(1);
  });

  // SPI-1364: the stop's grace and the settle's quiet are the Owner's termctrl settings, carried on each request.
  it("waits the request's grace before killing again, and settles on the request's quiet", async () => {
    const { terminals, killed } = fakeHost(repl, {
      close: () => ({ signalled: 1, survivors: 1, signal: "KILL" }),
      kill: (_key, exit) => {
        exit(137);
        return { signalled: 1, survivors: 0, signal: "KILL" };
      },
    });
    const id = await start(terminals);
    const began = Date.now();
    await terminals.handle({ op: "stop", owner, id, graceMs: 200 });
    expect(killed[0]!.at - began).toBeGreaterThanOrEqual(200);
    expect(killed[0]!.at - began).toBeLessThan(2_000);

    const other = await start(terminals);
    await settle(terminals, other, { mode: "start" });
    const typedAt = Date.now();
    const answer = await terminals.handle({
      op: "settle",
      owner,
      id: other,
      text: "abc\r",
      mode: "input",
      deadline: Date.now() + 5_000,
      chunkMs: 5_000,
      view: true,
      quietMs: 1_000,
    });
    expect(answer.ok && answer.value.reason).toBe("quiet");
    expect(Date.now() - typedAt).toBeGreaterThanOrEqual(1_000);
  });

  it("runs a Background job with its output tee'd to a log, and reports an unseen exit once", async () => {
    const { terminals, opened } = fakeHost(repl);
    const id = await start(terminals, "background_job");
    expect(id).toBe("b1");
    expect(opened[0]?.command).toContain("| tee -a '/tmp/t3flare-jobs/");
    const view = await settle(terminals, id, { mode: "start" });
    expect(view.view.output).toBe("job line 1\njob line 2");
    expect(view.view.logPath).toMatch(/^\/tmp\/t3flare-jobs\/term-agent-.+-b1\.log$/);
    terminals.frames([{ key: opened[0]!.key, seq: 9, exit: { code: 3 } }]);
    const exits = await terminals.handle({ op: "exits", owner, tail: { lines: 1, bytes: 16_384 } });
    expect(exits.ok && exits.value.exits.map((exit) => [exit.id, exit.exit, exit.tail])).toEqual([
      ["b1", { code: 3, signal: null }, "job line 2"],
    ]);
    const again = await terminals.handle({ op: "exits", owner, tail: { lines: 1, bytes: 16_384 } });
    expect(again.ok && again.value.exits).toEqual([]);
  });
});

describe("an agent Terminal's scrollback and tail (SPI-1362)", () => {
  it("gives a Background job's output within the request's tail, in lines and in bytes", async () => {
    const { terminals } = fakeHost(repl);
    const id = await start(terminals, "background_job");
    const view = async (tail: { lines: number; bytes: number }) => {
      const answer = await terminals.handle({
        op: "settle",
        owner,
        id,
        mode: "poll",
        deadline: Date.now() + 100,
        chunkMs: 100,
        view: false,
        tail,
      });
      if (!answer.ok) throw new Error(answer.error);
      return answer.value.view.output;
    };
    expect(await view({ lines: 100, bytes: 1_000 })).toBe("job line 1\njob line 2");
    expect(await view({ lines: 1, bytes: 1_000 })).toBe("job line 2");
    expect(await view({ lines: 100, bytes: 12 })).toBe("job line 2");
  });
});

describe("an agent Terminal's scrollback in storage, and the Workspace's exited bound (SPI-1397)", () => {
  /** Starts a Terminal for `who` in `terminals`, 40 columns by 6 rows. */
  const startFor = async (terminals: AgentTerminals, who: string, kind: "terminal" | "background_job") => {
    const started = await terminals.handle({
      op: "start",
      owner: who,
      kind,
      command: "node",
      cwd: "/workspace/repo",
      cols: 40,
      rows: 6,
      notify: true,
    });
    if (!started.ok) throw new Error(started.error);
    return started.value.entry.id;
  };
  /** A final view of `id`, as the tool asks for it. */
  const look = async (terminals: AgentTerminals, id: string, scrolledLines?: number) => {
    const answer = await terminals.handle({
      op: "settle",
      owner,
      id,
      mode: "poll",
      deadline: Date.now(),
      chunkMs: 0,
      view: true,
      ...(scrolledLines === undefined ? {} : { scrolledLines }),
    });
    if (!answer.ok) throw new Error(answer.error);
    return answer.value.view;
  };
  /**
   * Output that scrolls a 40-column Terminal far past its spill margin in one frame: short lines, lines that wrap,
   * wide characters, a surrogate pair, carriage returns and colour.
   */
  const output = (from: number, count: number): string =>
    Array.from({ length: count }, (_, index) => {
      const n = from + index;
      if (n % 7 === 0) return `wrapped ${n} ${"x".repeat(90)}`;
      if (n % 11 === 0) return `wide ${n} ${"漢字".repeat(12)} 😀`;
      if (n % 13 === 0) return `overwritten ${n}\rcr ${n}`;
      return `\x1b[32mline ${n}\x1b[0m`;
    }).join("\r\n") + "\r\n";
  /** What scrolled off a Terminal with unbounded scrollback for the same output: the pre-SPI-1397 answer. */
  const reference = async (data: ReadonlyArray<string>) => {
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 1_000_000, allowProposedApi: true });
    for (const chunk of data) await new Promise<void>((resolve) => term.write(chunk, resolve));
    const buffer = term.buffer.normal;
    const lines: Array<string> = [];
    for (let line = 0; line < buffer.baseY; line++) lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
    term.dispose();
    return lines;
  };
  /** A Terminal at its prompt, then `chunks` of output, each one frame. */
  const filled = async (chunks: ReadonlyArray<string>, store: ScrollbackStore = nodeScrollbackStore()) => {
    const host = fakeHost(repl, {}, store);
    const id = await startFor(host.terminals, owner, "terminal");
    await settle(host.terminals, id, { mode: "start" });
    for (const chunk of chunks) host.emitTo(host.opened[0]!.key)(chunk);
    return { ...host, id };
  };

  it("keeps only the newest 128 exited entries across a Workspace's Sessions, and names the bound for one it forgot", async () => {
    const { terminals, opened } = fakeHost(repl);
    const owners = ["session-a", "session-b", "session-c"];
    const started: Array<{ owner: string; id: string }> = [];
    for (let index = 0; index < AGENT_EXITED_TERMINALS_KEPT + 7; index++) {
      const who = owners[index % owners.length]!;
      started.push({ owner: who, id: await startFor(terminals, who, index % 5 === 0 ? "background_job" : "terminal") });
      // Each exits before the next starts: the oldest exited is the first started.
      terminals.frames([{ key: opened[index]!.key, seq: 0, exit: { code: 0 } }]);
    }
    const listed = await Promise.all(owners.map((who) => terminals.handle({ op: "list", owner: who })));
    const kept = listed.flatMap((answer, index) =>
      answer.ok ? answer.value.entries.map((entry) => `${owners[index]}/${entry.id}`) : [],
    );
    expect(kept).toHaveLength(AGENT_EXITED_TERMINALS_KEPT);
    expect(kept.toSorted()).toEqual(
      started
        .slice(7)
        .map((entry) => `${entry.owner}/${entry.id}`)
        .toSorted(),
    );
    // The first started was a Background job: its log outlives it; the second a Terminal.
    const job = started[0]!;
    const forgotten = await terminals.handle({
      op: "settle",
      owner: job.owner,
      id: job.id,
      mode: "poll",
      deadline: 0,
      chunkMs: 0,
      view: true,
    });
    expect(forgotten.ok ? "" : forgotten.error).toBe(
      agentTerminalDropped(job.id, `/tmp/t3flare-jobs/${opened[0]!.key}.log`),
    );
    expect(forgotten.ok ? "" : forgotten.error).toContain("keeps its last 128 exited Terminals and Background jobs");
    expect(forgotten.ok ? "" : forgotten.error).toContain("Its whole output is still in /tmp/t3flare-jobs/");
    const terminal = started[1]!;
    const stopped = await terminals.handle({ op: "stop", owner: terminal.owner, id: terminal.id });
    expect(stopped.ok ? "" : stopped.error).toBe(agentTerminalDropped(terminal.id, undefined));
    // A running entry is never forgotten for the bound.
    const running = await startFor(terminals, "session-a", "terminal");
    const list = await terminals.handle({ op: "list", owner: "session-a" });
    expect(list.ok && list.value.entries.some((entry) => entry.id === running && entry.state === "running")).toBe(true);
  });

  it("answers a Terminal past its viewport with the scrollback an unbounded xterm keeps, read from storage", async () => {
    const chunks = [output(0, 3_000), output(3_000, 40), output(3_040, 500)];
    const { terminals, id, opened } = await filled(chunks);
    const view = await look(terminals, id);
    const expected = await reference(["> ", ...chunks]);
    expect(expected.length).toBeGreaterThan(3_500);
    expect(view.scrolledOff).toEqual(expected);
    expect(view.outputMissing).toBe(false);
    // The lines came from storage: the xterm itself keeps only its screen and the spill margin.
    expect(expected.length).toBeGreaterThan(10 * AGENT_TERMINAL_SPILL_LINES);
    // Then only what is new since that view.
    const more = output(9_000, 30);
    fakeEmit(terminals, opened[0]!.key, more);
    const next = await look(terminals, id);
    const all = await reference(["> ", ...chunks, more]);
    expect(next.scrolledOff).toEqual(all.slice(expected.length));
  });

  it("reads only the lines a result shows, and the result is the same as from every line", async () => {
    const limits = { ...DEFAULT_TERMCTRL_LIMITS, scrollback: { lines: 10, bytes: 64 * 1024 } };
    const steps = [output(0, 2_000), output(2_000, 3), output(2_003, 700)];
    const run = async (scrolledLines: number | undefined) => {
      const { terminals, id, opened } = await filled([steps[0]!]);
      const first = await look(terminals, id, scrolledLines);
      // A short step, then a long one: the dedupe of the previous screen's rows, then a cut.
      fakeEmit(terminals, opened[0]!.key, steps[1]!);
      const second = await look(terminals, id, scrolledLines);
      fakeEmit(terminals, opened[0]!.key, steps[2]!);
      const third = await look(terminals, id, scrolledLines);
      return [first, second, third];
    };
    const whole = await run(undefined);
    const ends = await run(10);
    expect(whole.every((view) => view.scrolledOffOmitted === undefined)).toBe(true);
    expect(ends[0]!.scrolledOff).toHaveLength(10 + 6 + 10);
    expect(ends[0]!.scrolledOffOmitted).toEqual({ at: 16, count: whole[0]!.scrolledOff.length - 26 });
    expect(ends[1]!.scrolledOffOmitted).toBeUndefined();
    for (const [index, view] of whole.entries())
      expect(terminalResult(ends[index]!, "quiet", {}, limits)).toEqual(terminalResult(view, "quiet", {}, limits));
  });

  it("keeps each Terminal's last bytes up to its cap, oldest dropped first, and says output is missing", async () => {
    const store = nodeScrollbackStore(4_000);
    const { terminals, id } = await filled([output(0, 1_000)], store);
    const view = await look(terminals, id);
    expect(view.outputMissing).toBe(true);
    const all = await reference(["> ", output(0, 1_000)]);
    // The newest lines, whole, within the cap.
    expect(view.scrolledOff).toEqual(all.slice(all.length - view.scrolledOff.length));
    const kept = view.scrolledOff.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    expect(kept).toBeLessThanOrEqual(4_000);
    expect(kept + Buffer.byteLength(all[all.length - view.scrolledOff.length - 1]!) + 1).toBeGreaterThan(4_000);
    const text = terminalResult(view, "quiet").text;
    expect(text).toContain("a Terminal keeps its last 8 MiB of scrollback");
  });

  it("deletes a Terminal's rows when it is stopped, and every row when the Workspace DO starts", async () => {
    const store = nodeScrollbackStore();
    const rows = () =>
      (store.db.prepare("SELECT count(*) AS n FROM t3flare_agent_scrollback").get() as { n: number }).n;
    const { terminals, id } = await filled([output(0, 2_000)], store);
    await look(terminals, id);
    expect(rows()).toBeGreaterThan(0);
    await terminals.handle({ op: "stop", owner, id });
    expect(rows()).toBe(0);
    const again = await filled([output(0, 2_000)], store);
    await look(again.terminals, again.id);
    expect(rows()).toBeGreaterThan(0);
    store.clear();
    expect(rows()).toBe(0);
  });

  it("keeps the Workspace DO's memory flat as a Terminal's scrollback grows", { timeout: 120_000 }, async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const heap = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const MiB = 1024 * 1024;
    // 80-byte lines in 32 KiB frames, as the host batches them.
    const line = (n: number) => `${String(n).padStart(8, "0")} ${"y".repeat(71)}`;
    const feed = async (terminals: AgentTerminals, key: string, id: string, from: number, count: number) => {
      for (let start = from; start < from + count; start += 400) {
        const frame = Array.from({ length: 400 }, (_, index) => line(start + index)).join("\r\n") + "\r\n";
        fakeEmit(terminals, key, frame);
        await look(terminals, id, 100);
      }
    };
    const { terminals, id, opened } = await filled([]);
    await feed(terminals, opened[0]!.key, id, 0, 20_000);
    const small = heap();
    // Over six times the output, past the 8 MiB cap: about 10.5 MB of scrollback.
    await feed(terminals, opened[0]!.key, id, 20_000, 110_000);
    const large = heap();
    const grown = large - small;
    // The same output in an xterm that keeps it (the pre-SPI-1397 shape, scrollback in memory) grows by far more.
    const before = heap();
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 300_000, allowProposedApi: true });
    for (let start = 0; start < 130_000; start += 400)
      await new Promise<void>((resolve) =>
        term.write(Array.from({ length: 400 }, (_, index) => line(start + index)).join("\r\n") + "\r\n", resolve),
      );
    const inMemory = heap() - before;
    term.dispose();
    // Measured on Node 26: 0.05 MiB grown, against 94 MiB for the xterm that keeps its scrollback (40 columns).
    expect(inMemory, `heap of an xterm keeping it: ${(inMemory / MiB).toFixed(1)} MiB`).toBeGreaterThan(20 * MiB);
    expect(grown, `heap grown from 20,000 to 130,000 lines: ${(grown / MiB).toFixed(2)} MiB`).toBeLessThan(2 * MiB);
  });
});

describe("an agent Terminal's wrapper", () => {
  it("runs the command under bash -c in its cwd, linking nothing for the repo's own path", () => {
    const wrapper = terminalCommand({
      marker: "term-agent-x-t1",
      t3Path: "/workspace/repo",
      cwd: "/tmp",
      command: 'pwd -P; echo "it\'s $((1+1))"',
    });
    expect(wrapper).not.toContain("mount");
    const ran = spawnSync("bash", ["-c", wrapper], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim().split("\n").at(-1)).toBe("it's 2");
  });
});
