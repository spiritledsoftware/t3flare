// @effect-diagnostics effectFnOpportunity:off
// t3's GitHub pull request, source control and issue features on a GitHub App token for the repo each operation acts on
// (ADR-0001: Layers over t3's three provider registries; ADR-0013). t3's GitHub provider reads one credential per host,
// from `gh auth token`, which the process router answers with a token for one installation: the first Workspace's
// owner. Installation tokens are per owner, so an Environment with Projects under two owners had every operation on the
// second owner's repos refused ("Resource not accessible by integration"). Each operation now runs with a token minted
// for its repo's owner pinned through t3's `PinnedGitHubCredential`, which t3's request policy takes before any other
// credential; `gh auth token` keeps answering what t3 asks without a repo.
import { ENVIRONMENT_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import { isUnderW, toWorkspace } from "@t3flare/workspace-client";
import { type IssueTrackerKind, type SourceControlProviderKind } from "@t3tools/contracts";
import {
  repositoryPathFromRemoteUrl,
  type SourceControlProvider,
} from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as IssueTrackerRegistry from "t3/src/issue/IssueTrackerRegistry.ts";
import * as PullRequestProviderRegistry from "t3/src/pullRequest/PullRequestProviderRegistry.ts";
import * as SourceControlProviderRegistry from "t3/src/sourceControl/SourceControlProviderRegistry.ts";

import { PinnedGitHubCredential } from "../../../../t3code/packages/source-control-github/src/server/GitHubRequestPolicy.ts";
import { parseGitHubRepositorySelector } from "../../../../t3code/packages/source-control-github/src/server/gitHubRepositoryResolution.ts";
import { environmentServices } from "../agents/bindings.ts";
import type { Minted, MintRequest } from "../agents/github.ts";
import { scratchProjectOf } from "../agents/scratch.ts";

/** The GitHub App is github.com's; another host's operations keep t3's own credential. */
const APP_HOST = "github.com";

/** The kind t3 registers its GitHub provider, PR provider and issue tracker under. */
const GITHUB = "github";

/** A repo on github.com, as a Workspace names it. */
export interface GitHubRepo {
  readonly owner: string;
  readonly name: string;
}

/** Where an operation's token comes from: the Environment's GitHub App, and the github.com repos of its Workspaces. */
export interface ProviderPins {
  readonly mint: (request: MintRequest) => Promise<Minted>;
  /** GitHub refused `token`: the next `mint` mints another rather than handing it out again. */
  readonly invalidate: (token: string) => void;
  /** The github.com repo of the Workspace `cwd` is in (a project, a worktree, a scratch checkout), if any. */
  readonly repoAt: (cwd: string) => GitHubRepo | undefined;
  /** The names of `owner`'s repos among the Environment's github.com Projects. */
  readonly reposOf: (owner: string) => ReadonlyArray<string>;
}

/** The repos an operation acts on, all of one owner (one installation, so one token can cover them). */
export interface PinTarget {
  readonly owner: string;
  readonly names: ReadonlyArray<string>;
}

const isGitHubHost = (host: string): boolean => host.trim().toLowerCase() === APP_HOST;

/** `owner/name` (or a github.com URL) on github.com; null for anything else. */
const repoNamed = (repository: string): GitHubRepo | null => {
  const locator = parseGitHubRepositorySelector(repository, APP_HOST);
  return locator === null || locator.host !== APP_HOST ? null : { owner: locator.owner, name: locator.name };
};

/** The repo a source control context's remote names, when the context is github.com's. */
const repoOfContext = (context: object): GitHubRepo | null | undefined => {
  if (!("remoteUrl" in context) || typeof context.remoteUrl !== "string") return undefined;
  const provider = "provider" in context ? context.provider : undefined;
  const baseUrl =
    typeof provider === "object" && provider !== null && "baseUrl" in provider ? provider.baseUrl : undefined;
  if (typeof baseUrl !== "string" || !URL.canParse(baseUrl) || !isGitHubHost(new URL(baseUrl).host)) return null;
  const path = repositoryPathFromRemoteUrl(context.remoteUrl);
  return path === null ? null : repoNamed(path);
};

/** One target for `repos` when they share an owner; none when they are of two owners, or there are none. */
const targetOf = (repos: ReadonlyArray<GitHubRepo | null>): PinTarget | undefined => {
  const named = repos.filter((repo): repo is GitHubRepo => repo !== null);
  if (named.length === 0 || named.length !== repos.length) return undefined;
  const owner = named[0]!.owner.toLowerCase();
  if (named.some((repo) => repo.owner.toLowerCase() !== owner)) return undefined;
  return { owner, names: [...new Set(named.map((repo) => repo.name))] };
};

/**
 * The repos an operation of t3's GitHub providers acts on, read from its input: its `repository` (a pull request's
 * `ProviderRepositoryRef`, a clone URL lookup), the `repositories` or `changeRequests` it reads across, an issue's
 * `scope`, a link's `url`, a source control `context`'s remote, else the Workspace its `cwd` is in. An input naming
 * another host, or repos of two owners, has none, and runs as t3's own.
 */
export const pinTargetOf = (input: unknown, repoAt: (cwd: string) => GitHubRepo | undefined): PinTarget | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  if ("host" in input && typeof input.host === "string" && !isGitHubHost(input.host)) return undefined;
  if ("repository" in input && typeof input.repository === "string") return targetOf([repoNamed(input.repository)]);
  if ("repositories" in input && Array.isArray(input.repositories)) {
    const repositories: ReadonlyArray<unknown> = input.repositories;
    return targetOf(repositories.map((repository) => (typeof repository === "string" ? repoNamed(repository) : null)));
  }
  if ("changeRequests" in input && Array.isArray(input.changeRequests)) {
    const changeRequests: ReadonlyArray<unknown> = input.changeRequests;
    return targetOf(
      changeRequests.map((request) =>
        typeof request === "object" &&
        request !== null &&
        "repository" in request &&
        typeof request.repository === "string"
          ? repoNamed(request.repository)
          : null,
      ),
    );
  }
  if ("scope" in input && typeof input.scope === "string") return targetOf([repoNamed(input.scope)]);
  if ("url" in input && input.url instanceof URL) {
    if (!isGitHubHost(input.url.host)) return undefined;
    const [owner, name] = input.url.pathname.split("/").filter(Boolean);
    return owner === undefined || name === undefined ? undefined : targetOf([{ owner, name }]);
  }
  if ("context" in input && typeof input.context === "object" && input.context !== null) {
    const repo = repoOfContext(input.context);
    if (repo !== undefined) return repo === null ? undefined : targetOf([repo]);
  }
  if ("cwd" in input && typeof input.cwd === "string") {
    const repo = repoAt(input.cwd);
    return repo === undefined ? undefined : targetOf([repo]);
  }
  return undefined;
};

