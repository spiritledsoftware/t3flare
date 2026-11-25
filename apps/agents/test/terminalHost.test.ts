// The Workspace DO's terminals (step 2b, ADR-0021) at their seam, `TerminalHost`, over a fake PTY process: what the
// Environment's adapter sees pushed, and what reaches the shell and the kill script. Review F1 (markers), F2 (no
// `ExecProcess.kill`), F10 (only input is use), F11 (the epoch) and D1 (a lapsed heartbeat kills).
// @effect-diagnostics globalTimers:off
import { EMPTY_ENVIRONMENT, resolveEnvironment } from "@t3flare/harness-registry";
import type { KillAnswer } from "@t3flare/sandbox-image/kill";
import { MARK_BUSY, MARK_PROMPT, scanMarkers } from "@t3flare/sandbox-image/terminal";
import type { TerminalFrame, TerminalPushAnswer } from "@t3flare/workspace-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { launchOf, terminalHoldOf, terminalHoldsOf } from "../src/workspace/containerLaunch.ts";
import { ContainerRefused } from "../src/workspace/containerStep.ts";
import {
  HEARTBEAT_LAPSE_MS,
  type ShellProcess,
  TerminalHost,
  type TerminalHostDeps,
} from "../src/workspace/terminalHost.ts";

/** No stage override: the holds are the launch's. */
const NO_OVERRIDES = { busyHoldMs: undefined, promptHoldMs: undefined };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shell: what is written to its stdin, its stdout to feed, its exit to settle. No `kill`, as the host must not call one. */
const fakeShell = () => {
  const typed: Array<string> = [];
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const resized: Array<[number, number]> = [];
  const process: ShellProcess = {
    stdin: new WritableStream<Uint8Array>({ write: (chunk) => void typed.push(decoder.decode(chunk)) }),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => void (feed = controller) }),
    exitCode: new Promise<number>((resolve) => (exit = resolve)),
    resize: (cols, rows) => void resized.push([cols, rows]),
  };
  return {
    process,
    typed,
    resized,
    print: (text: string) => feed.enqueue(encoder.encode(text)),
    exit: (code: number) => {
      feed.close();
      exit(code);
    },
  };
};

const harness = (
  options: {
    running?: boolean;
    refuse?: string;
    pushMs?: number;
    answer?: (frames: ReadonlyArray<TerminalFrame>) => TerminalPushAnswer;
    beforeSpawn?: () => Promise<void>;
    readBashrc?: () => boolean;
    killAnswer?: KillAnswer;
    firstPromptMs?: () => number;
  } = {},
) => {
  let now = 1_000_000;
  let running = options.running ?? true;
  const shells: Array<ReturnType<typeof fakeShell>> = [];
  const spawned: Array<{ argv: ReadonlyArray<string>; env: Record<string, string> }> = [];
  const frames: Array<TerminalFrame> = [];
  const killed: Array<ReadonlyArray<string>> = [];
  const changes: Array<string> = [];
  let remembered: ReadonlyArray<string> = [];
  const deps: TerminalHostDeps = {
    now: () => now,
    epoch: "epoch-1",
    running: () => running,
    startContainer: async () => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      running = true;
    },
    spawn: async (argv, spawnOptions) => {
      const shell = fakeShell();
      shells.push(shell);
      spawned.push({ argv, env: spawnOptions.env });
      return shell.process;
    },
    kill: async (markers) => {
      killed.push(markers);
      return options.killAnswer;
    },
    push: async (push) => {
      if (options.pushMs !== undefined) await tick(options.pushMs);
      frames.push(...push.frames);
      return options.answer?.(push.frames) ?? { unknown: [] };
    },
    baseEnv: { PATH: "/usr/bin", MISE_YES: "1" },
    filesMayHaveChanged: (why) => void changes.push(why),
    remember: (markers) => void (remembered = markers),
    remembered: () => remembered,
    beforeSpawn: options.beforeSpawn ?? (async () => undefined),
    projectRootView: "/workspace/.t3flare/project-root",
    ...(options.readBashrc === undefined ? {} : { readBashrc: options.readBashrc }),
    ...(options.firstPromptMs === undefined ? {} : { firstPromptMs: options.firstPromptMs }),
  };
  const host = new TerminalHost(deps);
  return {
    host,
    shells,
    spawned,
    frames,
    killed,
    changes,
    advance: (ms: number) => void (now += ms),
    setRemembered: (markers: ReadonlyArray<string>) => void (remembered = markers),
    text: (key: string) =>
      frames
        .filter((frame) => frame.key === key && frame.data !== undefined)
        .map((frame) => frame.data)
        .join(""),
  };
};

