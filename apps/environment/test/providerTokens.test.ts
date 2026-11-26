// @effect-diagnostics effectFnOpportunity:off globalDate:off nodeBuiltinImport:off
// t3's GitHub pull request, source control and issue features in an Environment with Projects under two owners: each
// operation runs on a GitHub App token minted for its repo's owner, through t3's own GitHub providers, over a fake GitHub
// that answers a repo only to a token of its owner's installation. `gh auth token` answers as the process router does:
// one token, for the first Workspace's owner.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ENVIRONMENT_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as PullRequestProviderRegistry from "t3/src/pullRequest/PullRequestProviderRegistry.ts";
import * as SourceControlProviderRegistry from "t3/src/sourceControl/SourceControlProviderRegistry.ts";
import { describe, expect, it } from "vitest";

import * as GitHubAppAccess from "../../../t3code/packages/source-control-github/src/server/GitHubAppAccess.ts";
import * as GitHubAppSignIn from "../../../t3code/packages/source-control-github/src/server/GitHubAppSignIn.ts";
import * as GitHubCredentials from "../../../t3code/packages/source-control-github/src/server/GitHubCredentials.ts";
import * as GitHubPullRequestApi from "../../../t3code/packages/source-control-github/src/server/GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "../../../t3code/packages/source-control-github/src/server/GitHubPullRequestProvider.ts";
import * as GitHubQuota from "../../../t3code/packages/source-control-github/src/server/GitHubQuota.ts";
import { PinnedGitHubCredential } from "../../../t3code/packages/source-control-github/src/server/GitHubRequestPolicy.ts";
import * as GitHubRest from "../../../t3code/packages/source-control-github/src/server/GitHubRest.ts";
import * as GitHubSourceControlProvider from "../../../t3code/packages/source-control-github/src/server/GitHubSourceControlProvider.ts";
import * as TestSourceControlHost from "../../../t3code/packages/source-control-testing/src/TestSourceControlHost.ts";

import type { MintRequest } from "../src/agents/github.ts";
import {
  pinTargetOf,
  withProviderTokens,
  withPullRequestTokens,
  withSourceControlTokens,
  type GitHubRepo,
  type ProviderPins,
} from "../src/t3/providerTokens.ts";

/** The Environment's Workspaces: `/w/<id>` → its repo. Two Projects under `acme`, one under `other`. */
const WORKSPACES: Readonly<Record<string, GitHubRepo>> = {
  "acme-web": { owner: "acme", name: "web" },
  "acme-api": { owner: "acme", name: "api" },
  "other-app": { owner: "other", name: "app" },
};

const repoAt = (cwd: string): GitHubRepo | undefined => WORKSPACES[/^\/w\/([^/]+)/.exec(cwd)?.[1] ?? ""];

/** An installation token as the fake GitHub reads it: `token:<owner>:<name>,<name>`. */
const tokenFor = (request: MintRequest) => `token:${request.owner}:${[...request.repositories].sort().join(",")}`;

/** What `gh auth token` answers: the first Workspace's owner's token, as the process router mints it. */
const GH_TOKEN = "token:acme:api,web";

interface Log {
  readonly mints: Array<MintRequest>;
  readonly invalidated: Array<string>;
}

const newLog = (): Log => ({ mints: [], invalidated: [] });

const pinsOf = (
  log: Log,
  options: { readonly refuse?: boolean; readonly stale?: boolean } = {},
): (() => ProviderPins) => {
  const pins: ProviderPins = {
    mint: async (request) => {
      log.mints.push(request);
      if (options.refuse === true) throw new Error("The GitHub App is not installed on other");
      const token = tokenFor(request);
      const stale = options.stale === true && !log.invalidated.includes(`stale:${token}`);
      return { token: stale ? `stale:${token}` : token, expiresAt: Date.now() + 3_600_000 };
    },
    invalidate: (token) => void log.invalidated.push(token),
    repoAt,
    reposOf: (owner) =>
      Object.values(WORKSPACES)
        .filter((repo) => repo.owner === owner)
        .map((repo) => repo.name),
  };
  return () => pins;
};

/** Whether `auth` is an installation token that covers `owner/name`. */
const covers = (auth: string, owner: string, name: string): boolean => {
  const match = /^Bearer token:([^:]+):(.*)$/.exec(auth);
  return match !== null && match[1] === owner.toLowerCase() && match[2]!.split(",").includes(name.toLowerCase());
};