/** A refusal t3's request policy gives the credential it carried, anywhere in an error's causes: a 401, or a 403. */
const refusedCredential = (error: unknown): boolean => {
  let cause = error;
  // t3 wraps a request's failure in a provider error or two; a few levels reach it.
  for (let depth = 0; depth < 6 && typeof cause === "object" && cause !== null; depth++) {
    if ("_tag" in cause) {
      if (cause._tag === "GitHubApiAuthenticationError") return true;
      if (cause._tag === "GitHubApiResponseError" && "status" in cause && cause.status === 403) return true;
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
};

/**
 * `effect`, run with a token for `target`'s owner pinned. The token covers the owner's Projects' repos and the ones
 * named, so t3's batched reads, which share one request per credential fingerprint across repos, are all covered by it;
 * the fingerprint is the installation's, as GitHub counts its rate limit. A pin already in place (t3's own, or a
 * repository lookup's) is left as it is; an owner the App cannot mint for runs as t3's own, on `gh auth token`. A token
 * GitHub refuses is dropped, so the next operation mints another.
 */
const pinnedTo = <A, E, R>(
  pins: ProviderPins,
  target: () => PinTarget | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if ((yield* PinnedGitHubCredential) !== null) return yield* effect;
    const wanted = target();
    if (wanted === undefined) return yield* effect;
    const names = [...new Set([...pins.reposOf(wanted.owner), ...wanted.names].map((name) => name.toLowerCase()))];
    const minted = yield* Effect.promise(() =>
      pins
        .mint({ owner: wanted.owner, repositories: names, permissions: ENVIRONMENT_GITHUB_PERMISSIONS })
        .then((value): Minted | undefined => value)
        .catch(() => undefined),
    );
    if (minted === undefined) return yield* effect;
    return yield* effect.pipe(
      Effect.provideService(PinnedGitHubCredential, {
        host: APP_HOST,
        token: Redacted.make(minted.token),
        // The rate-limit scope t3 keys its pauses by: one per installation, as GitHub counts.
        credentialFingerprint: `${APP_HOST}:t3flare-app:${wanted.owner}`,
      }),
      Effect.tapError((error) =>
        refusedCredential(error) ? Effect.sync(() => pins.invalidate(minted.token)) : Effect.void,
      ),
    );
  });

/**
 * `service` with every method that answers an Effect run pinned to the repo its first argument names
 * (`pinTargetOf`). Everything else (a Stream, a plain value, a sync helper) is t3's own: a Stream outlives a token.
 */
export const withProviderTokens = <T extends object>(service: T, pins: () => ProviderPins): T =>
  new Proxy(service, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: Array<unknown>) => {
        const out: unknown = value.apply(target, args);
        if (!Effect.isEffect(out)) return out;
        const sources = pins();
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's Effect, its channels kept as they are
        return pinnedTo(sources, () => pinTargetOf(args[0], sources.repoAt), out);
      };
    },
  });

