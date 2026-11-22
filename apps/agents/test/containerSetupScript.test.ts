// The Container setup's wrapper script (ADR-0047 §7; apps/sandbox-image/src/containerSetup.ts), run for real in bash in
// the image's own Ubuntu base (pinned by digest as the Dockerfile pins it: uutils coreutils, util-linux's `flock`), as
// `globalMiseScript.test.ts` runs the lay-down's; skipped only without a Docker daemon, and failing in CI when the image
// cannot be pulled. The Owner's script goes in on stdin, as the Workspace DO sends it.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import { CONTAINER_SETUP_BOUNDS, CONTAINER_SETUP_SCRIPT, containerSetupArgv, containerSetupDeadlineMs, parseContainerSetupAnswer } from "@t3flare/sandbox-image/containerSetup";
import { beforeAll, describe, expect, it, type TestContext } from "vitest";

/** The final stage's base of apps/sandbox-image/image/Dockerfile, by the same digest. */
const IMAGE = "ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c";
const docker = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 20_000 }).status === 0;
let pulled = false;

const withImage = (name: string, fn: () => void) =>
  it(name, (context: TestContext) => {
    if (!pulled) context.skip();
    fn();
  });

/** Each run: `text` on stdin to the wrapper with `seconds` as its limit; answers each run's whole stdout. */
const run = (cases: ReadonlyArray<{ readonly text: string; readonly seconds?: number; readonly window?: number; readonly before?: string; readonly env?: string }>) => {
  const steps = cases
    .map(({ text, seconds = 60, window = 48 * 1024, before = "", env = "" }, index) => {
      const argv = containerSetupArgv("x".repeat(64), seconds, window).slice(3);
      return `${before}
printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > /t/in
sha=$(sha256sum /t/in | cut -c1-64)
echo "OUT ${index} $(cd /tmp && ${env} bash -c "$SCRIPT" ${argv[0]} "$sha" ${argv[2]} ${argv[3]} < /t/in 2>/dev/null | base64 -w0)"`;
    })
    .join("\n");
  const script = `mkdir -p /t
cat > /t/script.sh <<'T3FLARE_EOF'
${CONTAINER_SETUP_SCRIPT}
T3FLARE_EOF
SCRIPT=$(cat /t/script.sh)
${steps}
`;
  const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], { input: script, encoding: "utf8", timeout: 120_000 });
  const lines = result.stdout.split("\n");
  return cases.map((_, index) => {
    const line = lines.find((each) => each.startsWith(`OUT ${index} `))?.slice(`OUT ${index} `.length) ?? "";
    return parseContainerSetupAnswer(Buffer.from(line, "base64").toString("utf8"));
  });
};

