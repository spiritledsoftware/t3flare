// @effect-diagnostics nodeBuiltinImport:off
// The image's OpenCode launcher's watcher (apps/sandbox-image/image/t3flare-opencode), on a real shell in the image's
// Ubuntu base, skipped without Docker: a diagnostic about t3flare's system configuration ends OpenCode; one about the
// Owner's own config, copied in when "CLI agents read your dotfiles" is on (ADR-0047 §9), is said once on stderr, and
// OpenCode runs on (it skipped that statement).
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;
const SCRIPTS = path.resolve(import.meta.dirname, "../../sandbox-image/image");

const watch = (lines: ReadonlyArray<string>) => {
  const script = `mkdir -p /x; sleep 4 & self=$!; sleep 0.2
printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")} > /x/log
XDG_CONFIG_HOME=/h/config sh /img/t3flare-opencode --t3flare-watch $self /x/log
# OpenCode stands in as a sleep: its exit says whether the watcher ended it (143, TERM) or it ran to its end (0).
wait $self; echo "exit=$?"`;
  return spawnSync("docker", ["run", "--rm", "-i", "-v", `${SCRIPTS}:/img:ro`, IMAGE, "bash", "-c", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
};

describe.skipIf(!docker)("OpenCode's launcher watcher", () => {
  it("says once that OpenCode skipped part of the Owner's copied config, naming the setting, and leaves OpenCode running", () => {
    const owner =
      'level=WARN message="configuration normalization diagnostic" source=/h/config/opencode/opencode.json action="rejected malformed JSON or JSONC document"';
    const result = watch([owner, owner]);
    const notes = result.stderr.split("\n").filter((line) => line.startsWith("t3flare:"));
    expect(notes).toEqual([
      't3flare: OpenCode skipped part of your config in /h/config/opencode, the copy of your ~/.config/opencode made because the Environment setting "CLI agents read your dotfiles" is on; fix it there, or turn the setting off to skip it',
    ]);
    expect(result.stderr).toContain("rejected malformed JSON or JSONC document");
    expect(result.stderr).not.toContain("the process was ended");
    expect(result.stdout.trim()).toBe("exit=0");
  }, 90_000);

  it("still ends OpenCode on a diagnostic about t3flare's own configuration", () => {
    const result = watch(['message="configuration normalization diagnostic" source=/etc/opencode/opencode.json']);
    expect(result.stderr).toContain(
      "t3flare: OpenCode could not read part of t3flare's configuration; the process was ended",
    );
    expect(result.stdout.trim()).toBe("exit=143");
  }, 90_000);
});
