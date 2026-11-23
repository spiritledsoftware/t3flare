// The stage scripts' /ws calls, sent again once when Cloudflare's edge drops the socket (scripts/lib/socketRetry.ts): a
// bump's acceptance test died of a SocketReadError 5 s into a clone the Worker logged as `responseStreamDisconnected`.
import { describe, expect, it, vi } from "vitest";

import { withSocketRetry } from "../scripts/lib/socketRetry.ts";

type Call = (cookie: string, method: string, payload: unknown) => Promise<unknown>;

const dropped = (reason: "SocketReadError" | "SocketCloseError") =>
  Object.assign(new Error(`${reason}: dropped`), {
    _tag: "RpcClientError",
    reason: { _tag: reason },
  });
const exists = () =>
  Object.assign(new Error("Destination path already exists and is not empty."), {
    _tag: "SourceControlRepositoryError",
    operation: "cloneRepository",
    detail: "Destination path already exists and is not empty.",
  });

/** Runs the retried call with fake timers, so the 1 s pause passes at once; answers its value or its error. */
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

describe("withSocketRetry", () => {
  it.each(["SocketReadError", "SocketCloseError"] as const)(
    "sends an allowlisted method once more after a %s, and answers with the resend's answer",
    async (reason) => {
      const inner = vi
        .fn<Call>()
        .mockRejectedValueOnce(dropped(reason))
        .mockResolvedValueOnce({ ok: true });
      const result = await run(inner, "server.getConfig");
      expect(result).toMatchObject({ value: { ok: true } });
      expect(result.logged).toEqual(["ws server.getConfig: socket dropped, attempt 2 of 2"]);
      expect(inner).toHaveBeenCalledTimes(2);
    },
  );

  it("does not resend a method off the allowlist", async () => {
    const inner = vi.fn<Call>().mockRejectedValue(dropped("SocketReadError"));
    const result = await run(inner, "server.updateSettings");
    expect((result as { error: { reason: { _tag: string } } }).error.reason._tag).toBe(
      "SocketReadError",
    );
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("gives up after the one resend with its error", async () => {
    const inner = vi
      .fn<Call>()
      .mockRejectedValueOnce(dropped("SocketReadError"))
      .mockRejectedValueOnce(dropped("SocketCloseError"));
    const result = await run(inner, "subscribeWorktreeSetup");
    expect((result as { error: { reason: { _tag: string } } }).error.reason._tag).toBe(
      "SocketCloseError",
    );
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other error at once", async () => {
    const inner = vi
      .fn<Call>()
      .mockRejectedValue(
        Object.assign(new Error("SocketOpenError"), {
          _tag: "RpcClientError",
          reason: { _tag: "SocketOpenError" },
        }),
      );
    expect(await run(inner, "server.getConfig")).toMatchObject({
      error: { reason: { _tag: "SocketOpenError" } },
    });
    const refused = vi.fn<Call>().mockRejectedValue(exists());
    expect(
      await run(refused, "sourceControl.cloneRepository", { destinationPath: "/w/a" }),
    ).toMatchObject({ error: { _tag: "SourceControlRepositoryError" } });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("answers a resent clone that finds its destination already cloned as the clone's success", async () => {
    const inner = vi
      .fn<Call>()
      .mockRejectedValueOnce(dropped("SocketReadError"))
      .mockRejectedValueOnce(exists());
    const result = await run(inner, "sourceControl.cloneRepository", {
      remoteUrl: "https://github.com/o/r.git",
      destinationPath: "/w/a",
    });
    expect(result).toMatchObject({
      value: { cwd: "/w/a", remoteUrl: "https://github.com/o/r.git", repository: null },
    });
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