const open = (key: string) => ({
  key,
  t3Path: "/w/demo",
  cwd: "/w/demo/src",
  cols: 80,
  rows: 24,
  env: { TERM: "xterm-256color" },
});

describe("scanMarkers", () => {
  it("strips the rc file's markers and reports the foreground's state and prompts", () => {
    const scanned = scanMarkers("", `ls${MARK_BUSY}a b\r\n${MARK_PROMPT}$ `);
    expect(scanned).toEqual({ text: "lsa b\r\n$ ", busy: false, prompts: 1, carry: "" });
  });

  it("keeps a marker cut by the chunk's end for the next chunk", () => {
    const first = scanMarkers("", `out${MARK_PROMPT.slice(0, 4)}`);
    expect(first).toMatchObject({ text: "out", prompts: 0, carry: MARK_PROMPT.slice(0, 4) });
    const second = scanMarkers(first.carry, `${MARK_PROMPT.slice(4)}$ `);
    expect(second).toEqual({ text: "$ ", busy: false, prompts: 1, carry: "" });
  });

  it("passes other escape sequences and OSCs through", () => {
    const text = "\x1b[1;34mblue\x1b[0m \x1b]0;title\x07 \x1b]6973;x\x07";
    expect(scanMarkers("", text).text).toBe(text);
  });
});

