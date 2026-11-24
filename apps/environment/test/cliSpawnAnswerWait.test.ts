// The Answer wait at a CLI agent's spawn (SPI-1316): the process's MCP tool timeout is made from the wait as stored at
// its spawn (`cliToolTimeoutSec`), written into Codex's relay entries, and the process carries that wait to the channel
// (`ChannelStart.answerMs`), so its relay cards keep it for its life and a raised wait never outlasts the CLI's
// timeout.
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ModelEndpoints } from "@t3flare/models/endpoints";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { spawnCli } from "../src/agents/cliProcess.ts";
import type { ChannelStart } from "../src/agents/processChannel.ts";

const ENDPOINTS: ModelEndpoints = {
  revision: 1,
  endpoints: [
    {
      id: "openai",
      label: "openai",
      api: "openai-responses",
      baseUrl: "https://openai.example",
      auth: "api-key",
      headers: {},
      models: [
        {
          id: "gpt-5-mini",
          name: "gpt-5-mini",
          reasoning: false,
          input: ["text"],
          contextWindow: 1,
          maxTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          known: false,
        },
      ],
    },
  ],
} as unknown as ModelEndpoints;

const started: Array<ChannelStart> = [];
const bind = (ownerAnswerMs?: () => number, mcpCallMs?: () => number) =>
  bindEnvironmentServices({
    ...(ownerAnswerMs === undefined ? {} : { ownerAnswerMs }),
    ...(mcpCallMs === undefined ? {} : { mcpCallMs }),
    workspaces: {
      list: () => [],
      resolve: (id: string) => (id === "demo" ? { id } : undefined),
      get: () => undefined,
      worktreesOf: () => [],
    },
    agents: {
      WORKSPACES: {
        idFromName: (name: string) => name,
        get: () => ({ takeEnvironmentSkills: async (hash: string) => ({ taken: false, hash }) }),
      },
    },
    environmentSkills: () => ({ hash: () => undefined }),
    modelEndpoints: () => ENDPOINTS,
    faults: false,
    relayServers: () => ["commissary"],
    processes: {
      newKey: () => `proc-${started.length + 1}`,
      start: async (input: ChannelStart) => {
        started.push(input);
        return {
          cli: input.cli,
          pid: 1,
          running: true,
          exit: new Promise(() => undefined),
          kill: () => undefined,
          write: async () => undefined,
          closeStdin: async () => undefined,
          stdout: (async function* () {})(),
          stderr: (async function* () {})(),
        };
      },
    },
  } as unknown as EnvironmentServices);

const spawnCodex = (thread: string) =>
  Effect.runPromiseExit(
    spawnCli(
      ChildProcess.make("codex", ["app-server"], {
        cwd: "/w/demo",
        env: { T3CODE_THREAD_ID: thread },
      }) as ChildProcess.StandardCommand,
    ).pipe(Effect.scoped),
  );
const timeoutOf = (start: ChannelStart) => /tool_timeout_sec=(\d+),/.exec(start.argv.join(" "))?.[1];

afterEach(() => {
  started.length = 0;
  vi.restoreAllMocks();
  bindEnvironmentServices(undefined as unknown as EnvironmentServices);
});

describe("a CLI agent's spawn takes the Answer wait (SPI-1316)", () => {
  it("writes Codex's tool_timeout_sec from the wait at the spawn: 1,500 at the default wait, 3,900 at 30 minutes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // A 270-second MCP call time limit; off (the default since SPI-1386) adds the off deadline, a week, instead.
    const callMs = () => 270_000;
    bind(undefined, callMs);
    expect((await spawnCodex("spawn-default"))._tag).toBe("Success");
    expect(timeoutOf(started[0]!)).toBe("1500");
    bind(() => 30 * 60_000, callMs);
    expect((await spawnCodex("spawn-30"))._tag).toBe("Success");
    expect(timeoutOf(started[1]!)).toBe("3900");
  });

  it("gives each process of one thread the wait at its own spawn, so an older one keeps its own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let wait = 45 * 60_000;
    bind(
      () => wait,
      () => 270_000,
    );
    expect((await spawnCodex("spawn-kept"))._tag).toBe("Success");
    wait = 10 * 60_000;
    expect((await spawnCodex("spawn-kept"))._tag).toBe("Success");
    expect(started.map((start) => [start.thread, start.answerMs, timeoutOf(start)])).toEqual([
      ["spawn-kept", 45 * 60_000, "5700"],
      ["spawn-kept", 10 * 60_000, "1500"],
    ]);
  });
});

describe("a CLI agent's spawn takes the MCP call time limit (SPI-1359)", () => {
  it("writes Codex's tool_timeout_sec with the call time limit at the spawn in it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    bind(undefined, () => 3600_000);
    expect((await spawnCodex("spawn-long-call"))._tag).toBe("Success");
    // Two 10-minute waits, the hour's call, and 30 s.
    expect(timeoutOf(started[0]!)).toBe(String(1200 + 3600 + 30));
  });
});
