// @effect-diagnostics nodeBuiltinImport:off
// Repairs a checkout whose `t3code/.git` points nowhere (ADR-0030's SPI-1335 refinement). T3's checkout cache writes
// `t3code/.git` relative to another git worktree's module dir, so a new git worktree's pointer resolves nowhere and
// `git switch`, `git status` and `git add` fail. The repair gives this checkout its own module dir, borrowing the main
// checkout's objects through `objects/info/alternates`, so it needs no network. It never shares another checkout's
// module dir: two checkouts on one module dir move each other's HEAD and index.
//
// Plain Node, no dependencies: it runs before anything is installed.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The submodule this repairs: t3flare has the one (ADR-0001). */
const SUBMODULE = "t3code";
const INIT_COMMAND = `git submodule update --init ${SUBMODULE}`;

export type WorktreeSetupResult =
  | { readonly kind: "healthy" }
  | { readonly kind: "repaired"; readonly message: string }
  | { readonly kind: "uninitialised"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The child environment: the caller's, without the GIT_* variables that point git at a repository, index, work tree or
 * object store (a git hook exports GIT_DIR and GIT_INDEX_FILE, and `reset` would then write the superproject's index).
 * Which config files to read and the commit identity are kept: they name no repository.
 */
const KEPT_GIT_VARIABLES = /^GIT_(CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|AUTHOR_\w+|COMMITTER_\w+)$/;
const childEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") || KEPT_GIT_VARIABLES.test(key)),
  );

/** git with the caller's repository-naming GIT_* variables dropped (childEnv); adrMergeDriver.ts uses it too. */
export const git = (args: ReadonlyArray<string>) => {
  // submodule.recurse is off for every command here: with the pointer broken, a recursing command fails on it.
  const result = spawnSync("git", ["-c", "submodule.recurse=false", ...args], { encoding: "utf8", env: childEnv() });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
};

const realpath = (target: string): string | undefined => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
};

/** Whether `dir` is a git dir whose HEAD names a commit it has: an unborn or dangling HEAD is not a usable checkout. */
const hasCommitAtHead = (dir: string) =>
  git([`--git-dir=${dir}`, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).ok;

/** The directory a gitfile names, resolved against the file's own directory as git does; undefined if it names none. */
export const gitfileTarget = (gitfile: string): string | undefined => {
  const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitfile, "utf8"));
  return match === null ? undefined : path.resolve(path.dirname(gitfile), match[1]!.trim());
};

/** Where a checkout's submodule lives and the module dirs it may use. */
type Layout = {
  readonly root: string;
  readonly subPath: string;
  readonly workTree: string;
  readonly gitfile: string;
  /** This checkout's own module dir, `<git-dir>/modules/t3code`. */
  readonly moduleDir: string;
  /** The main checkout's module dir, `<git-common-dir>/modules/t3code`, whose objects a repair borrows. */
  readonly mainModuleDir: string;
};

type Inspection =
  | { readonly kind: "healthy" }
  | { readonly kind: "uninitialised"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "broken"; readonly layout: Layout; readonly pin: string };

/**
 * Reads the checkout at `root` without writing. Healthy: the submodule's `.git` is a directory, or a gitfile naming this
 * checkout's own module dir, and either has a commit at HEAD. The pointer is read as a file, never through git: with it
 * broken, `git -C <submodule>` acts on the superproject.
 */
export const inspectCheckout = (root: string): Inspection => {
  const gitDir = git(["-C", root, "rev-parse", "--absolute-git-dir"]);
  const commonDir = git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir.ok || !commonDir.ok)
    return { kind: "failed", message: `${root} is not a git checkout: ${gitDir.err || commonDir.err}` };
  const subPath =
    git(["-C", root, "config", "--file", ".gitmodules", "--get", `submodule.${SUBMODULE}.path`]).out || SUBMODULE;
  const workTree = path.join(root, subPath);
  const gitfile = path.join(workTree, ".git");
  const moduleDir = path.join(gitDir.out, "modules", SUBMODULE);
  const layout = {
    root,
    subPath,
    workTree,
    gitfile,
    moduleDir,
    mainModuleDir: path.join(commonDir.out, "modules", SUBMODULE),
  };

  const stat = fs.lstatSync(gitfile, { throwIfNoEntry: false });
  if (stat === undefined)
    return { kind: "uninitialised", message: `${subPath} is not checked out; run: ${INIT_COMMAND}` };
  if (stat.isDirectory()) {
    // An embedded repository: the checkout's own, never rewritten here.
    if (hasCommitAtHead(gitfile)) return { kind: "healthy" };
    return {
      kind: "failed",
      message: `${subPath}/.git is a repository with no commit at HEAD; move ${subPath} aside and run: ${INIT_COMMAND}`,
    };
  }
  const target = gitfileTarget(gitfile);
  if (target !== undefined && realpath(target) === realpath(moduleDir) && hasCommitAtHead(target))
    return { kind: "healthy" };

  const pin = /^160000 commit ([0-9a-f]+)\t/.exec(git(["-C", root, "ls-tree", "HEAD", subPath]).out)?.[1];
  if (pin === undefined) return { kind: "failed", message: `${subPath} is not a submodule at HEAD of ${root}` };
  return { kind: "broken", layout, pin };
};

