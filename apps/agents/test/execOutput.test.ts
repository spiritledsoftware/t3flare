// SPI-1364: computer keeps only the last 2,000 lines or 64 KiB of an exec's output by default. A script that bounds its
// own output runs whole (`output: false`); every other command keeps computer's default, as before (a follow-up owns
// that). A checkpoint diff is cut on the Container to the size t3 asks for.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diffScript, execOutput } from "../src/workspace/execOutput.ts";

describe("an exec's output", () => {
  it("is whole for a script that bounds its own, and computer's default for every other command", () => {
    expect(execOutput(true)).toBe(false);
    expect(execOutput(false)).toBeUndefined();
  });
});

describe("a checkpoint diff on the Container", () => {
  /** Runs `diffScript` in bash with a stand-in `git` that prints `bytes` bytes and exits `status`. */
  const run = (maxBytes: number | undefined, bytes: number, status = 0) => {
    const dir = mkdtempSync(join(tmpdir(), "t3flare-diff-"));
    // `bytes` < 0: git writes until the pipe closes, so SIGPIPE ends it (141), as a long diff does.
    const body = bytes < 0 ? "exec yes x" : `head -c ${bytes} /dev/zero | tr '\\0' x\nexit ${status}`;
    writeFileSync(join(dir, "git"), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, "git"), 0o755);
    const ran = spawnSync("bash", ["-c", diffScript(["diff", "a", "b"], maxBytes)], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    return { status: ran.status, length: ran.stdout.length };
  };

  it("cuts git's output to the size t3 asks for, and counts git ended by the cut as success", () => {
    expect(run(1000, 300_000)).toEqual({ status: 0, length: 1000 });
    expect(run(1000, -1)).toEqual({ status: 0, length: 1000 });
    expect(run(1000, 10)).toEqual({ status: 0, length: 10 });
  });

  it("keeps git's own failure, and runs git alone when t3 asks no size", () => {
    expect(run(1000, 10, 2).status).toBe(2);
    expect(diffScript(["diff", "a b"], undefined)).toBe("exec git 'diff' 'a b'");
  });
});
