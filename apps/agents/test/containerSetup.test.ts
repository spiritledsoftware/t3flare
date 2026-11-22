// @effect-diagnostics globalTimers:off globalDate:off
// The Container setup as the Workspace DO runs it (ADR-0047 §7; `ContainerSetup`), with a fake exec and clock: the
// Owner's script once per Container, bounded by its time limit, reported with the end of its output and every secret
// Variable's value blanked, and refusing the Container's commands on a failure when the Owner set that. The wrapper
// script itself is `containerSetupScript.test.ts`'s; the keyed, held, retried step is `globalMise.test.ts`'s too.
import { type ContainerSetupReport, EMPTY_ENVIRONMENT, resolveEnvironment } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { launchOf, secretValuesOf, withScripts } from "../src/workspace/containerLaunch.ts";
import { blankSecrets, CONTAINER_SETUP_KEY, ContainerSetup, type ContainerSetupLaunch } from "../src/workspace/containerSetup.ts";
import type { ContainerExec } from "../src/workspace/containerStep.ts";
import { SECRET_MARGIN_BYTES } from "@t3flare/sandbox-image/containerSetup";

const SHA = "c".repeat(64);
const LAUNCH: ContainerSetupLaunch = { text: "apt-get install -y ripgrep\n", bytes: 27, sha256: SHA, revision: 3, source: "environment", minutes: 5, failure: "carryOn", outputBytes: 32 * 1024 };
const MARK = "@@t3flare-container-setup@@";
const answered = (output: string, answer: Record<string, unknown>) => `${output}\n${MARK}${JSON.stringify({ sha256: SHA, exitCode: 0, timedOut: false, ms: 40, ...answer })}\n`;

type Step = { readonly stdout?: string; readonly throws?: string; readonly hang?: boolean };

const setup = (steps: Array<Step>, options: { launch?: ContainerSetupLaunch | undefined; secrets?: () => ReadonlyArray<string> } = {}) => {
  const map = new Map<string, unknown>();
  const calls: Array<{ argv: ReadonlyArray<string>; stdin: string }> = [];
  const reports: Array<ContainerSetupReport> = [];
  let killed = 0;
  const launch = "launch" in options ? options.launch : LAUNCH;
  const container = new ContainerSetup({
    exec: async (argv, stdin): Promise<ContainerExec> => {
      calls.push({ argv, stdin });
      const step = steps.shift() ?? { stdout: answered("", {}) };
      if (step.throws !== undefined) throw new Error(step.throws);
      return {
        output: step.hang === true ? new Promise(() => undefined) : Promise.resolve({ stdout: step.stdout ?? "", exitCode: 0 }),
        kill: () => void killed++,
      };
    },
    launch: () => launch,
    secrets: options.secrets ?? (() => []),
    hold: () => () => undefined,
    used: async () => undefined,
    report: (report) => void reports.push(report),
    storage: { get: <T>(key: string) => map.get(key) as T | undefined, put: <T>(key: string, value: T) => void map.set(key, structuredClone(value)) },
    workspace: () => "/w/app",
    now: () => Date.now(),
    deadlineMs: () => 20,
  });
  return { container, calls, reports, map, killed: () => killed };
};

