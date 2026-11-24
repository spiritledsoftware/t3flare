// The Workspace DO's half of the agent's Terminals (SPI-1057): entries over a fake PTY host that echoes like a REPL,
// rendered by the headless xterm, with termctrl's settle reasons, scrolled-off lines, exits, stops, waits and the cap.
// @effect-diagnostics globalTimers:off globalDate:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import type { KillAnswer } from "@t3flare/sandbox-image/kill";
import { terminalCommand } from "@t3flare/sandbox-image/terminal";
import { describe, expect, it } from "vitest";

import { AgentTerminals } from "../src/workspace/agentTerminals.ts";

/** A host whose "programs" answer input as `program` says, pushing frames back as the real host does. */
const fakeHost = (
  program: (data: string, emit: (data: string) => void, exit: (code: number) => void) => void,
  maxLive: () => number = () => 8,
  /** What a close and a kill do to a key's process, and their kills' answers; by default a close ends it with 130. */
  stops: {
    readonly close?: (key: string, exit: (code: number) => void) => KillAnswer | undefined;
    readonly kill?: (key: string, exit: (code: number) => void) => KillAnswer | undefined;
  } = {},
  scrollback: () => number = () => 1000,
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
    maxLive,
    scrollback,
  });
  return { terminals, opened, closed, killed };
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

  it("stops and forgets an entry; waits for exits; refuses past the cap; keeps owners apart", async () => {
    let maxLive = 3;
    const { terminals, closed } = fakeHost(repl, () => maxLive);
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

    for (let index = 0; index < 3; index++) await start(terminals);
    const fourth = {
      op: "start",
      owner,
      kind: "background_job",
      command: "x",
      cwd: "/workspace/repo",
      cols: 40,
      rows: 6,
      notify: true,
    } as const;
    const refused = await terminals.handle(fourth);
    // SPI-1387: the limit names itself and its value.
    expect(refused.ok ? "" : refused.error).toContain(
      "already runs 3 Terminals and Background jobs, and agents may run at most 3 at once (a fixed limit: each keeps its screen in the Workspace's memory); stop one first.",
    );
    // A lower count stops none that run; the next start is refused against it.
    maxLive = 1;
    expect(terminals.live).toBe(3);
    expect(closed).toHaveLength(1);
    const lowered = await terminals.handle({ ...fourth, kind: "terminal" });
    expect(lowered.ok ? "" : lowered.error).toContain("may run at most 1 at once");
  });

  // SPI-1372: what outlives the close's kill is killed again, and the stop says what happened.
  it("kills what outlives a Terminal's close, and reports what the kills did", { timeout: 15_000 }, async () => {
    const KILL = (survivors: number): KillAnswer => ({ signalled: 1, survivors, signal: "KILL" });
    const which = (key: string) => key.slice(key.lastIndexOf("-") + 1);
    const { terminals, opened, killed } = fakeHost(repl, () => 8, {
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
    const { terminals, killed } = fakeHost(repl, () => 8, {
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
  it("keeps the scrollback the Container's launch says", async () => {
    const lines = async (scrollback: number) => {
      const { terminals, opened } = fakeHost(
        repl,
        () => 8,
        {},
        () => scrollback,
      );
      const id = await start(terminals);
      for (let index = 0; index < 10; index++) await settle(terminals, id, { text: `a${index}\r`, waitMs: 300 });
      terminals.frames([{ key: opened[0]!.key, seq: 999, exit: { code: 0 } }]);
      const exits = await terminals.handle({ op: "exits", owner, tail: { lines: 1_000, bytes: 1_000_000 } });
      if (!exits.ok) throw new Error(exits.error);
      return exits.value.exits[0]!.tail.split("\n").length;
    };
    // 10 inputs make 21 lines: a 6-row screen with no scrollback keeps 6 of them, 1,000 lines of scrollback all.
    expect(await lines(0)).toBeLessThanOrEqual(6);
    expect(await lines(1_000)).toBeGreaterThanOrEqual(20);
  });

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
