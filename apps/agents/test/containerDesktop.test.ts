// The Container desktop's screenshots (SPI-1446, SPI-1445 D7, D12, D13): `/workspace/.container-desktop` is a static
// Container-only path, so a screenshot there never syncs into the Workspace DO's files or shows in git; `agent-desktop`
// and `container-desktop` run on the Container; and the Durable agent's own `read` of a screenshot there reaches the
// Container and gives the model an image.
import type { Workspace } from "@cloudflare/computer";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputerWorkspaceStub, ContainerAccess, EnvRequest } from "@t3flare/computer-env";
import { describe, expect, it, vi } from "vitest";

import { routeCommand } from "../src/extensions/bash-routing.ts";
import { codingTools } from "../src/extensions/coding-tools.ts";
import { CONTAINER_IGNORE } from "../src/workspace/constants.ts";
import { containerPatterns } from "../src/workspace/containerOnly.ts";
import { context } from "./harness.fixture.ts";

// computer-env's `env.ts` loads computer, whose module loads `cloudflare:` URLs Node cannot; `read` runs none of it.
// computer-env's own copy of computer (pnpm installs it apart from this package's, with other peers) is the one mocked.
vi.mock("../../../packages/computer-env/node_modules/@cloudflare/computer", () => ({}));

const { ComputerExecutionEnv, isContainerOnly, WorkspaceEnvHost } = await import("@t3flare/computer-env");
type ComputerExecutionEnv = InstanceType<typeof ComputerExecutionEnv>;

const SCREENSHOT = "/workspace/.container-desktop/screenshots/20261126T120000.png";

/** A 1×1 PNG, as `agent-desktop screenshot` writes one (smaller). */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

/** The patterns a Container of a repo with one submodule starts with, as the Workspace DO makes them. */
const PATTERNS = containerPatterns(CONTAINER_IGNORE, ["t3code"]);

describe("the Container desktop's screenshots are Container-only (D12)", () => {
  it("keeps everything under /workspace/.container-desktop on the Container's disk", () => {
    expect(CONTAINER_IGNORE).toContain("/.container-desktop");
    expect(isContainerOnly("/workspace/.container-desktop", PATTERNS)).toBe(true);
    expect(isContainerOnly(SCREENSHOT, PATTERNS)).toBe(true);
    expect(isContainerOnly(SCREENSHOT, containerPatterns(CONTAINER_IGNORE, []))).toBe(true);
  });

  it("is anchored at the mount root: the repo's files of that name, and the harness's own, still sync", () => {
    expect(isContainerOnly("/workspace/repo/.container-desktop/x.png", PATTERNS)).toBe(false);
    expect(isContainerOnly("/workspace/repo/src/index.ts", PATTERNS)).toBe(false);
    expect(isContainerOnly("/workspace/.t3flare/tmp/x", PATTERNS)).toBe(false);
  });
});

describe("the Container desktop's commands run on the Container (D7)", () => {
  it.each([
    "agent-desktop screenshot",
    "container-desktop ensure",
    "DISPLAY=:99 agent-desktop click @e3 && ls",
    "agent-desktop snapshot | head -50",
  ])("routes `%s` to the Container without asking the Worker Shell", (command) => {
    expect(routeCommand(command)).toMatchObject({ backend: "container", unknown: [] });
  });
});

/**
 * A Workspace DO's file operations (`WorkspaceEnvHost`) over in-memory files, whose Container has `disk` and starts
 * with `PATTERNS`: its scripts are answered as bash would, a copy putting the file's bytes at the stage `S`.
 */
const workspaceOver = (disk: ReadonlyMap<string, Uint8Array>) => {
  const files = new Map<string, Uint8Array>();
  const ran: string[] = [];

  const missing = (path: string) => Object.assign(new Error(`no such file: ${path}`), { code: "ENOENT" });

  const statOf = async (path: string) => {
    const bytes = files.get(path);
    if (bytes === undefined) throw missing(path);
    return { isFile: true, isDirectory: false, isSymbolicLink: false, size: bytes.length, mtime: 1_000, inode: 1 };
  };

  // SAFETY: the operations `read` reaches use only these members of computer's Workspace.
  const workspace = {
    fs: {
      stat: statOf,
      lstat: statOf,
      mkdir: async () => undefined,
      writeFile: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      rm: async (path: string) => void files.delete(path),
      readFile: async (path: string, options?: { byteOffset?: number; byteLength?: number }) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw missing(path);
        const start = options?.byteOffset ?? 0;
        return new Response(bytes.slice(start, start + (options?.byteLength ?? bytes.length))).body;
      },
    },
    provider: () => ({
      realpath: async (path: string) => path,
      link: async (from: string, to: string) => {
        const bytes = files.get(from);
        if (bytes === undefined) throw missing(from);
        files.set(to, bytes);
      },
    }),
  } as unknown as Workspace;

  const container: ContainerAccess = {
    patterns: async () => PATTERNS,
    running: () => true,
    run: async (_script, env) => {
      const path = env["P"] ?? "";
      ran.push(path);
      const bytes = disk.get(path);
      if (bytes === undefined) return { exitCode: 10, stdout: "", stderr: "No such file or directory" };
      if (env["S"] !== undefined) files.set(env["S"], bytes);
      return { exitCode: 0, stdout: `regular file\t${bytes.length}\t1.000\n`, stderr: "" };
    },
  };

  const host = new WorkspaceEnvHost(workspace, container);

  // SAFETY: `read` uses only the stub's file operations.
  const stub = {
    fileOperation: (request: EnvRequest) => host.handle(request),
  } as unknown as ComputerWorkspaceStub;

  return { stub, files, ran };
};

const readTool = (): ToolRegistration => codingTools().tools!.find((tool) => tool.name === "read")!;

/** A tool call's api for `env`, on a model that takes images (pi-durable's defaults: no model is resolved). */
const apiOf = (env: ComputerExecutionEnv) =>
  ({
    env,
    agent: async () => ({}),
    models: { getModel: () => undefined },
  }) as unknown as ToolExecutionApi;

describe("the Durable agent's read of a screenshot (D13)", () => {
  it("reaches the Container and gives the model the PNG as an image", async () => {
    const { stub, files, ran } = workspaceOver(new Map([[SCREENSHOT, PNG]]));
    const env = new ComputerExecutionEnv({ workspace: stub, id: "w", cwd: "/workspace/repo", reachContainer: true });

    const result = await readTool().execute({ path: SCREENSHOT } as never, apiOf(env), context);

    const image = { type: "image", mimeType: "image/png", data: btoa(String.fromCharCode(...PNG)) };
    expect(result.isError).toBeUndefined();
    expect(result.output).toEqual([image]);
    expect(result.structuredOutput).toEqual(image);
    // Read on the Container, and the copy it staged is gone from the Workspace DO's files.
    expect(ran).toContain(SCREENSHOT);
    expect([...files.keys()]).toEqual([]);
  });
});