describe("ContainerSetup", () => {
  it("runs the Owner's script on stdin with its digest and time limit in seconds, and reports exit 0 as ok", async () => {
    const t = setup([{ stdout: answered("installed\n", {}) }]);
    expect(await t.container.ensure("r1")).toMatchObject({ runtime: "r1", outcome: "ok", exitCode: 0 });
    expect(t.calls[0]!.stdin).toBe(LAUNCH.text);
    expect(t.calls[0]!.argv.slice(-3)).toEqual([SHA, "300", String(48 * 1024)]);
    expect(t.reports).toEqual([expect.objectContaining({ workspace: "/w/app", runtime: "r1", revision: 3, sha256: SHA, bytes: 27, source: "environment", outcome: "ok", exitCode: 0, timedOut: false, output: "installed\n" })]);
    expect(t.map.get(CONTAINER_SETUP_KEY)).toMatchObject({ runtime: "r1", outcome: "ok" });
  });

  it("reports a non-zero exit, or the time limit, as failed", async () => {
    const t = setup([{ stdout: answered("E: no package\n", { exitCode: 100 }) }]);
    expect(await t.container.ensure("r1")).toMatchObject({ outcome: "failed", exitCode: 100 });
    const timed = setup([{ stdout: answered("", { exitCode: 124, timedOut: true }) }]);
    expect(await timed.container.ensure("r1")).toMatchObject({ outcome: "failed", timedOut: true });
  });

  it("kills the exec at its deadline: final for that Container", async () => {
    const t = setup([{ hang: true }]);
    expect(await t.container.ensure("r1")).toMatchObject({ outcome: "deadline", attempts: 1 });
    expect(t.killed()).toBe(1);
    expect(t.container.due("r1")).toBe(false);
  });

  it("treats a run without an answer, or one that found the lock held, as an exec failure, tried again at once", async () => {
    const t = setup([{ stdout: "bash: flock: command not found\n" }, { stdout: answered("", { exitCode: null, locked: true }) }]);
    expect(await t.container.ensure("r1")).toMatchObject({ outcome: "exec-failed", attempts: 2 });
    expect(t.container.due("r1")).toBe(true);
  });

  it("runs nothing for an empty script, or a launch from before the Container setup, and reports none", async () => {
    const empty = setup([], { launch: { ...LAUNCH, text: "", bytes: 0 } });
    expect(await empty.container.ensure("r1")).toMatchObject({ outcome: "none" });
    expect(empty.calls).toHaveLength(0);
    expect(empty.reports).toMatchObject([{ outcome: "none", exitCode: null, output: "", revision: 3 }]);
    const before = setup([], { launch: undefined });
    expect(await before.container.ensure("r1")).toMatchObject({ outcome: "none" });
    expect(before.calls).toHaveLength(0);
  });

  it("blanks every secret Variable's value in the reported output", async () => {
    const t = setup([{ stdout: answered("token=s3cr3t-value\nnpm ok with s3cr3t-value\n", {}) }], { secrets: () => ["s3cr3t-value"] });
    await t.container.ensure("r1");
    expect(t.reports[0]!.output).toBe("token=***\nnpm ok with ***\n");
  });

  it("blanks the opened value of a secret Variable the Container started with, as the Workspace DO wires it (ADR-0046)", async () => {
    const variables = [
      { name: "DOTFILES_TOKEN", value: "ghp_live_0123456789", secret: true },
      { name: "NODE_ENV", value: "production", secret: false },
    ];
    const taken = { settings: { ...resolveEnvironment(EMPTY_ENVIRONMENT), variables, containerSetup: "git clone https://$DOTFILES_TOKEN@github.com/me/dotfiles\n" }, source: "environment" as const };
    const launch = await withScripts(launchOf(taken), taken);
    const t = setup([{ stdout: answered("+ git clone https://ghp_live_0123456789@github.com/me/dotfiles\nNODE_ENV=production\n", {}) }], { launch: launch.containerSetup, secrets: () => secretValuesOf(launch) });
    await t.container.ensure("r1");
    expect(t.reports[0]!.output).toBe("+ git clone https://***@github.com/me/dotfiles\nNODE_ENV=production\n");
  });

  it("keeps the last setupOutputKiB of output, and asks the wrapper for that and 16 KiB more", async () => {
    const t = setup([{ stdout: answered(`${"a".repeat(5000)}END\n`, {}) }], { launch: { ...LAUNCH, outputBytes: 4 * 1024 } });
    await t.container.ensure("r1");
    expect(t.reports[0]!.output).toBe(`${"a".repeat(4096 - 4)}END\n`);
    expect(t.calls[0]!.argv.at(-1)).toBe(String(4 * 1024 + 16 * 1024));
  });

  it("refuses the Container's commands after a failure only when the Owner set refuse", async () => {
    const carry = setup([{ stdout: answered("", { exitCode: 1 }) }]);
    expect(carry.container.refusal(await carry.container.ensure("r1"))).toBeUndefined();
    const refuse = setup([{ stdout: answered("", { exitCode: 1 }) }, { stdout: answered("", {}) }], { launch: { ...LAUNCH, failure: "refuse" } });
    expect(refuse.container.refusal(await refuse.container.ensure("r1"))).toMatch(/Container setup failed \(exit 1\)/);
    expect(refuse.container.refusal(await refuse.container.ensure("r2"))).toBeUndefined();
  });
});

describe("blankSecrets", () => {
  it("blanks each value, a longer one before one it holds, and ignores an empty value", () => {
    expect(blankSecrets("ab abc abcd", ["abc", "abcd", ""], 100)).toBe("ab *** ***");
  });

  it("never cuts a character in two", () => {
    const shown = blankSecrets(`€${"x".repeat(9)}`, [], 10);
    expect(shown).toBe("x".repeat(9));
  });

  /** What the wrapper answers: the last `bytes` of the whole output, as `tail -c` cuts it (ASCII here). */
  const tailOf = (whole: string, bytes: number) => whole.slice(Math.max(0, whole.length - bytes));
  const KEPT = 4 * 1024;
  const WINDOW = KEPT + SECRET_MARGIN_BYTES;

  it("shows no part of a long secret echoed many times, whose copy the window's start split", () => {
    // 4000 characters, the most a Variable's value holds, echoed 15 times: blanking shrinks the window far below what
    // is kept, so a cut of the blanked text would keep the split copy's tail.
    const secret = `s3cr3t-${"Q".repeat(3993)}`;
    const whole = Array.from({ length: 15 }, (_, i) => `line ${i}: token=${secret}\n`).join("");
    const window = tailOf(whole, WINDOW);
    expect(window.startsWith("s3cr3t-")).toBe(false);
    const shown = blankSecrets(window, [secret], KEPT);
    expect(shown).not.toMatch(/Q/);
    expect(shown.endsWith("line 14: token=***\n")).toBe(true);
  });

  it("shows no part of a short token traced by set -x in a long loop, whose copy the window's start split", () => {
    const token = `ghp_${"Z".repeat(36)}`;
    const line = `+ curl -sf -H 'Authorization: Bearer ${token}' https://api.github.com/repos/me/dotfiles\n`;
    // The window starts in the middle of a copy of the token.
    const whole = `${line.repeat(400)}+ done\n`;
    const start = whole.length - WINDOW;
    const window = whole.slice(start);
    expect(whole.slice(start - 10, start + 10)).toMatch(/Z/);
    const shown = blankSecrets(window, [token], KEPT);
    expect(shown).not.toMatch(/Z|ghp_/);
    expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(KEPT);
    expect(shown.endsWith("Bearer ***' https://api.github.com/repos/me/dotfiles\n+ done\n")).toBe(true);
  });

  it("blanks a secret that crosses the kept part's start whole", () => {
    const secret = "S".repeat(40);
    const window = `${"x".repeat(100)}${secret}${"y".repeat(KEPT - 20)}`;
    const shown = blankSecrets(window, [secret], KEPT);
    expect(shown.startsWith("***y")).toBe(true);
    expect(shown).not.toMatch(/S/);
  });
});
