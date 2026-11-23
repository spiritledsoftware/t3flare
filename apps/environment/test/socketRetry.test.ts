// The stage scripts' /ws calls, sent again once when Cloudflare's edge drops the socket (scripts/lib/socketRetry.ts): a
// bump's acceptance test died of a SocketReadError 5 s into a clone the Worker logged as `responseStreamDisconnected`.
import { SourceControlProviderKind, SourceControlRepositoryError } from "@t3tools/contracts";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketCloseError, SocketOpenError, SocketReadError } from "effect/socket/Socket";
import { describe, expect, it, vi } from "vitest";

import { withSocketRetry } from "../scripts/lib/socketRetry.ts";

type Call = (cookie: string, method: string, payload: unknown) => Promise<unknown>;

const dropped = {
  SocketReadError: () => new RpcClientError({ reason: new SocketReadError({ cause: new Error("stream ended") }) }),
  SocketCloseError: () => new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }),
};
const unopened = () => new RpcClientError({ reason: new SocketOpenError({ kind: "Unknown", cause: new Error("refused") }) });
const taken = (detail: string) => new SourceControlRepositoryError({ operation: "cloneRepository", provider: SourceControlProviderKind.make("unknown"), detail });
const T3_TAKEN = "Destination path already exists and is not empty.";
const GIT_TAKEN = "fatal: destination path 'a' already exists and is not an empty directory.";

const CLONE = "sourceControl.cloneRepository";
const clonePayload = { remoteUrl: "https://github.com/o/r.git", destinationPath: "/w/a" };
const refs = (current: boolean) => ({ refs: current ? [{ name: "main", current: true, isDefault: true, worktreePath: null }] : [], isRepo: current, hasPrimaryRemote: current, nextCursor: null, totalCount: current ? 1 : 0 });

/** The fake server: the clone answers from `clone` in turn, `vcs.listRefs` from `listRefs` in turn (its last answer
 * repeating), any other method from `other`. */
const fake = (answers: { clone?: Array<() => unknown>; listRefs?: Array<() => unknown>; other?: Array<() => unknown> }) =>
  vi.fn<Call>(async (_cookie, method) => {
    const queue = (method === CLONE ? answers.clone : method === "vcs.listRefs" ? answers.listRefs : answers.other) ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) throw new Error(`unexpected ${method}`);
    return next();
  });
const fail = (error: () => unknown) => () => {
  throw error();
};

/** Runs the retried call with fake timers, so its pauses pass at once; answers its value or its error, and what it logged. */
const run = async (inner: Call, method: string, payload: unknown = {}) => {
  vi.useFakeTimers();
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const pending = withSocketRetry(inner)("cookie", method, payload).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return { ...(await pending), logged: stderr.mock.calls.map((args) => String(args[0])) };
  } finally {
    stderr.mockRestore();
    vi.useRealTimers();
  }
};
const callsTo = (inner: ReturnType<typeof fake>, method: string) => inner.mock.calls.filter(([, called]) => called === method).length;

describe("withSocketRetry", () => {
  it.each(["SocketReadError", "SocketCloseError"] as const)("sends an allowlisted method once more after a %s, and answers with the resend's answer", async (reason) => {
    const inner = fake({ other: [fail(dropped[reason]), () => ({ ok: true })] });
    const result = await run(inner, "server.getConfig");
    expect(result).toMatchObject({ value: { ok: true }, logged: ["ws server.getConfig: socket dropped, attempt 2 of 2"] });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not resend a method off the allowlist", async () => {
    const inner = fake({ other: [fail(dropped.SocketReadError)] });
    expect(await run(inner, "server.updateSettings")).toMatchObject({ error: { reason: { _tag: "SocketReadError" } }, logged: [] });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives up after the one resend with its error", async () => {
    const inner = fake({ other: [fail(dropped.SocketReadError), fail(dropped.SocketCloseError)] });
    expect(await run(inner, "subscribeWorktreeSetup")).toMatchObject({ error: { reason: { _tag: "SocketCloseError" } } });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("rethrows a socket that never opened at once", async () => {
    const inner = fake({ other: [fail(unopened)] });
    expect(await run(inner, "server.getConfig")).toMatchObject({ error: { reason: { _tag: "SocketOpenError" } } });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("rethrows a first clone's taken destination at once: it was not this run's clone", async () => {
    const inner = fake({ clone: [fail(() => taken(T3_TAKEN))] });
    expect(await run(inner, CLONE, clonePayload)).toMatchObject({ error: { _tag: "SourceControlRepositoryError" } });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["t3's", T3_TAKEN],
    ["git's", GIT_TAKEN],
  ])("answers a resent clone refused with %s taken destination once the first clone has a checked-out branch", async (_, detail) => {
    const inner = fake({ clone: [fail(dropped.SocketReadError), fail(() => taken(detail))], listRefs: [fail(() => new Error("not a git repository")), () => refs(false), () => refs(true)] });
    const result = await run(inner, CLONE, clonePayload);
    expect(result).toMatchObject({ value: { cwd: "/w/a", remoteUrl: "https://github.com/o/r.git", repository: null } });
    expect(callsTo(inner, CLONE)).toBe(2);
    expect(callsTo(inner, "vcs.listRefs")).toBe(3);
    expect(inner).toHaveBeenCalledWith("cookie", "vcs.listRefs", { cwd: "/w/a", refKind: "local", refresh: true, limit: 200 });
  });

  it("throws the drop when the first clone never finishes", async () => {
    const inner = fake({ clone: [fail(dropped.SocketReadError), fail(() => taken(T3_TAKEN))], listRefs: [() => refs(false)] });
    expect(await run(inner, CLONE, clonePayload)).toMatchObject({ error: { reason: { _tag: "SocketReadError" } } });
    expect(callsTo(inner, "vcs.listRefs")).toBeGreaterThan(10);
  });

  it.each([
    ["a destination t3 would answer resolved", { ...clonePayload, destinationPath: "w/a" }],
    ["a destination t3 would answer normalised", { ...clonePayload, destinationPath: "/w/b/../a" }],
    ["a remote t3 would answer redacted", { ...clonePayload, remoteUrl: "https://x:token@github.com/o/r.git" }],
    ["no remote, a repository looked up", { destinationPath: "/w/a", provider: "github", repository: "o/r" }],
  ])("throws the drop for a clone it cannot answer as t3 would: %s", async (_, payload) => {
    const inner = fake({ clone: [fail(dropped.SocketReadError), fail(() => taken(T3_TAKEN))], listRefs: [() => refs(true)] });
    expect(await run(inner, CLONE, payload)).toMatchObject({ error: { reason: { _tag: "SocketReadError" } } });
    expect(callsTo(inner, "vcs.listRefs")).toBe(0);
  });
});
