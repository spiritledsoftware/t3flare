// Repo skills' discovery (SPI-1147 §1): roots and directories in order, the rules table, the cap, and the Environment
// skill set's precedence.
import { describe, expect, it } from "vitest";

import { directoriesUp, discoverSkills, listingStopped, type Skill, withoutTrailingSlashes } from "./discovery.ts";
import { memoryFiles, skillMd } from "./testing.ts";

const ROOT = "/workspace/repo";
const at = (cwd: string, files: Record<string, string>, environment: ReadonlyArray<Skill> = []) =>
  discoverSkills(memoryFiles(files), { cwd, root: ROOT, environment });

describe("Repo skills' discovery", () => {
  it("finds a skill in .agents/skills with its name, description and SKILL.md path", async () => {
    const found = await at(ROOT, {
      [`${ROOT}/.agents/skills/fruit/SKILL.md`]: skillMd({ name: "fruit", description: "The fruit code." }),
    });
    expect(found).toEqual({
      skills: [
        {
          name: "fruit",
          description: "The fruit code.",
          filePath: `${ROOT}/.agents/skills/fruit/SKILL.md`,
          disableModelInvocation: false,
        },
      ],
      skipped: [],
      omitted: 0,
    });
  });

  it("looks in .pi/skills, then .agents/skills, then .claude/skills: the first name found wins", async () => {
    const found = await at(ROOT, {
      [`${ROOT}/.claude/skills/a/SKILL.md`]: skillMd({ name: "a", description: "claude a" }),
      [`${ROOT}/.claude/skills/c/SKILL.md`]: skillMd({ name: "c", description: "claude c" }),
      [`${ROOT}/.agents/skills/a/SKILL.md`]: skillMd({ name: "a", description: "agents a" }),
      [`${ROOT}/.agents/skills/b/SKILL.md`]: skillMd({ name: "b", description: "agents b" }),
      [`${ROOT}/.pi/skills/b/SKILL.md`]: skillMd({ name: "b", description: "pi b" }),
    });
    expect(found.skills.map((skill) => skill.description)).toEqual(["pi b", "agents a", "claude c"]);
    expect(found.skipped).toEqual([
      { path: `${ROOT}/.agents/skills/b/SKILL.md`, reason: `"b" is shadowed by ${ROOT}/.pi/skills/b/SKILL.md` },
      { path: `${ROOT}/.claude/skills/a/SKILL.md`, reason: `"a" is shadowed by ${ROOT}/.agents/skills/a/SKILL.md` },
    ]);
  });

  it("searches from the cwd up to the repo root, nearest directory first, and no further", async () => {
    const found = await at(`${ROOT}/pkg/app`, {
      [`/workspace/.agents/skills/above/SKILL.md`]: skillMd({ name: "above", description: "above the repo" }),
      [`${ROOT}/.claude/skills/x/SKILL.md`]: skillMd({ name: "x", description: "root claude" }),
      [`${ROOT}/pkg/.claude/skills/x/SKILL.md`]: skillMd({ name: "x", description: "pkg claude" }),
      [`${ROOT}/pkg/app/.agents/skills/y/SKILL.md`]: skillMd({ name: "y", description: "app agents" }),
      [`${ROOT}/.pi/skills/y/SKILL.md`]: skillMd({ name: "y", description: "root pi" }),
    });
    expect(found.skills.map((skill) => skill.description)).toEqual(["app agents", "pkg claude"]);
    expect(found.skipped.map((skipped) => skipped.path)).toEqual([
      `${ROOT}/.pi/skills/y/SKILL.md`,
      `${ROOT}/.claude/skills/x/SKILL.md`,
    ]);
  });
});

