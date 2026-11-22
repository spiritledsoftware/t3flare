// The CLI agents' dotfiles (ADR-0047 §9, SPI-1331): with the Environment's `agentsReadDotfiles` (on by default), each CLI
// process's fresh home is first filled from the Owner's own config for that CLI in their home, where their dotfiles put
// it; the profile's files and links then go over it, so t3flare's model routing and managed settings stay on top. Pure.
import { OWNER_HOME } from "@t3flare/sandbox-image/env";
import type { ProcessCheck, ProcessSeed } from "@t3flare/sandbox-image/process";
import { SKILLS_MOUNT } from "@t3flare/skills";

export type DotfilesCli = "claude" | "codex" | "opencode" | "pi";

/** The setting's title, as the page shows it: a check's note names it. */
const SETTING = `the Environment setting "CLI agents read your dotfiles"`;

/** What each CLI copies from the Owner's home into its own (`home` is the process's), its synced sessions skipped. */
export const dotfilesSeed = (cli: DotfilesCli, home: string): ReadonlyArray<ProcessSeed> => {
  switch (cli) {
    case "claude":
      // `CLAUDE_CONFIG_DIR`: settings, CLAUDE.md, hooks, agents, commands, skills and plugins; and the user config, which
      // Claude Code reads from that directory when it is set. Its projects are the synced ones (`CLAUDE_PROJECTS`).
      return [
        { from: `${OWNER_HOME}/.claude`, to: `${home}/claude`, skip: ["projects"] },
        { from: `${OWNER_HOME}/.claude.json`, to: `${home}/claude/.claude.json` },
      ];
    case "codex":
      // `CODEX_HOME`; its sessions are the synced ones (`CODEX_SESSIONS`).
      return [{ from: `${OWNER_HOME}/.codex`, to: `${home}/codex`, skip: ["sessions"] }];
    case "opencode":
      // Its config under `XDG_CONFIG_HOME`; its system configuration (/etc/opencode) outranks it.
      return [{ from: `${OWNER_HOME}/.config/opencode`, to: `${home}/config/opencode` }];
    case "pi":
      // Its user directory (`PI_CODING_AGENT_DIR`), extensions included (the Owner's choice); its sessions are the synced
      // ones (`PI_SESSIONS`). Not `auth.json`: pi's credentials are t3flare's, its models the relay's (ADR-0016). pi reads
      // `skills/` there before its `--skill` paths and keeps the first Skill of a name, so an Owner's Skill named as an
      // Environment skill is left out of the copy: the Environment skill, from its flag, wins.
      return [{ from: `${OWNER_HOME}/.pi/agent`, to: `${home}/agent`, skip: ["sessions", "auth.json"], shadow: { dir: "skills", by: SKILLS_MOUNT } }];
  }
};

/** The image's Codex and the launch's `-c` overrides, for its check. */
export interface CodexCheckOf {
  readonly bin: string;
  readonly overrides: ReadonlyArray<string>;
}

/**
 * Codex's check of the Owner's `config.toml`: Codex refuses to start on one it cannot load (bad TOML, or a `profile`
 * key, which 0.167 no longer takes), with nothing naming the copy. `codex features list` loads it, under the launch's
 * own `-c` overrides (the file is judged as the launch will read it), and exits.
 */
const codexCheck = (home: string, codex: CodexCheckOf): ProcessCheck => ({
  when: `${OWNER_HOME}/.codex/config.toml`,
  argv: [codex.bin, ...codex.overrides.flatMap((value) => ["-c", value]), "features", "list"],
  failure: `Codex cannot load ${home}/codex/config.toml, the copy of your ~/.codex/config.toml made because ${SETTING} is on. Fix that file, or turn the setting off to skip it.`,
});

/**
 * The launch's part for the dotfiles: the seed, and Codex's check, when the Environment says so (`dotfiles` absent: on,
 * the setting's default). `codex`: the image's Codex and the launch's overrides, for its check.
 */
export const dotfilesLaunch = (
  cli: DotfilesCli,
  home: string,
  dotfiles: boolean | undefined,
  codex?: CodexCheckOf,
): { readonly seed?: ReadonlyArray<ProcessSeed>; readonly check?: ProcessCheck } => {
  if (dotfiles === false) return {};
  return { seed: dotfilesSeed(cli, home), ...(cli === "codex" && codex !== undefined ? { check: codexCheck(home, codex) } : {}) };
};

/** Whether the dotfiles are on for a launch: absent is the setting's default, on. */
export const dotfilesOn = (dotfiles: boolean | undefined): boolean => dotfiles !== false;