/** The Environment's GitHub App and Workspaces, as t3's providers' operations use them. */
export const environmentPins = (): ProviderPins => {
  const services = environmentServices();
  const github = services.github();
  return {
    mint: (request) => github.mint(request),
    invalidate: (token) => github.invalidate(token),
    repoAt: (cwd) => {
      if (!isUnderW(cwd)) return undefined;
      const id = scratchProjectOf(cwd) ?? toWorkspace(cwd)?.id;
      const ws = id === undefined ? undefined : services.workspaces.resolve(id);
      if (ws === undefined || ws.host !== APP_HOST || ws.owner === null || ws.name === null) return undefined;
      return { owner: ws.owner, name: ws.name };
    },
    reposOf: (owner) =>
      services.workspaces
        .projects()
        .filter((ws) => ws.host === APP_HOST && ws.owner === owner && ws.name !== null)
        .map((ws) => ws.name!),
  };
};

const isGitHub = (kind: SourceControlProviderKind | IssueTrackerKind): boolean => kind === GITHUB;

/** t3's pull request providers, GitHub's on the App's token for each repo. */
export const withPullRequestTokens = (
  stock: PullRequestProviderRegistry.PullRequestProviderRegistry["Service"],
  pins: () => ProviderPins,
): PullRequestProviderRegistry.PullRequestProviderRegistry["Service"] => {
  const wrapped = new Map(
    stock.kinds.filter(isGitHub).flatMap((kind) => {
      const provider = stock.get(kind);
      return provider === null ? [] : [[kind, withProviderTokens(provider, pins)] as const];
    }),
  );
  return { ...stock, get: (kind) => wrapped.get(kind) ?? stock.get(kind) };
};

/** t3's issue trackers, GitHub's on the App's token for each repo; standalone trackers (Linear) are t3's own. */
export const withIssueTrackerTokens = (
  stock: IssueTrackerRegistry.IssueTrackerRegistry["Service"],
  pins: () => ProviderPins,
): IssueTrackerRegistry.IssueTrackerRegistry["Service"] => {
  const wrapped = new Map(
    stock.kinds.filter(isGitHub).flatMap((kind) => {
      const tracker = stock.get(kind);
      return tracker === null ? [] : [[kind, withProviderTokens(tracker, pins)] as const];
    }),
  );
  return { ...stock, get: (kind) => wrapped.get(kind) ?? stock.get(kind) };
};

/** t3's source control providers, GitHub's on the App's token for the repo of each operation. */
export const withSourceControlTokens = (
  stock: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  pins: () => ProviderPins,
): SourceControlProviderRegistry.SourceControlProviderRegistry["Service"] => {
  const pinned = (provider: SourceControlProvider["Service"]): SourceControlProvider["Service"] =>
    isGitHub(provider.kind) ? withProviderTokens(provider, pins) : provider;
  return SourceControlProviderRegistry.SourceControlProviderRegistry.of({
    ...stock,
    // A link's subject is read by the provider t3 keeps inside the registry, so its lookup is pinned here.
    resolveLink: (input) => {
      const lookup = stock.resolveLink(input);
      if (lookup === undefined) return undefined;
      const sources = pins();
      return pinnedTo(sources, () => pinTargetOf(input, sources.repoAt), lookup);
    },
    get: (kind) => stock.get(kind).pipe(Effect.map(pinned)),
    resolveHandle: (input) =>
      stock.resolveHandle(input).pipe(Effect.map((handle) => ({ ...handle, provider: pinned(handle.provider) }))),
    resolve: (input) => stock.resolve(input).pipe(Effect.map(pinned)),
  });
};

/** t3's pull request provider registry, its GitHub provider on the Environment's GitHub App. */
export const layerPullRequestProviderRegistry = Layer.effect(
  PullRequestProviderRegistry.PullRequestProviderRegistry,
  Effect.gen(function* () {
    return withPullRequestTokens(yield* PullRequestProviderRegistry.PullRequestProviderRegistry, environmentPins);
  }),
).pipe(Layer.provide(PullRequestProviderRegistry.layer));

/** t3's issue tracker registry, its GitHub tracker on the Environment's GitHub App. */
export const layerIssueTrackerRegistry = Layer.effect(
  IssueTrackerRegistry.IssueTrackerRegistry,
  Effect.gen(function* () {
    return withIssueTrackerTokens(yield* IssueTrackerRegistry.IssueTrackerRegistry, environmentPins);
  }),
).pipe(Layer.provide(IssueTrackerRegistry.layer));

/**
 * t3's source control provider registry, its GitHub provider on the Environment's GitHub App. It needs what t3's own
 * `layer` needs (the drivers, the VCS registry, the server's config and settings), which the composition root provides.
 */
export const layerSourceControlProviderRegistry = Layer.effect(
  SourceControlProviderRegistry.SourceControlProviderRegistry,
  Effect.gen(function* () {
    return withSourceControlTokens(yield* SourceControlProviderRegistry.SourceControlProviderRegistry, environmentPins);
  }),
).pipe(Layer.provide(SourceControlProviderRegistry.layer));
