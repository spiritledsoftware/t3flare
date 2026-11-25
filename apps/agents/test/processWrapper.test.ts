// A CLI process's launcher (step 4a; apps/sandbox-image/src/process.ts) on a real bash: in an Ubuntu container (the
// image's base) with Docker, skipped without Docker. The CLI's stdout carries only the CLI's bytes; the home is fresh,
// its files and links made; t3's path resolves to the repo; core dumps are off; old homes and old sessions go. With
// hostile programs first on PATH, it runs none of them, and the holder is still `setsid --wait …` (SPI-1209).
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { CHECK_TIMEOUT_SEC, processCommand } from "@t3flare/sandbox-image/process";
import { describe, expect, it } from "vitest";

const IMAGE = "ubuntu:26.04";
const docker = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0;

describe.skipIf(!docker)("the CLI process launcher", () => {
  it("leaves stdout to the CLI, builds the home fresh, and resolves t3's path to the repo", () => {
    const launcher = processCommand({
      marker: "proc-test1",
      t3Path: "/w/demo",
      cwd: "/w/demo/sub",
      argv: [
        "/bin/bash",
        "-c",
        'echo "cwd=$(pwd -P) core=$(ulimit -c) cfg=$(cat /var/lib/t3flare/cli/proc-test1/cfg.toml) link=$(readlink /var/lib/t3flare/cli/proc-test1/sessions) stale=$(ls /var/lib/t3flare/cli | tr "\\n" ,) old=$(ls /workspace/.t3flare/pi/sessions | tr "\\n" ,)"',
      ],
      files: [{ path: "/var/lib/t3flare/cli/proc-test1/cfg.toml", text: 'a = "it\'s"\n' }],
      links: [{ path: "/var/lib/t3flare/cli/proc-test1/sessions", target: "/workspace/.t3flare/codex/sessions" }],
      prune: [{ dir: "/workspace/.t3flare/pi/sessions", days: 60 }],
    });
    const script = `set -u
mkdir -p /workspace/repo/sub /var/lib/t3flare/cli/proc-gone /workspace/.t3flare/pi/sessions
touch -d '90 days ago' /workspace/.t3flare/pi/sessions/old.jsonl
touch /workspace/.t3flare/pi/sessions/new.jsonl
cat > /tmp/launcher.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
T3FLARE_EXEC=proc-test1 bash /tmp/launcher.sh 2>/tmp/err
echo "exit=$?"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stdout.trim().split("\n")).toEqual([
      'cwd=/workspace/repo/sub core=0 cfg=a = "it\'s" link=/workspace/.t3flare/codex/sessions stale=proc-test1, old=new.jsonl,',
      "exit=0",
    ]);
  }, 180_000);

  it("keeps a parked card's session from the prune by touching its files first; an unsafe id names nothing (SPI-1389)", () => {
    const launcher = processCommand({
      marker: "proc-keep",
      t3Path: "/w/demo",
      cwd: "/w/demo",
      argv: [
        "/bin/bash",
        "-c",
        'echo "left=$(ls /workspace/.t3flare/pi/sessions | tr "\\n" ,) inside=$(ls /workspace/.t3flare/pi/sessions/parked-1 | tr "\\n" ,)"',
      ],
      keep: { dirs: ["/workspace/.t3flare/pi/sessions"], sessions: ["parked-1", "x*' ; rm -rf / ; '", ".", ".."] },
      prune: [{ dir: "/workspace/.t3flare/pi/sessions", days: 60 }],
    });
    const script = `set -u
mkdir -p /workspace/repo /workspace/.t3flare/pi/sessions/sub /workspace/.t3flare/pi/sessions/parked-1
touch -d '90 days ago' /workspace/.t3flare/pi/sessions/2026_parked-1.jsonl /workspace/.t3flare/pi/sessions/sub/old.jsonl /workspace/.t3flare/pi/sessions/parked-1/tool-result.txt
cat > /tmp/launcher.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
T3FLARE_EXEC=proc-keep bash /tmp/launcher.sh 2>/tmp/err
echo "exit=$?"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    // The parked session's file was touched before the prune, so only the other old file went.
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "left=2026_parked-1.jsonl,parked-1,sub, inside=tool-result.txt,",
      "exit=0",
    ]);
    // An unsafe id, `.` and `..` name nothing: a `.` would match, and so touch, every path.
    expect(launcher).not.toContain("rm -rf / ;");
    expect(launcher).not.toContain("'*.*'");
    expect(launcher).not.toContain("'*..*'");
  }, 180_000);

  it("runs no program from PATH while the model handle is in its environment, and setsid keeps its name (SPI-1209)", () => {
    // Hostile programs first on PATH, as a project's mise shims would be: each notes that it ran and what handle it saw.
    const SHIMMED = [
      "bash",
      "setsid",
      "mkdir",
      "mount",
      "mountpoint",
      "rmdir",
      "dirname",
      "ln",
      "basename",
      "grep",
      "rm",
      "base64",
      "chmod",
      "find",
      "cp",
    ];
    const launcher = processCommand({
      marker: "proc-test2",
      t3Path: "/w/demo",
      cwd: "/w/demo",
      // The CLI prints its parent's command line: the holder, setsid, which forks here (bash leads its own session).
      argv: ["/bin/sh", "-c", "/usr/bin/tr '\\0' ' ' < /proc/$PPID/cmdline; echo"],
      seed: [
        { from: "/root/.codex", to: "/var/lib/t3flare/cli/proc-test2/codex" },
        { from: "/root/.claude.json", to: "/var/lib/t3flare/cli/proc-test2/claude.json" },
      ],
      files: [{ path: "/var/lib/t3flare/cli/proc-test2/cfg.toml", text: "a = 1\n" }],
      links: [
        { path: "/var/lib/t3flare/cli/proc-test2/sessions", target: "/workspace/.t3flare/codex/sessions" },
        { path: "/var/lib/t3flare/cli/proc-test2/codex/skills", target: "/workspace/.t3flare/skills", merge: true },
      ],
      prune: [{ dir: "/workspace/.t3flare/pi/sessions", days: 60 }],
    });
    const script = `set -u
mkdir -p /root/.codex/skills/mine /workspace/.t3flare/skills/env && echo x > /root/.codex/AGENTS.md && echo '{}' > /root/.claude.json
mkdir -p /shims /workspace/repo /workspace/.t3flare/pi/sessions /var/lib/t3flare/cli/proc-gone
for tool in ${SHIMMED.join(" ")}; do
  printf '#!/bin/sh\\necho "%s handle=$T3FLARE_MODEL_HANDLE" >> /tmp/shims.txt\\nexec /usr/bin/%s "$@"\\n' "$tool" "$tool" > /shims/$tool
  chmod 755 /shims/$tool
done
cat > /tmp/launcher.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
PATH=/shims:/usr/bin:/bin T3FLARE_EXEC=proc-test2 T3FLARE_MODEL_HANDLE=handle-1 /usr/bin/setsid --wait /usr/bin/bash /tmp/launcher.sh 2>/tmp/err
echo "exit=$?"
echo "shims=$(cat /tmp/shims.txt 2>/dev/null | tr '\\n' ,)"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "setsid --wait /bin/sh -c /usr/bin/tr '\\0' ' ' < /proc/$PPID/cmdline; echo ",
      "exit=0",
      "shims=",
    ]);
  }, 180_000);

  it("fills the home from the Owner's config first, then writes t3flare's files over it, and merges a skills link (ADR-0047 §9)", () => {
    const home = "/var/lib/t3flare/cli/proc-test3";
    const launcher = processCommand({
      marker: "proc-test3",
      t3Path: "/w/demo",
      cwd: "/w/demo",
      // The CLI lists its home: each file with its text, each link with its target.
      argv: [
        "/bin/bash",
        "-c",
        `cd ${home} && find . \\( -type f -o -type l \\) | while read -r f; do if [ -L "$f" ]; then echo "$f -> $(readlink "$f")"; else echo "$f = $(cat "$f")"; fi; done; [ -x claude/hooks/h.sh ] && echo "hook executable"`,
      ],
      seed: [
        { from: "/root/.claude", to: `${home}/claude`, skip: ["projects"] },
        { from: "/root/.claude.json", to: `${home}/claude/.claude.json` },
        { from: "/root/.missing", to: `${home}/missing` },
      ],
      files: [
        { path: `${home}/claude/over.json`, text: "t3flare" },
        { path: `${home}/claude/keep.toml`, text: "t3flare", keep: true },
        { path: `${home}/claude/new.toml`, text: "t3flare", keep: true },
      ],
      links: [
        { path: `${home}/claude/projects`, target: "/workspace/.t3flare/claude/projects" },
        { path: `${home}/claude/skills`, target: "/skills", merge: true },
      ],
    });
    const script = `set -u
mkdir -p /workspace/repo /root/.claude/projects/p1 /root/.claude/skills/mine /root/.claude/skills/clash /root/.claude/hooks /root/dot /skills/clash /skills/env
echo owner > /root/.claude/CLAUDE.md; echo owner > /root/.claude/over.json; echo owner > /root/.claude/keep.toml
echo hook > /root/.claude/hooks/h.sh; chmod 755 /root/.claude/hooks/h.sh
echo '{"a":1}' > /root/.claude.json; echo session > /root/.claude/projects/p1/s.jsonl
echo mine > /root/.claude/skills/mine/SKILL.md; echo owner > /root/.claude/skills/clash/SKILL.md
echo linked > /root/dot/real.md; ln -s /root/dot/real.md /root/.claude/linked.md; ln -s /nowhere /root/.claude/dangling
echo env > /skills/clash/SKILL.md; echo env > /skills/env/SKILL.md
cat > /tmp/launcher.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
T3FLARE_EXEC=proc-test3 bash /tmp/launcher.sh 2>/tmp/err
echo "exit=$?"
echo "owner=$(cat /root/.claude/over.json)"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    const lines = result.stdout.trim().split("\n");
    expect(lines.slice(0, -3).sort(), result.stderr).toEqual(
      [
        './claude/.claude.json = {"a":1}',
        "./claude/CLAUDE.md = owner",
        "./claude/hooks/h.sh = hook",
        "./claude/keep.toml = owner",
        "./claude/linked.md = linked",
        "./claude/new.toml = t3flare",
        "./claude/over.json = t3flare",
        "./claude/projects -> /workspace/.t3flare/claude/projects",
        "./claude/skills/clash -> /skills/clash",
        "./claude/skills/env -> /skills/env",
        "./claude/skills/mine/SKILL.md = mine",
      ].sort(),
    );
    expect(lines.slice(-3)).toEqual(["hook executable", "exit=0", "owner=owner"]);
  }, 180_000);

  it("checks a seeded config before the start: on a failure, names the file on stderr and exits 78 without starting the CLI (ADR-0047 §9)", () => {
    const launch = (marker: string) =>
      processCommand({
        marker,
        t3Path: "/w/demo",
        cwd: "/w/demo",
        argv: ["/bin/sh", "-c", "echo started"],
        seed: [{ from: "/root/.tool", to: `/var/lib/t3flare/cli/${marker}/tool` }],
        // The CLI's own loader, standing in: fails on a file that says "bad", from `/`.
        check: {
          when: "/root/.tool/config",
          argv: [
            "/bin/sh",
            "-c",
            `pwd; grep -q bad /var/lib/t3flare/cli/${marker}/tool/config && echo "parse error at line 1" >&2 && exit 1; exit 0`,
          ],
          failure: "the tool cannot load your config",
        },
      });
    const script = `set -u
mkdir -p /workspace/repo /root/.tool
cat > /tmp/l.sh <<'T3FLARE_EOF'
${launch("proc-test4")}
T3FLARE_EOF
echo good > /root/.tool/config
T3FLARE_EXEC=proc-test4 bash /tmp/l.sh 2>/tmp/err; echo "good exit=$? err=$(tr '\\n' '|' < /tmp/err)"
echo bad > /root/.tool/config
T3FLARE_EXEC=proc-test4 bash /tmp/l.sh 2>/tmp/err; echo "bad exit=$? err=$(tr '\\n' '|' < /tmp/err)"
rm -r /root/.tool
T3FLARE_EXEC=proc-test4 bash /tmp/l.sh 2>/tmp/err; echo "none exit=$? err=$(tr '\\n' '|' < /tmp/err)"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "started",
      "good exit=0 err=",
      "bad exit=78 err=t3flare: the tool cannot load your config|parse error at line 1|",
      "started",
      "none exit=0 err=",
    ]);
  }, 180_000);

  it("leaves out of a seeded directory each entry its shadow names, so that one wins a name clash (pi's Skills, ADR-0047 §9)", () => {
    const launcher = processCommand({
      marker: "proc-test5",
      t3Path: "/w/demo",
      cwd: "/w/demo",
      argv: [
        "/bin/bash",
        "-c",
        "cd /var/lib/t3flare/cli/proc-test5/agent && find . -type f | sort | tr '\\n' ' '; echo",
      ],
      seed: [
        {
          from: "/root/.pi/agent",
          to: "/var/lib/t3flare/cli/proc-test5/agent",
          shadow: { dir: "skills", by: "/skills" },
        },
      ],
    });
    const script = `set -u
mkdir -p /workspace/repo /root/.pi/agent/skills/deploy /root/.pi/agent/skills/mine /root/.pi/agent/extensions /skills/deploy /skills/env
echo o > /root/.pi/agent/skills/deploy/SKILL.md; echo o > /root/.pi/agent/skills/mine/SKILL.md; echo o > /root/.pi/agent/extensions/x.ts
cat > /tmp/l.sh <<'T3FLARE_EOF'
${launcher}
T3FLARE_EOF
T3FLARE_EXEC=proc-test5 bash /tmp/l.sh 2>/tmp/err; echo "exit=$?"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "./extensions/x.ts ./skills/mine/SKILL.md ",
      "exit=0",
    ]);
  }, 180_000);

  it("runs a check with its stdin closed and under a bound: it never reads the CLI's protocol stream, and one that hangs is no verdict", () => {
    const launch = (check: string) =>
      processCommand({
        marker: "proc-test6",
        t3Path: "/w/demo",
        cwd: "/w/demo",
        // The CLI echoes the first line of its stdin: the protocol's first frame must still be there.
        argv: ["/bin/sh", "-c", 'read -r line; echo "cli got: $line"'],
        check: { when: "/root/.tool", argv: ["/bin/sh", "-c", check], failure: "the tool cannot load your config" },
      });
    const script = `set -u
mkdir -p /workspace/repo; touch /root/.tool
cat > /tmp/reads.sh <<'T3FLARE_EOF'
${launch("cat >/dev/null; exit 0")}
T3FLARE_EOF
cat > /tmp/hangs.sh <<'T3FLARE_EOF'
${launch("sleep 600")}
T3FLARE_EOF
echo frame-1 | T3FLARE_EXEC=proc-test6 bash /tmp/reads.sh 2>/dev/null; echo "reads exit=$?"
# The bound, shortened by text for the test (the script must say what it replaces).
sed -i "s/timeout -k 5 ${CHECK_TIMEOUT_SEC} /timeout -k 1 2 /" /tmp/hangs.sh
echo frame-1 | T3FLARE_EXEC=proc-test6 bash /tmp/hangs.sh 2>/tmp/err; echo "hangs exit=$? err=$(cat /tmp/err)"`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], {
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stdout.trim().split("\n"), result.stderr).toEqual([
      "cli got: frame-1",
      "reads exit=0",
      "cli got: frame-1",
      "hangs exit=0 err=t3flare: the check of /root/.tool did not finish in 30 s; starting anyway",
    ]);
  }, 180_000);

  it("refuses a seed from outside /root or into anywhere but the process's home", () => {
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        seed: [{ from: "/etc/shadow", to: "/var/lib/t3flare/cli/proc-x/a" }],
      }),
    ).toThrow(/may not copy/);
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        seed: [{ from: "/root/../etc", to: "/var/lib/t3flare/cli/proc-x/a" }],
      }),
    ).toThrow(/may not copy/);
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        seed: [{ from: "/root/.claude", to: "/workspace/.t3flare/x" }],
      }),
    ).toThrow(/may not copy/);
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        seed: [
          { from: "/root/.pi/agent", to: "/var/lib/t3flare/cli/proc-x/a", shadow: { dir: "../x", by: "/skills" } },
        ],
      }),
    ).toThrow(/may not copy/);
  });

  it("refuses a file outside the process's home and the synced harness directory", () => {
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        files: [{ path: "/root/.bashrc", text: "x" }],
      }),
    ).toThrow(/may not write/);
    expect(() =>
      processCommand({
        marker: "proc-x",
        t3Path: "/w/d",
        cwd: "/w/d",
        argv: ["/bin/true"],
        files: [{ path: "/workspace/.t3flare/../repo/x", text: "x" }],
      }),
    ).toThrow(/may not write/);
    expect(() => processCommand({ marker: "term-x", t3Path: "/w/d", cwd: "/w/d", argv: ["/bin/true"] })).toThrow(
      /marker/,
    );
  });
});
