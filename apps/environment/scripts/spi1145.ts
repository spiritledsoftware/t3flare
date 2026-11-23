// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1145: an admin call in flight keeps the Environment DO up, without counting as activity; the forced idle check
// alone still resets it.
//
//   node scripts/stage.ts run <stage> spi1145 [--repo octocat/Hello-World] [--seconds 45] [--out <file>]
//
// 1. Clones a small repo as a Workspace, then runs a `workspace-call` exec that sleeps `--seconds` (at least 30, for
//    at least 3 forced checks) and commits. While it runs, forces the idle check every 5 s: none may reset the DO, and
//    the exec must answer 200 with its commit made.
// 2. Polls the health route every 5 s (an admin call) and waits for the natural, unforced idle reset: the polls must
//    not postpone it.
// 3. Boots t3 again by pairing, then a forced idle check with nothing in flight must reset the DO.
import * as fs from "node:fs";

import { admin, pair, sleep, wsCall } from "./lib/client.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const repo = arg("repo") ?? "octocat/Hello-World";
const seconds = Number(arg("seconds") ?? 45);
if (!(seconds >= 30)) {
  console.error("--seconds must be at least 30: the exec must outlast 3 forced idle checks, 5 s apart");
  process.exit(2);
}
const report: Record<string, unknown> = { repo, seconds, at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
  return ok;
};
const finish = () => {
  const out = JSON.stringify({ ok: failures.length === 0, failures, ...report }, null, 2);
  const file = arg("out");
  if (file !== undefined) fs.writeFileSync(file, `${out}\n`);
  console.log(out);
  process.exit(failures.length === 0 ? 0 : 1);
};

const cookie = await pair();
const id = `s1145-${Date.now().toString(36)}`;
const cloned = (await wsCall(cookie, "sourceControl.cloneRepository", {
  remoteUrl: `https://github.com/${repo}.git`,
  destinationPath: `/w/${id}`,
}).catch((error: unknown) => ({ error: String(error).slice(0, 500) }))) as { cwd?: string; error?: string };
report.clone = cloned;
if (!check("clone", cloned.cwd === `/w/${id}`, cloned)) finish();

const idleCheck = async () => {
  const answer = await admin("POST", "/_t3flare/idle-check?force=1");
  return { at: new Date().toISOString(), http: answer.status, reset: answer.json?.reset, why: answer.json?.why };
};

// 1. A long exec, with the idle check forced while it runs.
const started = Date.now();
const exec = admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, {
  exec: {
    script: `sleep ${seconds} && git -c user.name=t -c user.email=t@x commit -q --allow-empty -m spi1145 && echo done`,
    cwd: "/workspace/repo",
    timeoutMs: (seconds + 60) * 1000,
  },
}).catch((error: unknown) => ({ status: 0, json: { error: String(error).slice(0, 300) } }));
let settled = false;
void exec.then(() => (settled = true));
const during: Array<Awaited<ReturnType<typeof idleCheck>>> = [];
await sleep(5000);
while (!settled && Date.now() - started < (seconds - 5) * 1000) {
  during.push(await idleCheck());
  await sleep(5000);
}
const answer = await exec;
const stdout: string | null =
  typeof answer.json?.result?.stdout === "string" ? answer.json.result.stdout.slice(0, 300) : null;
report.exec = {
  ms: Date.now() - started,
  http: answer.status,
  exitCode: answer.json?.result?.exitCode,
  stdout,
  error: answer.status === 200 ? null : JSON.stringify(answer.json ?? null).slice(0, 400),
};
report.idleChecksDuring = during;
check("the idle check was forced during the call", during.length >= 3, during);
check(
  "no forced idle check reset the DO during the call",
  during.every((d) => d.http === 200 && d.reset === false),
  during,
);
check(
  "each forced idle check during the call saw it in flight",
  during.every((d) => /admin calls in flight/.test(String(d.why))),
  during,
);
check("the exec answered 200 and finished", answer.status === 200 && (stdout ?? "").includes("done"), report.exec);
const log = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, {
  git: { argv: ["log", "-1", "--format=%s"], cwd: "/workspace/repo" },
});
report.commitCheck = { http: log.status, stdout: log.json?.result?.stdout ?? null };
check("the commit was made", String(log.json?.result?.stdout ?? "").trim() === "spi1145", report.commitCheck);

// 2. The natural reset, while the health route is polled every 5 s: an admin poll is not activity.
const health = async () => {
  const answer = await admin("GET", "/_t3flare/health");
  return {
    at: new Date().toISOString(),
    http: answer.status,
    runtime: answer.json?.runtime,
    constructedAt: answer.json?.object?.constructedAt,
    adminInFlight: answer.json?.activity?.adminInFlight,
    inFlight: answer.json?.activity?.inFlight,
    sockets: answer.json?.activity?.sockets,
  };
};
const polls: Array<Awaited<ReturnType<typeof health>>> = [await health()];
const constructedAt = polls[0]!.constructedAt;
const naturalStarted = Date.now();
while (Date.now() - naturalStarted < 5 * 60_000) {
  await sleep(5000);
  const poll = await health();
  polls.push(poll);
  if (poll.constructedAt !== constructedAt) break;
}
const reset = polls.at(-1)!;
report.naturalReset = {
  afterMs: Date.now() - naturalStarted,
  polls: polls.length,
  first: polls[0],
  last: reset,
};
check(
  "the natural idle reset came while health was polled every 5 s",
  reset.constructedAt !== constructedAt && reset.runtime === "stopped",
  report.naturalReset,
);

// 3. t3 booted again, nothing in flight: the forced idle check alone resets the DO (retried while something else
// still holds it).
await pair();
const after: Array<Awaited<ReturnType<typeof idleCheck>> & { confirmedBy?: unknown }> = [];
for (let attempt = 0; attempt < 12; attempt++) {
  const before = await health();
  const verdict = await idleCheck();
  // `checkIdle` aborts the object on a `setTimeout(0)` after answering, which can race the answer out: a 500 is a
  // reset if the object was constructed again with t3 stopped.
  if (verdict.http === 500) {
    const next = await health();
    after.push({ ...verdict, confirmedBy: next });
    if (next.constructedAt !== before.constructedAt && next.runtime === "stopped") break;
  } else {
    after.push(verdict);
    if (verdict.reset === true) break;
  }
  await sleep(5000);
}
report.idleChecksAfter = after;
const last = after.at(-1);
check(
  "a forced idle check alone resets the idle DO",
  last?.reset === true || (last?.http === 500 && (last.confirmedBy as any)?.runtime === "stopped"),
  after,
);
report.healthAfter = await health();
finish();
