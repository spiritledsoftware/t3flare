// SPI-1375: t3's git runs through the Workspace DO answer the head of each stream, cut in the Container just past t3's
// own cap, never computer's silent tail. Run through the computer-like exec seam, so a tailed answer fails here.
// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIT_HEAD_SLACK_BYTES, GIT_WHOLE_OUTPUT_BYTES, gitOutputCut } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { cutStreams, gitExecOf, gitHeadScript, gitOutcome, keptFor, keptWhole } from "../src/workspace/gitOutput.ts";
import { CANCEL_KILL_AFTER_MS } from "../src/workspace/runCancels.ts";
import { computerExec, computerTail } from "./computerExec.fixture.ts";

/** A folder whose `git` is `body` (a bash script), first on PATH. */
const standIn = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), "t3flare-git-output-"));
  writeFileSync(join(dir, "git"), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "git"), 0o755);
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
};

/** `lines` numbered lines on stdout, `errBytes` bytes of `e` on stderr, then exit `status`. */
const printing = (lines: number, errBytes = 0, status = 0) =>
  standIn(`seq 1 ${lines}\nhead -c ${errBytes} /dev/zero | tr '\\0' e >&2\nexit ${status}`);

const seq = (lines: number) => Array.from({ length: lines }, (_, at) => `${at + 1}\n`).join("");

const run = (maxOutputBytes: number | undefined, env: Record<string, string>, stdin?: string) => {
  const result = computerExec({
    ...gitExecOf({ argv: ["log"], ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) }),
    env,
    ...(stdin === undefined ? {} : { stdin }),
  });
  return { result, outcome: gitOutcome(result, maxOutputBytes) };
};

describe("the computer-like exec seam", () => {
  it("tails a command's output as computer does, unless it runs whole", () => {
    const env = printing(30_000);
    const tailed = computerExec({ script: "git", env });
    expect(tailed.stdout).toBe(seq(30_000).split("\n").slice(-2001).join("\n"));
    expect(computerTail(Buffer.from("x".repeat(70_000))).length).toBe(64 * 1024);
    // computer keeps whole lines where it can: a long line and a short one keep only the short one.
    expect(computerTail(Buffer.from(`${"x".repeat(70_000)}\ny`)).toString()).toBe("y");
    expect(computerExec({ script: "git", env, wholeOutput: true }).stdout).toBe(seq(30_000));
  });
});