/**
 * A fake GitHub: `POST repos/<owner>/<name>/pulls` opens a pull request only for a token of that owner's installation
 * that names the repo, else answers 403 as GitHub does; a revoked (`stale:`) token gets 401; `GET user` answers the
 * App's bot to any installation token.
 */
const fakeGitHub = (seen: Array<string>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const auth = request.headers.authorization ?? "";
      seen.push(`${request.method} ${url.pathname} ${auth}`);
      const json = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (auth.startsWith("Bearer stale:")) return json({ message: "Bad credentials" }, 401);
      if (url.pathname === "/user")
        return auth.startsWith("Bearer token:")
          ? json({ id: 7, login: "t3flare[bot]" })
          : json({ message: "Bad credentials" }, 401);
      const pulls = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
      if (pulls !== null && request.method === "POST") {
        return covers(auth, pulls[1]!, pulls[2]!)
          ? json({ number: 1, html_url: `https://github.com/${pulls[1]}/${pulls[2]}/pull/1` }, 201)
          : json({ message: "Resource not accessible by integration" }, 403);
      }
      return json({ message: "Not Found" }, 404);
    }),
  );

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

/** t3's credential source as the process router answers `gh auth token`. */
const ghAuthToken = Layer.succeed(
  GitHubCredentials.GitHubCredentials,
  GitHubCredentials.GitHubCredentials.of({
    get: (host) =>
      Effect.succeed({ host, token: Redacted.make(GH_TOKEN), source: "gh" as const, fingerprint: `${host}:gh` }),
    saved: () => Effect.succeedNone,
    fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
    invalidate: () => Effect.void,
  }),
);

const restLayer = (seen: Array<string>) => {
  const http = Layer.succeed(HttpClient.HttpClient, fakeGitHub(seen));
  return GitHubRest.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ghAuthToken, http, appSignedOut)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
};

/** `git remote -v` in each Workspace names its repo on github.com. */
const gitHost = TestSourceControlHost.layer({
  process: {
    run: (input) => {
      const repo = repoAt(input.cwd ?? "");
      const remotes =
        input.args[0] === "remote" && repo !== undefined
          ? `origin\thttps://github.com/${repo.owner}/${repo.name}.git (fetch)\norigin\thttps://github.com/${repo.owner}/${repo.name}.git (push)\n`
          : "";
      return Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(remotes === "" ? 1 : 0),
        stdout: remotes,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  },
});

/** t3's own GitHub source control provider over the fake GitHub. */
const stockSourceControl = (seen: Array<string>) =>
  GitHubSourceControlProvider.make.pipe(Effect.provide(Layer.mergeAll(restLayer(seen), gitHost, NodeServices.layer)));

/** t3's own GitHub pull request provider over the fake GitHub. */
const stockPullRequests = (seen: Array<string>) =>
  GitHubPullRequestProvider.make.pipe(
    Effect.provide(
      GitHubPullRequestApi.layer.pipe(
        Layer.provideMerge(GitHubAppAccess.layer),
        Layer.provide(restLayer(seen)),
        Layer.provide(TestSourceControlHost.layer()),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const bodyFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "t3flare-provider-tokens-"));
  const path = join(dir, "body.md");
  writeFileSync(path, "The change.\n");
  return path;
})();

const createIn = (provider: SourceControlProvider.SourceControlProvider["Service"], cwd: string) =>
  provider.createChangeRequest({ cwd, baseRefName: "main", headSelector: "feature", title: "A change", bodyFile });

