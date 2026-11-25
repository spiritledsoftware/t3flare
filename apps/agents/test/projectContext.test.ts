// The `project_context` section (SPI-1321, SPI-1388) over a fake environment: each AGENTS.md or CLAUDE.md from the repo
// root down to the working directory, each whole; a file that cannot be read, or would not fit the prompt's Session row,
// is named in its place, and the search goes on to CLAUDE.md as pi's does.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";

import { jsonTextBytes } from "@t3flare/session-protocol";

import { leftOut, PROJECT_CONTEXT_BYTES, projectContext, tooLarge } from "../src/extensions/project-context.ts";

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

  it("names a file it cannot read in its place, and goes on to CLAUDE.md, as pi does", async () => {
    const out = await render({ [`${ROOT}/CLAUDE.md`]: "fallback" }, `${ROOT}/pkg`, {
      [`${ROOT}/AGENTS.md`]: { code: "unknown", message: "the read is larger than 32 MiB" },
      [`${ROOT}/pkg/AGENTS.md`]: new Error("RPC failed"),
    });
    expect(out).toContain(
      `## ${ROOT}/AGENTS.md\n\n[t3flare could not put this file in the prompt (the read is larger than 32 MiB), so its instructions are missing from it. Tell the owner.]`,
    );
    expect(out).toContain(`## ${ROOT}/CLAUDE.md\n\nfallback`);
    expect(out).toContain(leftOut(`${ROOT}/pkg/AGENTS.md`, "Error: RPC failed"));
  });

  it("takes a file while the whole section fits its share of the prompt's Session row, and names one that does not", async () => {
    expect(PROJECT_CONTEXT_BYTES).toBe((8_000_000 - 64 * 1024) / 2);
    // The section's stored size counts its opening line, each file's part with the join before it, and any notes.
    const opening = await render({}, ROOT);
    const room = PROJECT_CONTEXT_BYTES - jsonTextBytes(opening);
    const path = `${ROOT}/AGENTS.md`;
    const partBytes = (text: string) => jsonTextBytes(`\n\n## ${path}\n\n${text}`);
    const filling = (character: string) =>
      character.repeat(Math.floor((room - partBytes("")) / jsonTextBytes(character)));
    // Just under: 6-byte escapes (a control character), so fewer characters fill it.
    const under = filling("\u0001");
    const whole = await render({ [path]: under }, ROOT);
    expect(whole).toContain(`## ${path}\n\n${under}`);
    expect(jsonTextBytes(whole)).toBeLessThanOrEqual(PROJECT_CONTEXT_BYTES);
    // Just over, by one plain character: named in its place with its size, and CLAUDE.md read instead.
    const over = `${filling("a")}a`;
    const bytes = partBytes(over);
    expect(bytes).toBe(room + 1);
    const out = await render({ [path]: over, [`${ROOT}/CLAUDE.md`]: "small" }, ROOT);
    expect(out).toContain(leftOut(path, tooLarge(bytes, room)));
    expect(out).toContain(
      `past the ${room.toLocaleString("en-US")} left of the 3,967,232 the project files may take of the prompt's one Session row, which Cloudflare refuses past 8 MB`,
    );
    expect(out).not.toContain(over);
    expect(out).toContain(`## ${ROOT}/CLAUDE.md\n\nsmall`);
  });

  it("skips a name that is absent or a directory, as before", async () => {
    const out = await render({ [`${ROOT}/CLAUDE.md`]: "claude" }, ROOT, {
      [`${ROOT}/AGENTS.md`]: { code: "is_directory", message: "a directory" },
    });
    expect(out).toContain(`## ${ROOT}/CLAUDE.md\n\nclaude`);
    expect(out).not.toContain("could not read");
  });
});
