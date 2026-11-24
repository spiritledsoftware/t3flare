// SPI-1370: a git read's answer too large for a Durable Object SQLite row is answered, never cached, and its put never
// throws, so `WorkspaceDO.git()` never reports a read that ran as `container_refused`. Run against a real Durable
// Object's SQLite, so the row limit is the platform's (8 MiB: a 9 MiB value throws SQLITE_TOOBIG there).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_ANSWER_BYTES } from "../src/workspace/readCache.ts";
import type { VfsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { VFS_PROBE: DurableObjectNamespace<VfsProbe> };
const probe = () => bindings.VFS_PROBE.get(bindings.VFS_PROBE.newUniqueId());

describe("readCache.put", () => {
  it("keeps an answer that fits a row, up to near its 8 MiB", async () => {
    expect(await probe().cacheRead(1_000_000)).toEqual({ threw: null, cached: true });
    expect(await probe().cacheRead(8_000_000)).toEqual({ threw: null, cached: true });
  });

  it("skips an answer over the 8 MiB row, without throwing", async () => {
    expect(await probe().cacheRead(9 * 1024 * 1024)).toEqual({ threw: null, cached: false });
  });

  it("keeps an answer of exactly MAX_ANSWER_BYTES, and skips one a byte over", async () => {
    // The answer's JSON around an empty stdout, as the probe makes it.
    const wrapper = JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }).length;
    expect(await probe().cacheRead(MAX_ANSWER_BYTES - wrapper)).toEqual({ threw: null, cached: true });
    expect(await probe().cacheRead(MAX_ANSWER_BYTES - wrapper + 1)).toEqual({ threw: null, cached: false });
  });

  it("measures the row in UTF-8 bytes, not characters", async () => {
    // 2 bytes each: 6 MB fits.
    expect(await probe().cacheRead(3_000_000, "é")).toEqual({ threw: null, cached: true });
    // 3 bytes each: 9 MB does not, though it is 3 million characters.
    expect(await probe().cacheRead(3_000_000, "€")).toEqual({ threw: null, cached: false });
  });
});

describe("a prime into the read cache (SPI-1360)", () => {
  it("keeps its fixed reads and local branches, and leaves t3's own reads half the cache, past gitReadsKept refs", async () => {
    const kept = 20;
    const refs = [
      "refs/heads/main",
      "refs/heads/feature",
      ...Array.from({ length: 1500 }, (_, at) => `refs/remotes/origin/r${at}`),
    ];
    const { primed, othersLeft } = await probe().primeKeeps(kept, kept, refs);
    expect(primed).toHaveLength(kept / 2);
    expect(primed.every(([, left]) => left)).toBe(true);
    expect(primed.map(([read]) => read).slice(0, 7)).toEqual([
      "rev-parse --git-common-dir",
      "remote",
      "config --get checkout.workers",
      "rev-parse --git-path index --git-path objects",
      "count-objects -v",
      expect.stringContaining("refs/heads/main"),
      expect.stringContaining("refs/heads/feature"),
    ]);
    expect(othersLeft).toBe(kept / 2);
  });
});
