// SPI-1370: a git read's answer too large for a Durable Object SQLite row is answered, never cached, and its put never
// throws, so `WorkspaceDO.git()` never reports a read that ran as `container_refused`. Run against a real Durable
// Object's SQLite, so the row limit is the platform's (8 MiB: a 9 MiB value throws SQLITE_TOOBIG there).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

  it("measures the row in UTF-8 bytes, not characters", async () => {
    // 2 bytes each: 6 MB fits.
    expect(await probe().cacheRead(3_000_000, "é")).toEqual({ threw: null, cached: true });
    // 3 bytes each: 9 MB does not, though it is 3 million characters.
    expect(await probe().cacheRead(3_000_000, "€")).toEqual({ threw: null, cached: false });
  });
});
