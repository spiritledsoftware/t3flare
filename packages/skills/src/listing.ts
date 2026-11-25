// The agent's `<available_skills>` listing (SPI-1147 §2): pi's `formatSkillsForPrompt` (pi's coding agent,
// `core/skills.js`), with the skills the owner alone names (`disable-model-invocation`) left out, and one line for the
// Repo skills past the cap. The agent reads a listed `SKILL.md` with `read`; there is no skill tool.
import type { SkillDiscovery } from "./discovery.ts";

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The line for the Repo skills the cap (`repoSkills`, absent from an older Workspace) left out: by default, how many.
 * This package does not know the setting behind the cap; the agent's listing passes a line that names it.
 */
export type OmittedLine = (omitted: number, repoSkills: number | undefined) => string;

const omittedCount: OmittedLine = (omitted) => `${omitted} more skills in this repository are not listed.`;

/** The listing of `discovery`'s skills, `omittedLine` saying what the cap left out; empty when there is nothing to list. */
export const formatSkills = (
  discovery: Pick<SkillDiscovery, "skills" | "omitted" | "repoSkills">,
  omittedLine: OmittedLine = omittedCount,
): string => {
  const visible = discovery.skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
    ...(discovery.omitted > 0 ? [omittedLine(discovery.omitted, discovery.repoSkills)] : []),
  ].join("\n");
};
