// @effect-diagnostics globalConsole:off globalDate:off globalFetch:off nodeBuiltinImport:off
// SPI-1333's stage evidence: a Workspace's Container starts from the Base snapshot (ADR-0047 §6). Run through a test
// stage's `run`, which sets the stage's service token and admin token (never printed):
//
//   node scripts/stage.ts run <stage> p1333 ready          an Image setup that writes a marker and apt-installs figlet; the
//                                                          Base snapshot built (ready.json)
//   … start         a stopped Workspace starts from it: the marker and figlet are there, `launch.from` names it (start.json)
//   … fallback      the platform refuses the snapshot (a stage fault hands it a bogus id): the start goes again from the
//                   Workspace image within seconds, and the Builder builds again (fallback.json)
//   … image-change  after a redeploy whose Workspace image changed: a start waits for the new build (the default) and
//                   never starts the old snapshot (image-change.json)
//   … clear         the Image setup emptied
//   … record        the Builder's record, in a line
//
// Evidence goes to .evidence/base-start/ (or `--out <dir>`), each file naming the deployed commit.
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureProject } from "./lib/cliTurn.ts";
import { admin, base, pair, sleep } from "./lib/client.ts";
import { writeEvidence as writeFile } from "./lib/evidence.ts";
import { panelApi } from "./lib/relayEvidence.ts";

const outAt = process.argv.indexOf("--out");
const OUT = path.resolve(outAt === -1 ? path.resolve(import.meta.dirname, "../../../.evidence/base-start") : process.argv[outAt + 1]!);
const WORKSPACE = "p1333";
const MARKER = "/opt/p1333-marker";
const IMAGE_SETUP = `set -euo pipefail
echo "p1333 $(date -u +%FT%TZ)" > ${MARKER}
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends figlet
`;
const CHECK = `cat ${MARKER} 2>/dev/null || echo NO-MARKER; command -v figlet || echo NO-FIGLET`;

const deployedCommit = async (): Promise<string | null> => (await admin("GET", "/_t3flare/health")).json?.build?.commit ?? null;

