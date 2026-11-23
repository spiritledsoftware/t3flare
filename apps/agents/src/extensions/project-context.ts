// The `project_context` section (step 2a plan, section 4): the repository's `AGENTS.md` (or `CLAUDE.md`) files, from
// the repo root down to the conversation's working directory, read through the call's environment before each request.
// Part 1 keeps only the section: `read`/`edit`/`write` do not show nested files' instructions as the agent reaches
// them.
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { defaultSettings, type SettingValue } from "@t3flare/harness-registry";

export const PROJECT_CONTEXT_EXTENSION = "project-context";

/** The `project-context` extension's settings (SPI-1321). */
export interface ProjectContextLimits {
  /** The most of one AGENTS.md or CLAUDE.md the section shows. */
  readonly maxFileCharacters: number;
}

/** The `project-context` extension's resolved settings as limits. */
export const projectContextLimits = (values: Readonly<Record<string, SettingValue>>): ProjectContextLimits => ({
  maxFileCharacters: Number(values.maxFileCharacters),
});

export const DEFAULT_PROJECT_CONTEXT_LIMITS: ProjectContextLimits = projectContextLimits(
  defaultSettings(PROJECT_CONTEXT_EXTENSION),
);

const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** The directories from `root` down to `cwd` (just `root` when `cwd` is outside it). */
const chain = (root: string, cwd: string): ReadonlyArray<string> => {
  if (cwd !== root && !cwd.startsWith(`${root}/`)) return [root];
  const below = cwd.slice(root.length).split("/").filter(Boolean);
  return [root, ...below.map((_, at) => `${root}/${below.slice(0, at + 1).join("/")}`)];
};

/** The section, for a repo at `root`, within `limits`. */
export const projectContext = (
  root: string,
  limits: ProjectContextLimits = DEFAULT_PROJECT_CONTEXT_LIMITS,
): Extension => {
  const maxChars = limits.maxFileCharacters;
  return defineExtension({
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
            const read = await env.readTextFile(`${directory}/${name}`, context).catch(() => undefined);
            if (read === undefined || !read.ok) continue;
            const body = read.value.length > maxChars ? `${read.value.slice(0, maxChars)}\n… [cut]` : read.value;
            parts.push(`## ${directory}/${name}\n\n${body.trim()}`);
            break;
          }
        }
        return parts.join("\n\n");
      }),
    ],
  });
};