/** Writes `content` to `file` through a sibling and a rename, so a reader sees the old file or the new, never half. */
const replaceFile = (file: string, content: string) => {
  const staged = `${file}.setup`;
  fs.writeFileSync(staged, content);
  fs.renameSync(staged, file);
};

/** A link from `from` to `to` that survives a symlinked path to either. */
const relativeLink = (from: string, to: string) =>
  path.relative(realpath(from) ?? from, path.join(realpath(path.dirname(to)) ?? path.dirname(to), path.basename(to)));

/**
 * Gives a broken checkout its own module dir. It is prepared beside its final place and verified to have the pinned
 * commit before the dangling pointer is touched, so a failure leaves the checkout as it found it, and broken on the next
 * run too. A surviving module dir with a commit at HEAD (only the pointer broke) is re-pointed at and left alone.
 */
const repair = ({ layout, pin }: { layout: Layout; pin: string }): WorktreeSetupResult => {
  const { root, subPath, workTree, gitfile, moduleDir, mainModuleDir } = layout;
  const pointAtModuleDir = () => replaceFile(gitfile, `gitdir: ${relativeLink(workTree, moduleDir)}\n`);
  if (fs.existsSync(moduleDir)) {
    if (!hasCommitAtHead(moduleDir)) {
      return {
        kind: "failed",
        message: `${subPath}/.git points nowhere and this checkout's ${moduleDir} has no commit at HEAD; move both aside and run: ${INIT_COMMAND}`,
      };
    }
    pointAtModuleDir();
    return { kind: "repaired", message: `re-pointed ${subPath}/.git at this checkout's ${moduleDir}` };
  }
  if (!fs.existsSync(path.join(mainModuleDir, "objects"))) {
    return {
      kind: "uninitialised",
      message: `${subPath}/.git points nowhere and the main checkout has no ${SUBMODULE} objects to borrow; run: ${INIT_COMMAND}`,
    };
  }

  // A sibling of the module dir, so the relative core.worktree written into it holds after the rename.
  const staged = `${moduleDir}.setup`;
  const inStaged = (args: ReadonlyArray<string>) => git([`--git-dir=${staged}`, `--work-tree=${workTree}`, ...args]);
  const url = git(["-C", root, "config", "--file", ".gitmodules", "--get", `submodule.${SUBMODULE}.url`]);
  const steps: ReadonlyArray<() => { ok: boolean; err: string }> = [
    () => {
      fs.rmSync(staged, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      return inStaged(["init", "--quiet"]);
    },
    () => {
      fs.writeFileSync(path.join(staged, "objects", "info", "alternates"), `${path.join(mainModuleDir, "objects")}\n`);
      // The layout `git submodule` itself writes: both links relative, so the checkout can move.
      return inStaged(["config", "core.worktree", relativeLink(moduleDir, workTree)]);
    },
    () => (url.ok ? inStaged(["remote", "add", "origin", url.out]) : { ok: true, err: "" }),
    // update-ref refuses a commit the borrowed objects lack.
    () => inStaged(["update-ref", "--no-deref", "HEAD", pin]),
    // The index only: the files on disk are the checkout's own and stay as they are.
    () => inStaged(["reset", "--quiet", "--mixed"]),
  ];
  for (const step of steps) {
    let result: { ok: boolean; err: string };
    try {
      result = step();
    } catch (error) {
      result = { ok: false, err: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      fs.rmSync(staged, { recursive: true, force: true });
      return {
        kind: "failed",
        message: `could not repair ${subPath}/.git (${result.err}); move ${subPath} aside and run: ${INIT_COMMAND}`,
      };
    }
  }
  try {
    fs.renameSync(staged, moduleDir);
    pointAtModuleDir();
  } catch (error) {
    return {
      kind: "failed",
      message: `could not repair ${subPath}/.git (${error instanceof Error ? error.message : String(error)}); move ${subPath} aside and run: ${INIT_COMMAND}`,
    };
  }
  return {
    kind: "repaired",
    message: `${subPath}/.git pointed nowhere; gave this checkout its own ${moduleDir}, borrowing the main checkout's objects`,
  };
};

/**
 * Checks, and if needed repairs, the t3code submodule of the checkout at `root`. Healthy writes nothing; an
 * uninitialised submodule, or a broken one with no module dir in this checkout or the main checkout to borrow from, is
 * reported and left alone.
 */
export const worktreeSetup = (root: string): WorktreeSetupResult => {
  const inspection = inspectCheckout(root);
  return inspection.kind === "broken" ? repair(inspection) : inspection;
};