describe("TerminalHost", () => {
  it("opens a shell under the wrapper with the marker and no BASH_ENV, after the status line when the Container is stopped", async () => {
    const h = harness({ running: false });
    const answer = await h.host.open(open("term-a1"));
    expect(answer).toEqual({ epoch: "epoch-1", unknown: [] });
    expect(h.spawned[0]!.argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(h.spawned[0]!.argv[2]).toContain("exec bash --rcfile /tmp/t3flare-rc-term-a1 -i");
    expect(h.spawned[0]!.argv[2]).toContain("mount --bind '/workspace/repo' '/w/demo'");
    expect(h.spawned[0]!.env).toEqual({
      PATH: "/usr/bin",
      MISE_YES: "1",
      TERM: "xterm-256color",
      T3FLARE_EXEC: "term-a1",
    });
    await h.host.settled();
    expect(h.text("term-a1")).toContain("Starting the Workspace's Container");
  });

  it("sources ~/.bashrc in the shell's rc as the running Container's launch says, read at each open (ADR-0047 §9)", async () => {
    let read = true;
    const h = harness({ readBashrc: () => read });
    await h.host.open(open("term-a1"));
    read = false;
    await h.host.open(open("term-a2"));
    expect(h.spawned[0]!.argv[2]).toContain("[ -r ~/.bashrc ] && . ~/.bashrc");
    expect(h.spawned[1]!.argv[2]).not.toContain("~/.bashrc");
  });

  it("strips the markers, pushes the foreground's state, and holds input until the first prompt", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.input("term-a1", "echo hi\r");
    await h.host.input("term-a1", "pwd\r");
    expect(h.shells[0]!.typed).toEqual([]);
    h.shells[0]!.print(`motd\r\n${MARK_PROMPT}# `);
    await tick();
    expect(h.shells[0]!.typed).toEqual(["echo hi\r", "pwd\r"]);
    h.shells[0]!.print(`${MARK_BUSY}hi\r\n`);
    await tick();
    await h.host.settled();
    expect(h.text("term-a1")).toBe("motd\r\n# hi\r\n");
    expect(h.frames.filter((frame) => frame.busy !== undefined).map((frame) => frame.busy)).toEqual([false, true]);
    expect(h.frames.map((frame) => frame.seq)).toEqual([...h.frames.keys()]);
    expect(h.changes).toContain("prompt");
  });

  it("holds input before the first prompt for FIRST_PROMPT_SECONDS (SPI-1364, SPI-1387), 20 s where none is given", async () => {
    const h = harness({ firstPromptMs: () => 5_000 });
    await h.host.open(open("term-a1"));
    await h.host.input("term-a1", "a");
    h.advance(4_999);
    await h.host.input("term-a1", "b");
    expect(h.shells[0]!.typed).toEqual([]);
    h.advance(1);
    await h.host.input("term-a1", "c");
    await tick();
    expect(h.shells[0]!.typed.join("")).toBe("abc");
    const plain = harness();
    await plain.host.open(open("term-a1"));
    await plain.host.input("term-a1", "a");
    plain.advance(19_999);
    await plain.host.input("term-a1", "b");
    expect(plain.shells[0]!.typed).toEqual([]);
  });

  it("closes through the kill script on the marker, and reports the exit with the shell's code", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.close("term-a1");
    expect(h.killed).toEqual([["term-a1"]]);
    h.shells[0]!.exit(143);
    await tick();
    await h.host.settled();
    expect(h.frames.at(-1)).toMatchObject({ key: "term-a1", exit: { code: 143 } });
    expect(h.host.size).toBe(0);
    // What the shell left in its session is killed after the exit too; a later close is answered as unknown.
    expect(h.killed).toEqual([["term-a1"], ["term-a1"]]);
    expect(await h.host.close("term-a1")).toEqual({ epoch: "epoch-1", unknown: ["term-a1"] });
  });

  // SPI-1372: an agent's stop kills again past its grace and reads the answer.
  it("kills a key again with the script's answer: none when the Container is not running, an error when it gives none", async () => {
    const answer = { signalled: 1, survivors: 0, signal: "KILL" } as const;
    expect(await harness({ killAnswer: answer }).host.kill("term-a1")).toEqual(answer);
    const stopped = harness({ running: false, killAnswer: answer });
    expect(await stopped.host.kill("term-a1")).toBeUndefined();
    expect(stopped.killed).toEqual([]);
    await expect(harness().host.kill("term-a1")).rejects.toThrow("the kill script gave no answer");
  });

  it("closes with the kill script's answer, and none for a key it does not hold", async () => {
    const answer = { signalled: 2, survivors: 1, signal: "KILL" } as const;
    const h = harness({ killAnswer: answer });
    await h.host.open(open("term-a1"));
    expect(await h.host.closeAnswered("term-a1")).toEqual(answer);
    expect(h.killed).toEqual([["term-a1"]]);
    expect(await h.host.closeAnswered("term-zz")).toBeUndefined();
    expect(h.killed).toEqual([["term-a1"]]);
  });

  it("kills a terminal whose Environment stopped heartbeating", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    await h.host.open(open("term-b2"));
    h.advance(HEARTBEAT_LAPSE_MS - 1);
    expect(h.host.heartbeat(["term-b2", "term-zz"])).toEqual({ epoch: "epoch-1", unknown: ["term-zz"] });
    expect(await h.host.expire()).toBe(0);
    h.advance(2);
    expect(await h.host.expire()).toBe(1);
    expect(h.killed).toEqual([["term-a1"]]);
  });

  it("kills a terminal the Environment answers as unknown", async () => {
    const h = harness({ answer: (frames) => ({ unknown: [...new Set(frames.map((frame) => frame.key))] }) });
    await h.host.open(open("term-a1"));
    h.shells[0]!.print("output nobody reads");
    await tick();
    await h.host.settled();
    expect(h.killed).toEqual([["term-a1"]]);
  });

  it("opens any number of terminals, and refuses one whose Container cannot start, in the terminal", async () => {
    // SPI-1391: the Owner's Terminals per Workspace have no limit, as locally.
    const many = harness();
    for (let i = 0; i < 20; i++) await many.host.open(open(`term-${i}`));
    await many.host.settled();
    expect(many.spawned).toHaveLength(20);
    expect(many.frames.some((frame) => frame.exit !== undefined)).toBe(false);

    const refused = harness({ running: false, refuse: "the Container cannot start: 3 Containers are running" });
    await refused.host.open(open("term-a1"));
    await refused.host.settled();
    expect(refused.text("term-a1")).toContain("t3flare: the Container cannot start: 3 Containers are running");
    expect(refused.frames.at(-1)).toMatchObject({ exit: { code: 1 } });
    expect(refused.spawned).toEqual([]);
  });

  it("refuses a terminal in it when its running Container's steps refuse commands (ADR-0047 §7), and spawns after any other failure before the spawn", async () => {
    const refused = harness({
      beforeSpawn: async () =>
        Promise.reject(new ContainerRefused("Refused: this Container's Container setup failed (exit 2)")),
    });
    await refused.host.open(open("term-a1"));
    await refused.host.settled();
    expect(refused.text("term-a1")).toContain("t3flare: Refused: this Container's Container setup failed (exit 2)");
    expect(refused.frames.at(-1)).toMatchObject({ exit: { code: 1 } });
    expect(refused.spawned).toEqual([]);
    const pushFailed = harness({ beforeSpawn: async () => Promise.reject(new Error("push failed")) });
    await pushFailed.host.open(open("term-a1"));
    await pushFailed.host.settled();
    expect(pushFailed.spawned).toHaveLength(1);
  });

  it("counts only input as use: neither an open (a re-attach after an Environment restart) nor output moves the last input", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    expect(h.host.lastInput).toBe(0);
    h.advance(60_000);
    h.shells[0]!.print(`${MARK_PROMPT}tick\r\n`.repeat(20));
    await tick();
    expect(h.host.lastInput).toBe(0);
    await h.host.input("term-a1", "x");
    expect(h.host.lastInput).toBe(1_060_000);
  });

  describe("the Container hold (cost audit F1): an idle prompt holds less than a running command", () => {
    // The defaults' holds, as a Container started before SPI-1317 (no launch values) keeps them: 10 and 30 minutes.
    const hold = terminalHoldOf(terminalHoldsOf(undefined), NO_OVERRIDES);

    it("does not hold for a terminal that was only opened", async () => {
      const h = harness({ running: false });
      await h.host.open(open("term-a1"));
      h.shells[0]!.print(`${MARK_PROMPT}$ `);
      await tick();
      expect(h.host.holdsContainer(hold)).toBe(false);
    });

    it("holds a terminal at its prompt for the prompt hold after the last input", async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      h.shells[0]!.print(`${MARK_PROMPT}$ `);
      await tick();
      await h.host.input("term-a1", "ls\r");
      h.shells[0]!.print(`${MARK_BUSY}a b\r\n${MARK_PROMPT}$ `);
      await tick();
      h.advance(9 * 60_000);
      expect(h.host.holdsContainer(hold)).toBe(true);
      h.advance(2 * 60_000);
      expect(h.host.holdsContainer(hold)).toBe(false);
    });

    it("holds a terminal running a command for the busy hold after the last input", async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      h.shells[0]!.print(`${MARK_PROMPT}$ `);
      await tick();
      await h.host.input("term-a1", "npm run dev\r");
      h.shells[0]!.print(`${MARK_BUSY}listening\r\n`);
      await tick();
      h.advance(29 * 60_000);
      expect(h.host.holdsContainer(hold)).toBe(true);
      h.advance(2 * 60_000);
      expect(h.host.holdsContainer(hold)).toBe(false);
    });

    it("holds for the busy hold the Container started with (SPI-1317); the stage's override still wins", async () => {
      const launch = launchOf({
        settings: { ...resolveEnvironment(EMPTY_ENVIRONMENT), terminalBusyHoldMinutes: 5 },
        source: "environment",
      });
      const running = async () => {
        const h = harness();
        await h.host.open(open("term-a1"));
        h.shells[0]!.print(`${MARK_PROMPT}$ `);
        await tick();
        await h.host.input("term-a1", "npm run dev\r");
        h.shells[0]!.print(`${MARK_BUSY}listening\r\n`);
        await tick();
        return h;
      };
      const fiveMinutes = terminalHoldOf(terminalHoldsOf(launch), NO_OVERRIDES);
      const h = await running();
      h.advance(5 * 60_000 - 1);
      expect(h.host.holdsContainer(fiveMinutes)).toBe(true);
      h.advance(1);
      expect(h.host.holdsContainer(fiveMinutes)).toBe(false);

      const overridden = terminalHoldOf(terminalHoldsOf(launch), {
        busyHoldMs: "180000",
        promptHoldMs: "60000",
      });
      expect(overridden).toEqual({ terminalBusyHoldMs: 180_000, terminalPromptHoldMs: 60_000 });
      const o = await running();
      o.advance(3 * 60_000);
      expect(o.host.holdsContainer(overridden)).toBe(false);
      // An override that is not a positive number is none.
      expect(terminalHoldOf(terminalHoldsOf(launch), { busyHoldMs: "", promptHoldMs: "0" })).toEqual({
        terminalBusyHoldMs: 300_000,
        terminalPromptHoldMs: 600_000,
      });
    });

    it("holds nothing once every terminal is closed", async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      await h.host.input("term-a1", "x");
      h.shells[0]!.exit(0);
      await tick();
      expect(h.host.holdsContainer(hold)).toBe(false);
    });
  });

  describe("output batching (cost audit F4): immediate while typing, 100 ms batches otherwise", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());
    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    it("batches output nobody typed for into one push, 100 ms after the first line", async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      await h.host.settled();
      const before = h.host.pushes;
      h.shells[0]!.print("line 1\r\n");
      await advance(30);
      h.shells[0]!.print("line 2\r\n");
      await advance(60);
      expect(h.host.pushes - before).toBe(0);
      await advance(20);
      expect(h.host.pushes - before).toBe(1);
      expect(h.text("term-a1")).toBe("line 1\r\nline 2\r\n");
    });

    it("keeps batching continuous output nobody typed for, not pushing again as soon as each push returns", async () => {
      const h = harness({ pushMs: 20 });
      await h.host.open(open("term-a1"));
      await h.host.settled();
      const before = h.host.pushes;
      for (let i = 0; i < 50; i++) {
        h.shells[0]!.print(`line ${i}\r\n`);
        await advance(10);
      }
      await advance(200);
      // 500 ms of output: one push per 100 ms batch (and the last), where one per round trip made about 20.
      expect(h.host.pushes - before).toBeLessThanOrEqual(6);
      expect(h.text("term-a1")).toContain("line 49");
    });

    it("pushes the echo of a keystroke promptly, even with a batch already waiting", async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      h.shells[0]!.print(`${MARK_PROMPT}$ `);
      await advance(40);
      await h.host.settled();
      h.shells[0]!.print("background noise\r\n");
      await advance(5);
      await h.host.input("term-a1", "x");
      h.shells[0]!.print("x");
      // Within the typing batch (16 ms), long before the 100 ms one the noise was waiting for.
      await advance(20);
      expect(h.text("term-a1")).toBe("$ background noise\r\nx");
    });
  });

  it("kills the shells an earlier instance started and lost, at the first open", async () => {
    const h = harness();
    h.setRemembered(["term-old1", "term-old2"]);
    await h.host.open(open("term-new"));
    expect(h.killed).toEqual([["term-old1", "term-old2"]]);
  });

  it("ends every shell when the Container stops", async () => {
    const h = harness();
    await h.host.open(open("term-a1"));
    h.host.containerStopped();
    await h.host.settled();
    expect(h.text("term-a1")).toContain("Container stopped");
    expect(h.frames.at(-1)).toMatchObject({ exit: { code: 129 } });
  });

  describe("a stop the Terminal hold let happen names the hold (SPI-1431)", () => {
    const hold = terminalHoldOf(terminalHoldsOf(undefined), NO_OVERRIDES);
    const atPrompt = async () => {
      const h = harness();
      await h.host.open(open("term-a1"));
      h.shells[0]!.print(`${MARK_PROMPT}$ `);
      await tick();
      return h;
    };

    it("names the busy hold, its value and where to change it, while a command runs", async () => {
      const h = await atPrompt();
      await h.host.input("term-a1", "npm run dev\r");
      h.shells[0]!.print(`${MARK_BUSY}listening\r\n`);
      await tick();
      const lapse = h.host.appliedHold(hold);
      expect(lapse).toEqual({ hold: "busy", minutes: 30 });
      h.host.containerStopped(lapse);
      await h.host.settled();
      expect(h.text("term-a1")).toContain(
        "The Workspace's Container stopped: its Terminals had no input for 30 minutes while a command ran, the Terminal " +
          "hold while a command runs; change it under Environment › Advanced › Terminal hold while a command runs " +
          "(minutes).",
      );
      expect(h.frames.at(-1)).toMatchObject({ exit: { code: 129 } });
    });

    it("names the prompt hold at the prompt, with the value applied", async () => {
      const h = await atPrompt();
      const overridden = terminalHoldOf(hold, { busyHoldMs: undefined, promptHoldMs: "300000" });
      const lapse = h.host.appliedHold(overridden);
      expect(lapse).toEqual({ hold: "prompt", minutes: 5 });
      h.host.containerStopped(lapse);
      await h.host.settled();
      expect(h.text("term-a1")).toContain(
        "The Workspace's Container stopped: its Terminals had no input for 5 minutes at the prompt, the Terminal hold " +
          "at the prompt; change it under Environment › Advanced › Terminal hold at the prompt (minutes).",
      );
    });

    it("applies no hold with no terminal open, and a plain stop keeps the plain line", async () => {
      expect(harness().host.appliedHold(hold)).toBeUndefined();
      const h = await atPrompt();
      h.host.containerStopped();
      await h.host.settled();
      expect(h.text("term-a1")).toContain("The Workspace's Container stopped.\x1b[0m");
      expect(h.text("term-a1")).not.toContain("hold");
    });
  });
});
