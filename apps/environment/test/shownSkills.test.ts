// A skills change's view of the skills it would install (SPI-1368): each shows as much of its SKILL.md and its paths as
// its share of the change record's row holds, not a fixed 32 KiB and 200 paths.
import { describe, expect, it } from "vitest";

import { CHANGE_RECORD_BYTES } from "../src/settings/changes.ts";
import { SHOWN_SKILLS_BYTES, shownSkills } from "../src/settings/render.ts";

const skill = (name: string, skillMd: string, paths: ReadonlyArray<string>) => ({
  name,
  description: `The ${name} skill.`,
  path: `skills/${name}`,
  files: paths.length,
  bytes: skillMd.length,
  digest: "d".repeat(64),
  problems: [],
  skillMd,
  paths,
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("shownSkills", () => {
  it("shows one skill's long SKILL.md and many paths whole when the row holds them", () => {
    const text = "line of instructions\n".repeat(10_000);
    const paths = Array.from({ length: 1_000 }, (_, at) => `docs/page-${at}.md`);
    const [shown] = shownSkills([skill("a", text, paths)]);
    expect(shown?.skillMd).toBe(text);
    expect(shown?.skillMdCut).toBeUndefined();
    expect(shown?.paths).toEqual(paths);
    expect(shown?.morePaths).toBeUndefined();
  });

  it("cuts what passes each skill's share, and keeps the view within half the record's row", () => {
    const text = "\u0001".repeat(2_000_000);
    const paths = Array.from({ length: 200_000 }, (_, at) => `p/${at}`);
    const shown = shownSkills([skill("a", text, paths), skill("b", text, paths)]);
    expect(SHOWN_SKILLS_BYTES).toBe(Math.floor(CHANGE_RECORD_BYTES / 2));
    expect(bytes(shown)).toBeLessThanOrEqual(SHOWN_SKILLS_BYTES);
    for (const each of shown) {
      expect(each.skillMdCut).toBe(true);
      expect(each.skillMd.length).toBeGreaterThan(0);
      expect(each.morePaths).toBe(paths.length - each.paths.length);
      expect(each.paths.length).toBeGreaterThan(200);
    }
  });
});