describe("a git run's output (SPI-1375)", () => {
  it("is whole past computer's 64 KiB and 2,000 lines, under t3's 1 MB cap", () => {
    const { outcome } = run(1_000_000, printing(30_000));
    expect(seq(30_000).length).toBeGreaterThan(64 * 1024);
    expect(outcome).toEqual({ ok: true, answer: { exitCode: 0, stdout: seq(30_000), stderr: "", cut: null } });
  });

  it("past t3's cap is its head, cut past the cap by the slack, with git's own exit status", () => {
    const { outcome } = run(10_000, printing(200_000, 0, 3));
    const cut = 10_000 + 1 + GIT_HEAD_SLACK_BYTES;
    expect(gitOutputCut(10_000)).toBe(cut);
    expect(outcome).toEqual({
      ok: true,
      answer: { exitCode: 3, stdout: seq(200_000).slice(0, cut), stderr: "", cut },
    });
  });

  it("cuts stderr the same way, and passes stdin to git", () => {
    const { outcome } = run(10, standIn("cat\nhead -c 200000 /dev/zero | tr '\\0' e >&2"), "from t3\n");
    expect(outcome).toEqual({
      ok: true,
      answer: {
        exitCode: 0,
        stdout: "from t3\n",
        stderr: "e".repeat(gitOutputCut(10)),
        cut: gitOutputCut(10),
      },
    });
  });

  it("with no cap, is whole up to GIT_WHOLE_OUTPUT_BYTES, and past it fails naming the bound", () => {
    const within = run(undefined, standIn(`head -c ${GIT_WHOLE_OUTPUT_BYTES} /dev/zero | tr '\\0' x`));
    expect(within.outcome.ok && within.outcome.answer.stdout.length).toBe(GIT_WHOLE_OUTPUT_BYTES);
    const past = run(undefined, standIn(`head -c ${GIT_WHOLE_OUTPUT_BYTES + 1} /dev/zero | tr '\\0' x`));
    expect(past.outcome).toEqual({
      ok: false,
      detail:
        "git's output passed 16 MiB (16777216 bytes), the most the Workspace answers of one git command t3 does not cap; it is fixed by the Workspace's 128 MB of memory",
    });
    // A cap above the bound (the review guide's 64 MiB) is held to it too, and the refusal says so.
    const longer = standIn(`head -c ${GIT_WHOLE_OUTPUT_BYTES + 10} /dev/zero | tr '\\0' x`);
    expect(run(64 * 1024 * 1024, longer).outcome).toEqual({
      ok: false,
      detail:
        "git's output passed 16 MiB (16777216 bytes), the most the Workspace answers of one git command t3 caps higher (this one at 67108864 bytes); it is fixed by the Workspace's 128 MB of memory",
    });
    // A cap at the bound (t3's own 16 MiB reads) keeps the slack: past the cap, the answer is t3's to judge.
    expect(gitOutputCut(GIT_WHOLE_OUTPUT_BYTES)).toBe(GIT_WHOLE_OUTPUT_BYTES + 1 + GIT_HEAD_SLACK_BYTES);
    const atCap = run(GIT_WHOLE_OUTPUT_BYTES, longer).outcome;
    expect(atCap.ok && [atCap.answer.stdout.length, atCap.answer.cut]).toEqual([GIT_WHOLE_OUTPUT_BYTES + 10, null]);
  }, 60_000);

  it("is never computer's tail: the same run without whole output loses its head", () => {
    const exec = gitExecOf({ argv: ["log"], maxOutputBytes: 1_000_000 });
    const tailed = computerExec({ ...exec, wholeOutput: false, env: printing(30_000) });
    expect(gitOutcome(tailed, 1_000_000)).not.toEqual(run(1_000_000, printing(30_000)).outcome);
  });

  /** The script over a stand-in git that writes its pid to a file, then `body`; the script's process and that file. */
  const started = (body: string, options: { readonly group?: boolean } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "t3flare-git-pid-"));
    const env = standIn(`echo $$ > ${dir}/pid\n${body}`);
    // `group`: its own process group, so a TERM can reach every process of it at once, as a group kill would.
    const child = spawn("bash", ["-c", gitHeadScript(["fetch"], 100)], {
      env: { ...process.env, ...env, TMPDIR: dir },
      detached: options.group === true,
    });
    // The script's stdout closes only when every process holding it (the reader, the watcher) has ended.
    const closed = new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (status) => resolve(status)));
    return { child, exited, closed, pidFile: join(dir, "pid"), dir };
  };
  const until = async (ready: () => boolean) => {
    for (let at = 0; at < 100 && !ready(); at++) await new Promise((resolve) => setTimeout(resolve, 50));
    return ready();
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("ends git when the run is cancelled (TERM), with git's own status", async () => {
    const { child, exited, pidFile } = started(`trap 'exit 7' TERM\nwhile :; do sleep 0.05; done`);
    expect(await until(() => existsSync(pidFile))).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(7);
  });

  it("ends, its output closed and its files gone, after a cancel (TERM, then KILL 1 s on) at any moment as it starts", async () => {
    const within = <A>(promise: Promise<A>, ms: number) =>
      Promise.race([promise, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), ms))]);
    for (let at = 0; at < 300; at++) {
      const group = at % 2 === 1;
      const { child, closed, pidFile, dir } = started(`trap 'exit 7' TERM\nwhile :; do sleep 0.05; done`, { group });
      await new Promise((resolve) => setTimeout(resolve, at % 11));
      if (group) process.kill(-child.pid!, "SIGTERM");
      else child.kill("SIGTERM");
      // The Workspace's cancel: TERM, then KILL after CANCEL_KILL_AFTER_MS when the run has not ended. bash 5.2 can lose
      // a TERM that lands as it starts a process (`gitHeadScript`); the KILL bounds it.
      let status = await within(closed, CANCEL_KILL_AFTER_MS);
      if (status === "late") {
        child.kill("SIGKILL");
        status = await within(closed, 5_000);
      }
      // bash ended by the TERM before its trap, or by the KILL (null), git's own status (7), or git's TERM (143): never
      // a run left going, nor 141.
      expect([null, 7, 143]).toContain(status);
      if (existsSync(pidFile)) expect(await until(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
      // Its temporary folder is gone, whether the script or its watcher removed it.
      expect(await until(() => readdirSync(dir).every((name) => !name.startsWith("t3flare-git.")))).toBe(true);
    }
  }, 300_000);

  it("leaves no process behind when git ends at once (its watcher and reader see the end of their FIFOs)", async () => {
    /** Whether any process of group `pgid` is left: a signal 0 to the group fails with ESRCH once it is empty. */
    const groupAlive = (pgid: number) => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    // 20 ms apart, 500 times: about 10 s per run, longer under load.
    const POLL_MS = 20;
    const POLL_ATTEMPTS = 500;
    // 16 at a time, so their watchers and readers start late, as under load.
    const one = async (): Promise<number> => {
      const { child, closed } = started("exit 0", { group: true });
      expect(await closed).toBe(0);
      // Its watcher ends once it is scheduled to read the script's last word, however late under load: wait for the
      // group to empty, polling POLL_ATTEMPTS times POLL_MS apart. A process still there after that is a leak.
      for (let at = 0; at < POLL_ATTEMPTS; at++)
        if (groupAlive(child.pid!)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        else return 0;
      process.kill(-child.pid!, "SIGKILL");
      return 1;
    };
    let left = 0;
    for (let batch = 0; batch < 25; batch++)
      left += (await Promise.all(Array.from({ length: 16 }, one))).reduce((sum, count) => sum + count, 0);
    expect(left).toBe(0);
  }, 120_000);

  it("kills git when the script is killed (KILL), even one that ignores TERM", async () => {
    const { child, exited, pidFile } = started(`trap '' TERM\nwhile :; do sleep 0.05; done`);
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    child.kill("SIGKILL");
    await exited;
    expect(await until(() => !alive(pid))).toBe(true);
  });
});

