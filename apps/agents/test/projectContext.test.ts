// The `project_context` section (SPI-1321, SPI-1388) over a fake environment: each AGENTS.md or CLAUDE.md from the repo
// root down to the working directory, each whole; a file that exists but cannot be read is named in its place.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";

import { projectContext, unreadable } from "../src/extensions/project-context.ts";

const ROOT = "/workspace/repo";

/** The section as `projectContext(ROOT)` renders it for an environment holding `files`, failing reads in `failing`. */
const render = async (
  files: Readonly<Record<string, string>>,
  cwd: string,
  failing: Readonly<Record<string, { readonly code: string; readonly message: string } | Error>> = {},
) => {
  const section = projectContext(ROOT).sections?.[0];
  if (section === undefined) throw new Error("no section");
  const env = {
    cwd,
    readTextFile: async (path: string) => {
      const failure = failing[path];
      if (failure instanceof Error) throw failure;
      if (failure !== undefined) return { ok: false, error: failure };
      return path in files
        ? { ok: true, value: files[path] }
        : { ok: false, error: { code: "not_found", message: "" } };
    },
  };
  // SAFETY: the section reads only `input.env`'s `cwd` and `readTextFile`.
  return String(await section.render({ env } as never, BACKGROUND_CONTEXT));
};

describe("project_context (SPI-1321, SPI-1388)", () => {
  it("shows a long AGENTS.md whole: no limit of t3flare's cuts it", async () => {
    const body = `${"a".repeat(1_000_000)}END`;
    const out = await render({ [`${ROOT}/AGENTS.md`]: body }, ROOT);
    expect(out).toContain(`## ${ROOT}/AGENTS.md\n\n${body}`);
    expect(out).not.toContain("[cut]");
  });

  it("shows each directory's file down to the working directory", async () => {
    const out = await render(
      { [`${ROOT}/AGENTS.md`]: "b".repeat(100), [`${ROOT}/pkg/CLAUDE.md`]: "nested" },
      `${ROOT}/pkg/src`,
    );
    expect(out).toContain(`## ${ROOT}/AGENTS.md\n\n${"b".repeat(100)}`);
    expect(out).toContain(`## ${ROOT}/pkg/CLAUDE.md\n\nnested`);
  });

  it("names a file it cannot read in its place, never leaving it out silently", async () => {
    const out = await render({ [`${ROOT}/CLAUDE.md`]: "fallback" }, `${ROOT}/pkg`, {
      [`${ROOT}/AGENTS.md`]: { code: "unknown", message: "the read is larger than 32 MiB" },
      [`${ROOT}/pkg/AGENTS.md`]: new Error("RPC failed"),
    });
    expect(out).toContain(unreadable(`${ROOT}/AGENTS.md`, "the read is larger than 32 MiB"));
    expect(out).toContain(
      `## ${ROOT}/AGENTS.md\n\n[t3flare could not read this file (the read is larger than 32 MiB), so its instructions are missing from this prompt. Tell the owner.]`,
    );
    // An unreadable AGENTS.md is the directory's file: its CLAUDE.md does not stand in for it.
    expect(out).not.toContain("fallback");
    expect(out).toContain(unreadable(`${ROOT}/pkg/AGENTS.md`, "Error: RPC failed"));
  });

  it("skips a name that is absent or a directory, as before", async () => {
    const out = await render({ [`${ROOT}/CLAUDE.md`]: "claude" }, ROOT, {
      [`${ROOT}/AGENTS.md`]: { code: "is_directory", message: "a directory" },
    });
    expect(out).toContain(`## ${ROOT}/CLAUDE.md\n\nclaude`);
    expect(out).not.toContain("could not read");
  });
});
