// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off
// SPI-1145: an admin call in flight keeps the Environment DO up; the forced idle check alone still resets it.
//
//   node scripts/stage.ts run <stage> spi1145 [--repo octocat/Hello-World] [--seconds 45] [--out <file>]
//
// Clones a small repo as a Workspace, then runs a `workspace-call` exec that sleeps `--seconds` and commits. While it
// runs, forces the idle check every 5 s: none may reset the DO, and the exec must answer 200 with its commit made.
// After it, a forced idle check with nothing in flight must reset the DO.
import * as fs from "node:fs";

import { admin, pair, sleep, wsCall } from "./lib/client.ts";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const repo = arg("repo") ?? "octocat/Hello-World";
const seconds = Number(arg("seconds") ?? 45);
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
report.exec = {
  ms: Date.now() - started,
  http: answer.status,
  exitCode: answer.json?.result?.exitCode,
  stdout: typeof answer.json?.result?.stdout === "string" ? answer.json.result.stdout.slice(0, 300) : null,
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
  during.every((d) => /requests in flight/.test(String(d.why))),
  during,
);
check(
  "the exec answered 200 and finished",
  answer.status === 200 && String((report.exec as any).stdout ?? "").includes("done"),
  report.exec,
);
const log = await admin("POST", `/_t3flare/agents/workspace-call?id=${encodeURIComponent(id)}`, {
  git: { argv: ["log", "-1", "--format=%s"], cwd: "/workspace/repo" },
});
report.commitCheck = { http: log.status, stdout: log.json?.result?.stdout ?? null };
check("the commit was made", String(log.json?.result?.stdout ?? "").trim() === "spi1145", report.commitCheck);

// 2. Nothing in flight: the forced idle check alone resets the DO (retried while something else still holds it).
const after: Array<Awaited<ReturnType<typeof idleCheck>>> = [];
for (let attempt = 0; attempt < 12; attempt++) {
  const verdict = await idleCheck();
  after.push(verdict);
  if (verdict.reset === true) break;
  await sleep(5000);
}
report.idleChecksAfter = after;
check("a forced idle check alone resets the idle DO", after.at(-1)?.reset === true, after);
const health = await admin("GET", "/_t3flare/health");
report.healthAfter = { runtime: health.json?.runtime, constructions: health.json?.isolate?.constructions };
finish();
