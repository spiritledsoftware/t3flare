// The `project_context` section (step 2a plan, section 4): the repository's `AGENTS.md` (or `CLAUDE.md`) files, from
// the repo root down to the conversation's working directory, read through the call's environment before each request.
// Part 1 keeps only the section: `read`/`edit`/`write` do not show nested files' instructions as the agent reaches
// them.
//
// Each file reaches the prompt whole (SPI-1388): t3flare cuts none. A file that exists but cannot be read (one past the
// Workspace's 32 MiB RPC message, or any other failure) is named in its place with why, never left out silently; one
// that reads but makes the prompt larger than the model's context is refused by the endpoint, and the turn fails with
// its error.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const PROJECT_CONTEXT_EXTENSION = "project-context";

const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Read failures that mean there is no such file to show: the next name, or the next directory, is tried. */
const ABSENT = new Set(["not_found", "is_directory", "not_directory"]);

/** The directories from `root` down to `cwd` (just `root` when `cwd` is outside it). */
const chain = (root: string, cwd: string): ReadonlyArray<string> => {
  if (cwd !== root && !cwd.startsWith(`${root}/`)) return [root];
  const below = cwd.slice(root.length).split("/").filter(Boolean);
  return [root, ...below.map((_, at) => `${root}/${below.slice(0, at + 1).join("/")}`)];
};

/** What the section says in place of a file it could not read: the file, why, and that its instructions are missing. */
export const unreadable = (path: string, why: string): string =>
  `## ${path}\n\n[t3flare could not read this file (${why}), so its instructions are missing from this prompt. Tell the owner.]`;

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
        for (const directory of chain(root, env.cwd)) {
          for (const name of NAMES) {
            const path = `${directory}/${name}`;
            const read = await env
              .readTextFile(path, context)
              .catch((error: unknown) => ({ ok: false as const, error: { code: "unknown", message: String(error) } }));
            if (read.ok) {
              parts.push(`## ${path}\n\n${read.value.trim()}`);
              break;
            }
            if (ABSENT.has(read.error.code)) continue;
            parts.push(unreadable(path, read.error.message));
            break;
          }
        }
        return parts.join("\n\n");
      }),
    ],
  });
