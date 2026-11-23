// The CLI agents' dotfiles (ADR-0047 §9, SPI-1331): with the Environment's `agentsReadDotfiles`, each CLI's fresh home
// is first filled from the Owner's own config in /root (the launch's `seed`), then t3flare's files go over it. What the
// launcher does with a seed is `processWrapper.test.ts`'s; here, what each profile asks for.
import { describe, expect, it } from "vitest";

import {
  CODEX_SESSIONS,
  type Launch,
  type LaunchAnswer,
  type ProfileContext,
  profileLaunch,
} from "../src/agents/cliProfiles.ts";

const EXTENSION = "export default function (pi) {}\n";
const STATE_EXTENSION = "/t3/state/cache/pi-t3-mcp-extension.ts";
const SCHEMA = "/t3/state/schema.json";
const model = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
  contextWindow: 100_000,
  maxTokens: 8000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  known: false,
});

const context = (dotfiles: boolean | undefined): ProfileContext => ({
  readStateFile: (path) => (path === STATE_EXTENSION ? EXTENSION : path === SCHEMA ? "{}" : undefined),
  piExtensionSource: EXTENSION,
  endpoints: [{ id: "openai", label: "OpenAI", models: [model("gpt-5-mini")] }],
  piRelay: {
    endpoints: [{ id: "comm", label: "Commissary", api: "anthropic-messages", models: [model("claude-haiku-5-5")] }],
    model: "comm/claude-haiku-5-5",
  },
  claudeRelay: {
    endpoints: ["comm"],
    models: ["comm/claude-haiku-5-5"],
    backgroundModel: "comm/claude-haiku-5-5",
    opusModel: "comm/claude-haiku-5-5",
    sonnetModel: "comm/claude-haiku-5-5",
  },
  opencodeRelay: {
    endpoints: [{ id: "comm", label: "Commissary", api: "anthropic-messages", models: [model("claude-haiku-5-5")] }],
    model: "comm/claude-haiku-5-5",
    smallModel: undefined,
  },
  ...(dotfiles === undefined ? {} : { dotfiles }),
});

const ARGS = {
  codex: ["app-server"],
  "codex exec": [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--model",
    "gpt-5-mini",
    "--output-schema",
    SCHEMA,
    "-",
  ],
  pi: ["--mode", "rpc", "--extension", STATE_EXTENSION],
  claude: [],
  opencode: ["acp"],
} as const;

const launched = (answer: LaunchAnswer): Launch => {
  if ("refused" in answer) throw new Error(answer.refused);
  return answer;
};

const launch = (cli: keyof typeof ARGS, dotfiles: boolean | undefined) =>
  launched(
    profileLaunch(
      {
        cli: cli === "codex exec" ? "codex" : cli,
        args: ARGS[cli],
        key: "proc-1",
        cwd: "/w/demo",
        env: {},
        allowProbe: false,
      },
      context(dotfiles),
    ),
  );

const HOME = "/var/lib/t3flare/cli/proc-1";