describe("a kept answer, for a read with a cap (SPI-1375)", () => {
  const whole = { exitCode: 0, stdout: "a".repeat(100), stderr: "b".repeat(5), cut: null };
  it("whole, answers any cap, cut to that cap's head", () => {
    expect(keptFor(whole, undefined)).toEqual(whole);
    expect(keptFor(whole, 1_000_000)).toEqual(whole);
    const cut = gitOutputCut(0);
    expect(keptFor({ ...whole, stdout: "a".repeat(cut + 10) }, 0)).toEqual({ ...whole, stdout: "a".repeat(cut), cut });
  });

  it("cut, answers only a cap no larger than its own", () => {
    const cut = gitOutputCut(1_000);
    const kept = { exitCode: 0, stdout: "a".repeat(cut), stderr: "", cut };
    expect(keptFor(kept, 1_000)).toEqual(kept);
    expect(keptFor(kept, 10)).toEqual({ ...kept, stdout: "a".repeat(gitOutputCut(10)), cut: gitOutputCut(10) });
    expect(keptFor(kept, 2_000)).toBeUndefined();
    expect(keptFor(kept, undefined)).toBeUndefined();
  });

  it("from before SPI-1375 (no `cut`) serves none: computer's tail can be any size, even a short one", () => {
    expect(keptFor({ exitCode: 0, stdout: "x\n", stderr: "" }, 1_000_000)).toBeUndefined();
    expect(computerTail(Buffer.from(`${"x".repeat(70_000)}\ny`)).length).toBe(1);
  });

  it("is patched by a stale read only when no stream of it was cut", () => {
    const cut = gitOutputCut(1_000);
    expect(keptWhole({ exitCode: 0, stdout: "a".repeat(cut), stderr: "", cut }, 1_000)).toBeUndefined();
    expect(keptWhole(whole, 1_000_000)).toEqual(whole);
    // Whole, but cut to a smaller cap's head here: no longer whole for this read.
    expect(keptWhole({ ...whole, stdout: "a".repeat(gitOutputCut(0) + 1) }, 0)).toBeUndefined();
  });

  it("flags the streams the Container cut, for the router to judge by", () => {
    const cut = gitOutputCut(10);
    expect(cutStreams({ exitCode: 0, stdout: "a".repeat(cut), stderr: "e", cut })).toEqual({
      stdout: true,
      stderr: false,
    });
    expect(cutStreams({ exitCode: 0, stdout: "a", stderr: "e", cut: null })).toBeUndefined();
  });
});
