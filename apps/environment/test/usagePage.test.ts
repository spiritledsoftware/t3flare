// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// t3's Usage page on t3flare's records (SPI-1173), wired as the bundle wires it: t3's own `UsageService` (the Layer the
// composition root builds, `t3/composition.ts`) over the Shadow's `BUILT_IN_USAGE_DRIVERS` (build.ts's SHADOWS redirect,
// restated here as a module mock), reading the records the Environment's `recordUsage` keeps. If the Shadow lost its
// readers, or they read another store, the summary would have no bucket of ours.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { UsageDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ServerConfig from "t3/src/config.ts";
import * as ServerSettings from "t3/src/serverSettings.ts";
import * as UsageService from "t3/src/usage/UsageService.ts";
import { bindEnvironmentServices, type EnvironmentServices } from "../src/agents/bindings.ts";
import { acceptUsage, usageStore } from "../src/usage/records.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

vi.mock("t3/src/provider/builtInDrivers.ts", () => import("../src/shadows/builtInDrivers.ts"));

/** t3's Usage summary from `sinceDay` to `untilDay` (UTC), its server settings `settings` over the defaults. */
const summaryOf = async (
  sinceDay: UsageDay,
  untilDay: UsageDay,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3flare-usage-page-"));
  const rates = { "house-model": { input_cost_per_token: 0.000_002, output_cost_per_token: 0.000_004 } };
  const layer = UsageService.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), NodePath.join(home, "t3"))),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Hostname, "usage-page-test")),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, { HOME: home })),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(rates)))),
      ),
    ),
  );
  try {
    const read = Effect.gen(function* () {
      const service = yield* UsageService.UsageService;
      return yield* service.readSummary({ sinceDay, untilDay, timeZone: "UTC", awaitRefresh: true });
    }).pipe(Effect.provide(layer), Effect.scoped);
    // SAFETY: the type is t3's own drivers' (the mock is not seen by the typechecker): their readers need t3's usage
    // services (Antigravity, Codex history, Cursor, Muse); the Shadow's need none, which running it here shows.
    type Summary = Effect.Effect<Effect.Success<typeof read>, Effect.Error<typeof read>>;
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- t3's drivers' requirements, which the mocked Shadow's readers do not have (SAFETY above)
    return await Effect.runPromise(read as Summary);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

describe("t3's Usage page, through the Shadow's readers", () => {
  // The records land a minute before now and the summary reads only today's UTC day, so a wall clock in the first minute
  // after 00:00 UTC would put them on yesterday. Only `Date` is faked: the Effect layers run on real timers.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows each agent's records by its endpoint's model, the unpriced one priced by t3's rate table", async () => {
    const now = Date.now();
    const store = usageStore(nodeSqlStorage());
    bindEnvironmentServices({ usage: store } as unknown as EnvironmentServices);
    const endpoints = {
      revision: 1,
      endpoints: [
        {
          id: "gw",
          label: "GW",
          api: "anthropic-messages" as const,
          baseUrl: "https://gw.example",
          auth: "api-key" as const,
          headers: {},
          models: [
            {
              id: "house-model",
              name: "House",
              reasoning: false,
              input: ["text" as const],
              contextWindow: 100_000,
              maxTokens: 8_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              known: false,
            },
          ],
        },
      ],
    };
    const tokens = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    const kept = acceptUsage(
      {
        entries: [
          {
            agent: "durable",
            endpointId: "gw",
            modelId: "house-model",
            at: now - 60_000,
            session: "s1",
            ...tokens,
            costUsd: 0.25,
          },
          {
            agent: "codex",
            endpointId: "gw",
            modelId: "house-model",
            at: now - 60_000,
            session: "proc-1",
            ...tokens,
            costUsd: null,
          },
        ],
      },
      { store, endpoints, now: () => now },
    );
    expect(kept).toEqual({ kept: 2 });

    const day = UsageDay.make(new Date(now).toISOString().slice(0, 10));
    const summary = await summaryOf(day, day);
    const ours = summary.buckets.map((bucket) => ({
      provider: bucket.provider,
      source: bucket.sourcePath,
      model: bucket.model,
      costUsd: bucket.costUsd,
      costSource: bucket.costSource,
    }));
    expect(ours).toEqual(
      expect.arrayContaining([
        {
          provider: "pi",
          source: "t3flare://usage/durable",
          model: "gw/house-model",
          costUsd: 0.25,
          costSource: "providerReported",
        },
        {
          provider: "codex",
          source: "t3flare://usage/codex",
          model: "gw/house-model",
          costUsd: 2,
          costSource: "modelPriced",
        },
      ]),
    );
    expect(
      summary.sources
        .filter((source) => source.fingerprint.resolvedHomePath.startsWith("t3flare://"))
        .map((source) => source.fingerprint.resolvedHomePath),
    ).toEqual([
      "t3flare://usage/durable",
      "t3flare://usage/text-generation",
      "t3flare://usage/pi",
      "t3flare://usage/codex",
      "t3flare://usage/claude",
      "t3flare://usage/opencode",
    ]);
  });

  it("shows records past t3's usageHistoryRetentionDays: the Owner's usageRetentionDays governs ours (SPI-1323)", async () => {
    // t3 cuts only its own transcript cache at `retentionCutoffMs`; if it began cutting scan results too, rows the Owner
    // kept past t3's setting would vanish from the page (docs/upstream-fragility.md).
    const now = Date.now();
    const store = usageStore(nodeSqlStorage(), { retentionDays: () => 365 });
    bindEnvironmentServices({ usage: store } as unknown as EnvironmentServices);
    const at = now - 30 * 24 * 60 * 60 * 1000;
    const endpoints = { revision: 1, endpoints: [] };
    const entry = { agent: "durable", endpointId: "gw", modelId: "m", at, session: "s1", costUsd: 0.5 } as const;
    const tokens = { input: 10, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    expect(acceptUsage({ entries: [{ ...entry, ...tokens }] }, { store, endpoints, now: () => now })).toEqual({
      kept: 1,
    });
    const day = UsageDay.make(new Date(at).toISOString().slice(0, 10));
    const summary = await summaryOf(day, day, { usageHistoryRetentionDays: 7 });
    expect(summary.buckets.filter((bucket) => bucket.sourcePath === "t3flare://usage/durable")).toEqual([
      expect.objectContaining({ model: "gw/m", costUsd: 0.5 }),
    ]);
  });
});
