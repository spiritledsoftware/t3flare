// @effect-diagnostics nodeBuiltinImport:off
// The ADR merge driver (SPI-1401): its join of concurrent appends, then real rebases in scratch repositories with the
// driver configured as `node scripts/worktree-setup.ts` configures it. `node --test`, so the root scripts need no test
// dependency.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { adrMerge, type AdrMergeResult } from "./adrMerge.ts";
import { configureAdrMergeDriver } from "./worktreeSetup.ts";

// The scratch repositories see none of the machine's git config or hooks, nor a GIT_DIR or GIT_INDEX_FILE this test
// was started under; identity comes from the environment.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

const MARKER_LINE = /^(<{7,}|\|{7,}|={7,}|>{7,})( |$)/m;

const ADR = "# 0032. A decision\n\nWe decide this.\n\nIt matters.\n";
const refinement = (n: number, body = `Refinement ${n} changes the decision.`) =>
  `\n## Refinement (SPI-${n}, 2026-11-25)\n\n${body}\n`;

const merged = (result: AdrMergeResult) => {
  assert.equal(result.kind, "merged", result.kind === "conflict" ? result.conflict : "");
  return result.kind === "merged" ? result.merged : "";
};
const conflict = (result: AdrMergeResult) => {
  assert.equal(result.kind, "conflict");
  return result.kind === "conflict" ? result.conflict : "";
};

void describe("adrMerge", () => {
  void it("joins two refinements appended to the same tail: ours, then theirs, one blank line between", () => {
    const text = merged(adrMerge(ADR + refinement(1), ADR, ADR + refinement(2)));
    assert.equal(text, ADR + refinement(1) + refinement(2));
    assert.doesNotMatch(text, MARKER_LINE);
  });

  void it("adds the blank line when neither append brings one", () => {
    const text = merged(adrMerge(`${ADR}one\n`, ADR, `${ADR}two\n`));
    assert.equal(text, `${ADR}one\n\ntwo\n`);
  });

  void it("joins three-way appends in turn, as a rebase meets them", () => {
    const first = merged(adrMerge(ADR + refinement(1), ADR, ADR + refinement(2)));
    const text = merged(adrMerge(first, ADR, ADR + refinement(3)));
    assert.equal(text, ADR + refinement(1) + refinement(2) + refinement(3));
  });

  void it("keeps one copy of an append both sides made identically", () => {
    assert.equal(merged(adrMerge(ADR + refinement(1), ADR, ADR + refinement(1))), ADR + refinement(1));
  });

  void it("returns git's clean merge when the sides change different places", () => {
    const ours = ADR.replace("We decide this.", "We decide that.");
    const text = merged(adrMerge(ours, ADR, ADR + refinement(2)));
    assert.equal(text, ours + refinement(2));
  });

  void it("never writes a marker line on a merge, even when both appends quote marker-like lines", () => {
    const quoted = (n: number) =>
      refinement(n, ["```", "<<<<<<< HEAD", "|||||||", "=======", ">>>>>>> theirs", "```"].join("\n"));
    const text = merged(adrMerge(ADR + quoted(1), ADR, ADR + quoted(2)));
    assert.equal(text, ADR + quoted(1) + quoted(2));
    const lines = (s: string) => s.split("\n").filter((line) => MARKER_LINE.test(line));
    assert.deepEqual(lines(text), [...lines(quoted(1)), ...lines(quoted(2))]);
  });

  void it("leaves a both-sides edit of one line as git's conflict, with its labels and marker size", () => {
    const ours = ADR.replace("We decide this.", "We decide that.");
    const theirs = ADR.replace("We decide this.", "We decide nothing.");
    const text = conflict(adrMerge(ours, ADR, theirs, { labels: ["HEAD", "base", "abc123 (SPI-2)"] }));
    assert.match(text, /^<<<<<<< HEAD\nWe decide that\.\n=======\nWe decide nothing\.\n>>>>>>> abc123 \(SPI-2\)$/m);
    assert.doesNotMatch(text, /^\|{7}/m, "the default conflict style shows no base");
  });

  void it("shows the base in the conflict when the repository's style is diff3, and honours the marker size", () => {
    const ours = ADR.replace("It matters.", "It matters a lot.");
    const theirs = ADR.replace("It matters.", "It barely matters.");
    const text = conflict(adrMerge(ours, ADR, theirs, { conflictStyle: "diff3", markerSize: 9 }));
    assert.match(
      text,
      /^<{9} ours\nIt matters a lot\.\n\|{9} base\nIt matters\.\n={9}\nIt barely matters\.\n>{9} theirs$/m,
    );
  });

  void it("conflicts when an empty-base join comes with a real edit elsewhere", () => {
    const ours = ADR.replace("We decide this.", "We decide that.") + refinement(1);
    const theirs = ADR.replace("We decide this.", "We decide nothing.") + refinement(2);
    const text = conflict(adrMerge(ours, ADR, theirs));
    assert.match(text, /^<<<<<<< ours$/m);
  });
});

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr-merge-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const run = (cwd: string, ...args: ReadonlyArray<string>) =>
  spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};
