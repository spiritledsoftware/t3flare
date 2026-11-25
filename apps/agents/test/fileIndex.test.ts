// SPI-1392: the Workspace's file index walks no further than its answer could carry, names a cut, and is kept per path
// for one revision of the repo when it is small enough.
import { type FoundEntry, foundEntryBytes, MIN_FOUND_ENTRY_BYTES, REPO_ROOT } from "@t3flare/workspace-client";
import { describe, expect, it } from "vitest";

import { FileIndex, INDEX_CACHE_MAX_BYTES, indexWalkLimit } from "../src/workspace/fileIndex.ts";

/** A tree of `count` entries, each at `pathOf` its place; records how far each walk went. */
const harness = (count: number, pathOf: (at: number) => string = (at) => `${REPO_ROOT}/f${at}`) => {
  let rev = 1;
  const walks: Array<{ path: string; limit: number | undefined; yielded: number }> = [];
  const entry = (at: number): FoundEntry => ({ path: pathOf(at), kind: "file" });
  const index = new FileIndex({
    find: async (path, limit) => {
      const out: Array<FoundEntry> = [];
      for (let at = 0; at < count && (limit === undefined || out.length < limit); at++) out.push(entry(at));
      walks.push({ path, limit, yielded: out.length });
      return { ok: out };
    },
    revision: () => rev,
  });
  return { index, walks, move: () => void rev++, fail: () => void (rev = -1) };
};

describe("the file index's walk", () => {
  it("is limited to the answer's bytes over the smallest entry, so no larger array is built, and a cut is named", async () => {
    expect(MIN_FOUND_ENTRY_BYTES).toBe(foundEntryBytes({ path: "x", kind: "file" }));
    expect(MIN_FOUND_ENTRY_BYTES).toBe(66);
    const maxBytes = 66 * 10 + 65;
    expect(indexWalkLimit(maxBytes)).toBe(10);
    // Entries of the smallest size: the walk would go on for 1,000, and stops one past the limit.
    const { index, walks } = harness(1_000, () => "x");
    const answer = await index.read(REPO_ROOT, maxBytes);
    expect(walks).toEqual([{ path: REPO_ROOT, limit: 11, yielded: 11 }]);
    if (!("ok" in answer)) throw new Error("expected an index");
    expect(answer.ok.entries).toHaveLength(10);
    expect(answer.ok.truncated).toBe(true);
    expect(answer.ok.cut).toContain(`${maxBytes} bytes`);
    expect(answer.ok.cut).toContain("10 entries");
  });

  it("a whole index is not cut and names nothing", async () => {
    const { index } = harness(5);
    const answer = await index.read(REPO_ROOT, 1024 * 1024);
    if (!("ok" in answer)) throw new Error("expected an index");
    expect(answer.ok).toEqual({ entries: expect.any(Array), truncated: false, revision: 1 });
    expect(answer.ok.entries).toHaveLength(5);
  });

  it("the limit for the real answer bound is about 500k entries", () => {
    expect(indexWalkLimit(32 * 1024 * 1024 - 64 * 1024)).toBe(507_407);
  });
});

describe("the file index's cache", () => {
  it("answers the same path at the same revision without walking again", async () => {
    const { index, walks } = harness(5);
    const first = await index.read(REPO_ROOT, 1024 * 1024);
    const second = await index.read(REPO_ROOT, 1024 * 1024);
    expect(second).toEqual(first);
    expect(walks).toHaveLength(1);
  });

  it("walks again once the revision moved", async () => {
    const { index, walks, move } = harness(5);
    await index.read(REPO_ROOT, 1024 * 1024);
    move();
    await index.read(REPO_ROOT, 1024 * 1024);
    expect(walks).toHaveLength(2);
  });

  it("keeps each path apart, and an answer for another bound apart", async () => {
    const { index, walks } = harness(5);
    await index.read(REPO_ROOT, 1024 * 1024);
    await index.read(`${REPO_ROOT}/src`, 1024 * 1024);
    await index.read(REPO_ROOT, 1024);
    expect(walks).toHaveLength(3);
  });

  it("does not keep an index over 8 MiB", async () => {
    expect(INDEX_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024);
    // 1,000-character paths: 2,064 bytes each, so 4,100 entries are just over 8 MiB.
    const { index, walks } = harness(
      4_100,
      (at) => `${REPO_ROOT}/${String(at).padStart(1_000 - REPO_ROOT.length - 1, "0")}`,
    );
    const answer = await index.read(REPO_ROOT, 32 * 1024 * 1024);
    if (!("ok" in answer)) throw new Error("expected an index");
    const bytes = answer.ok.entries.reduce((sum, entry) => sum + foundEntryBytes(entry), 0);
    expect(bytes).toBeGreaterThan(INDEX_CACHE_MAX_BYTES);
    await index.read(REPO_ROOT, 32 * 1024 * 1024);
    expect(walks).toHaveLength(2);
  });

  it("keeps nothing while the revision is unknown (below 0, its query failed), and walks every time", async () => {
    const { index, walks, fail } = harness(5);
    fail();
    const first = await index.read(REPO_ROOT, 1024 * 1024);
    await index.read(REPO_ROOT, 1024 * 1024);
    expect(walks).toHaveLength(2);
    if (!("ok" in first)) throw new Error("expected an index");
    expect(first.ok.revision).toBeUndefined();
  });

  it("keeps nothing outside the repo, whose revision does not cover it", async () => {
    const { index, walks } = harness(5);
    await index.read("/workspace/.harness", 1024 * 1024);
    await index.read("/workspace/.harness", 1024 * 1024);
    expect(walks).toHaveLength(2);
  });
});
