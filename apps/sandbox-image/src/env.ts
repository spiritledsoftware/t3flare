// What the Workspace DO gives each Container command; no Node imports, so the agents Worker can import it.
import { DESKTOP_ENV } from "./desktop.ts";

/**
 * The directory of the image's own files that commands read. Its earlier path, which the image keeps a copy at for one
 * release (`image/Dockerfile`): on a Container started on the previous image, `/usr/local/share/t3flare` lacks
 * `mise.toml` and `command.bash`. Moves to `/usr/local/share/t3flare` once every Container runs the new image.
 */
export const IMAGE_SHARE = "/usr/local/share/cloudpid";

/** The image's base mise config: the Toolchains it preinstalls (`image/mise.toml`). mise's system config. */
export const BASE_MISE_CONFIG = `${IMAGE_SHARE}/mise.toml`;

/** Where the Global mise config's lay-down keeps its files: the Container's own disk, outside `/workspace` (SPI-1150). */
export const GLOBAL_MISE_DIR = "/var/lib/t3flare/mise";

/** Where the Container setup's wrapper keeps the script, its output and its answer: the Container's own disk (ADR-0047 §7). */
export const CONTAINER_SETUP_DIR = "/var/lib/t3flare/container-setup";

/**
 * mise's global config: the owner's Global mise config, laid down at each Container start when git and gh run under it
 * (`globalMise.ts`, ADR-0032's Global mise config refinement). With no Global mise config it is a link to the dotfiles'
 * own (`DOTFILES_MISE_CONFIG`, ADR-0047 §10), made under the same check. Absent when neither is laid down, and mise
 * then resolves as from the base file alone.
 */
export const GLOBAL_MISE_CONFIG = `${GLOBAL_MISE_DIR}/config.toml`;

/**
 * The Owner's home in a Container: root's, the HOME the Image setup and the Container setup run with (ADR-0047) and
 * where their dotfiles are (§9, §10). Fixed by constraint: every command, both setups and every CLI profile run as root
 * with `HOME=/root` (computerd passes that HOME; the profiles pin it), so this is the one `~` there is.
 */
export const OWNER_HOME = "/root";

/**
 * The dotfiles' own mise config: mise's default global config under `MISE_CONFIG_DIR`, as a dotfiles manager (chezmoi)
 * writes it. mise reads it only through `GLOBAL_MISE_CONFIG`'s link (`MISE_GLOBAL_CONFIG_FILE` names that file).
 */
export const DOTFILES_MISE_CONFIG = `${OWNER_HOME}/.config/mise/config.toml`;

/**
 * What every Container command's environment carries besides PATH (computerd passes only PATH and HOME): mise's configs,
 * so git, gh, node and the rest resolve from the image's preinstalled Toolchains under the owner's global config and a
 * repo's own (system < global < project), and git never prompts.
 *
 * mise sends no GitHub token (SPI-1150): gh's `hosts.yml` (an agent's `gh auth login`), git's credential helper (the
 * Workspace's one-repo token) and a config's `credential_command` are turned off here, and an environment variable beats
 * every config file's setting. A token that could fail an install that works without one is never sent. The two empty
 * values hold `disable_tools` and `disable_backends` at none, so no file can remove git or gh by them.
 *
 * mise's own directories are pinned to the image's defaults under /root, where the lay-down installs (and the shims on
 * PATH point): a CLI profile that moves XDG_* (OpenCode's home) would otherwise send mise elsewhere, and a command
 * there would install the pins again, or find none with auto-install off.
 *
 * The Container desktop's display and session bus (`DESKTOP_ENV`, SPI-1447): every command, Terminal and CLI agent
 * names them, whether the desktop runs or not, as a process on the Owner's machine names its own.
 */
export const COMMAND_ENV: Readonly<Record<string, string>> = {
  MISE_SYSTEM_CONFIG_FILE: BASE_MISE_CONFIG,
  MISE_GLOBAL_CONFIG_FILE: GLOBAL_MISE_CONFIG,
  MISE_TRUSTED_CONFIG_PATHS: `${IMAGE_SHARE}:/workspace`,
  MISE_YES: "1",
  MISE_DATA_DIR: `${OWNER_HOME}/.local/share/mise`,
  MISE_CACHE_DIR: `${OWNER_HOME}/.cache/mise`,
  MISE_STATE_DIR: `${OWNER_HOME}/.local/state/mise`,
  MISE_CONFIG_DIR: `${OWNER_HOME}/.config/mise`,
  MISE_GITHUB_GH_CLI_TOKENS: "false",
  MISE_GITHUB_USE_GIT_CREDENTIALS: "false",
  MISE_GITHUB_CREDENTIAL_COMMAND: "",
  MISE_DISABLE_TOOLS: "",
  MISE_DISABLE_BACKENDS: "",
  GIT_TERMINAL_PROMPT: "0",
  BASH_ENV: `${IMAGE_SHARE}/command.bash`,
  ...DESKTOP_ENV,
};
