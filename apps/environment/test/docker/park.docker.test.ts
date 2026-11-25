// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
// SPI-1389 in `pnpm run test:docker`: park and resume with each real CLI (Claude Code, Codex, OpenCode, pi), launched
// as the Workspace DO launches it, on the stand-in model relay (keyhost.mjs; no model is called), against the
// Environment's own MCP relay (`relayMessage`), parked-card store (`parkedCards`) and argument hash (`argsHashOf`),
// which run here in the test's process; the keyhost forwards the CLI's `/t3flare/mcp/` requests to them.
//
// t3's adapter, and with it the CLI wrapper that times a park, raises the question and reads the answer message, is not
// in this harness (the drivers speak each CLI's own protocol): `cliCard.test.ts` covers it. Here the park is what the
// wrapper does to the CLI: the held relay call answered with the parked text (`parkedCallText`), the card's record kept as the wrapper
// keeps it, and the process killed. The answer turn is a new process, given the text the wrapper gives it
// (`answerTurnText`, `park.ts`). What is the CLI's own, and checked here:
// - it calls the relayed tool through the relay, and takes the parked answer as a complete tool result (the model sees
//   it, and the turn goes on);
// - after the kill, a new process's repeated call reaches the relay with the same arguments' hash, so the allowance
//   lets it run once without a card; the next repeat asks again;
// - (Claude Code, OpenCode, Codex) the CLI's own approval request, cancelled as a park cancels it, comes back in the
//   answer turn's process the same; its whole call, read off each process's lines by the wrapper's own recorder
//   (`nativeCalls.ts`), takes the parked call's allowance once. pi has none of its own.
// Not driven here: an MCP server's question and an Open change. Both are cards the Environment raises during a relayed
// call (the MCP host's elicitation, the Settings server's change), which this harness's relay has neither of; to the CLI
// each is the same held relay call answered "parked", which the relay card's test covers. Their own parks are tested
// with the Environment's code (`cliCard.test.ts`, `settingsCard.test.ts`).
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { CLI_MCP_START_SECONDS, cliToolTimeoutSec, type McpRelayInput } from "@t3flare/harness-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { relayUrl } from "../../src/agents/cliProfiles.ts";
import type { McpView } from "../../src/mcp/host.ts";
import { argsHashOf } from "../../src/mcp/canonical.ts";
import { relayMessage } from "../../src/mcp/relay.ts";
import { nativeCallRecorder, nativeProtocolOf } from "../../src/provider/cli/nativeCalls.ts";
import { answerTurnText, parkedCallText } from "../../src/provider/cli/park.ts";
import { parkedCards, type ParkedCard } from "../../src/provider/cli/parked.ts";
import { nodeSqlStorage, nodeTransaction } from "../nodeSqlStorage.ts";
import {
  type Cli,
  docker,
  driveAsync,
  EXTENSION,
  launchOf,
  removeMounted,
  runCommand,
  startHarness,
  T3_PATH,
} from "./cliHarness.ts";

/** A parked-card store over a fresh in-memory SQLite, its transactions real. */
const nodeParkedCards = () => {
  const sql = nodeSqlStorage();
  return parkedCards(sql, nodeTransaction(sql));
};

const here = import.meta.dirname;
const SERVER = "fixture";
const TOOL = "fixture_note";
const ARGS = { line: "parked-probe" };
const THREAD = "thread-park";
const NAME = "t3flare-park";

const VIEW: McpView = {
  version: "v",
  servers: [
    {
      name: SERVER,
      kind: "direct",
      state: "available",
      listedAt: 1,
      exposure: "deferred",
      tools: [
        {
          name: `mcp__${SERVER}__${TOOL}`,
          upstream: TOOL,
          description: "Notes a line.",
          inputSchema: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
          hash: "h-note",
          class: "write",
          hinted: "write",
          exposure: "deferred",
        },
      ],
    },
  ],
} as McpView;

/** How the stand-in owner answers the relay's card: the park, as the wrapper's timer does it, or a decline. */
type Owner = "park" | "decline";

