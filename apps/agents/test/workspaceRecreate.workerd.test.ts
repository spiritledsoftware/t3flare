// @effect-diagnostics globalTimers:off cryptoRandomUUID:off
// SPI-1436: a purged Workspace DO refuses every RPC (review F4), so the Environment's mkdir of a new project folder at a
// purged name failed for good. `makeEmpty` is provisioning, like `clone`: it makes the Workspace again. Run against the
// real WorkspaceDO and its Durable Object's SQLite; none of these RPCs starts its Container.
import { env } from "cloudflare:workers";
import { REPO_ROOT } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import type { WorkspaceDO } from "../src/workspace/WorkspaceDO.ts";

const bindings = env as unknown as { WORKSPACE: DurableObjectNamespace<WorkspaceDO> };

/** `destroy()` restarts the object; a call that lands on the old one fails, so it is sent again to the new one. */
const settled = async (call: () => Promise<unknown>): Promise<unknown> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 5 || String(error).includes("this Workspace was deleted")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

describe("a purged Workspace made again (SPI-1436)", () => {
  it("makeEmpty after destroy makes the repo folder, and fs answers again", async () => {
    const name = `recreate-${crypto.randomUUID()}`;
    const ws = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName(name));
    expect(await ws().makeEmpty({ id: name })).toEqual({ ok: null });
    expect(await ws().fs({ op: "write", path: `${REPO_ROOT}/old.txt`, data: new TextEncoder().encode("old") })).toEqual(
      { ok: null },
    );
    expect(await ws().destroy()).toEqual({ destroyed: true });

    expect(await settled(() => ws().makeEmpty({ id: name }))).toEqual({ ok: null });
    const stat = await ws().fs({ op: "stat", path: REPO_ROOT });
    expect("ok" in stat && (stat.ok as { kind: string }).kind).toBe("directory");
    // The purge's files are gone: the folder is new and empty.
    expect(await ws().fs({ op: "readdir", path: REPO_ROOT })).toEqual({ ok: [] });
  });

  it("fs on a destroyed Workspace is still refused (review F4)", async () => {
    const name = `refused-${crypto.randomUUID()}`;
    const ws = () => bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName(name));
    expect(await ws().makeEmpty({ id: name })).toEqual({ ok: null });
    expect(await ws().destroy()).toEqual({ destroyed: true });
    await expect(settled(() => ws().fs({ op: "mkdir", path: REPO_ROOT, recursive: true }))).rejects.toThrow(
      "this Workspace was deleted",
    );
  });
});