const commitFile = (cwd: string, file: string, content: string, message: string) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "commit", "--quiet", "-am", message);
};

let fixtures = 0;
/**
 * A repository with this checkout's `.gitattributes` and ADR merge driver (the driver's files untracked, as a scratch
 * copy), one ADR on `main`, and a branch `feature` off it. With `configured`, the driver is set up as
 * `node scripts/worktree-setup.ts` sets it up.
 */
const repository = ({ configured }: { configured: boolean }) => {
  const dir = path.join(scratch, String(++fixtures));
  fs.mkdirSync(path.join(dir, "docs", "adr"), { recursive: true });
  git(dir, "init", "--quiet");
  for (const file of ["scripts/adr-merge.ts", "scripts/lib/adrMerge.ts"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(dir, file));
  }
  fs.copyFileSync(path.join(repoRoot, ".gitattributes"), path.join(dir, ".gitattributes"));
  fs.writeFileSync(path.join(dir, "docs", "adr", "x.md"), ADR);
  git(dir, "add", ".gitattributes", "docs");
  git(dir, "commit", "--quiet", "-m", "adr");
  git(dir, "branch", "feature");
  if (configured) assert.equal(configureAdrMergeDriver(dir).kind, "configured");
  return dir;
};
const ADR_FILE = "docs/adr/x.md";
const read = (dir: string) => fs.readFileSync(path.join(dir, ADR_FILE), "utf8");

void describe("the adr-append merge driver in a rebase", () => {
  void it("rebases a refinement onto main's refinement with no conflict, main's first", () => {
    const dir = repository({ configured: true });
    commitFile(dir, ADR_FILE, ADR + refinement(1), "SPI-1");
    git(dir, "switch", "--quiet", "feature");
    commitFile(dir, ADR_FILE, ADR + refinement(2), "SPI-2");
    git(dir, "rebase", "--quiet", "main");
    assert.equal(read(dir), ADR + refinement(1) + refinement(2));
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=no"), "");
    assert.doesNotMatch(read(dir), MARKER_LINE);
  });

  void it("works the same in a linked git worktree", () => {
    const dir = repository({ configured: true });
    commitFile(dir, ADR_FILE, ADR + refinement(1), "SPI-1");
    const linked = path.join(dir, ".worktrees", "linked");
    git(dir, "worktree", "add", "--quiet", linked, "feature");
    for (const file of ["scripts/adr-merge.ts", "scripts/lib/adrMerge.ts"]) {
      fs.mkdirSync(path.dirname(path.join(linked, file)), { recursive: true });
      fs.copyFileSync(path.join(dir, file), path.join(linked, file));
    }
    commitFile(linked, ADR_FILE, ADR + refinement(2), "SPI-2");
    git(linked, "rebase", "--quiet", "main");
    assert.equal(read(linked), ADR + refinement(1) + refinement(2));
  });

  void it("still stops the rebase with git's markers on a both-sides edit", () => {
    const dir = repository({ configured: true });
    commitFile(dir, ADR_FILE, ADR.replace("We decide this.", "We decide that."), "main edit");
    git(dir, "switch", "--quiet", "feature");
    commitFile(dir, ADR_FILE, ADR.replace("We decide this.", "We decide nothing."), "feature edit");
    const rebase = run(dir, "rebase", "main");
    assert.notEqual(rebase.status, 0);
    assert.match(git(dir, "status", "--porcelain", "--untracked-files=no"), /^UU docs\/adr\/x\.md$/m);
    assert.match(read(dir), /^<<<<<<< .+\nWe decide that\.\n=======\nWe decide nothing\.\n>>>>>>> .+$/m);
  });

  void it("without the config, conflicts on concurrent appends as git always has", () => {
    const dir = repository({ configured: false });
    commitFile(dir, ADR_FILE, ADR + refinement(1), "SPI-1");
    git(dir, "switch", "--quiet", "feature");
    commitFile(dir, ADR_FILE, ADR + refinement(2), "SPI-2");
    assert.notEqual(run(dir, "rebase", "main").status, 0);
    assert.match(read(dir), /^<<<<<<< /m);
  });

  void it("falls back to git's text merge in a checkout without the driver script", () => {
    const dir = repository({ configured: true });
    fs.rmSync(path.join(dir, "scripts"), { recursive: true });
    commitFile(dir, ADR_FILE, ADR + refinement(1), "SPI-1");
    git(dir, "switch", "--quiet", "feature");
    commitFile(dir, ADR_FILE, ADR + refinement(2), "SPI-2");
    assert.notEqual(run(dir, "rebase", "main").status, 0);
    assert.match(read(dir), /^<<<<<<< .+\n## Refinement \(SPI-1, 2026-11-25\)/m);
  });
});
