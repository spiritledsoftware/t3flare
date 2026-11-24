// The passive-read rule after root's ruling on step 2b M2 (ADR-0009 refinement): only allow-listed `.git` reads with no
// answer at all may start a stopped Container; primed answers (made while it ran) are byte-for-byte git's.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  allowedRead,
  passiveDecision,
  type PrimeExec,
  primeArgvs,
  primeReads,
  primeScript,
  UPSTREAM_FORMAT,
} from "../src/workspace/gitDirReads.ts";

const REPO = "/workspace/repo";

describe("the allow-list", () => {
  it("takes exactly the reads t3's worktree launch sends, with or without its own --git-dir", () => {
    expect(allowedRead(["rev-parse", "--git-common-dir"], REPO)?.name).toBe("git-common-dir");
    expect(allowedRead(["--git-dir", `${REPO}/.git`, "remote"], REPO)?.name).toBe("remotes");
    expect(allowedRead(["for-each-ref", UPSTREAM_FORMAT, "refs/heads/main"], REPO)?.name).toBe("base-upstream");
    expect(allowedRead(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"], REPO)?.name).toBe(
      "remote-commit",
    );
    expect(allowedRead(["config", "--get", "checkout.workers"], REPO)?.name).toBe("checkout-workers");
    // t3's commit draft (SPI-1186), before its first write.
    expect(allowedRead(["rev-parse", "--git-path", "index", "--git-path", "objects"], REPO)?.name).toBe(
      "commit-git-paths",
    );
    expect(allowedRead(["count-objects", "-v"], REPO)?.name).toBe("commit-alternates");
    // t3's status poll and branch list are not on it.
    for (const argv of [
      ["status", "--porcelain=2", "--branch", "-z"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/main"],
      ["config", "--get", "remote.origin.url"],
      ["--git-dir", "/w/other/.git", "remote"],
      ["rev-parse", "--show-toplevel"],
      // The review diff's index path, and count-objects in another shape.
      ["rev-parse", "--git-path", "index"],
      ["count-objects"],
    ]) {
      expect(allowedRead(argv, REPO), argv.join(" ")).toBeUndefined();
    }
  });
});

describe("a passive read while the Container is stopped", () => {
  const stopped = { cachedNow: false, running: false, hasLastAnswer: false, allowed: false, emulated: false };

  it("never starts it for a read with a last answer, allow-listed or not", () => {
    expect(passiveDecision({ ...stopped, hasLastAnswer: true, allowed: false })).toBe("stale");
    expect(passiveDecision({ ...stopped, hasLastAnswer: true, allowed: true })).toBe("stale");
  });

  it("starts it only for an unprimed allow-listed read that is not answered from the files", () => {
    expect(passiveDecision({ ...stopped, allowed: true })).toBe("run-starting-container");
    expect(passiveDecision({ ...stopped, allowed: false })).toBe("stale");
    // `remote` is answered from the files.
    expect(passiveDecision({ ...stopped, allowed: true, emulated: true })).toBe("stale");
  });

  it("answers from the cache when it is fresh, and runs the read when the Container runs", () => {
    expect(passiveDecision({ ...stopped, cachedNow: true, hasLastAnswer: true })).toBe("cache");
    expect(passiveDecision({ ...stopped, running: true })).toBe("run");
  });
});

/** A Workspace repo for the prime: `branches` local branches tracking origin, and `remotes` remote-tracking refs. */
const primedRepo = (branches: number, remotes: number) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3flare-prime-")));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env, ...(input === undefined ? {} : { input }) });
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  run(seed, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(seed, "a"), "a");
  run(seed, ["add", "a"]);
  run(seed, ["commit", "-qm", "a"]);
  const repo = path.join(dir, "repo");
  run(dir, ["clone", "-q", seed, repo]);
  for (let at = 0; at < branches; at++) run(repo, ["branch", "--track", `feature-${at}`, "origin/main"]);
  const head = run(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const refs = Array.from(
    { length: remotes },
    (_, at) => `create refs/remotes/origin/r${String(at).padStart(5, "0")} ${head}\n`,
  );
  run(repo, ["update-ref", "--stdin"], refs.join(""));
  /** The Workspace DO's exec with `wholeOutput`: the script's output, whole. */
  const exec: PrimeExec = async (input) => {
    const ran = spawnSync("bash", ["-c", input.script], {
      cwd: repo,
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024 * 1024,
      ...(input.stdin === undefined ? {} : { input: input.stdin }),
    });
    return { exitCode: ran.status ?? -1, stdout: ran.stdout };
  };
  return {
    exec,
    direct: (argv: ReadonlyArray<string>) => run(repo, argv),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

const FIXED_READS = [
  ["rev-parse", "--git-common-dir"],
  ["remote"],
  ["config", "--get", "checkout.workers"],
  ["rev-parse", "--git-path", "index", "--git-path", "objects"],
  ["count-objects", "-v"],
];

describe("priming", () => {
  it("answers each allow-listed read as git does", async () => {
    const repo = primedRepo(1, 0);
    try {
      const answers = await primeReads(repo.exec, () => true);
      expect(answers.length).toBeGreaterThanOrEqual(8);
      expect(answers.map((answer) => answer.argv)).toEqual(expect.arrayContaining(FIXED_READS));
      for (const answer of answers) {
        const direct = repo.direct(answer.argv);
        expect({ exitCode: answer.exitCode, stdout: answer.stdout }, answer.argv.join(" ")).toEqual({
          exitCode: direct.status,
          stdout: direct.stdout,
        });
      }
    } finally {
      repo.remove();
    }
  });

  it("with more refs than its output holds, still primes the fixed reads and every local branch, first", async () => {
    const repo = primedRepo(3, 1500);
    try {
      const answers = await primeReads(repo.exec, () => true, 8 * 1024);
      const argvs = answers.map((answer) => answer.argv);
      expect(argvs.slice(0, FIXED_READS.length)).toEqual(FIXED_READS);
      for (const branch of ["main", "feature-0", "feature-1", "feature-2"])
        expect(argvs).toContainEqual(["for-each-ref", UPSTREAM_FORMAT, `refs/heads/${branch}`]);
      // The cut fell among the remote refs: some primed, the rest left.
      const remote = argvs.filter((argv) => argv[1] === "--verify");
      expect(remote.length).toBeGreaterThan(0);
      expect(remote.length).toBeLessThan(1500);
      for (const answer of answers) {
        const direct = repo.direct(answer.argv);
        expect({ exitCode: answer.exitCode, stdout: answer.stdout }, answer.argv.join(" ")).toEqual({
          exitCode: direct.status,
          stdout: direct.stdout,
        });
      }
    } finally {
      repo.remove();
    }
  });

  it("primes every branch and remote ref its output holds: none is left out by a count", () => {
    const refs = Array.from({ length: 2000 }, (_, index) => [
      `refs/heads/b${index}`,
      `refs/remotes/origin/b${index}`,
    ]).flat();
    const argvs = primeArgvs(refs);
    expect(argvs.filter((argv) => argv[0] === "for-each-ref")).toHaveLength(2000);
    expect(argvs.filter((argv) => argv[1] === "--verify")).toHaveLength(2000);
    // Past the 128 KiB one argument holds: the script goes on stdin.
    expect(primeScript(argvs).length).toBeGreaterThan(128 * 1024);
  });
});