const writeEvidence = async (name: string, value: Record<string, unknown>) => {
  writeFile(path.join(OUT, name), { host: base.host, commit: await deployedCommit(), ...value });
  console.log(`(ok: ${String(value.ok)})`);
};
const readEvidence = (name: string): any => {
  const file = path.join(OUT, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
};

const setEnvironment = async (settings: Record<string, unknown>) => {
  const answer = await panelApi("POST", "environment", { settings });
  if (answer.status !== 200) throw new Error(`environment change refused: ${answer.status} ${JSON.stringify(answer.json).slice(0, 300)}`);
  return answer.json as { revision: number };
};

const callOn = async (body: unknown) => {
  const answer = await admin("POST", `/_t3flare/agents/workspace-call?id=${WORKSPACE}`, body);
  return { status: answer.status, result: answer.json?.result ?? { error: String(answer.json).slice(0, 400) }, container: answer.json?.container } as { status: number; result: any; container: any };
};
const execTimed = async (script: string, timeoutMs = 20 * 60_000) => {
  const started = Date.now();
  const answer = await callOn({ exec: { script, timeoutMs } });
  return { ms: Date.now() - started, exitCode: answer.result?.exitCode as number | undefined, stdout: String(answer.result?.stdout ?? ""), stderr: String(answer.result?.stderr ?? answer.result?.error ?? "").slice(0, 600), from: answer.container?.launch?.from ?? null };
};
const stop = async () => {
  await admin("POST", `/_t3flare/agents/workspace-stop?id=${WORKSPACE}`);
  await sleep(2_000);
};
const record = async (): Promise<any> => (await admin("GET", "/_t3flare/agents/base-builder")).json;

/** Polls the Builder until `done` holds or `ms` passes; the records seen, each state once. */
const until = async (done: (r: any) => boolean, ms: number) => {
  const started = Date.now();
  const seen: Array<string> = [];
  let last: any;
  while (Date.now() - started < ms) {
    last = await record();
    const step = `${last?.state}${last?.phase === undefined ? "" : `/${last.phase}`}`;
    if (seen.at(-1) !== step) {
      seen.push(step);
      console.log(`builder: ${step}`);
    }
    if (done(last)) break;
    await sleep(10_000);
  }
  return { last, seen, ms: Date.now() - started };
};
const readyForKey = (r: any) => r?.state === "ready" && r.good !== null && r.good.key === r.key;

const ready = async () => {
  const { revision } = await setEnvironment({ imageSetup: IMAGE_SETUP, whileBuilding: "lastGood", whileBuildingNewImage: "wait" });
  const polled = await until((r) => (r?.revision ?? -1) >= revision && (readyForKey(r) || r?.state === "failed"), 25 * 60_000);
  await writeEvidence("ready.json", { revision, seen: polled.seen, record: polled.last, ms: polled.ms, ok: readyForKey(polled.last) });
};

const start = async () => {
  // The Workspace, as t3 makes one: the fixture repository cloned into a project.
  await ensureProject(await pair(), WORKSPACE);
  const builder = await record();
  await stop();
  const run = await execTimed(CHECK);
  const ok = readyForKey(builder) && run.exitCode === 0 && run.stdout.includes("p1333 ") && run.stdout.includes("/figlet") && run.from?.base?.snapshotId === builder.good.id;
  await writeEvidence("start.json", { builder: { key: builder?.key, good: builder?.good }, run, ok });
};

const fallback = async () => {
  const before = await record();
  await stop();
  const armed = await callOn({ baseFault: { snapshotId: `p1333-bogus-${Date.now()}` } });
  const run = await execTimed(CHECK);
  // The image has no marker or figlet; the start went again from it, within seconds rather than two 60 s connects.
  const fellBack = run.exitCode === 0 && run.stdout.includes("NO-MARKER") && typeof run.from?.image?.why === "string" && run.from.image.why.includes("refused") && run.ms < 60_000;
  const rebuilt = await until((r) => readyForKey(r) && r.good.id !== before?.good?.id, 25 * 60_000);
  await stop();
  const again = await execTimed(CHECK);
  await writeEvidence("fallback.json", {
    armed: armed.result,
    before: before?.good ?? null,
    run,
    rebuild: { seen: rebuilt.seen, good: rebuilt.last?.good ?? null, ms: rebuilt.ms },
    again,
    ok: fellBack && rebuilt.seen.some((step) => step.startsWith("building")) && again.from?.base?.snapshotId === rebuilt.last?.good?.id && again.stdout.includes("/figlet"),
  });
};

const imageChange = async () => {
  const earlier = readEvidence("fallback.json")?.rebuild?.good ?? readEvidence("ready.json")?.record?.good;
  if (earlier === undefined) throw new Error("run ready (and fallback) on the old image first");
  const before = await record();
  await stop();
  // The default (`whileBuildingNewImage: wait`): the start waits for the build on the new image.
  const run = await execTimed(CHECK);
  const after = await record();
  await writeEvidence("image-change.json", {
    earlier: { id: earlier.id, imageDigest: earlier.imageDigest },
    before: { state: before?.state, phase: before?.phase, good: before?.good ?? null },
    run,
    after: { state: after?.state, good: after?.good ?? null },
    ok: run.exitCode === 0 && run.stdout.includes("/figlet") && run.from?.base?.snapshotId !== earlier.id && after?.good?.imageDigest !== earlier.imageDigest && run.from?.base?.snapshotId === after?.good?.id,
  });
};

const clear = async () => {
  await setEnvironment({ imageSetup: "" });
  console.log("the Image setup is empty");
};

/** The Builder's record now, in a line. */
const show = async () => {
  const r = await record();
  console.log(JSON.stringify({ state: r?.state, phase: r?.phase, reason: r?.reason, revision: r?.revision, key: r?.key?.slice(0, 12), good: r?.good && { id: r.good.id, key: r.good.key.slice(0, 12), imageDigest: r.good.imageDigest.slice(-16) }, at: r?.at === undefined ? null : new Date(r.at).toISOString() }));
};

const commands: Record<string, () => Promise<void>> = { ready, start, fallback, "image-change": imageChange, clear, record: show };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: p1333.ts ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
await command();