describe("t3's GitHub operations in an Environment with Projects under two owners", () => {
  it("stock t3 opens a pull request in the second owner's repo with the first owner's token, and GitHub refuses it (the bug)", async () => {
    const seen: Array<string> = [];
    const error = await Effect.runPromise(
      stockSourceControl(seen).pipe(Effect.flatMap((provider) => Effect.flip(createIn(provider, "/w/other-app")))),
    );
    expect(error.operation).toBe("createChangeRequest");
    expect(seen).toEqual([`POST /repos/other/app/pulls Bearer ${GH_TOKEN}`]);
  });

  it("opens it with a token minted for the repo's owner, covering that owner's Projects", async () => {
    const seen: Array<string> = [];
    const log = newLog();
    await Effect.runPromise(
      stockSourceControl(seen).pipe(
        Effect.flatMap((stock) => {
          const provider = withProviderTokens(stock, pinsOf(log));
          return Effect.all([createIn(provider, "/w/other-app"), createIn(provider, "/w/acme-api")]);
        }),
      ),
    );
    expect(log.mints).toEqual([
      { owner: "other", repositories: ["app"], permissions: ENVIRONMENT_GITHUB_PERMISSIONS },
      { owner: "acme", repositories: ["web", "api"], permissions: ENVIRONMENT_GITHUB_PERMISSIONS },
    ]);
    expect(seen).toEqual([
      "POST /repos/other/app/pulls Bearer token:other:app",
      "POST /repos/acme/api/pulls Bearer token:acme:api,web",
    ]);
  });

  it("verifies t3's pinned pull request credential with the repo owner's token and the installation's fingerprint", async () => {
    // t3's merge, review and comment paths run under `withVerifiedCredential`, which captures the credential the request
    // policy chooses: the outer pin.
    const seen: Array<string> = [];
    const log = newLog();
    const identity = await Effect.runPromise(
      stockPullRequests(seen).pipe(
        Effect.flatMap((stock) => {
          const provider = withProviderTokens(stock, pinsOf(log));
          return provider.withVerifiedCredential!(
            { cwd: "/w/acme-web", host: "github.com", repository: "other/app" },
            (verified) => Effect.map(PinnedGitHubCredential, (pin) => ({ verified, pin })),
          );
        }),
      ),
    );
    expect(identity.verified).toEqual({
      accountId: "7",
      viewer: "t3flare[bot]",
      credentialFingerprint: "github.com:t3flare-app:other",
    });
    expect(identity.pin === null ? undefined : Redacted.value(identity.pin.token)).toBe("token:other:app");
    expect(seen).toEqual(["GET /user Bearer token:other:app"]);
  });

  it("drops a token GitHub refuses, so the next operation mints another", async () => {
    const seen: Array<string> = [];
    const log = newLog();
    const provider = await Effect.runPromise(
      stockSourceControl(seen).pipe(Effect.map((stock) => withProviderTokens(stock, pinsOf(log, { stale: true })))),
    );
    await Effect.runPromise(Effect.flip(createIn(provider, "/w/other-app")));
    expect(log.invalidated).toEqual(["stale:token:other:app"]);
    await Effect.runPromise(createIn(provider, "/w/other-app"));
    expect(seen).toEqual([
      "POST /repos/other/app/pulls Bearer stale:token:other:app",
      "POST /repos/other/app/pulls Bearer token:other:app",
    ]);
  });

  it("runs as t3's own, on `gh auth token`, when the App cannot mint for the owner", async () => {
    const seen: Array<string> = [];
    const log = newLog();
    await Effect.runPromise(
      stockSourceControl(seen).pipe(
        Effect.flatMap((stock) =>
          Effect.flip(createIn(withProviderTokens(stock, pinsOf(log, { refuse: true })), "/w/other-app")),
        ),
      ),
    );
    expect(log.mints).toHaveLength(1);
    expect(seen).toEqual([`POST /repos/other/app/pulls Bearer ${GH_TOKEN}`]);
  });

  it("leaves a pin already in place (t3's own, a repository lookup's) as it is", async () => {
    const seen: Array<string> = [];
    const log = newLog();
    await Effect.runPromise(
      stockSourceControl(seen).pipe(
        Effect.flatMap((stock) =>
          createIn(withProviderTokens(stock, pinsOf(log)), "/w/other-app").pipe(
            Effect.provideService(PinnedGitHubCredential, {
              host: "github.com",
              token: Redacted.make("token:other:app"),
              credentialFingerprint: "outer",
            }),
          ),
        ),
      ),
    );
    expect(log.mints).toEqual([]);
    expect(seen).toEqual(["POST /repos/other/app/pulls Bearer token:other:app"]);
  });
});

