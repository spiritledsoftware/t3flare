// @effect-diagnostics globalConsole:off
// The Workspace DO's side of Repo skills and Prompt templates (SPI-1147 §1): discovery run next to its own files, so a
// request is one RPC and never starts the Container (ADR-0009). The Environment skill set is SPI-1148's; until then it
// is empty.
import type { ReadEnv } from "@t3flare/computer-env";
import {
  CLI_ROOTS,
  DIRECTORY_LISTING_ENTRIES,
  type CliAgent,
  discoverPrompts,
  discoverSkills,
  type PromptTemplate,
  type Skill,
  type SkillDiscovery,
  type SkillFiles,
  type SkillLimits,
} from "@t3flare/skills";
import type { ResolvedEnvironment } from "@t3flare/harness-registry";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * How far discovery reads, as the Environment settings give it (SPI-1365): the Repo skills listed; each directory's
 * listing is `DIRECTORY_LISTING_ENTRIES` (SPI-1387).
 */
export type DiscoveryLimits = Pick<ResolvedEnvironment, "repoSkillsListed">;

const skillLimitsOf = (limits: DiscoveryLimits): SkillLimits => ({
  repoSkills: limits.repoSkillsListed,
  rootEntries: DIRECTORY_LISTING_ENTRIES,
  linkedEntries: DIRECTORY_LISTING_ENTRIES,
});

/** `env`'s file reads as discovery takes them: hidden names listed, git's ignore rules not applied, `node_modules` not walked. */
export const skillFilesOf = (env: ReadEnv): SkillFiles => ({
  list: async (directory, maxEntries) => {
    if (env.listFiles === undefined) return { entries: [], truncated: false };
    const listing = await env.listFiles(
      directory,
      { hidden: true, gitignore: false, exclude: ["node_modules"], maxEntries },
      BACKGROUND_CONTEXT,
    );
    // `truncated`: the listing stopped at `maxEntries` or its own size or time bound (SPI-1387).
    if (listing.ok) return { entries: listing.value.entries, truncated: listing.value.truncated };
    if (listing.error.code === "not_found" || listing.error.code === "not_directory")
      return { entries: [], truncated: false };
    throw new Error(`Cannot list skills in ${directory}: ${listing.error.message}`);
  },
  read: async (path) => {
    const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
    return read.ok ? read.value : undefined;
  },
});

/**
 * The Skills of a thread in `env`'s cwd, logging one line when any was skipped. With `agent` (a CLI agent's, SPI-1151):
 * that CLI's roots (`CLI_ROOTS`).
 */
export const workspaceSkills = async (
  env: ReadEnv,
  root: string,
  environment: ReadonlyArray<Skill>,
  limits: DiscoveryLimits,
  agent?: CliAgent,
): Promise<SkillDiscovery> => {
  const found = await discoverSkills(skillFilesOf(env), {
    cwd: env.cwd,
    root,
    environment,
    roots: agent === undefined ? undefined : CLI_ROOTS[agent].skills,
    limits: skillLimitsOf(limits),
  });
  if (found.skipped.length > 0) {
    console.log(
      JSON.stringify({
        t3flare: "skills",
        cwd: env.cwd,
        skills: found.skills.length,
        omitted: found.omitted,
        skipped: found.skipped,
        skippedCount: found.skipped.length,
      }),
    );
  }
  return found;
};

/**
 * The Prompt templates of a thread in `env`'s cwd; with `agent`, that CLI's repo commands (SPI-1151). A directory whose
 * listing reached `DIRECTORY_LISTING_ENTRIES` is logged with the limit (SPI-1387).
 */
export const workspacePrompts = (env: ReadEnv, agent?: CliAgent): Promise<ReadonlyArray<PromptTemplate>> =>
  discoverPrompts(
    skillFilesOf(env),
    env.cwd,
    agent === undefined ? undefined : CLI_ROOTS[agent].commands,
    DIRECTORY_LISTING_ENTRIES,
    (directory, reason) =>
      console.log(JSON.stringify({ t3flare: "prompts", cwd: env.cwd, skipped: [{ path: directory, reason }] })),
  );
