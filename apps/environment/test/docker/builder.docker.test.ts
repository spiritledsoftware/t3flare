// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off globalTimers:off
// `pnpm run test:docker` (SPI-1332): the Builder's scripts (apps/agents/src/workspace/builderScripts.ts) on the Workspace
// image (apps/sandbox-image/image/Dockerfile, built here for linux/amd64), as the Builder runs them through the
// platform's exec: a Container from the image with `sleep infinity` as its entrypoint, the files written from stdin, the
// run launched detached under every Variable, COMMAND_ENV and HOME=/root, its exit file polled. Not part of
// `pnpm run check`: it needs Docker and the network (an apt install).
//
//   pnpm --filter @t3flare/environment exec vitest run --config vitest.docker.config.ts test/docker/builder.docker.test.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";

import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  BUILDER_DIR,
  BUILDER_FILES,
  EXIT_SCRIPT,
  LAUNCH_SCRIPT,
  LAYDOWN_SCRIPT,
  PROOF_SCRIPT,
  RUN_SCRIPT,
  TAIL_SCRIPT,
  WRITE_SCRIPT,
} from "../../../agents/src/workspace/builderScripts.ts";

const here = import.meta.dirname;
const imageContext = path.resolve(here, "../../../sandbox-image/image");
const IMAGE = "t3flare-builder-test";
const NAME = `t3flare-builder-test-${process.pid}`;

const docker = (args: ReadonlyArray<string>, input?: string) => {
  const result = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The platform's exec as the Builder calls it: argv, an environment, stdin. */
const exec = (argv: ReadonlyArray<string>, options: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: string } = {}) =>
  docker(["exec", ...(options.stdin === undefined ? [] : ["-i"]), ...Object.entries(options.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]), NAME, ...argv], options.stdin);

/** The log's last `bytes`, as the Builder reads them. */
const tail = (bytes: number) => exec(["bash", "-c", TAIL_SCRIPT, "t3flare-builder", String(bytes)]).stdout;

const write = (file: string, text: string) => expect(exec(["bash", "-c", WRITE_SCRIPT, "t3flare-builder", file], { stdin: text }).code).toBe(0);

/** Writes the files and launches the run as `#starting` does; answers the exit code once the exit file holds it. */
const build = async (setup: string, mise: string, variables: Readonly<Record<string, string>>): Promise<number> => {
  write(BUILDER_FILES.setup, setup);
  write(BUILDER_FILES.mise, mise);
  write(BUILDER_FILES.laydown, LAYDOWN_SCRIPT);
  write(BUILDER_FILES.run, RUN_SCRIPT);
  const sha = createHash("sha256").update(mise).digest("hex");
  const launched = exec(["bash", "-c", LAUNCH_SCRIPT, "t3flare-builder", "7", sha, "environment"], { env: { ...variables, ...COMMAND_ENV, HOME: "/root" } });
  expect(launched.stdout.trim()).toBe("launched");
  for (let i = 0; i < 600; i++) {
    const code = exec(["bash", "-c", EXIT_SCRIPT]).stdout.trim();
    if (code !== "") return Number(code);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the run did not end");
};

beforeAll(() => {
  console.log("building the Workspace image (linux/amd64)…");
  const built = docker(["build", "-q", "--platform", "linux/amd64", "-t", IMAGE, imageContext]);
  if (built.code !== 0) throw new Error(built.stderr);
  const started = docker(["run", "-d", "--rm", "--platform", "linux/amd64", "--name", NAME, "--tmpfs", "/run", "--entrypoint", "sleep", IMAGE, "infinity"]);
  if (started.code !== 0) throw new Error(started.stderr);
}, 1_800_000);

afterAll(() => {
  docker(["rm", "-f", NAME]);
});

it("runs the Image setup as root with HOME=/root, every Variable and COMMAND_ENV, after laying down the Global mise config", async () => {
  const setup = [
    "set -e",
    'echo "home=$HOME user=$(id -un) cwd=$PWD"',
    'echo "token=$NPM_TOKEN mise=$MISE_GLOBAL_CONFIG_FILE"',
    "apt-get update -qq && apt-get install -y -qq jq > /dev/null",
    "mkdir -p /opt/marker && jq -n '{built: true}' > /opt/marker/marker.json",
  ].join("\n");
  const code = await build(setup, "", { NPM_TOKEN: "s3cr3t-value", MISE_GLOBAL_CONFIG_FILE: "the Variable loses" });
  const log = tail(65536);
  expect(code, log).toBe(0);
  expect(log).toContain("home=/root user=root cwd=/root");
  expect(log).toContain(`token=s3cr3t-value mise=${COMMAND_ENV.MISE_GLOBAL_CONFIG_FILE}`);
  expect(log).toContain("t3flare: the Image setup exited 0");
  expect(exec(["cat", "/opt/marker/marker.json"]).stdout).toContain('"built": true');
  // The Builder's own files are on /run (tmpfs): a snapshot does not capture them.
  expect(exec(["bash", "-c", `findmnt -no FSTYPE --target ${BUILDER_DIR}`]).stdout.trim()).toBe("tmpfs");
}, 600_000);

it("answers a failing Image setup's exit code and keeps its output's tail", async () => {
  const code = await build('echo "about to fail"\nexit 7\n', "", {});
  expect(code).toBe(7);
  const end = tail(40);
  expect(Buffer.byteLength(end)).toBeLessThanOrEqual(40);
  expect(end).toContain("exited 7");
}, 120_000);

it("lays down a Global mise config before the Image setup runs, which then has its tools", async () => {
  const mise = "[tools]\njq = 'latest'\n";
  const code = await build("mise which jq && echo laid", mise, {});
  const log = tail(65536);
  expect(code, log).toBe(0);
  expect(log).toContain("t3flare: laying down the Global mise config");
  expect(log).toContain('"laid":true');
}, 900_000);

it("finds no computerd under sleep: the proof is the image's own entrypoint's", () => {
  expect(exec(["bash", "-c", PROOF_SCRIPT]).code).not.toBe(0);
});