/** The Environment's relay over this test's store, served for the keyhost; what it asked and ran. */
const relayHost = () => {
  const store = nodeParkedCards();
  const asks: Array<{ readonly tool: string; readonly argsHash: string }> = [];
  const ran: Array<Readonly<Record<string, unknown>>> = [];
  const parked: Array<ParkedCard> = [];
  const accepted = new Map<string, Set<string>>();
  let owner: Owner = "park";
  let cli = "claude";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      // The relay is stateless and tools only: no event stream to open, nothing to close (as the Workspace DO answers).
      if (req.method !== "POST") return void res.writeHead(405).end();
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return void res.writeHead(400).end();
      }
      const input: McpRelayInput = {
        workspace: "ws-park",
        thread: THREAD,
        cli,
        server: (req.url ?? "").split("/").at(-1) ?? SERVER,
        message,
        askId: randomUUID(),
      };
      const answer = await relayMessage(input, {
        view: async () => VIEW,
        call: async (call) => {
          ran.push(call.args);
          return { kind: "result", isError: false, text: `noted: ${String(call.args.line)}` };
        },
        state: () => ({ runtimeMode: "approval-required", interactionMode: "default" }),
        ask: async (ask) => {
          asks.push({ tool: ask.call.tool, argsHash: ask.call.argsHash });
          if (owner === "decline") return { approved: false, reason: "decline" };
          // The park: the card's record, as the wrapper keeps it, then the held call's answer.
          const card: ParkedCard = {
            id: `runtime-request:${cli}:t3flare-park:${randomUUID()}`,
            thread: THREAD,
            kind: "tool",
            call: ask.call,
            title: ask.title,
            parkedAt: Date.now(),
          };
          store.park(card);
          parked.push(card);
          return { approved: false, parked: parkedCallText({ by: "park", minutes: 10 }, "tool") };
        },
        allowance: (thread, call) => store.take(thread, "tool", call),
        accepted: {
          has: (thread, key) => accepted.get(thread)?.has(key) === true,
          add: (thread, key) => void accepted.set(thread, new Set([...(accepted.get(thread) ?? []), key])),
        },
        log: () => undefined,
      });
      if (answer.kind === "accepted") return void res.writeHead(202).end();
      // As the Workspace DO answers a handle it refuses.
      if (answer.kind === "refused") return void res.writeHead(answer.status).end(answer.message);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  return {
    store,
    asks,
    ran,
    parked,
    server,
    reset: (next: string) => {
      cli = next;
      owner = "park";
      asks.length = 0;
      ran.length = 0;
      parked.length = 0;
      accepted.clear();
    },
    setOwner: (next: Owner) => void (owner = next),
  };
};

const relay = relayHost();
let harness: ReturnType<typeof startHarness>;
const handle = randomBytes(32).toString("hex");

beforeAll(async () => {
  await new Promise<void>((resolve) => relay.server.listen(0, "0.0.0.0", resolve));
  const port = (relay.server.address() as AddressInfo).port;
  harness = startHarness(NAME, {
    modelHandle: handle,
    mcpUpstream: `http://host.docker.internal:${port}`,
    callTool: { name: TOOL, args: ARGS },
  });
}, 600_000);

afterAll(() => {
  harness?.stop();
  relay.server.close();
});

/** The keyhost's model-relay lines, in order. */
const modelLines = () =>
  docker(["logs", `${NAME}-keyhost`])
    .stdout.split("\n")
    .filter((line) => line.includes('"model-relay"'))
    .map(
      (line) =>
        JSON.parse(line) as {
          called: string | null;
          relayResult: string | null;
          path: string;
          tools: ReadonlyArray<string>;
        },
    );

