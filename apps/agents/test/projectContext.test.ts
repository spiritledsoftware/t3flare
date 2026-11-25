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

  it("takes a file that fits the project files' share of the prompt's Session row, and names one that does not", async () => {
    expect(PROJECT_CONTEXT_BYTES).toBe((8_000_000 - 64 * 1024) / 2);
    // Each file's stored size is its part's JSON bytes: its heading, and its text with JSON's escapes.
    const sized = (path: string, bytes: number, character: string) => {
      const head = jsonTextBytes(`## ${path}\n\n`);
      return character.repeat(Math.floor((bytes - head) / jsonTextBytes(character)));
    };
    const path = `${ROOT}/AGENTS.md`;
    // Just under: 7-byte escapes (a control character takes six), so fewer characters fill it.
    const under = sized(path, PROJECT_CONTEXT_BYTES, "\u0001");
    expect(jsonTextBytes(`## ${path}\n\n${under}`)).toBeLessThanOrEqual(PROJECT_CONTEXT_BYTES);
    expect(await render({ [path]: `${under}` }, ROOT)).toContain(`## ${path}\n\n${under}`);
    // Just over, by one plain character: named in its place with its size, and CLAUDE.md read instead.
    const over = `${sized(path, PROJECT_CONTEXT_BYTES, "a")}aa`;
    const bytes = jsonTextBytes(`## ${path}\n\n${over}`);
    expect(bytes).toBeGreaterThan(PROJECT_CONTEXT_BYTES);
    const out = await render({ [path]: over, [`${ROOT}/CLAUDE.md`]: "small" }, ROOT);
    expect(out).toContain(leftOut(path, tooLarge(bytes, PROJECT_CONTEXT_BYTES)));
    expect(out).toContain(
      "past the 3,967,232 left of the 3,967,232 the project files may take of the prompt's one Session row, which Cloudflare refuses past 8 MB",
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
