// The peer leak check's Container dump (SPI-1364): no file-size or file-count cap, and no cut at all. The dump is written
// to a file of the check's own in the Container and read back a slice at a time, each within one DO RPC answer, scanned
// and dropped, so every file is checked and no secret goes into the Container. A dump that did not finish is still
// scanned as far as it got, and says it is incomplete.
import { describe, expect, it } from "vitest";

import {
  containerDump,
  containerScan,
  DUMP_END,
  DUMP_SLICE_BYTES,
  DUMP_TIMEOUT_MS,
  DUMP_PREFIX,
  dumpPath,
  dumpSize,
  dumpSlice,
  dumpSlices,
  scanDump,
} from "../src/host/peerLeak.ts";

describe("the peer leak check's Container dump", () => {
  const path = dumpPath("abc-1");

  it("cuts nothing, writes the dump to the check's own file and leaves that file out, and marks its end", () => {
    expect(path).toBe("/tmp/t3flare-leak-dump-abc-1");
    expect(dumpPath("x; rm -rf /")).toBe("/tmp/t3flare-leak-dump-xrm-rf");
    const script = containerDump(path);
    expect(script).not.toMatch(/-size|head -/);
    // Every check's dump file is left out: its own, and a concurrent check's.
    expect(script).toContain(`-not -path '${DUMP_PREFIX}*'`);
    expect(path.startsWith(DUMP_PREFIX)).toBe(true);
    expect(script).toContain(`> ${path}`);
    expect(script).toContain(DUMP_END);
    expect(dumpSize(path)).toBe(`stat -c %s ${path} 2>/dev/null || echo 0`);
    expect(dumpSlice(path, 100, 50)).toBe(`tail -c +101 ${path} | head -c 50`);
  });

  it("reads 4 MiB a slice, which the Workspace DO holds whole beside a large diff", () => {
    expect(DUMP_SLICE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("slices the whole dump, each slice starting back by the overlap", () => {
    expect(dumpSlices(25, 10, 3)).toEqual([
      { offset: 0, length: 10 },
      { offset: 7, length: 10 },
      { offset: 14, length: 10 },
      { offset: 21, length: 4 },
    ]);
    expect(dumpSlices(10, 10, 3)).toEqual([{ offset: 0, length: 10 }]);
    expect(dumpSlices(0, 10, 3)).toEqual([]);
  });

  it("finds a secret split by a slice's edge, counts the files of every slice, and says the dump was read to its end", async () => {
    const secret = { name: "token", value: "s3cr3t-value-1234" };
    const head = "== env\nA=1\n== /proc/1/environ\nB=2\n== /workspace/a\n";
    const filler = "x".repeat(DUMP_SLICE_BYTES - head.length - 5);
    const dump = `${head}${filler}\n== /workspace/b\n${secret.value}\n${DUMP_END}\n`;
    const reads: Array<number> = [];
    const answer = await scanDump(
      dump.length,
      async (offset, length) => {
        reads.push(offset);
        return dump.slice(offset, offset + length);
      },
      [secret],
    );
    expect(reads.length).toBeGreaterThan(1);
    expect(answer).toEqual({ bytes: dump.length, files: 2, complete: true, leaked: ["token"] });
  });
});

describe("the Container's part of the check", () => {
  /** A Container whose dump writes `written`, and whose dump exec answers `dumpExit` (a timeout's kill, say). */
  const container = (written: string, dumpExit: number) => {
    const calls: Array<{ readonly script: string; readonly timeoutMs?: number; readonly wholeOutput?: boolean }> = [];
    const exec = async (input: {
      readonly script: string;
      readonly timeoutMs?: number;
      readonly wholeOutput?: boolean;
    }) => {
      calls.push(input);
      if (input.script.startsWith("{")) return { exitCode: dumpExit, stdout: "" };
      if (input.script.startsWith("stat ")) return { exitCode: 0, stdout: `${written.length}\n` };
      const slice = /^tail -c \+(\d+) \S+ \| head -c (\d+)$/.exec(input.script);
      if (slice !== null) {
        const offset = Number(slice[1]) - 1;
        return { exitCode: 0, stdout: written.slice(offset, offset + Number(slice[2])) };
      }
      return { exitCode: 0, stdout: "" };
    };
    return { calls, exec };
  };
  const secret = { name: "token", value: "s3cr3t-value-1234" };

  it("gives the dump its own deadline, reads each slice whole, and removes its file", async () => {
    const run = container(`== env\nA=1\n== /workspace/a\nx\n${DUMP_END}\n`, 0);
    const answer = await containerScan(run.exec, [secret], "id-1");
    expect(answer).toMatchObject({ exitCode: 0, files: 1, complete: true, leaked: [] });
    expect(run.calls[0]).toMatchObject({ timeoutMs: DUMP_TIMEOUT_MS });
    // computer's default would keep only a slice's last 64 KiB, and save the whole in the Workspace's own files.
    const slices = run.calls.filter((call) => call.script.startsWith("tail "));
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) expect(slice).toMatchObject({ wholeOutput: true });
    expect(run.calls.at(-1)?.script).toBe(`rm -f ${dumpPath("id-1")}`);
  });

  it("scans what a timed-out dump wrote, finds a leak in it, and says the scan is incomplete", async () => {
    // The dump's exec was killed at its deadline (137): no end marker, but what it wrote is on the Container's disk.
    const run = container(`== env\nA=1\n== /workspace/a\n${secret.value}\n== /workspace/big\nxxxx`, 137);
    const answer = await containerScan(run.exec, [secret], "id-2");
    expect(answer).toMatchObject({ exitCode: 137, complete: false, leaked: ["token"] });
    expect(answer.bytes).toBeGreaterThan(0);
    expect(run.calls.at(-1)?.script).toBe(`rm -f ${dumpPath("id-2")}`);
  });

  it("says incomplete when the dump wrote nothing, and still removes the file when a read fails", async () => {
    const empty = container("", -1);
    expect(await containerScan(empty.exec, [secret], "id-3")).toMatchObject({ bytes: 0, complete: false });
    const calls: Array<string> = [];
    const failing = async (input: { readonly script: string }) => {
      calls.push(input.script);
      if (input.script.startsWith("tail ")) throw new Error("the Container stopped");
      return { exitCode: 0, stdout: input.script.startsWith("stat ") ? "10\n" : "" };
    };
    await expect(containerScan(failing, [secret], "id-4")).rejects.toThrow("the Container stopped");
    expect(calls.at(-1)).toBe(`rm -f ${dumpPath("id-4")}`);
  });
});
