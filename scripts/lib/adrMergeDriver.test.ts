// @effect-diagnostics nodeBuiltinImport:off
// The ADR merge driver's configuration (SPI-1401), on scratch repositories: `node --test`, so the root scripts need no
// test dependency. The driver's merges are adrMerge.test.ts's.
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { ADR_MERGE_DRIVER, configureAdrMergeDriver } from "./adrMergeDriver.ts";

// The scratch repositories see none of the machine's git config, nor a GIT_DIR this test was started under.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr-merge-driver-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};

let fixtures = 0;
/** A repository with one commit. */
const repository = () => {
  const dir = path.join(scratch, String(++fixtures));
  fs.mkdirSync(dir);
  git(dir, "init", "--quiet");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "one");
  return dir;
};

void describe("configureAdrMergeDriver", () => {
  void it("sets the adr-append merge driver once, for every worktree, and a second run changes nothing", () => {
    const dir = repository();
    const config = path.join(dir, ".git", "config");
    assert.equal(configureAdrMergeDriver(dir).kind, "configured");
    assert.equal(git(dir, "config", "--get", "merge.adr-append.name"), ADR_MERGE_DRIVER.name);
    assert.equal(git(dir, "config", "--get", "merge.adr-append.driver"), ADR_MERGE_DRIVER.driver);

    const linked = path.join(scratch, `${fixtures}-linked`);
    git(dir, "worktree", "add", "--quiet", "-b", "linked", linked);
    assert.equal(git(linked, "config", "--get", "merge.adr-append.driver"), ADR_MERGE_DRIVER.driver);
    const before = fs.readFileSync(config, "utf8");
    assert.deepEqual(configureAdrMergeDriver(linked), { kind: "unchanged" });
    assert.deepEqual(configureAdrMergeDriver(dir), { kind: "unchanged" });
    assert.equal(fs.readFileSync(config, "utf8"), before);
  });

  void it("rewrites a driver that differs from this checkout's", () => {
    const dir = repository();
    git(dir, "config", "merge.adr-append.driver", "true");
    assert.equal(configureAdrMergeDriver(dir).kind, "configured");
    assert.equal(git(dir, "config", "--get", "merge.adr-append.driver"), ADR_MERGE_DRIVER.driver);
  });

  void it("reports a checkout that is no git repository, configuring nothing", () => {
    const dir = path.join(scratch, "not-a-repository");
    fs.mkdirSync(dir);
    assert.equal(configureAdrMergeDriver(dir).kind, "failed");
  });
});