/** The keyhost's MCP relay lines (each request the CLI sent to the relay), and its failed forwards. */
const mcpLines = () =>
  docker(["logs", `${NAME}-keyhost`])
    .stdout.split("\n")
    .filter((line) => line.includes('"mcp-relay'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Waits until `check` holds, at most `ms`. */
const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return check();
};

/**
 * One CLI process's launch and its driver scenario for `prompts` (the first, then more in the same session), on `on`'s
 * harness. `permission: "cancel"` answers the CLI's own approval requests as a park does; else they are allowed.
 */
const processOf = (
  cli: Cli,
  marker: string,
  workspace: string,
  prompts: ReadonlyArray<string>,
  permission?: "cancel",
  on: ReturnType<typeof startHarness> = harness,
) => {
  const toolHandle = randomBytes(32).toString("hex");
  const relayEntries = {
    handle: toolHandle,
    servers: [SERVER],
    toolTimeoutSec: cliToolTimeoutSec(10 * 60_000, 0),
    startTimeoutSec: CLI_MCP_START_SECONDS,
  };
  const args =
    cli === "codex"
      ? ["app-server"]
      : cli === "opencode"
        ? ["acp"]
        : cli === "pi"
          ? [
              "--mode",
              "rpc",
              "--extension",
              EXTENSION,
              "--provider",
              "t3flare-endpoint-probe",
              "--model",
              "claude-haiku-5-5",
            ]
          : [];
  const launch = launchOf(
    { cli, args, key: marker, env: cli === "pi" ? { T3_PI_RUNTIME_MODE: "approval-required" } : {} },
    relayEntries,
  );
  const command = runCommand({
    harness: on,
    name: NAME,
    launch: { ...launch, env: { ...launch.env, T3FLARE_MODEL_HANDLE: handle } },
    marker,
    workspace,
    // An init as PID 1, as a Container's exec gives the launcher a parent: run as PID 1, `setsid --wait` reaps the CLI's
    // orphaned children too, and exits 1 at the first that is not its own (Codex's, now and then mid-turn).
    dockerArgs: ["--init"],
  });
  // As t3's ACP adapter hands the relay's servers to Claude Code and OpenCode (acpDriver.ts).
  const mcpServers = [
    {
      type: "http",
      name: SERVER,
      url: relayUrl(SERVER),
      headers: [{ name: "Authorization", value: `Bearer ${toolHandle}` }],
    },
  ];
  const [first, ...more] = prompts;
  if (cli === "codex")
    return {
      command,
      driver: "codex-rpc.mjs",
      scenario: {
        model: "probe/claude-haiku-5-5",
        cwd: T3_PATH,
        prompt: first,
        turns: prompts.length,
        timeoutMs: 240_000,
        // As t3's Codex adapter asks for a thread that needs approval; a park cancels the request.
        threadParams: { approvalPolicy: "untrusted" },
        approve: permission === "cancel" ? "cancel" : "accept",
      },
    };
  if (cli === "pi")
    return {
      command,
      driver: "pi-rpc.mjs",
      scenario: { commands: prompts.map((message) => ({ type: "prompt", message })), timeoutMs: 240_000 },
    };
  return {
    command,
    driver: "acp-rpc.mjs",
    scenario: {
      cwd: T3_PATH,
      waitMs: 20_000,
      settleMs: 3000,
      timeoutMs: 240_000,
      ...(cli === "opencode" ? { model: "t3flare-endpoint-probe/claude-haiku-5-5" } : {}),
      mcpServers,
      prompt: first,
      prompts: more,
      ...(permission === undefined ? {} : { permission }),
    },
  };
};

describe.each<Cli>(["claude", "codex", "opencode", "pi"])(
  "%s parks on a relay call and resumes on the answer",
  (cli) => {
    it("parks the held call, and the answer turn's repeat runs once on its allowance", async () => {
      relay.reset(cli);
      const workspace = workspaceFor(`.park-${cli}-`);
      const report: Record<string, unknown> = { cli };
      try {
        // The parked turn: the call is held, parked, and the process killed once the parked answer reached the model.
        const seen = modelLines().length;
        const firstMarker = `proc-${randomUUID()}`;
        const first = processOf(cli, firstMarker, workspace, ["Note the line."], "cancel");
        const firstRun = driveAsync(first.driver, first.scenario, first.command);
        const parkedSeen = await until(
          () =>
            modelLines()
              .slice(seen)
              .some((line) => line.relayResult === "parked"),
          180_000,
        );
        docker(["kill", `${NAME}-${firstMarker}`], { quiet: true });
        const firstSummary = await firstRun;
        report.first = {
          parkedSeen,
          asks: relay.asks.length,
          ran: relay.ran.length,
          permissions: firstSummary.permissions ?? null,
          errors: firstSummary.errors ?? null,
          stderr: String(firstSummary.stderr ?? firstSummary.driverFailed ?? "").slice(-600),
          model: modelLines()
            .slice(seen)
            .slice(0, 6)
            .map((line) => ({
              called: line.called,
              relayResult: line.relayResult,
              tools: line.tools.slice(0, 40),
              mentions: (line as { mentions?: unknown }).mentions,
            })),
          mcp: mcpLines().slice(-12),
        };
        const text = () => JSON.stringify(report);
        expect(relay.parked.length, text()).toBe(1);
        expect(relay.ran, text()).toEqual([]);
        expect(parkedSeen, text()).toBe(true);
        const card = relay.parked[0]!;
        expect(card.call?.tool, text()).toBe(`${SERVER}/${TOOL}`);

        // The answer: allowed once. A new process takes the answer turn, then one more prompt in the same session.
        relay.store.answer(card.id, "accept");
        relay.setOwner("decline");
        const secondMarker = `proc-${randomUUID()}`;
        const second = processOf(cli, secondMarker, workspace, [
          answerTurnText(card, "accept", "Allow", undefined),
          "Note the line again.",
        ]);
        const secondSeen = modelLines().length;
        const secondMcp = mcpLines().length;
        const secondSummary = await driveAsync(second.driver, second.scenario, second.command);
        report.second = {
          summary: JSON.stringify(secondSummary).slice(0, 1500),
          model: modelLines()
            .slice(secondSeen)
            .slice(0, 8)
            .map((line) => ({ called: line.called, relayResult: line.relayResult })),
          mcp: mcpLines().slice(secondMcp).length,
          asks: relay.asks.slice(1),
          ran: [...relay.ran],
          permissions: secondSummary.permissions ?? null,
          errors: secondSummary.errors ?? null,
          stderr: String(secondSummary.stderr ?? secondSummary.driverFailed ?? "").slice(-600),
        };
        // The repeat ran on the allowance, with no card; the next one asked again and was declined.
        expect(relay.ran, text()).toEqual([ARGS]);
        expect(relay.asks.length, text()).toBe(2);
        expect(relay.asks[1], text()).toEqual(relay.asks[0]);
        expect(relay.store.take(THREAD, "tool", card.call!), text()).toBeUndefined();
      } finally {
        const left = docker(["ps", "-aq", "--filter", `name=${NAME}-proc-`], { quiet: true }).stdout.split("\n");
        if (left.some((id) => id !== "")) docker(["rm", "-f", ...left.filter((id) => id !== "")], { quiet: true });
        removeMounted(workspace);
      }
    });
  },
);

/** A workspace with the fixture's repository, writable by the container's user. */
const workspaceFor = (prefix: string) => {
  const workspace = fs.mkdtempSync(path.join(here, prefix));
  fs.mkdirSync(path.join(workspace, "repo"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path.join(workspace, "repo") });
  fs.chmodSync(workspace, 0o777);
  return workspace;
};

// The CLI's own approval request (the `native` card kind): a park cancels it and ends the process; the answer turn's
// process asks again, and the wrapper allows the repeat once when its request matches the cancelled one (its kind and
// text, from the same tool call). The match itself is the wrapper's (`cliCard.test.ts`); here, that each CLI's repeat
// is the same request. pi has no approval requests of its own: its tools run, and the relay's cards are its only ones.
describe("a CLI's own approval request, cancelled by a park, comes back the same in the answer turn's process", () => {
  let native: ReturnType<typeof startHarness>;
  beforeAll(() => {
    // The relay here too, so each CLI's relay entry starts as it does in a Container (no tool is called through it).
    const port = (relay.server.address() as AddressInfo).port;
    native = startHarness(`${NAME}-native`, {
      modelHandle: handle,
      codexShell: true,
      mcpUpstream: `http://host.docker.internal:${port}`,
    });
  }, 600_000);
  afterAll(() => native?.stop());

  /** The CLI's approval requests in a driver's summary, as comparable values. */
  const requestsOf = (cli: Cli, summary: any): ReadonlyArray<unknown> =>
    cli === "codex"
      ? (summary.approvals ?? []).map((entry: { method: string; command: unknown }) => ({
          method: entry.method,
          command: entry.command,
        }))
      : (summary.permissions ?? []);

  /**
   * The CLI's first approval request in a driver's log, and its whole call as the wrapper reads it off the process
   * (`nativeCalls.ts`, by the native id t3 gives the request): every line the CLI wrote, through the real recorder.
   */
  const firstCallOf = (cli: Cli, log: string): { readonly nativeId: string; readonly call: unknown } | undefined => {
    const recorder = nativeCallRecorder(nativeProtocolOf(cli === "claude" ? "claude-agent-acp" : cli));
    let nativeId: string | undefined;
    for (const line of fs.readFileSync(log, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as { dir: string; msg: { method?: string; params?: Record<string, any> } };
      if (entry.dir !== "in") continue;
      recorder.observe(JSON.stringify(entry.msg));
      const { method, params } = entry.msg;
      if (nativeId !== undefined || params === undefined) continue;
      if (method === "session/request_permission") nativeId = params.toolCall?.toolCallId;
      else if (method?.endsWith("/requestApproval")) nativeId = params.approvalId ?? params.itemId;
    }
    return nativeId === undefined ? undefined : { nativeId, call: recorder.callOf(nativeId) };
  };

  it.each<Cli>(["claude", "opencode", "codex"])("%s", async (cli) => {
    const workspace = workspaceFor(`.park-native-${cli}-`);
    const logs = fs.mkdtempSync(path.join(os.tmpdir(), `park-native-${cli}-`));
    const report: Record<string, unknown> = { cli };
    try {
      const firstMarker = `proc-${randomUUID()}`;
      const first = processOf(cli, firstMarker, workspace, ["Write your environment to a file."], "cancel", native);
      const firstSummary = await driveAsync(first.driver, first.scenario, first.command, path.join(logs, "1.log"));
      // The park ends the process; its turn already ended on the cancel.
      docker(["kill", `${NAME}-${firstMarker}`], { quiet: true });
      // The park's record: the cancelled request's whole call, as the wrapper reads it and keeps it.
      const cancelled = firstCallOf(cli, path.join(logs, "1.log"));
      const store = nodeParkedCards();
      const parkedCall =
        cancelled?.call === undefined ? undefined : { tool: "native", argsHash: await argsHashOf(cancelled.call) };
      const card: ParkedCard = {
        id: "runtime-request:native:t3flare-park:1",
        thread: THREAD,
        kind: "native",
        title: "env > /workspace/shell-env.txt",
        ...(parkedCall === undefined ? {} : { call: parkedCall }),
        parkedAt: Date.now(),
      };
      store.park(card);
      store.answer(card.id, "accept");
      const second = processOf(
        cli,
        `proc-${randomUUID()}`,
        workspace,
        [answerTurnText(card, "accept", "Allow", undefined)],
        undefined,
        native,
      );
      const secondSummary = await driveAsync(second.driver, second.scenario, second.command, path.join(logs, "2.log"));
      const repeated = firstCallOf(cli, path.join(logs, "2.log"));
      report.first = {
        requests: requestsOf(cli, firstSummary),
        call: cancelled ?? null,
        summary: JSON.stringify(firstSummary).slice(0, 1200),
      };
      report.second = {
        requests: requestsOf(cli, secondSummary),
        call: repeated ?? null,
        summary: JSON.stringify(secondSummary).slice(0, 1200),
      };
      const text = JSON.stringify(report);
      expect(requestsOf(cli, firstSummary).length, text).toBeGreaterThan(0);
      expect(requestsOf(cli, secondSummary)[0], text).toEqual(requestsOf(cli, firstSummary)[0]);
      // The wrapper's allowance check: the repeat's whole call takes the allowance, once.
      expect(parkedCall, text).toBeDefined();
      expect(repeated?.call, text).toBeDefined();
      const repeat = { tool: "native", argsHash: await argsHashOf(repeated!.call) };
      expect(store.take(THREAD, "native", repeat), text).toEqual({ forSession: false });
      expect(store.take(THREAD, "native", repeat), text).toBeUndefined();
    } finally {
      const left = docker(["ps", "-aq", "--filter", `name=${NAME}-proc-`], { quiet: true }).stdout.split("\n");
      if (left.some((id) => id !== "")) docker(["rm", "-f", ...left.filter((id) => id !== "")], { quiet: true });
      removeMounted(workspace);
      fs.rmSync(logs, { recursive: true, force: true });
    }
  });
});