describe("the rules, the same for the agent and the composer", () => {
  const one = async (text: string, folder = "s") => {
    const path = `${ROOT}/.agents/skills/${folder}/SKILL.md`;
    const found = await at(ROOT, { [path]: text });
    return { skill: found.skills[0], skipped: found.skipped.map((skipped) => skipped.reason) };
  };

  it("skips a SKILL.md with no frontmatter, a frontmatter that is not YAML, or no description", async () => {
    expect(await one("# Just a heading\n")).toEqual({ skill: undefined, skipped: ["no frontmatter"] });
    expect(await one("---\nname: [unclosed\n---\n")).toEqual({
      skill: undefined,
      skipped: ["the frontmatter is not YAML"],
    });
    expect(await one("---\n- a list\n---\n")).toEqual({ skill: undefined, skipped: ["the frontmatter is not YAML"] });
    expect(await one(skillMd({ name: "s" }))).toEqual({ skill: undefined, skipped: ["no description"] });
    expect(await one(skillMd({ name: "s", description: "  " }))).toEqual({
      skill: undefined,
      skipped: ["no description"],
    });
  });

  it("names a skill without a name after its folder, and uses a frontmatter name that differs from it", async () => {
    expect((await one(skillMd({ description: "d" }), "folder-name")).skill?.name).toBe("folder-name");
    expect(await one(skillMd({ name: "declared", description: "d" }), "folder-name")).toMatchObject({
      skill: { name: "declared" },
      skipped: [],
    });
  });

  it("skips a name t3 cannot mention: over 64 characters, a character outside [a-zA-Z0-9:_-], no letter, a non-alphanumeric first character, or number-like", async () => {
    expect((await one(skillMd({ name: "a".repeat(64), description: "d" }))).skill?.name).toBe("a".repeat(64));
    expect((await one(skillMd({ name: "ns:tool_x-1", description: "d" }))).skill?.name).toBe("ns:tool_x-1");
    for (const name of [
      "a".repeat(65),
      "has space",
      "dotted.name",
      "émoji",
      "123",
      "-_:",
      "_private",
      "-x",
      ":ns",
      "5k",
      "2e5",
    ]) {
      const { skill, skipped } = await one(skillMd({ name, description: "d" }));
      expect(skill, name).toBeUndefined();
      expect(skipped[0], name).toMatch(/is not a name t3 can mention$/);
    }
  });

  it("cuts a description to 1,024 characters", async () => {
    expect((await one(skillMd({ name: "s", description: "x".repeat(1500) }))).skill?.description).toBe(
      "x".repeat(1024),
    );
  });

  it("ignores allowed-tools, and reads disable-model-invocation", async () => {
    const text =
      "---\nname: s\ndescription: d\nallowed-tools: Bash(rm:*) Write\ndisable-model-invocation: true\n---\nBody\n";
    expect(await one(text)).toEqual({
      skill: {
        name: "s",
        description: "d",
        filePath: `${ROOT}/.agents/skills/s/SKILL.md`,
        disableModelInvocation: true,
      },
      skipped: [],
    });
  });

  it("does not descend dot directories or node_modules, nor look below a skill", async () => {
    const found = await at(ROOT, {
      [`${ROOT}/.agents/skills/group/real/SKILL.md`]: skillMd({ name: "real", description: "d" }),
      [`${ROOT}/.agents/skills/.hidden/SKILL.md`]: skillMd({ name: "hidden", description: "d" }),
      [`${ROOT}/.agents/skills/group/.cache/SKILL.md`]: skillMd({ name: "cached", description: "d" }),
      [`${ROOT}/.agents/skills/node_modules/dep/SKILL.md`]: skillMd({ name: "dep", description: "d" }),
      [`${ROOT}/.agents/skills/group/real/nested/SKILL.md`]: skillMd({ name: "nested", description: "d" }),
    });
    expect(found.skills.map((skill) => skill.name)).toEqual(["real"]);
    expect(found.skipped).toEqual([]);
  });

  it("keeps the nearest 100 Repo skills and counts the rest as omitted", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 103; index++) {
      const name = `s${String(index).padStart(3, "0")}`;
      files[`${ROOT}/.agents/skills/${name}/SKILL.md`] = skillMd({ name, description: "d" });
    }
    files[`${ROOT}/sub/.claude/skills/near/SKILL.md`] = skillMd({ name: "near", description: "d" });
    const found = await at(`${ROOT}/sub`, files);
    expect(found.skills).toHaveLength(100);
    expect(found.skills[0]?.name).toBe("near");
    expect(found.skills.at(-1)?.name).toBe("s098");
    expect(found.omitted).toBe(4);
    // The cap it ran with, for the listing to name (SPI-1433).
    expect(found.repoSkills).toBe(100);
  });

  it("names its listing limit and value when a directory's listing stops at it (SPI-1387)", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 4; index++)
      files[`${ROOT}/.agents/skills/s${index}/SKILL.md`] = skillMd({ name: `s${index}`, description: "d" });
    const limits = { repoSkills: 100, rootEntries: 4, linkedEntries: 4 };
    const found = await discoverSkills(memoryFiles(files), { cwd: ROOT, root: ROOT, limits });
    expect(found.skipped).toContainEqual({
      path: `${ROOT}/.agents/skills`,
      reason: "its listing stopped at 4 entries, t3flare's fixed limit; any past them are not found",
    });
    // A listing under the limit is whole, and says nothing.
    const whole = await discoverSkills(memoryFiles(files), { cwd: ROOT, root: ROOT });
    expect(whole.skipped).toEqual([]);
  });

  it("names a listing stopped by its size or time bound, and says nothing of one exactly at the entries that ran to its end (SPI-1387)", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, at) => ({ path: `e${at}`, kind: "file" as const }));
    expect(listingStopped({ entries: entries(5000), truncated: true }, 5000)).toBe(
      "its listing stopped at 5,000 entries, t3flare's fixed limit; any past them are not found",
    );
    expect(listingStopped({ entries: entries(1200), truncated: true }, 5000)).toBe(
      "its listing stopped at 1,200 entries, at its bound of 4 MiB of names or 10 s; any past them are not found",
    );
    // Exactly the limit, and whole: not cut.
    expect(listingStopped({ entries: entries(5000), truncated: false }, 5000)).toBeUndefined();
  });
});

