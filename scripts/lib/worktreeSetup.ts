// @effect-diagnostics nodeBuiltinImport:off
// Repairs a checkout whose submodule `.git` points nowhere (SPI-1335). T3's checkout cache writes `t3code/.git` relative
// to another git worktree's module dir, so a new git worktree's pointer resolves nowhere and `git switch`, `git status`
// and `git add` fail. The repair gives this checkout its own module dir, borrowing the main checkout's objects through
// `objects/info/alternates`, so it needs no network. It never shares another checkout's module dir: two checkouts on
// one module dir move each other's HEAD and index.
//
// Plain Node, no dependencies: it runs before anything is installed.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type WorktreeSetupResult =
  | { readonly kind: "healthy" }
  | { readonly kind: "repaired"; readonly message: string }
  | { readonly kind: "uninitialised"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

const git = (args: ReadonlyArray<string>) => {
  // submodule.recurse is off for every command here: with the pointer broken, a recursing command fails on it.
  const result = spawnSync("git", ["-c", "submodule.recurse=false", ...args], { encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
};

const realpath = (target: string): string | undefined => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
};

/** Whether `dir` is a git dir: what git itself checks before it follows a gitfile. */
const isGitDir = (dir: string) => fs.existsSync(path.join(dir, "HEAD")) && fs.existsSync(path.join(dir, "objects")) && fs.existsSync(path.join(dir, "refs"));

/** The directory a gitfile names, resolved against the file's own directory as git does; undefined if it names none. */
export const gitfileTarget = (gitfile: string): string | undefined => {
  const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitfile, "utf8"));
  return match === null ? undefined : path.resolve(path.dirname(gitfile), match[1]!.trim());
};

/**
 * Checks, and if needed repairs, submodule `name` of the checkout at `root`. Healthy (the submodule's `.git` is a
 * directory, or a gitfile naming this checkout's own module dir) writes nothing. An uninitialised submodule, or one
 * with no module dir in this checkout or the main checkout to borrow from, is reported and left alone.
 *
 * With the pointer gone, `git -C <submodule>` would act on the superproject: every submodule command names its git dir
 * and work tree explicitly, and the pointer is read as a file, never through git.
 */
export const worktreeSetup = (root: string, name = "t3code"): WorktreeSetupResult => {
  const init = `git submodule update --init ${name}`;
  const gitDir = git(["-C", root, "rev-parse", "--absolute-git-dir"]);
  const commonDir = git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir.ok || !commonDir.ok) return { kind: "failed", message: `${root} is not a git checkout: ${gitDir.err || commonDir.err}` };
  const subPath = git(["-C", root, "config", "--file", ".gitmodules", "--get", `submodule.${name}.path`]).out || name;
  const workTree = path.join(root, subPath);
  const gitfile = path.join(workTree, ".git");
  const own = path.join(gitDir.out, "modules", name);
  const shared = path.join(commonDir.out, "modules", name);

  const stat = fs.lstatSync(gitfile, { throwIfNoEntry: false });
  if (stat === undefined) return { kind: "uninitialised", message: `${subPath} is not checked out; run: ${init}` };
  if (stat.isDirectory()) return { kind: "healthy" };
  const target = gitfileTarget(gitfile);
  if (target !== undefined && isGitDir(target) && realpath(target) === realpath(own)) return { kind: "healthy" };

  const pin = /^160000 commit ([0-9a-f]+)\t/.exec(git(["-C", root, "ls-tree", "HEAD", subPath]).out)?.[1];
  if (pin === undefined) return { kind: "failed", message: `${subPath} is not a submodule at HEAD of ${root}` };
  const ownExists = isGitDir(own);
  if (!ownExists && !isGitDir(shared)) {
    return { kind: "uninitialised", message: `${subPath}/.git points nowhere and the main checkout has no ${name} objects to borrow; run: ${init}` };
  }

  const relativeGitfile = `gitdir: ${path.relative(workTree, own)}\n`;
  const sub = (args: ReadonlyArray<string>) => git([`--git-dir=${own}`, `--work-tree=${workTree}`, ...args]);
  fs.rmSync(gitfile);
  if (ownExists) {
    // This checkout's own module dir survived (only the pointer broke): point back at it and leave its state alone.
    fs.writeFileSync(gitfile, relativeGitfile);
    return { kind: "repaired", message: `worktree setup: re-pointed ${subPath}/.git at this checkout's ${own}` };
  }

  fs.mkdirSync(path.dirname(own), { recursive: true });
  const steps: ReadonlyArray<() => { ok: boolean; err: string }> = [
    () => git(["init", "--quiet", `--separate-git-dir=${own}`, workTree]),
    () => {
      fs.writeFileSync(path.join(own, "objects", "info", "alternates"), `${path.join(shared, "objects")}\n`);
      // The layout `git submodule` itself writes: both links relative, so the checkout can move.
      fs.writeFileSync(gitfile, relativeGitfile);
      return sub(["config", "core.worktree", path.relative(own, workTree)]);
    },
    () => {
      const url = git(["-C", root, "config", "--file", ".gitmodules", "--get", `submodule.${name}.url`]);
      return url.ok ? sub(["remote", "add", "origin", url.out]) : { ok: true, err: "" };
    },
    () => sub(["update-ref", "--no-deref", "HEAD", pin]),
    // The index only: the files on disk are the checkout's own and stay as they are.
    () => sub(["reset", "--quiet", "--mixed"]),
  ];
  for (const step of steps) {
    const result = step();
    if (!result.ok) return { kind: "failed", message: `worktree setup: could not repair ${subPath}/.git (${result.err}); move ${subPath} aside and run: ${init}` };
  }
  return { kind: "repaired", message: `worktree setup: ${subPath}/.git pointed nowhere; gave this checkout its own ${own}, borrowing the main checkout's objects` };
};
