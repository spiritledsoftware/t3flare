// A sign-in request that runs past its time limit says so (SPI-1432): the answer carries `timedOut`, so the Environment
// can name the limit and its value.
// @effect-diagnostics asyncFunction:off newPromise:off
import { describe, expect, it, vi } from "vitest";

import { oauthMethods } from "../src/oauth.ts";
import { guardedFetch } from "../src/oauthFetch.ts";

// `oauth.ts` defines the Worker's entrypoint too, whose base only workerd has.
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const hung = ((_url: URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
  )) as unknown as typeof fetch;

const refused = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

const TOKEN_INPUT = {
  authorizationServerUrl: "https://as.example",
  metadata: {
    issuer: "https://as.example",
    authorization_endpoint: "https://as.example/authorize",
    token_endpoint: "https://as.example/token",
    response_types_supported: ["code"],
  },
  client: { client_id: "c" },
};

const calls = (base: typeof fetch) => {
  const methods = oauthMethods((timeoutMs) => guardedFetch(base, timeoutMs));
  return {
    begin: () =>
      methods.begin({
        serverUrl: "https://mcp.example/mcp",
        redirectUrl: "https://t3.example/callback",
        clientMetadataUrl: "https://t3.example/client.json",
        clientName: "t3flare",
        state: "s",
        timeoutMs: 20,
      }),
    exchange: () =>
      methods.exchange({
        ...TOKEN_INPUT,
        code: "x",
        codeVerifier: "v",
        redirectUrl: "https://t3.example/callback",
        timeoutMs: 20,
      }),
    refresh: () => methods.refresh({ ...TOKEN_INPUT, refreshToken: "r", timeoutMs: 20 }),
  };
};

describe("an OAuth request past its time limit", () => {
  it.each(["begin", "exchange", "refresh"] as const)("%s: fails with timedOut", async (method) => {
    const answer = await calls(hung)[method]();
    expect(answer).toMatchObject({ ok: false, timedOut: true });
  });

  it.each(["begin", "exchange", "refresh"] as const)("%s: any other failure carries no timedOut", async (method) => {
    const answer = await calls(refused)[method]();
    expect(answer.ok).toBe(false);
    expect(answer).not.toHaveProperty("timedOut");
  });
});