describe("the Environment skill set", () => {
  const environment: Skill = {
    name: "fruit",
    description: "the owner's",
    filePath: "/workspace/.t3flare/skills/fruit/SKILL.md",
    disableModelInvocation: false,
  };

  it("comes first, and beats a Repo skill of the same name, which is reported as skipped", async () => {
    const found = await at(
      ROOT,
      {
        [`${ROOT}/.agents/skills/fruit/SKILL.md`]: skillMd({ name: "fruit", description: "the fork's" }),
        [`${ROOT}/.agents/skills/veg/SKILL.md`]: skillMd({ name: "veg", description: "d" }),
      },
      [environment],
    );
    expect(found.skills.map((skill) => skill.description)).toEqual(["the owner's", "d"]);
    expect(found.skipped).toEqual([
      { path: `${ROOT}/.agents/skills/fruit/SKILL.md`, reason: `"fruit" is shadowed by ${environment.filePath}` },
    ]);
  });

  it("with a CLI's roots (SPI-1151): a cwdOnly root counts at the cwd alone, the others up to the repo root", async () => {
    const found = await discoverSkills(
      memoryFiles({
        [`${ROOT}/.pi/skills/root-pi/SKILL.md`]: skillMd({ name: "root-pi", description: "pi at the root" }),
        [`${ROOT}/.agents/skills/root-agents/SKILL.md`]: skillMd({
          name: "root-agents",
          description: "agents at the root",
        }),
        [`${ROOT}/pkg/.pi/skills/here-pi/SKILL.md`]: skillMd({ name: "here-pi", description: "pi at the cwd" }),
      }),
      {
        cwd: `${ROOT}/pkg`,
        root: ROOT,
        roots: [
          { directory: ".pi/skills", cwdOnly: true },
          { directory: ".agents/skills", cwdOnly: false },
        ],
      },
    );
    expect(found.skills.map((skill) => skill.name)).toEqual(["here-pi", "root-agents"]);
  });
});

describe("the directories above a cwd", () => {
  it("read a cwd's trailing slashes as none, and the root as /", () => {
    expect(withoutTrailingSlashes("/workspace/repo///")).toBe("/workspace/repo");
    expect(withoutTrailingSlashes("///")).toBe("/");
    expect(withoutTrailingSlashes("")).toBe("/");
    expect(directoriesUp("/workspace/repo/a/b//", "/workspace/repo")).toEqual([
      "/workspace/repo/a/b",
      "/workspace/repo/a",
      "/workspace/repo",
    ]);
  });

  it("trim a cwd with a long run of slashes inside it in linear time", () => {
    const started = performance.now();
    expect(withoutTrailingSlashes(`/workspace/repo${"/".repeat(60_000)}a`)).toHaveLength(60_016);
    expect(directoriesUp(`/workspace/repo${"/".repeat(60_000)}a/`, "/workspace/repo")).toEqual([
      "/workspace/repo/a",
      "/workspace/repo",
    ]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