describe.skipIf(!docker)("the Container setup's wrapper script", { timeout: 120_000 }, () => {
  beforeAll(() => {
    pulled = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" }).status === 0 || spawnSync("docker", ["pull", "-q", IMAGE], { encoding: "utf8", timeout: 300_000 }).status === 0;
    if (!pulled && process.env.CI !== undefined) throw new Error(`could not pull ${IMAGE}`);
  }, 320_000);

  withImage("runs the Owner's script in / with HOME=/root, its stdout and stderr together, and answers its exit", () => {
    const [ok, failed] = run([{ text: 'echo "pwd=$(pwd) home=$HOME"\necho oops >&2\n' }, { text: "echo first\nexit 3\n", env: "HOME=/elsewhere" }]);
    expect(ok).toMatchObject({ answer: { exitCode: 0, timedOut: false }, output: "pwd=/ home=/root\noops\n" });
    expect(failed).toMatchObject({ answer: { exitCode: 3, timedOut: false }, output: "first\n" });
  });

  withImage("stops a script at its time limit: 124 after TERM, 137 after the KILL", () => {
    const [term, kill] = run([
      { text: "echo started\nsleep 30\n", seconds: 1 },
      { text: "trap '' TERM\necho stubborn\nsleep 30\n", seconds: 1 },
    ]);
    expect(term).toMatchObject({ answer: { exitCode: 124, timedOut: true }, output: "started\n" });
    expect(kill).toMatchObject({ answer: { exitCode: 137, timedOut: true } });
  });

  withImage("tells a script's own exit 124 or 137 from its time limit", () => {
    const [own124, own137] = run([{ text: "echo quick\nexit 124\n", seconds: 30 }, { text: "exit 137\n", seconds: 30 }]);
    expect(own124).toMatchObject({ answer: { exitCode: 124, timedOut: false }, output: "quick\n" });
    expect(own137).toMatchObject({ answer: { exitCode: 137, timedOut: false } });
  });

  withImage("a broken exec that kills the wrapper leaves the run going; a retry waits for it and answers it, never running the script again", () => {
    // The first try is killed a second in (as a broken exec kills it); the retry starts at once.
    const script = `mkdir -p /t
cat > /t/script.sh <<'T3FLARE_EOF'
${CONTAINER_SETUP_SCRIPT}
T3FLARE_EOF
printf 'echo run >> /root/runs\nsleep 3\necho finished\nexit 4\n' > /t/in
sha=$(sha256sum /t/in | cut -c1-64)
bash -c "$(cat /t/script.sh)" t3flare-container-setup "$sha" 60 65536 < /t/in > /t/first 2>/dev/null &
first=$!
sleep 1
kill -9 $first
echo "RETRY $(bash -c "$(cat /t/script.sh)" t3flare-container-setup "$sha" 60 65536 < /t/in 2>/dev/null | base64 -w0)"
echo "RUNS $(wc -l < /root/runs)"
`;
    const result = spawnSync("docker", ["run", "--rm", "-i", IMAGE, "bash", "-s"], { input: script, encoding: "utf8", timeout: 120_000 });
    const field = (name: string) => result.stdout.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
    expect(field("RUNS")).toBe("1");
    expect(parseContainerSetupAnswer(Buffer.from(field("RETRY"), "base64").toString("utf8"))).toMatchObject({ answer: { exitCode: 4, timedOut: false }, output: "finished\n" });
  });

  withImage("answers only the window it is given of a long output", () => {
    const [long] = run([{ text: `head -c 20000 /dev/zero | tr '\\0' a\necho END\n`, window: 8192 }]);
    expect(long?.output.length).toBe(8192);
    expect(long?.output.endsWith("aaaaEND\n")).toBe(true);
  });

  withImage("runs a script once per disk: the same script again answers the first run's exit and output", () => {
    const [first, again, other] = run([{ text: "echo ran >> /root/count\ncat /root/count | wc -l\nexit 5\n" }, { text: "echo ran >> /root/count\ncat /root/count | wc -l\nexit 5\n" }, { text: "echo other\n" }]);
    expect(first).toMatchObject({ answer: { exitCode: 5 }, output: "1\n" });
    expect(again).toEqual(first);
    expect(other).toMatchObject({ answer: { exitCode: 0 }, output: "other\n" });
  });

  withImage("answers locked when another run holds the lock past its bound", () => {
    const before = `mkdir -p /stub && printf '#!/bin/bash\\nexit 1\\n' > /stub/flock && chmod +x /stub/flock`;
    const [locked] = run([{ text: "echo never\n", before, env: "PATH=/stub:$PATH" }]);
    expect(locked).toMatchObject({ answer: { locked: true }, output: "" });
  });
});

describe("containerSetupDeadlineMs", () => {
  it("waits for the lock, the script's limit, its KILL and a minute's margin", () => {
    const seconds = 5 * 60;
    const lock = seconds + CONTAINER_SETUP_BOUNDS.killAfter + CONTAINER_SETUP_BOUNDS.lockMargin;
    expect(containerSetupDeadlineMs(5)).toBe((lock + seconds + CONTAINER_SETUP_BOUNDS.killAfter + 60) * 1000);
  });
});

describe("parseContainerSetupAnswer", () => {
  const good = { sha256: "a".repeat(64), exitCode: 0, timedOut: false, ms: 3 };
  const marked = (output: string, answer: unknown) => `${output}\n@@t3flare-container-setup@@${JSON.stringify(answer)}\n`;

  it("splits the output from the answer after the last mark, so the Owner's own mark is output", () => {
    expect(parseContainerSetupAnswer(marked("hello\n", good))).toEqual({ output: "hello\n", answer: good });
    expect(parseContainerSetupAnswer(marked("@@t3flare-container-setup@@{}\n", good))).toEqual({ output: "@@t3flare-container-setup@@{}\n", answer: good });
  });

  it("answers nothing from text that is not an answer, field by field", () => {
    for (const bad of [{ sha256: "x" }, { exitCode: "0" }, { timedOut: "no" }, { ms: -1 }, { locked: 1 }]) expect(parseContainerSetupAnswer(marked("", { ...good, ...bad }))).toBeUndefined();
    expect(parseContainerSetupAnswer("bash: flock: command not found\n")).toBeUndefined();
    expect(parseContainerSetupAnswer("")).toBeUndefined();
  });
});
