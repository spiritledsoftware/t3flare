// @effect-diagnostics nodeBuiltinImport:off
// Patch 0011: t3's secret files (`request_secret` with `delivery: "file"`, or a pasted `value`) are written in the
// thread's Workspace, where its commands run, not beside t3's secret store: the Environment's store is DO storage, with
// no directory, so stock t3 failed every one ("Could not store the secret.") after the card said it was saved. Vitest
// runs t3 unpatched, so the Patch is applied here as build.ts applies it, and the copy's `SecretRequests` runs over
// t3flare's store and the Workspace DO's `placeSecretFile`, each on in-memory storage.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, SecretRef, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "t3/src/orchestration-v2/ThreadManagementService.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { placeSecretFile, SECRET_FILES_DIR } from "../../agents/src/workspace/secretFiles.ts";
import * as SecretResolver from "../../../t3code/packages/secret-provider-core/src/server/SecretResolver.ts";
import * as SecretStore from "../src/platform/secretStore.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const T3 = path.resolve(here, "../../../t3code");
const PATCH = path.resolve(here, "../../../patches/0011-secret-files-go-where-the-thread-runs.patch");
const SOURCES = ["apps/server/src/auth/ServerSecretStore.ts", "apps/server/src/secrets/SecretRequests.ts"];
const SECRET_REQUESTS = SOURCES[1]!;
const BARE: Record<string, string> = {
  "@t3tools/secret-provider-core/server/SecretResolver": path.join(
    T3,
    "packages/secret-provider-core/src/server/SecretResolver.ts",
  ),
};

type SecretRequestsModule = typeof import("t3/src/secrets/SecretRequests.ts");
let patched: SecretRequestsModule;
let work: string;
afterAll(() => {
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
});

beforeAll(async () => {
  fs.mkdirSync(path.resolve(here, "../dist"), { recursive: true });
  work = fs.mkdtempSync(path.resolve(here, "../dist/patch-0011-"));
  for (const source of SOURCES) {
    fs.mkdirSync(path.join(work, path.dirname(source)), { recursive: true });
    fs.copyFileSync(path.join(T3, source), path.join(work, source));
  }
  execFileSync("git", ["init", "-q", work]);
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", PATCH], { cwd: work, encoding: "utf8" });
  expect(applied.stderr).toBe("");
  expect(applied.status).toBe(0);
  // The copy's imports reach t3's own modules: the Patch changes ServerSecretStore's type only.
  const file = path.join(work, SECRET_REQUESTS);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(/from "(\.\.?\/[^"]+)"/g, (_, specifier: string) =>
      JSON.stringify(path.resolve(T3, path.dirname(SECRET_REQUESTS), specifier)).replace(/^/, "from "),
    )
    .replace(
      /from "(@t3tools\/secret-provider-core\/[^"]+)"/g,
      (_, specifier: string) => `from ${JSON.stringify(BARE[specifier])}`,
    );
  fs.writeFileSync(file, text);
  expect(text).toContain("store.placeThreadFile");
  patched = (await import(/* @vite-ignore */ file)) as SecretRequestsModule;
});

const threadId = ThreadId.make("thread-1");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");

/** DO key-value storage, in memory: what `SecretStore.layer` reads and writes. */
const memoryStorage = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => void values.set(key, value),
      delete: async (key: string) => values.delete(key),
    },
  };
};

/** A Workspace DO's `placeSecretFile` over in-memory files, the one Workspace of `threadId`. */
const memoryWorkspace = () => {
  const files = new Map<string, string>();
  let pushes = 0;
  const rpc = {
    placeSecretFile: (input: { readonly name: string; readonly text?: string }) =>
      placeSecretFile(
        {
          now: () => 0,
          list: async () => [],
          exists: async (file) => files.has(file),
          write: async (file, text) => void files.set(file, text),
          remove: async (file) => void files.delete(file),
          push: async () => void (pushes += 1),
        },
        input,
      ),
  };
  return { files, rpc, pushes: () => pushes };
};

const run = <A, E>(
  body: (service: InstanceType<typeof patched.SecretRequests>["Service"]) => Effect.Effect<A, E>,
  options: { readonly workspace: ReturnType<typeof memoryWorkspace> | undefined },
) => {
  const { storage, values } = memoryStorage();
  let secretStatus = "pending";
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    Layer.mock(SecretResolver.SecretResolver)({}),
    SecretStore.layer(storage as never, (thread) => (thread === threadId ? options.workspace?.rpc : undefined)).pipe(
      Layer.provide(NodeCrypto.layer),
    ),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: { projectId },
              runs: [{ id: "run-1", status: "running" }],
              turnItems: [
                {
                  id: turnItemId,
                  threadId,
                  runId: "run-1",
                  nodeId: "node-root",
                  type: "secret_request",
                  label: "ESPN cookie",
                  reason: "Reads the league.",
                  delivery: "file",
                  secretStatus,
                },
              ],
            }) as never,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "secret_request.record") secretStatus = command.secretStatus;
          return {} as never;
        }),
    }),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* patched.SecretRequests);
    }).pipe(Effect.provide(patched.layer.pipe(Layer.provide(dependencies))), Effect.scoped),
  ).then((result) => ({ result, values }));
};

const storedRequests = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.startsWith("t3flare/secret/secret-request-") && !key.endsWith("-salt"));

describe("patch 0011: secret files go where the thread runs", () => {
  it("a file request's value moves into the thread's Workspace, once", async () => {
    const workspace = memoryWorkspace();
    const { result, values } = await run(
      (service) =>
        Effect.gen(function* () {
          yield* service.answer({ threadId, turnItemId, answer: { type: "save", secret: "AEB'$(id)" } });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          // A retried request_secret gets the same file; the stored copy is gone, so it is never a ref again.
          const again = yield* service.saveToFile({ threadId, turnItemId });
          const reused = yield* service
            .consume({ ref: SecretRef.make(`secret-ref:${path.basename(file)}`), projectId })
            .pipe(Effect.flip);
          return { file, again, reused: reused.reason };
        }),
      { workspace },
    );
    expect(path.dirname(result.file)).toBe(SECRET_FILES_DIR);
    expect(result.again).toBe(result.file);
    expect(workspace.files.get(result.file)).toBe("AEB'$(id)");
    expect(workspace.pushes()).toBe(2);
    expect(result.reused).toBe("ref_unavailable");
    expect(storedRequests(values)).toEqual([]);
  });

  it("a pasted secret goes straight to the thread's Workspace", async () => {
    const workspace = memoryWorkspace();
    const { result } = await run(
      (service) => service.savePasted({ threadId, requestNamespace: "session-a", requestKey: "key-1", value: "4829" }),
      { workspace },
    );
    expect(path.dirname(result)).toBe(SECRET_FILES_DIR);
    expect(workspace.files.get(result)).toBe("4829");
  });

  it("a thread with no Workspace keeps the value, so the request can be retried", async () => {
    const { result, values } = await run(
      (service) =>
        Effect.gen(function* () {
          yield* service.answer({ threadId, turnItemId, answer: { type: "save", secret: "v" } });
          return (yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip)).reason;
        }),
      { workspace: undefined },
    );
    expect(result).toBe("store_failed");
    expect(storedRequests(values)).toHaveLength(1);
  });
});
