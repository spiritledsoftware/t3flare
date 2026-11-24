// SPI-1364: the leak check's grep walks every match a page at a time; a total cap of 200 matches left files past them
// unreported.
import { describe, expect, it } from "vitest";

import { GREP_PAGE, grepPaths } from "../src/workspace/files.ts";

/** A grep over `count` matches, one per file, answering each page as computer's does. */
const fakeFs = (count: number) => {
  const pages: Array<{ readonly limit: number; readonly offset: number }> = [];
  return {
    pages,
    grep: async (_pattern: string, _path: string, options: { readonly limit: number; readonly offset: number }) => {
      pages.push({ limit: options.limit, offset: options.offset });
      const end = Math.min(count, options.offset + options.limit);
      return Array.from({ length: Math.max(0, end - options.offset) }, (_, i) => ({
        path: `/workspace/f${options.offset + i}`,
      }));
    },
  };
};

describe("grepPaths", () => {
  it("reports every file past the first page, a page of GREP_PAGE matches at a time", async () => {
    const fs = fakeFs(GREP_PAGE * 2 + 5);
    const paths = await grepPaths(fs, "secret", "/workspace");
    expect(paths).toHaveLength(GREP_PAGE * 2 + 5);
    expect(paths).toContain(`/workspace/f${GREP_PAGE * 2 + 4}`);
    expect(fs.pages).toEqual([
      { limit: GREP_PAGE, offset: 0 },
      { limit: GREP_PAGE, offset: GREP_PAGE },
      { limit: GREP_PAGE, offset: GREP_PAGE * 2 },
    ]);
  });

  it("keeps each path once, and stops at a page that is not full", async () => {
    const fs = {
      grep: async (_p: string, _r: string, options: { readonly offset: number }) =>
        options.offset === 0 ? [{ path: "/a" }, { path: "/a" }] : [{ path: "/b" }],
    };
    expect(await grepPaths(fs, "x", "/", 2)).toEqual(["/a", "/b"]);
  });
});
