// @effect-diagnostics nodeBuiltinImport:off
// The worktree setup's repair (SPI-1335), on scratch repositories: `node --test`, so the root scripts need no test dependency.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { gitfileTarget, worktreeSetup } from "./worktreeSetup.ts";

// The scratch repositories see none of the machine's git config or hooks; identity comes from the environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-setup-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = spawnSync("git", ["-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};

let fixtures = 0;
/**
 * A superproject whose submodule `t3code` has two commits, with `submodule.recurse=true`, pinned at the second commit on
 * `main` and at the first on `old`; its main checkout has the submodule initialised. Returns the superproject's root
 * and both submodule commits.
 */
const superproject = () => {
  const dir = path.join(scratch, String(++fixtures));
  const upstream = path.join(dir, "upstream");
  fs.mkdirSync(upstream, { recursive: true });
  git(upstream, "init", "--quiet");
  fs.writeFileSync(path.join(upstream, "a.txt"), "one\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "--quiet", "-m", "one");
  const first = git(upstream, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(upstream, "a.txt"), "two\n");
  git(upstream, "commit", "--quiet", "-am", "two");
  const second = git(upstream, "rev-parse", "HEAD");

  const main = path.join(dir, "main");
  fs.mkdirSync(main);
  git(main, "init", "--quiet");
  git(main, "submodule", "--quiet", "add", upstream, "t3code");
  git(path.join(main, "t3code"), "checkout", "--quiet", first);
  git(main, "commit", "--quiet", "-am", "pin one");
  git(main, "branch", "old");
  git(path.join(main, "t3code"), "checkout", "--quiet", second);
  git(main, "commit", "--quiet", "-am", "pin two");
  git(main, "config", "submodule.recurse", "true");
  return { dir, main, first, second };
};

/** A linked git worktree of `main` whose `t3code/.git` is a dangling relative pointer beside populated files, as T3's checkout cache leaves it. */
const brokenWorktree = (fixture: ReturnType<typeof superproject>) => {
  const worktree = path.join(fixture.dir, "deep", "linked");
  git(fixture.main, "-c", "submodule.recurse=false", "worktree", "add", "--quiet", "-b", "linked", worktree);
  const sub = path.join(worktree, "t3code");
  fs.rmSync(sub, { recursive: true, force: true });
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "a.txt"), "two\n");
  fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/worktrees/elsewhere/modules/t3code\n");
  return worktree;
};

const gitDirOf = (checkout: string) => git(checkout, "rev-parse", "--absolute-git-dir");