describe("the registries", () => {
  /** A provider whose every read answers the token pinned for it. */
  const pinReader = (kind: string) =>
    ({
      kind: SourceControlProviderKind.make(kind),
      getDefaultBranch: () =>
        Effect.map(PinnedGitHubCredential, (pin) => (pin === null ? null : Redacted.value(pin.token))),
    }) as unknown as SourceControlProvider.SourceControlProvider["Service"];

  it("pins the GitHub provider a cwd resolves to, and leaves another host's alone", async () => {
    const log = newLog();
    const stock = {
      resolveLink: () => undefined,
      get: (kind) => Effect.succeed(pinReader(kind)),
      resolveHandle: (input) =>
        Effect.succeed({ provider: pinReader(input.cwd.includes("gitlab") ? "gitlab" : "github"), context: null }),
      resolve: (input) => Effect.succeed(pinReader(input.cwd.includes("gitlab") ? "gitlab" : "github")),
      discover: Effect.succeed([]),
    } satisfies SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
    const registry = withSourceControlTokens(stock, pinsOf(log));
    const branches = await Effect.runPromise(
      Effect.all([
        registry
          .resolve({ cwd: "/w/other-app" })
          .pipe(Effect.flatMap((p) => p.getDefaultBranch({ cwd: "/w/other-app" }))),
        registry
          .resolveHandle({ cwd: "/w/acme-web" })
          .pipe(Effect.flatMap((h) => h.provider.getDefaultBranch({ cwd: "/w/acme-web" }))),
        registry.resolve({ cwd: "/w/gitlab" }).pipe(Effect.flatMap((p) => p.getDefaultBranch({ cwd: "/w/gitlab" }))),
      ]),
    );
    expect(branches).toEqual(["token:other:app", "token:acme:api,web", null]);
  });

  it("pins the GitHub pull request provider only", () => {
    const provider = (kind: string) =>
      ({ kind: SourceControlProviderKind.make(kind) }) as unknown as PullRequestProviderApi;
    const github = provider("github");
    const gitlab = provider("gitlab");
    const registry = withPullRequestTokens(
      PullRequestProviderRegistry.fromProviders([github, gitlab]),
      pinsOf(newLog()),
    );
    expect(registry.get(SourceControlProviderKind.make("github"))).not.toBe(github);
    expect(registry.get(SourceControlProviderKind.make("gitlab"))).toBe(gitlab);
  });
});

describe("the repos an operation acts on", () => {
  const target = (input: unknown) => pinTargetOf(input, repoAt);

  it("reads a pull request's repository before its cwd", () => {
    expect(target({ cwd: "/w/acme-web", host: "github.com", repository: "Other/app", number: 1 })).toEqual({
      owner: "other",
      names: ["app"],
    });
  });

  it("reads the repositories read across, when they share an owner", () => {
    expect(target({ cwd: "/w/acme-web", host: "github.com", repositories: ["acme/web", "acme/api"] })).toEqual({
      owner: "acme",
      names: ["web", "api"],
    });
    expect(
      target({ cwd: "/w/acme-web", host: "github.com", changeRequests: [{ repository: "acme/web", number: 1 }] }),
    ).toEqual({ owner: "acme", names: ["web"] });
    // Two installations: no one token covers them, so t3 runs as its own.
    expect(target({ cwd: "/w/acme-web", host: "github.com", repositories: ["acme/web", "other/app"] })).toBeUndefined();
  });

  it("reads an issue's scope, a link's URL and a source control context's remote", () => {
    expect(target({ cwd: "/w/acme-web", host: "github.com", scope: "other/app", key: "3" })).toEqual({
      owner: "other",
      names: ["app"],
    });
    expect(target({ cwd: "/w/acme-web", url: new URL("https://github.com/other/app/pull/3") })).toEqual({
      owner: "other",
      names: ["app"],
    });
    expect(
      target({
        cwd: "/w/acme-web",
        context: {
          provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
          remoteName: "upstream",
          remoteUrl: "git@github.com:other/app.git",
        },
      }),
    ).toEqual({ owner: "other", names: ["app"] });
  });

  it("reads the Workspace a cwd is in, else nothing", () => {
    expect(target({ cwd: "/w/other-app/src" })).toEqual({ owner: "other", names: ["app"] });
    expect(target({ cwd: "/tmp" })).toBeUndefined();
    expect(target(undefined)).toBeUndefined();
  });

  it("leaves another host's operations alone", () => {
    expect(target({ cwd: "/w/acme-web", host: "gitlab.com", repository: "acme/web" })).toBeUndefined();
    expect(target({ cwd: "/w/acme-web", url: new URL("https://gitlab.com/acme/web/-/issues/1") })).toBeUndefined();
    expect(
      target({
        cwd: "/w/acme-web",
        context: {
          provider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
          remoteName: "origin",
          remoteUrl: "https://gitlab.com/acme/web.git",
        },
      }),
    ).toBeUndefined();
  });
});
