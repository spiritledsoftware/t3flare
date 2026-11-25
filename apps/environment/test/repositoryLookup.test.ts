// @effect-diagnostics effectFnOpportunity:off globalDate:off cryptoRandomUUID:off
// t3's lookup of a GitHub repository a Project is added from (SPI-1398), through t3's own SourceControlRepositoryService
// and GitHub provider, over a fake GitHub: the lookup carries a GitHub App token minted for that repo, whatever
// Workspaces exist, and a lookup that cannot have one says why instead of t3's generic sentence.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitHubNotInstalled, GitHubRefused } from "@t3flare/github-app/app";
import { REPOSITORY_LOOKUP_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import { SourceControlProviderKind, type SourceControlRepositoryError } from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "t3/src/config.ts";
import * as SourceControlProviderRegistry from "t3/src/sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "t3/src/sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "t3/src/vcs/GitVcsDriver.ts";
import { describe, expect, it } from "vitest";

import * as GitHubAppSignIn from "../../../t3code/packages/source-control-github/src/server/GitHubAppSignIn.ts";
import * as GitHubCredentials from "../../../t3code/packages/source-control-github/src/server/GitHubCredentials.ts";
import * as GitHubQuota from "../../../t3code/packages/source-control-github/src/server/GitHubQuota.ts";
import * as GitHubRest from "../../../t3code/packages/source-control-github/src/server/GitHubRest.ts";
import * as GitHubSourceControlProvider from "../../../t3code/packages/source-control-github/src/server/GitHubSourceControlProvider.ts";
import * as TestSourceControlHost from "../../../t3code/packages/source-control-testing/src/TestSourceControlHost.ts";

import type { MintRequest } from "../src/agents/github.ts";
import { GENERIC_DETAIL, withRepositoryLookupTokens, type LookupMinter } from "../src/t3/repositoryLookup.ts";

const github = SourceControlProviderKind.make("github");

/** GitHub's answer for a repo: it exists, and the token is one minted for it. */
const repo = (owner: string, name: string) => ({
  full_name: `${owner}/${name}`,
  html_url: `https://github.com/${owner}/${name}`,
  ssh_url: `git@github.com:${owner}/${name}.git`,
});

/**
 * A fake GitHub: `repos/<owner>/<name>` answers for a private repo in `privateRepos` only with a token minted for it
 * (`token:<owner>/<name>`), as an installation token restricted to its repositories would; a revoked token (`stale:…`)
 * gets 401; else 404.
 */
const fakeGitHub = (privateRepos: ReadonlyArray<string>, seen: Array<string>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const auth = request.headers.authorization ?? "";
      seen.push(`${request.method} ${url.pathname} ${auth}`);
      const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const full = match === null ? "" : `${match[1]}/${match[2]}`.toLowerCase();
      const ok = match !== null && privateRepos.includes(full) && auth === `Bearer token:${full}`;
      return HttpClientResponse.fromWeb(
        request,
        auth.startsWith("Bearer stale:")
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : ok
            ? Response.json(repo(...(full.split("/") as [string, string])))
            : Response.json({ message: "Not Found" }, { status: 404 }),
      );
    }),
  );

const appSignedOut = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
  enabled: false,
  token: () => Effect.succeedNone,
  invalidate: () => Effect.void,
});

/**
 * t3's credential source as the process router answers it with no GitHub Workspace: `gh auth token` exits 1, which t3
 * reads as not signed in.
 */
const noGhToken = Layer.succeed(
  GitHubCredentials.GitHubCredentials,
  GitHubCredentials.GitHubCredentials.of({
    get: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
    saved: () => Effect.succeedNone,
    fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
    invalidate: () => Effect.void,
  }),
);

