// @effect-diagnostics globalTimers:off globalDate:off
// The Container setup as the Workspace DO runs it (ADR-0047 §7; `ContainerSetup`), with a fake exec and clock: the
// Owner's script once per Container, bounded by its time limit, reported with the end of its output and every secret
// Variable's value blanked, and refusing the Container's commands on a failure when the Owner set that. The wrapper
// script itself is `containerSetupScript.test.ts`'s; the keyed, held, retried step is `globalMise.test.ts`'s too.
import { type ContainerSetupReport, MAX_SETUP_OUTPUT_BYTES } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import { blankSecrets, CONTAINER_SETUP_KEY, ContainerSetup, type ContainerSetupLaunch } from "../src/workspace/containerSetup.ts";
import type { ContainerExec } from "../src/workspace/containerStep.ts";

const SHA = "c".repeat(64);
const LAUNCH: ContainerSetupLaunch = { text: "apt-get install -y ripgrep\n", bytes: 27, sha256: SHA, revision: 3, source: "environment", minutes: 5, failure: "carryOn" };
const MARK = "@@t3flare-container-setup@@";
const answered = (output: string, answer: Record<string, unknown>) => `${output}\n${MARK}${JSON.stringify({ sha256: SHA, exitCode: 0, timedOut: false, ms: 40, ...answer })}\n`;

type Step = { readonly stdout?: string; readonly throws?: string; readonly hang?: boolean };

const setup = (steps: Array<Step>, options: { launch?: ContainerSetupLaunch | undefined; secrets?: ReadonlyArray<string> } = {}) => {
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
    secrets: () => options.secrets ?? [],
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
    expect(t.calls[0]!.argv.slice(-2)).toEqual([SHA, "300"]);
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
    const t = setup([{ stdout: answered("token=s3cr3t-value\nnpm ok with s3cr3t-value\n", {}) }], { secrets: ["s3cr3t-value"] });
    await t.container.ensure("r1");
    expect(t.reports[0]!.output).toBe("token=***\nnpm ok with ***\n");
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

  it("keeps the last bytes after blanking, so a value cut by the window's start never shows a part of it", () => {
    const secret = "S".repeat(40);
    // The secret crosses where a cut of the raw output would fall: blanked first, then cut.
    const output = `${"x".repeat(10)}${secret}${"y".repeat(MAX_SETUP_OUTPUT_BYTES - 20)}`;
    const shown = blankSecrets(output, [secret], MAX_SETUP_OUTPUT_BYTES);
    expect(shown).not.toContain("S");
    expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(MAX_SETUP_OUTPUT_BYTES);
    expect(shown.endsWith("y")).toBe(true);
  });

  it("never cuts a character in two", () => {
    const shown = blankSecrets(`€${"x".repeat(9)}`, [], 10);
    expect(shown).toBe("x".repeat(9));
  });
});
