// The `project_context` section (step 2a plan, section 4): the repository's `AGENTS.md` (or `CLAUDE.md`) files, from
// the repo root down to the conversation's working directory, read through the call's environment before each request.
// Part 1 keeps only the section: `read`/`edit`/`write` do not show nested files' instructions as the agent reaches
// them.
//
// Each file reaches the prompt whole (SPI-1388): t3flare cuts none. pi-durable keeps the prompt's sections as one
// `pi.system` Session row, which Cloudflare refuses past 8 MB, so the files take at most `PROJECT_CONTEXT_BYTES` of it,
// stored. A file that cannot be read, or that would take the files past that share, is named in its place with why
// (never left out silently, never cut), and the search goes on to the directory's next name, as pi's does: an
// unreadable AGENTS.md falls through to CLAUDE.md.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { jsonTextBytes, SESSION_ROW_BYTES, SESSION_ROW_ENVELOPE_BYTES } from "@t3flare/session-protocol";

export const PROJECT_CONTEXT_EXTENSION = "project-context";

const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Read failures that mean there is no such file to show: the next name, or the next directory, is tried. */
const ABSENT = new Set(["not_found", "is_directory", "not_directory"]);

/**
 * The most bytes the project files take of the `pi.system` row, stored (UTF-8 with JSON's escapes, `jsonTextBytes`).
 * A named constraint, derived from Cloudflare's 8 MB row (`SESSION_ROW_BYTES`, less its record): a baseline entry holds
 * every section and every tool declaration together, so the files take half, as a tool result's text does
 * (`MAX_TOOL_OUTPUT_KIB`), and the rest of the prompt the other half.
 */
export const PROJECT_CONTEXT_BYTES = Math.floor((SESSION_ROW_BYTES - SESSION_ROW_ENVELOPE_BYTES) / 2);

/** The directories from `root` down to `cwd` (just `root` when `cwd` is outside it). */
const chain = (root: string, cwd: string): ReadonlyArray<string> => {
  if (cwd !== root && !cwd.startsWith(`${root}/`)) return [root];
  const below = cwd.slice(root.length).split("/").filter(Boolean);
  return [root, ...below.map((_, at) => `${root}/${below.slice(0, at + 1).join("/")}`)];
};

/** What the section says in place of a file it left out: the file, why, and that its instructions are missing. */
export const leftOut = (path: string, why: string): string =>
  `## ${path}\n\n[t3flare could not put this file in the prompt (${why}), so its instructions are missing from it. Tell the owner.]`;

/** Why a file that read was left out: its stored size, past what the files may take of the prompt's Session row. */
export const tooLarge = (bytes: number, room: number): string =>
  `it takes ${bytes.toLocaleString("en-US")} bytes stored, past the ${room.toLocaleString("en-US")} left of the ${PROJECT_CONTEXT_BYTES.toLocaleString("en-US")} the project files may take of the prompt's one Session row, which Cloudflare refuses past 8 MB`;

/** The section, for a repo at `root`. */
export const projectContext = (root: string): Extension =>
  defineExtension({
    name: PROJECT_CONTEXT_EXTENSION,
    sections: [
      section("project_context", async (input, context) => {
        const env = input.env;
        if (env === undefined) return undefined;
        const parts: Array<string> = [
          `You work in a git repository at ${root}, the owner's project. Its files are yours to read and change; the owner reviews your changes as a diff.`,
        ];
        let used = 0;
        for (const directory of chain(root, env.cwd)) {
          for (const name of NAMES) {
            const path = `${directory}/${name}`;
            const read = await env
              .readTextFile(path, context)
              .catch((error: unknown) => ({ ok: false as const, error: { code: "unknown", message: String(error) } }));
            if (!read.ok) {
              if (!ABSENT.has(read.error.code)) parts.push(leftOut(path, read.error.message));
              continue;
            }
            const part = `## ${path}\n\n${read.value.trim()}`;
            const bytes = jsonTextBytes(part);
            if (used + bytes > PROJECT_CONTEXT_BYTES) {
              parts.push(leftOut(path, tooLarge(bytes, PROJECT_CONTEXT_BYTES - used)));
              continue;
            }
            used += bytes;
            parts.push(part);
            break;
          }
        }
        return parts.join("\n\n");
      }),
    ],
  });