/** t3's own repository service over t3's own GitHub provider, the fake GitHub and the router's `gh auth token`. */
const stockService = (privateRepos: ReadonlyArray<string>, seen: Array<string>) =>
  Effect.gen(function* () {
    const http = Layer.succeed(HttpClient.HttpClient, fakeGitHub(privateRepos, seen));
    const rest = GitHubRest.layer.pipe(
      Layer.provide(Layer.mergeAll(noGhToken, http, appSignedOut)),
      Layer.provideMerge(GitHubQuota.layer),
      Layer.provideMerge(SourceControlRateLimit.layer),
    );
    const host = TestSourceControlHost.layer({
      process: {
        run: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      },
    });
    const provider = yield* GitHubSourceControlProvider.make.pipe(
      Effect.provide(Layer.mergeAll(rest, http, host, NodeServices.layer)),
    );
    return yield* SourceControlRepositoryService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, { cwd: "/" } as unknown as ServerConfig.ServerConfig["Service"]),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            get: () => Effect.succeed(provider),
            resolveLink: () => undefined,
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

/** A minter that mints `token:<owner>/<name>` for one repo, or fails with `refuse`'s error; it records each request. */
/** What the fake minter was asked: each mint, each failure forgotten, each token GitHub refused. */
interface MinterLog {
  readonly requests: Array<MintRequest>;
  readonly forgotten: Array<MintRequest>;
  readonly invalidated: Array<string>;
}

const newLog = (): MinterLog => ({ requests: [], forgotten: [], invalidated: [] });

/**
 * A minter that mints `token:<owner>/<name>` for one repo, or fails with `refuse`'s error. With `stale`, it hands out a
 * revoked `stale:` token until told GitHub refused it, as `GitHubTokens` re-serves one after the App is reinstalled.
 */
const minter = (
  log: MinterLog,
  options: { readonly refuse?: () => Error; readonly live?: ReadonlyArray<string>; readonly stale?: boolean },
): LookupMinter => ({
  mint: async (request) => {
    log.requests.push(request);
    if (options.refuse !== undefined) throw options.refuse();
    const repo = `${request.owner}/${request.repositories.join(",")}`;
    const stale = options.stale === true && !log.invalidated.includes(`stale:${repo}`);
    return { token: `${stale ? "stale" : "token"}:${repo}`, expiresAt: Date.now() + 3_600_000 };
  },
  forget: (request) => void log.forgotten.push(request),
  invalidate: (token) => void log.invalidated.push(token),
  live: () => options.live ?? [],
});

const service = (options: {
  readonly privateRepos?: ReadonlyArray<string>;
  readonly log?: MinterLog;
  readonly refuse?: () => Error;
  readonly live?: ReadonlyArray<string>;
  readonly stale?: boolean;
  readonly seen?: Array<string>;
}) => {
  const log = options.log ?? newLog();
  return stockService(options.privateRepos ?? [], options.seen ?? []).pipe(
    Effect.map((stock) => withRepositoryLookupTokens(stock, () => minter(log, options))),
  );
};

const lookup = (svc: SourceControlRepositoryService.SourceControlRepositoryService["Service"], repository: string) =>
  svc.lookupRepository({ provider: github, repository });

const failureOf = <A>(effect: Effect.Effect<A, SourceControlRepositoryError>) => Effect.runPromise(Effect.flip(effect));

describe("t3's lookup of a GitHub repository (SPI-1398)", () => {
  it("fails with t3's generic sentence on stock t3 when the Environment has no GitHub Workspace (the bug)", async () => {
    const error = await Effect.runPromise(
      stockService(["acme/notes"], []).pipe(Effect.flatMap((stock) => Effect.flip(lookup(stock, "acme/notes")))),
    );
    expect(error.detail).toBe(GENERIC_DETAIL);
  });

  it("with no GitHub Workspace, finds a private repo the App is installed on, with a token minted for that repo alone", async () => {
    const log = newLog();
    const requests = log.requests;
    const seen: Array<string> = [];
    const info = await Effect.runPromise(
      service({ privateRepos: ["acme/notes"], log, seen }).pipe(Effect.flatMap((svc) => lookup(svc, "acme/notes"))),
    );
    expect(info).toEqual({
      provider: github,
      nameWithOwner: "acme/notes",
      url: "https://github.com/acme/notes",
      sshUrl: "git@github.com:acme/notes.git",
    });
    expect(requests).toEqual([
      { owner: "acme", repositories: ["notes"], permissions: REPOSITORY_LOOKUP_GITHUB_PERMISSIONS },
    ]);
    expect(seen).toEqual(["GET /repos/acme/notes Bearer token:acme/notes"]);
  });

  it("finds a private repo of an owner whose other repos are Workspaces, minting for the repo looked up", async () => {
    // The Environment's own `gh auth token` would name `acme/web` only; the lookup's token names the repo it reads.
    const log = newLog();
    const requests = log.requests;
    const info = await Effect.runPromise(
      service({ privateRepos: ["acme/web", "acme/notes"], log }).pipe(
        Effect.flatMap((svc) => lookup(svc, "https://github.com/Acme/notes.git")),
      ),
    );
    expect(info.nameWithOwner).toBe("acme/notes");
    expect(requests.map((r) => [r.owner, r.repositories])).toEqual([["acme", ["notes"]]]);
  });

  it("finds it through prepareClone too, as adding a Project by owner/name does", async () => {
    const log = newLog();
    const requests = log.requests;
    const prepared = await Effect.runPromise(
      service({ privateRepos: ["acme/notes"], log }).pipe(
        Effect.flatMap((svc) =>
          svc.prepareClone({
            provider: github,
            repository: "acme/notes",
            destinationPath: `/tmp/t3flare-lookup-test-${crypto.randomUUID()}/notes`,
          }),
        ),
      ),
    );
    expect(prepared.repository?.nameWithOwner).toBe("acme/notes");
    expect(requests).toHaveLength(1);
  });

  it("names an owner the App is not installed on", async () => {
    const error = await failureOf(
      service({ refuse: () => new GitHubNotInstalled("acme") }).pipe(
        Effect.flatMap((svc) => lookup(svc, "acme/notes")),
      ),
    );
    expect(error.detail).not.toBe(GENERIC_DETAIL);
    expect(error.detail).toContain("The GitHub App is not installed on acme");
    expect(error.message).toContain("not installed on acme");
  });

  it("names a repo outside the installation's selected repositories, or one that does not exist", async () => {
    const error = await failureOf(
      service({
        refuse: () =>
          new GitHubRefused(
            422,
            "GitHub refused the GitHub App's request (422: There is at least one repository that does not exist or is not accessible to the parent installation.)",
          ),
      }).pipe(Effect.flatMap((svc) => lookup(svc, "acme/notes"))),
    );
    expect(error.detail).toContain("acme/notes");
    expect(error.detail).toContain("selected repositories");
    expect(error.detail).toContain("does not exist");
  });

  it("says GitHub's own reason when the repo cannot be read with its token, not the generic sentence", async () => {
    // Minted, but GitHub answers 404 (a repo deleted since, say): t3's provider detail reaches the client.
    const error = await failureOf(
      service({ privateRepos: [] }).pipe(Effect.flatMap((svc) => lookup(svc, "acme/gone"))),
    );
    expect(error.detail).toBe("Repository not found. Check the owner and name and try again.");
  });

  it("takes live tokens and URL credentials out of the reason", async () => {
    const error = await failureOf(
      service({
        refuse: () => new Error("refused ghs_secret at https://x-access-token:ghs_other@github.com/acme/notes.git"),
        live: ["ghs_secret"],
      }).pipe(Effect.flatMap((svc) => lookup(svc, "acme/notes"))),
    );
    expect(error.detail).toContain("acme/notes");
    expect(error.detail).not.toContain("ghs_secret");
    expect(error.detail).not.toContain("ghs_other");
    expect(error.detail).toContain("https://github.com/acme/notes.git");
  });

  it("takes out userinfo holding an @ and a URL's query, as t3 does", async () => {
    const error = await failureOf(
      service({
        refuse: () =>
          new Error(
            "refused https://u:p@ss@github.com/acme/notes.git and https://github.com/acme/notes?token=ghs_q&x=1",
          ),
      }).pipe(Effect.flatMap((svc) => lookup(svc, "acme/notes"))),
    );
    expect(error.detail).not.toContain("ss@");
    expect(error.detail).not.toContain("p@");
    expect(error.detail).not.toContain("ghs_q");
    expect(error.detail).toContain("refused https://github.com/acme/notes.git and https://github.com/acme/notes");
  });

  it("asks GitHub again at each lookup, never telling a remembered failure", async () => {
    // GitHubApp keeps a failed mint for a wait (GITHUB_RETRY_SECONDS); the Owner who installs the App and retries at once
    // must not meet it, so each lookup forgets it first.
    const log = newLog();
    await failureOf(
      service({ log, refuse: () => new GitHubNotInstalled("acme") }).pipe(
        Effect.flatMap((svc) => lookup(svc, "acme/notes")),
      ),
    );
    expect(log.forgotten).toEqual(log.requests);
    expect(log.forgotten).toHaveLength(1);
  });

  it("after GitHub refuses a re-served token, runs t3's own lookup, says why, and mints afresh next time", async () => {
    const log = newLog();
    const seen: Array<string> = [];
    const svc = await Effect.runPromise(service({ privateRepos: ["acme/notes"], log, stale: true, seen }));
    const error = await failureOf(lookup(svc, "acme/notes"));
    expect(error.detail).toBe(
      "GitHub refused the GitHub App's token for acme/notes; t3flare mints another at the next lookup.",
    );
    expect(log.invalidated).toEqual(["stale:acme/notes"]);
    // The pinned try, then t3's own unpinned one, which asks `gh auth token` (none here) and so sends nothing.
    expect(seen).toEqual(["GET /repos/acme/notes Bearer stale:acme/notes"]);
    const info = await Effect.runPromise(lookup(svc, "acme/notes"));
    expect(info.nameWithOwner).toBe("acme/notes");
  });

  it("mints nothing for a bare name, another host, or another provider", async () => {
    const log = newLog();
    const requests = log.requests;
    await Effect.runPromise(
      service({ log }).pipe(
        Effect.flatMap((svc) =>
          Effect.all(
            [
              Effect.flip(lookup(svc, "notes")),
              Effect.flip(lookup(svc, "code.example.test/acme/notes")),
              Effect.flip(
                svc.lookupRepository({ provider: SourceControlProviderKind.make("gitlab"), repository: "acme/notes" }),
              ),
            ],
            { concurrency: 1 },
          ),
        ),
      ),
    );
    expect(requests).toEqual([]);
  });
});