describe("the CLI agents' dotfiles", () => {
  it("seed nothing when the Environment turns them off; absent is on, the setting's default", () => {
    for (const cli of Object.keys(ARGS) as ReadonlyArray<keyof typeof ARGS>) {
      expect(launch(cli, false).seed).toBeUndefined();
      expect(launch(cli, false).check).toBeUndefined();
      expect(launch(cli, undefined).seed).toEqual(launch(cli, true).seed);
    }
  });

  it("give Claude Code ~/.claude (but its synced projects) and ~/.claude.json in its config directory, the Environment skills merged over the Owner's", () => {
    const answer = launch("claude", true);
    expect(answer.env.CLAUDE_CONFIG_DIR).toBe(`${HOME}/claude`);
    expect(answer.seed).toEqual([
      { from: "/root/.claude", to: `${HOME}/claude`, skip: ["projects"] },
      { from: "/root/.claude.json", to: `${HOME}/claude/.claude.json` },
    ]);
    expect(answer.links).toContainEqual({
      path: `${HOME}/claude/skills`,
      target: "/workspace/.agents/skills",
      merge: true,
    });
    // The managed settings stay outside the seeded directory: the launcher installs them at /etc/claude-code, on top.
    expect(answer.files?.map((file) => file.path)).toEqual([`${HOME}/managed-settings.json`]);
    expect(answer.check).toBeUndefined();
  });

  it("give Codex ~/.codex (but its synced sessions), and keep the Owner's config.toml: t3flare's keys are its -c overrides, which win", () => {
    for (const cli of ["codex", "codex exec"] as const) {
      const answer = launch(cli, true);
      expect(answer.seed).toEqual([{ from: "/root/.codex", to: `${HOME}/codex`, skip: ["sessions"] }]);
      expect(answer.files?.find((file) => file.path === `${HOME}/codex/config.toml`)).toMatchObject({ keep: true });
      // A config.toml Codex cannot load stops it at start: the launcher checks the copy first and names it.
      // The check loads it under the launch's own -c overrides, as the launch will.
      const overrides = answer.argv.filter((_, at) => answer.argv[at - 1] === "-c");
      expect(overrides.length).toBeGreaterThan(5);
      expect(answer.check).toEqual({
        when: "/root/.codex/config.toml",
        argv: ["/opt/t3flare/bin/codex", ...overrides.flatMap((value) => ["-c", value]), "features", "list"],
        failure: expect.stringContaining(
          `Codex cannot load ${HOME}/codex/config.toml, the copy of your ~/.codex/config.toml`,
        ),
      });
      expect(answer.check?.failure).toContain("turn the setting off");
      // Codex filters by include_only after its `set`: an Owner's would drop the kill script's marker.
      expect(answer.argv).toContain("shell_environment_policy.include_only=[]");
      // An Owner's `inherit = "core"` or `"none"` would drop COMMAND_ENV's MISE_* (and mise) from Codex's shells.
      expect(answer.argv).toContain('shell_environment_policy.inherit="all"');
    }
    expect(launch("codex", true).links).toContainEqual({ path: `${HOME}/codex/sessions`, target: CODEX_SESSIONS });
    // Off, t3flare's placeholder is written as before.
    expect(
      launch("codex", false).files?.find((file) => file.path === `${HOME}/codex/config.toml`)?.keep,
    ).toBeUndefined();
  });

  it("give OpenCode ~/.config/opencode in its XDG config directory, under its system configuration, the Environment skills merged", () => {
    const answer = launch("opencode", true);
    expect(answer.env.XDG_CONFIG_HOME).toBe(`${HOME}/config`);
    expect(answer.seed).toEqual([{ from: "/root/.config/opencode", to: `${HOME}/config/opencode` }]);
    expect(answer.links).toContainEqual({
      path: `${HOME}/config/opencode/skills`,
      target: "/workspace/.agents/skills",
      merge: true,
    });
    expect(answer.files?.map((file) => file.path)).toEqual([`${HOME}/opencode.json`]);
  });

  it("give pi its user directory ~/.pi/agent (but its sessions) in its agent directory, t3flare's models.json and settings.json over it", () => {
    const answer = launch("pi", true);
    expect(answer.env.PI_CODING_AGENT_DIR).toBe(`${HOME}/agent`);
    // Not its auth.json: pi's credentials stay t3flare's (ADR-0016).
    // pi reads skills/ there before its --skill paths and keeps the first of a name: an Owner's Skill named as an
    // Environment skill is left out of the copy, so the Environment skill wins.
    expect(answer.seed).toEqual([
      {
        from: "/root/.pi/agent",
        to: `${HOME}/agent`,
        skip: ["sessions", "auth.json"],
        shadow: { dir: "skills", by: "/workspace/.agents/skills" },
      },
    ]);
    expect(answer.argv.slice(answer.argv.indexOf("--skill"), answer.argv.indexOf("--skill") + 2)).toEqual([
      "--skill",
      "/workspace/.agents/skills",
    ]);
    expect(
      answer.files?.filter((file) => file.path.startsWith(`${HOME}/agent/`)).map((file) => [file.path, file.keep]),
    ).toEqual([
      [`${HOME}/agent/models.json`, undefined],
      [`${HOME}/agent/settings.json`, undefined],
    ]);
  });
});
