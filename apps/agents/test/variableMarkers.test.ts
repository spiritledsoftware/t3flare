// @effect-diagnostics nodeBuiltinImport:off
// t3flare's internal markers win over a Variable (ADR-0046 §3, SPI-1329 review): a Variable named like a marker t3flare
// or t3 puts in a command's environment (`T3FLARE_PASSIVE_READ`, `T3FLARE_EXEC`, the handles, `T3CODE_THREAD_ID`) never
// reaches a command, so it cannot make every command look passive (skipping the Global mise lay-down) or stopped. The
// markers are derived from the code: every `T3FLARE_…`/`T3CODE_…` name a Workspace's code writes or reads.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BackendHandle, WorkspaceBackend } from "@cloudflare/computer";
import {
  fitVariableEnv,
  resolveEnvironment,
  setByT3flare,
  variableEnv,
  withheldFromCommands,
} from "@t3flare/harness-registry";
import { MODEL_HANDLE_ENV } from "@t3flare/models/relay";
import { describe, expect, it } from "vitest";

import { launchOf } from "../src/workspace/containerLaunch.ts";
import { ContainerStepsBackend, PASSIVE_MARKER } from "../src/workspace/containerStepsGate.ts";
import { VariablesBackend } from "../src/workspace/variables.ts";

/** computer-env's `EXEC_MARKER` (its index loads `cloudflare:` modules Node cannot): the sweep below finds it in the code. */
const EXEC_MARKER = "T3FLARE_EXEC";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every `.ts` file under `dir`, tests and declarations left out. */
const sources = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : sources(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") && !full.includes(`${path.sep}test${path.sep}`)
      ? [full]
      : [];
  });

/** The `T3FLARE_…` and `T3CODE_…` names in the code that runs commands in a Workspace. */
const markerNames = (): ReadonlyArray<string> => {
  const dirs = ["apps/agents/src/workspace", "apps/sandbox-image/src", "packages/computer-env/src"].map((dir) =>
    path.join(ROOT, dir),
  );
  const names = new Set<string>();
  for (const file of dirs.flatMap(sources))
    for (const match of readFileSync(file, "utf8").matchAll(/\b(T3FLARE|T3CODE)_[A-Z][A-Z0-9_]*\b/g))
      names.add(match[0]);
  return [...names].sort();
};

describe("the markers t3flare and t3 keep in a command's environment", () => {
  it("are derived from the code, the known ones among them", () => {
    expect(markerNames()).toEqual(expect.arrayContaining([PASSIVE_MARKER, EXEC_MARKER]));
  });

  it("are withheld from every command and noted on the Settings page", () => {
    for (const name of [...markerNames(), PASSIVE_MARKER, EXEC_MARKER, MODEL_HANDLE_ENV, "T3CODE_THREAD_ID"]) {
      expect(withheldFromCommands(name), name).toBe(true);
      expect(setByT3flare(name), name).toBe(true);
    }
    const variables = [PASSIVE_MARKER, EXEC_MARKER, "T3CODE_THREAD_ID", "NODE_ENV"].map((name) => ({
      name,
      value: "1",
      secret: false,
    }));
    expect(variableEnv(variables)).toEqual({ NODE_ENV: "1" });
    expect(
      launchOf({ settings: resolveEnvironment({ revision: 1, settings: { variables } }), source: "environment" })
        .variables,
    ).toEqual({ NODE_ENV: "1" });
    // A launch kept before this rule is read against it too.
    expect(fitVariableEnv({ [PASSIVE_MARKER]: "1", NODE_ENV: "1" })).toEqual({ NODE_ENV: "1" });
  });

  it("a Variable named T3FLARE_PASSIVE_READ does not make a command skip the Global mise lay-down", async () => {
    const sent: Array<Record<string, string> | undefined> = [];
    const asked: Array<string | undefined> = [];
    const inner = {
      id: "container-shell",
      type: "cloudflare-container",
      connect: async () =>
        ({
          runtimeId: "r1",
          rpc: {
            sync: {},
            shell: {
              exec: async (input: { env?: Record<string, string> }) => (sent.push(input.env), {} as never),
              getExec: async () => ({}) as never,
              killExec: async () => undefined,
              disposeExec: async () => undefined,
            },
          },
          close: async () => undefined,
        }) as unknown as BackendHandle,
    } as WorkspaceBackend;
    // As WorkspaceDO wires it: the Variables over the lay-down's gate, read from the kept launch.
    const launch = launchOf({
      settings: resolveEnvironment({
        revision: 1,
        settings: { variables: [{ name: PASSIVE_MARKER, value: "1", secret: false }] },
      }),
      source: "environment",
    });
    const backend = new VariablesBackend(
      new ContainerStepsBackend(inner, async (runtime) => void asked.push(runtime)),
      () => fitVariableEnv(launch.variables),
    );
    const handle = await backend.connect({} as never);
    await handle.rpc.shell.exec({ source: "node --version", env: {} } as never);
    expect(asked).toEqual(["r1"]);
    expect(sent[0]?.[PASSIVE_MARKER]).toBeUndefined();
  });
});