await describe("worktreeSetup", async () => {
  await it("gives a linked git worktree with a dangling t3code/.git its own module dir, without the network", () => {
    const fixture = superproject();
    const worktree = brokenWorktree(fixture);
    // The bug: git fails in the checkout.
    assert.notEqual(spawnSync("git", ["status"], { cwd: worktree }).status, 0);
    // No network: the upstream is gone, so only the main checkout's objects can serve the repair.
    fs.rmSync(path.join(fixture.dir, "upstream"), { recursive: true });

    const result = worktreeSetup(worktree);
    assert.equal(result.kind, "repaired");

    const own = path.join(gitDirOf(worktree), "modules", "t3code");
    assert.equal(gitfileTarget(path.join(worktree, "t3code", ".git")), own);
    assert.equal(fs.readFileSync(path.join(worktree, "t3code", ".git"), "utf8"), `gitdir: ${path.relative(path.join(worktree, "t3code"), own)}\n`);
    assert.equal(fs.readFileSync(path.join(own, "objects", "info", "alternates"), "utf8").trim(), path.join(fixture.main, ".git", "modules", "t3code", "objects"));
    assert.equal(git(path.join(worktree, "t3code"), "rev-parse", "HEAD"), fixture.second);
    assert.equal(git(path.join(worktree, "t3code"), "remote", "get-url", "origin"), path.join(fixture.dir, "upstream"));
    assert.equal(git(worktree, "status", "--porcelain"), "");
    assert.equal(git(worktree, "submodule", "update", "--init"), "");
    assert.equal(git(worktree, "rev-parse", "HEAD:t3code"), fixture.second);

    // A switch to a commit pinning another submodule commit recurses into it.
    git(worktree, "switch", "--quiet", "--detach", "old");
    assert.equal(git(path.join(worktree, "t3code"), "rev-parse", "HEAD"), fixture.first);
    assert.equal(fs.readFileSync(path.join(worktree, "t3code", "a.txt"), "utf8"), "one\n");
    assert.equal(git(worktree, "status", "--porcelain"), "");

    // The main checkout's submodule is untouched.
    assert.equal(git(path.join(fixture.main, "t3code"), "rev-parse", "HEAD"), fixture.second);
    assert.deepEqual(worktreeSetup(worktree), { kind: "healthy" });
  });

  await it("keeps the files on disk: an edit stays an edit", () => {
    const fixture = superproject();
    const worktree = brokenWorktree(fixture);
    fs.writeFileSync(path.join(worktree, "t3code", "a.txt"), "edited\n");
    assert.equal(worktreeSetup(worktree).kind, "repaired");
    assert.equal(fs.readFileSync(path.join(worktree, "t3code", "a.txt"), "utf8"), "edited\n");
    assert.equal(git(path.join(worktree, "t3code"), "status", "--porcelain"), "M a.txt");
  });

  await it("re-points a dangling t3code/.git at this checkout's own module dir when that survived", () => {
    const fixture = superproject();
    fs.writeFileSync(path.join(fixture.main, "t3code", ".git"), "gitdir: ../nowhere/modules/t3code\n");
    const result = worktreeSetup(fixture.main);
    assert.equal(result.kind, "repaired");
    assert.equal(gitfileTarget(path.join(fixture.main, "t3code", ".git")), path.join(fixture.main, ".git", "modules", "t3code"));
    assert.equal(git(fixture.main, "status", "--porcelain"), "");
  });

  await it("writes nothing in a healthy main checkout or a healthy linked git worktree", () => {
    const fixture = superproject();
    const worktree = path.join(fixture.dir, "healthy");
    git(fixture.main, "worktree", "add", "--quiet", "-b", "healthy", worktree);
    git(worktree, "submodule", "update", "--init", "--quiet");
    for (const checkout of [fixture.main, worktree]) {
      const gitfile = path.join(checkout, "t3code", ".git");
      const before = fs.statSync(gitfile).mtimeMs;
      assert.deepEqual(worktreeSetup(checkout), { kind: "healthy" });
      assert.equal(fs.statSync(gitfile).mtimeMs, before);
    }
  });

  await it("reports an uninitialised submodule with the init command, changing nothing", () => {
    const fixture = superproject();
    const worktree = path.join(fixture.dir, "uninit");
    git(fixture.main, "-c", "submodule.recurse=false", "worktree", "add", "--quiet", "-b", "uninit", worktree);
    const result = worktreeSetup(worktree);
    assert.equal(result.kind, "uninitialised");
    if (result.kind === "uninitialised") assert.match(result.message, /git submodule update --init t3code$/);
    assert.equal(fs.existsSync(path.join(worktree, "t3code", ".git")), false);
    assert.equal(fs.existsSync(path.join(gitDirOf(worktree), "modules")), false);
  });

  await it("reports a dangling t3code/.git with no main checkout module dir to borrow, changing nothing", () => {
    const fixture = superproject();
    const worktree = brokenWorktree(fixture);
    fs.rmSync(path.join(fixture.main, ".git", "modules"), { recursive: true });
    const result = worktreeSetup(worktree);
    assert.equal(result.kind, "uninitialised");
    if (result.kind === "uninitialised") assert.match(result.message, /git submodule update --init t3code$/);
    assert.equal(fs.readFileSync(path.join(worktree, "t3code", ".git"), "utf8"), "gitdir: ../../.git/worktrees/elsewhere/modules/t3code\n");
  });
});
