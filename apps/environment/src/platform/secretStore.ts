// @effect-diagnostics effectFnOpportunity:off
// t3's server secrets (signing keys it creates at runtime) in DO key-value storage, apart
// from SQL (ADR-0010). Same service as t3's file-backed `ServerSecretStore`.
//
// Patch 0011: t3 writes a `request_secret` file (`delivery: "file"`, or a pasted `value`) beside its store, which here
// has no directory a command can read. `placeThreadFile` puts it in the thread's Workspace instead, where its Container's
// commands read it (the agents Worker's `secretFiles.ts`).
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { WorkspaceRpc } from "../agents/rpc.ts";

const key = (name: string) => `t3flare/secret/${name}`;

/** The Workspace DO a thread's commands run in, or undefined when it has none that resolves. */
export type ThreadWorkspace = (threadId: string) => Pick<WorkspaceRpc, "placeSecretFile"> | undefined;

/** Patch 0011's hook, which the unpatched `ServerSecretStore` type t3flare is checked against does not name. */
type PlaceThreadFile = <E>(input: {
  readonly threadId: string;
  readonly name: string;
  readonly value: Effect.Effect<string, E>;
}) => Effect.Effect<string, E | ServerSecretStore.SecretStorePersistError>;

const placeThreadFileOf =
  (workspaceOf: ThreadWorkspace): PlaceThreadFile =>
  ({ threadId, name, value }) =>
    Effect.gen(function* () {
      const resource = `secret file ${name}`;
      const failed = (cause: unknown) => new ServerSecretStore.SecretStorePersistError({ resource, cause });
      const workspace = workspaceOf(threadId);
      if (workspace === undefined)
        return yield* failed(new Error(`t3flare: thread ${threadId} has no Workspace to write ${resource} in`));
      const place = (text?: string) =>
        Effect.tryPromise({
          try: () => workspace.placeSecretFile(text === undefined ? { name } : { name, text }),
          catch: failed,
        }).pipe(
          Effect.filterOrFail(
            (answer) => !("refused" in answer),
            (answer) => failed(new Error("refused" in answer ? answer.refused : "refused")),
          ),
        );
      // Read only when the file is not there yet: a retry of the same request gets the file the first one wrote.
      const there = yield* place();
      if ("path" in there) return there.path;
      const written = yield* place(yield* value);
      if ("path" in written) return written.path;
      return yield* failed(new Error(`t3flare: ${resource} was not written`));
    });

export const layer = (storage: DurableObjectStorage, workspaceOf?: ThreadWorkspace) =>
  Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const read = (name: string) =>
        Effect.tryPromise({
          try: () => storage.get<ArrayBuffer | Uint8Array>(key(name)),
          catch: (cause) => new ServerSecretStore.SecretStoreReadError({ resource: name, cause }),
        }).pipe(
          Effect.map((value) =>
            value === undefined ? Option.none<Uint8Array>() : Option.some(new Uint8Array(value as ArrayBuffer)),
          ),
        );
      const write = (name: string, value: Uint8Array) =>
        Effect.tryPromise({
          try: () => storage.put(key(name), Uint8Array.from(value)),
          catch: (cause) => new ServerSecretStore.SecretStorePersistError({ resource: name, cause }),
        });
      const create = (name: string, value: Uint8Array) =>
        Effect.flatMap(read(name), (existing) => (Option.isSome(existing) ? Effect.void : write(name, value)));
      const service = {
        get: read,
        set: write,
        create,
        // Requests to one DO are serialized at each await by its input gate, so a read and
        // the write after it cannot interleave with another creator.
        getOrCreateRandom: (name: string, bytes: number) =>
          Effect.gen(function* () {
            const existing = yield* read(name);
            if (Option.isSome(existing)) return existing.value;
            const value = yield* random.randomBytes(bytes);
            yield* write(name, value);
            return value;
          }),
        remove: (name: string) =>
          Effect.tryPromise({
            try: () => storage.delete(key(name)),
            catch: (cause) => new ServerSecretStore.SecretStoreRemoveError({ resource: name, cause }),
          }).pipe(Effect.asVoid),
        ...(workspaceOf === undefined ? {} : { placeThreadFile: placeThreadFileOf(workspaceOf) }),
      };
      return ServerSecretStore.ServerSecretStore.of(service);
    }),
  );
