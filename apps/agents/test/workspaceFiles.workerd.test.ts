// SPI-1369: an append to a Workspace file writes bytes; an append that decoded as UTF-8 corrupted any binary file past
// its first chunk (the Environment's `/w` appends go through it). `#copyFrom` copies a worktree's git bundle, or a
// project-root file, through `copyIn`, streaming its chunks into one write. Run against a real computer Workspace in a
// real Durable Object's SQLite.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { VfsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { VFS_PROBE: DurableObjectNamespace<VfsProbe> };
const probe = () => bindings.VFS_PROBE.get(bindings.VFS_PROBE.newUniqueId());

/** Bytes that are not valid UTF-8 anywhere: every value 0-255, in an order no chunk boundary lines up with. */
const binary = (size: number) => {
  const bytes = new Uint8Array(size);
  let state = 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
};

describe("fileOps write with append", () => {
  it("appends a binary file in 4 MiB chunks byte for byte", async () => {
    const MiB = 1024 * 1024;
    expect(await probe().copy("/workspace/.t3flare/repo.bundle", binary(9 * MiB + 12_345), 4 * MiB)).toEqual({
      equal: true,
      size: 9 * MiB + 12_345,
    });
  });

  it("appends a binary file in chunks that no storage chunk lines up with", async () => {
    expect(await probe().copy("/workspace/a/b.bin", binary(2_100_003), 700_001)).toEqual({
      equal: true,
      size: 2_100_003,
    });
  });

  it("appends to a file the exact length of a storage chunk", async () => {
    expect(await probe().copy("/workspace/c.bin", binary(3 * 524_288), 524_288)).toEqual({
      equal: true,
      size: 3 * 524_288,
    });
  });

  it("appends text, and an append to a missing file creates it", async () => {
    const p = probe();
    expect(await p.writeText("/workspace/new/log.txt", "héllo", true)).toBe("héllo");
    expect(await p.writeText("/workspace/new/log.txt", " wörld\n", true)).toBe("héllo wörld\n");
    expect(await p.writeText("/workspace/new/log.txt", "fresh", false)).toBe("fresh");
  });
});

describe("fileOps copyIn", () => {
  const MiB = 1024 * 1024;

  it("streams #copyFrom's 4 MiB chunks into one file, byte for byte", async () => {
    expect(await probe().copyIn("/workspace/.t3flare/repo.bundle", binary(9 * MiB + 12_345), 4 * MiB)).toEqual({
      equal: true,
      size: 9 * MiB + 12_345,
    });
  });

  it("copies a file of a whole number of chunks, and an empty one", async () => {
    const p = probe();
    expect(await p.copyIn("/workspace/whole.bin", binary(2 * MiB), MiB)).toEqual({ equal: true, size: 2 * MiB });
    expect(await p.copyIn("/workspace/empty.bin", new Uint8Array(0), MiB)).toEqual({ equal: true, size: 0 });
  });

  it("answers a chunk's error and leaves no file", async () => {
    const p = probe();
    expect(await p.copyIn("/workspace/half.bin", binary(3 * MiB), MiB, MiB)).toEqual({ error: `no chunk at ${MiB}` });
    expect(await p.exists("/workspace/half.bin")).toBe(false);
  });
});
