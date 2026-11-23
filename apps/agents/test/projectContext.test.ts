// The `project_context` section (SPI-1321) over a fake environment: each AGENTS.md or CLAUDE.md from the repo root
// down to the working directory, a longer one cut at the `maxFileCharacters` setting.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROJECT_CONTEXT_LIMITS, projectContext } from "../src/extensions/project-context.ts";

const ROOT = "/workspace/repo";

/** The section as `projectContext(ROOT, maxChars)` renders it for an environment holding `files`. */
const render = async (files: Readonly<Record<string, string>>, cwd: string, maxChars?: number) => {
  const section = projectContext(ROOT, maxChars === undefined ? undefined : { maxFileCharacters: maxChars })
    .sections?.[0];
  if (section === undefined) throw new Error("no section");
  const env = {
    cwd,
    readTextFile: async (path: string) =>
      path in files ? { ok: true, value: files[path] } : { ok: false, error: { code: "not_found" } },
  };
  // SAFETY: the section reads only `input.env`'s `cwd` and `readTextFile`.
  return String(await section.render({ env } as never, BACKGROUND_CONTEXT));
};

describe("project_context (SPI-1321)", () => {
  it("cuts a longer AGENTS.md at maxFileCharacters", async () => {
    const out = await render({ [`${ROOT}/AGENTS.md`]: "a".repeat(150) }, ROOT, 100);
    expect(out).toContain(`## ${ROOT}/AGENTS.md\n\n${"a".repeat(100)}\n… [cut]`);
    expect(out).not.toContain("a".repeat(101));
  });

  it("shows a file at the limit whole, and each directory's file down to the working directory", async () => {
    const out = await render(
      { [`${ROOT}/AGENTS.md`]: "b".repeat(100), [`${ROOT}/pkg/CLAUDE.md`]: "nested" },
      `${ROOT}/pkg/src`,
      100,
    );
    expect(out).toContain(`## ${ROOT}/AGENTS.md\n\n${"b".repeat(100)}`);
    expect(out).not.toContain("[cut]");
    expect(out).toContain(`## ${ROOT}/pkg/CLAUDE.md\n\nnested`);
  });

  it("defaults to the registry's 16,000 characters", async () => {
    expect(DEFAULT_PROJECT_CONTEXT_LIMITS).toEqual({ maxFileCharacters: 16_000 });
    const out = await render({ [`${ROOT}/AGENTS.md`]: "c".repeat(16_001) }, ROOT);
    expect(out).toContain(`${"c".repeat(16_000)}\n… [cut]`);
  });
});
