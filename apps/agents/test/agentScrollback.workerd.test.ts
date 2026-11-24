// SPI-1397: an agent Terminal's scrollback rows stay within a Durable Object SQLite row (8 MB, 8,000,000 bytes: a larger
// value throws SQLITE_TOOBIG there): the longest line kept, after a batch of short lines, goes to a row of its own. Run
// against a real Durable Object's SQLite, so the row limit is the platform's.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_LINE_BYTES } from "../src/workspace/agentScrollback.ts";
import type { VfsProbe } from "./workerd.fixture.ts";

const bindings = env as unknown as { VFS_PROBE: DurableObjectNamespace<VfsProbe> };
const probe = () => bindings.VFS_PROBE.get(bindings.VFS_PROBE.newUniqueId());

describe("an agent Terminal's scrollback rows", () => {
  it("store a line of the longest kept, after a batch of short lines, in a row of its own", async () => {
    expect(await probe().scrollbackRow(MAX_LINE_BYTES)).toEqual({ threw: null, length: MAX_LINE_BYTES });
  });

  it("cut a longer line to fit, never throwing, in UTF-8 bytes", async () => {
    expect(await probe().scrollbackRow(9 * 1024 * 1024)).toEqual({
      threw: null,
      length: Math.floor(MAX_LINE_BYTES / 3),
    });
    expect(await probe().scrollbackRow(4 * 1024 * 1024, "é")).toEqual({
      threw: null,
      length: Math.floor(MAX_LINE_BYTES / 3),
    });
  });
});
