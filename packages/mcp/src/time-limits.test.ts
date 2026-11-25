/**
 * A timeout names the time limit it ran past, with its value as applied (SPI-1432): the connect's, one listing's, a tool
 * call's, or another request's (the call's when the host gave it none of its own), so the host can say which.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AGENT, failedWith, HOST, run, settled, TARGET, testDeps } from "./core.fixture.ts";
import { fetchTo, HANG_TOOL, hostileServer, modernServer } from "./fakes.fixture.ts";
import { connect, type McpTarget } from "./index.ts";
import { McpError, TimedOut } from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** A stream that opens and never says anything. */
const silence = () =>
  new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
    headers: { "content-type": "text/event-stream" },
  });

/** A Modern server that answers `method` with silence. */
const silentOn = (method: string) =>
  hostileServer(modernServer(), (_request, rpc) => (rpc?.method === method ? silence() : undefined));

describe("a timeout names its limit", () => {
  it("the connect's, when the probe goes unanswered", async () => {
    const server = hostileServer(modernServer(), (_request, rpc) =>
      rpc?.method === "server/discover" ? new Response(null, { status: 202 }) : undefined,
    );

    const outcome = await run(
      Effect.gen(function* () {
        yield* connect({ ...TARGET, connectTimeoutMs: 300 }, testDeps(fetchTo(server)));

        return "connected";
      }).pipe(Effect.catch((error) => Effect.succeed({ failed: error }))),
    );

    expect(outcome).toEqual(failedWith(TimedOut, { limit: "connect", ms: 300 }));
  }, 10_000);

  it("the listing's, when a listing outlives it", async () => {
    const server = silentOn("tools/list");

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect({ ...TARGET, listTimeoutMs: 300 }, testDeps(fetchTo(server)));

        return yield* settled(connection.list("tools", HOST));
      }),
    );

    expect(outcome).toEqual(failedWith(TimedOut, { limit: "list", ms: 300, listed: "tools" }));
  }, 10_000);

  it("the call's, when a tool call outlives it", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect({ ...TARGET, timeoutMs: 300 }, testDeps(fetchTo(modernServer())));

        return yield* settled(connection.callTool({ tool: HANG_TOOL, arguments: {} }, AGENT));
      }),
    );

    expect(outcome).toEqual(failedWith(TimedOut, { limit: "call", ms: 300 }));
  }, 10_000);

  it.each<[string, McpTarget, Readonly<Record<string, string | number>>]>([
    [
      "its own, when the host gives it one apart from the call's",
      { ...TARGET, timeoutMs: WEEK_MS, requestTimeoutMs: 300 },
      { limit: "request", ms: 300 },
    ],
    ["the call's, when the host gives it none", { ...TARGET, timeoutMs: 300 }, { limit: "call", ms: 300 }],
    [
      "the call's, when the host gives it the call's",
      { ...TARGET, timeoutMs: 300, requestTimeoutMs: 300 },
      { limit: "call", ms: 300 },
    ],
  ])(
    "another request's: %s",
    async (_name, target, fields) => {
      const server = silentOn("resources/read");

      const outcome = await run(
        Effect.gen(function* () {
          const connection = yield* connect(target, testDeps(fetchTo(server)));

          return yield* settled(connection.readResource("file:///notes.md", AGENT));
        }),
      );

      expect(outcome).toEqual(failedWith(TimedOut, fields));
    },
    10_000,
  );

  it("decodes a TimedOut with or without them: an engine or a host from before SPI-1432", () => {
    const decode = (input: unknown) => Effect.runSync(Schema.decodeUnknownEffect(McpError)(input));

    expect(decode({ _tag: "TimedOut", message: "The server did not answer in time" })).toEqual(
      TimedOut.make({ message: "The server did not answer in time" }),
    );
    expect(decode({ _tag: "TimedOut", message: "Late", limit: "list", ms: 120_000, listed: "tools" })).toEqual(
      TimedOut.make({ message: "Late", limit: "list", ms: 120_000, listed: "tools" }),
    );
  });
});
