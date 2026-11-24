// The `skills` extension (SPI-1147 §2): the section's text from the Workspace's discovery, empty frozen as empty, and
// a failed discovery leaves the section out rather than failing the request.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WireSkillDiscovery } from "@t3flare/computer-env";
import { EMPTY_ENVIRONMENT, resolveEnvironment } from "@t3flare/harness-registry";
import { DEFAULT_SKILL_LIMITS, DIRECTORY_LISTING_ENTRIES } from "@t3flare/skills";
import { afterEach, describe, expect, it, vi } from "vitest";

import { skillsExtension, skillsSectionText } from "../src/extensions/skills.ts";
import { skillFilesOf, workspaceSkills } from "../src/workspace/skills.ts";

/** The Environment settings' defaults: how far discovery reads before any change. */
const DEFAULTS = resolveEnvironment(EMPTY_ENVIRONMENT);

const workspace = (answer: WireSkillDiscovery) =>
  ({ cwd: "/workspace/repo", discoverSkills: () => Promise.resolve(answer) }) as never;
const fruit = {
  name: "fruit-code",
  description: "The fruit code.",
  filePath: "/workspace/repo/.agents/skills/fruit-code/SKILL.md",
  disableModelInvocation: false,
};

describe("the skills section", () => {
  it("lists the Workspace's skills in a <skills> block", async () => {
    const text = await skillsSectionText(
      workspace({
        skills: [fruit, { ...fruit, name: "owner-only", disableModelInvocation: true }],
        skipped: [],
        omitted: 0,
      }),
    );
    expect(text).toMatch(/^<skills>\nThe following skills/);
    expect(text).toContain("<location>/workspace/repo/.agents/skills/fruit-code/SKILL.md</location>");
    expect(text).not.toContain("owner-only");
    expect(text).toMatch(/<\/available_skills>\n<\/skills>$/);
  });

  it("is empty, a text that freezes, when nothing is listed; absent without a Workspace", async () => {
    expect(await skillsSectionText(workspace({ skills: [], skipped: [], omitted: 0 }))).toBe("");
    expect(await skillsSectionText(undefined)).toBeUndefined();
    expect(await skillsSectionText({ cwd: "/" } as never)).toBeUndefined();
  });

  it("leaves itself out, logging why, when the Workspace's discovery fails, rather than failing the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const section = skillsExtension().sections?.[0];
    const failing = {
      cwd: "/workspace/repo",
      discoverSkills: () => Promise.reject(new Error("the Workspace DO is gone")),
    };
    expect(await section?.render({ env: failing, shown: {} } as never, BACKGROUND_CONTEXT)).toBeUndefined();
    expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { t3flare: "skills-section-failed", error: "Error: the Workspace DO is gone" },
    ]);
    warn.mockRestore();
  });
});

describe("the Workspace DO's discovery log", () => {
  const ROOT = "/workspace/repo";
  /** A `ReadEnv` over `files` (absolute path to text), listing every file below a directory. */
  const readEnv = (files: Record<string, string>) =>
    ({
      cwd: ROOT,
      listFiles: (directory: string) => {
        const entries = Object.keys(files)
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => ({ path: path.slice(directory.length + 1), kind: "file" as const }));
        return Promise.resolve(
          entries.length === 0
            ? { ok: false, error: { code: "not_found", message: "absent" } }
            : { ok: true, value: { entries, truncated: false } },
        );
      },
      readTextFile: (path: string) =>
        Promise.resolve(
          path in files
            ? { ok: true, value: files[path] }
            : { ok: false, error: { code: "not_found", message: "absent" } },
        ),
    }) as never;
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;
  const lines = () =>
    vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('"t3flare":"skills"'));

  afterEach(() => vi.restoreAllMocks());

  it("passes a listing's own truncation through, so a listing stopped by its size or time bound is named (SPI-1387)", async () => {
    const env = (truncated: boolean) =>
      ({
        cwd: ROOT,
        listFiles: () =>
          Promise.resolve({ ok: true, value: { entries: [{ path: "a/SKILL.md", kind: "file" }], truncated } }),
        readTextFile: () => Promise.resolve({ ok: true, value: skill("a", "one") }),
      }) as never;
    expect(await skillFilesOf(env(true)).list(`${ROOT}/.agents/skills`, 5000)).toMatchObject({ truncated: true });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cut = await workspaceSkills(env(true), ROOT, [], DEFAULTS);
    expect(cut.skipped).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("at its bound of 4 MiB of names or 10 s") }),
    );
    const whole = await workspaceSkills(env(false), ROOT, [], DEFAULTS);
    expect(whole.skipped.filter((skipped) => skipped.reason.includes("listing stopped"))).toEqual([]);
  });

  it("writes one skills line when anything was skipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const found = await workspaceSkills(
      readEnv({
        [`${ROOT}/.agents/skills/a/SKILL.md`]: skill("a", "first"),
        [`${ROOT}/.claude/skills/a/SKILL.md`]: skill("a", "loses"),
        [`${ROOT}/.claude/skills/b/SKILL.md`]: "no frontmatter",
      }),
      ROOT,
      [],
      DEFAULTS,
    );
    expect(found.skipped).toHaveLength(2);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!)).toMatchObject({
      t3flare: "skills",
      cwd: ROOT,
      skills: 1,
      omitted: 0,
      skippedCount: 2,
    });
  });

  it("writes none when nothing was skipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await workspaceSkills(readEnv({ [`${ROOT}/.agents/skills/a/SKILL.md`]: skill("a", "only") }), ROOT, [], DEFAULTS);
    expect(lines()).toEqual([]);
  });

  it("lists as many Repo skills as the Environment setting says (SPI-1365), and counts the rest", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, at) => [`${ROOT}/.agents/skills/s${at}/SKILL.md`, skill(`s${at}`, "one")]),
    );
    const found = await workspaceSkills(readEnv(files), ROOT, [], { ...DEFAULTS, repoSkillsListed: 3 });
    expect({ listed: found.skills.length, omitted: found.omitted }).toEqual({ listed: 3, omitted: 2 });
  });

  it("keeps packages/skills' defaults in step with the setting's default and the listing constant (SPI-1387)", () => {
    expect(DIRECTORY_LISTING_ENTRIES).toBe(5000);
    expect(DEFAULT_SKILL_LIMITS).toEqual({
      repoSkills: DEFAULTS.repoSkillsListed,
      rootEntries: DIRECTORY_LISTING_ENTRIES,
      linkedEntries: DIRECTORY_LISTING_ENTRIES,
    });
  });
});
