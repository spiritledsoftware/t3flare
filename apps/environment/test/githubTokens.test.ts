// @effect-diagnostics globalFetch:off globalDate:off nodeBuiltinImport:off
// The Environment's minters (`GitHubTokens`) as a repository lookup uses them (SPI-1398): `forget` lets a lookup the
// Owner retries ask GitHub at once, and `invalidate` stops a token GitHub refused from being handed out again.
import { generateKeyPairSync } from "node:crypto";

import { REPOSITORY_LOOKUP_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubTokens, type MintRequest } from "../src/agents/github.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const request: MintRequest = {
  owner: "acme",
  repositories: ["notes"],
  permissions: REPOSITORY_LOOKUP_GITHUB_PERMISSIONS,
};

/** GitHub for an App installed on `acme`: a mint refused with 422 while `refusing`, else a new token each time. */
const stubGitHub = () => {
  const state = { refusing: true, mints: 0 };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url === "https://api.github.com/app/installations?per_page=100")
      return Response.json([{ id: 7, account: { login: "acme" } }]);
    if ((init.method ?? "GET") === "POST" && url === "https://api.github.com/app/installations/7/access_tokens") {
      state.mints += 1;
      if (state.refusing) return Response.json({ message: "not accessible" }, { status: 422 });
      return Response.json(
        { token: `ghs_${state.mints}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  return state;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubTokens for a repository lookup (SPI-1398)", () => {
  it("asks GitHub again at once after `forget`, where it would otherwise tell the last failure again", async () => {
    const github = stubGitHub();
    const tokens = new GitHubTokens({ appId: "1", privateKey });
    await expect(tokens.mint(request)).rejects.toThrow(/422/);
    // The Owner added the repo to the installation.
    github.refusing = false;
    await expect(tokens.mint(request)).rejects.toThrow(/422/);
    expect(github.mints).toBe(1);
    tokens.forget(request);
    expect((await tokens.mint(request)).token).toBe("ghs_2");
  });

  it("mints another after `invalidate`, rather than handing the refused token out again", async () => {
    const github = stubGitHub();
    github.refusing = false;
    const tokens = new GitHubTokens({ appId: "1", privateKey });
    const first = await tokens.mint(request);
    expect((await tokens.mint(request)).token).toBe(first.token);
    tokens.invalidate(first.token);
    expect((await tokens.mint(request)).token).not.toBe(first.token);
  });
});
