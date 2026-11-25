// @effect-diagnostics effectFnOpportunity:off
// t3's lookup of a GitHub repository a Project is added from (SPI-1398, ADR-0001: a Layer over t3's
// `SourceControlRepositoryService`). t3's GitHub provider reads its credential per host, from `gh auth token`, which the
// process router answers with the Environment's own token: scoped to the repos that are already Workspaces, and none at
// all before the first. A repo being added is not one yet. So each lookup gets a GitHub App token minted for the repo it
// names, pinned for its requests through t3's `PinnedGitHubCredential`; `gh auth token` keeps its scope for t3's PR
// features. A lookup that cannot have one, or that GitHub refuses, says why where t3 would say only its generic sentence.
import { GitHubNotInstalled, GitHubRefused } from "@t3flare/github-app/app";
import { REPOSITORY_LOOKUP_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";
import {
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SourceControlRepositoryService from "t3/src/sourceControl/SourceControlRepositoryService.ts";

import { PinnedGitHubCredential } from "../../../../t3code/packages/source-control-github/src/server/GitHubRequestPolicy.ts";
import { parseGitHubRepositorySelector } from "../../../../t3code/packages/source-control-github/src/server/gitHubRepositoryResolution.ts";
import { environmentServices } from "../agents/bindings.ts";
import type { Minted, MintRequest } from "../agents/github.ts";

/** What t3 says of any provider failure without a `userFacingDetail` (`mapRepositoryError`), every GitHub one included. */
export const GENERIC_DETAIL = "The source control operation could not be completed.";

/** The GitHub App the Environment mints from (`GitHubTokens`), as a lookup uses it. */
export interface LookupMinter {
  readonly mint: (request: MintRequest) => Promise<Minted>;
  /** Every token minted that has not expired, taken out of what a lookup says. */
  readonly live: () => ReadonlyArray<string>;
}

type Service = SourceControlRepositoryService.SourceControlRepositoryService["Service"];
type Pin = typeof PinnedGitHubCredential.Service;

/** The GitHub App is github.com's; another host's repos keep t3's own credential. */
const APP_HOST = "github.com";

const isProviderError = Schema.is(SourceControlProviderError);

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Why no token could be minted for `owner/name`, as one sentence for the client. */
const mintRefusal = (owner: string, name: string, cause: unknown): string => {
  if (cause instanceof GitHubNotInstalled)
    return `The GitHub App is not installed on ${owner}, so ${owner}/${name} cannot be read: install it on ${owner}, with ${name} among its repositories.`;
  // A mint for a repo the installation cannot reach is a 422; GitHub says the same of a repo that does not exist.
  if (cause instanceof GitHubRefused && cause.status === 422)
    return `${owner}/${name} is not among the GitHub App installation's selected repositories on ${owner}, or it does not exist: check the name, or add it to the installation's repositories.`;
  return `The GitHub App could not mint a token to read ${owner}/${name}: ${messageOf(cause)}`;
};

/** A lookup's outcome before t3 runs it: the token to pin, or why there is none. */
type Prepared = { readonly pin: Pin } | { readonly refusal: string } | null;

/**
 * t3's repository service with each GitHub lookup (`lookupRepository`, and `prepareClone` and `cloneRepository` given
 * `owner/name`) run on a token minted for that repo. A repo the App cannot mint for still runs t3's own lookup (a public
 * repo may answer to the Environment's token); if that fails, the refusal is what the client is told.
 */
export const withRepositoryLookupTokens = (stock: Service, minter: () => LookupMinter): Service => {
  /** `text` without URL credentials or any live token. */
  const redact = (text: string): string => {
    let out = text.replace(/\/\/[^/@\s]+@/g, "//***@");
    for (const token of minter().live()) if (token !== "" && out.includes(token)) out = out.replaceAll(token, "***");
    return out;
  };

  const prepare = (provider: SourceControlProviderKind | undefined, repository: string | undefined) =>
    Effect.promise(async (): Promise<Prepared> => {
      if (provider !== "github" || repository === undefined) return null;
      const locator = parseGitHubRepositorySelector(repository, APP_HOST);
      if (locator === null || locator.host !== APP_HOST) return null;
      const owner = locator.owner.toLowerCase();
      try {
        const minted = await minter().mint({
          owner,
          repositories: [locator.name],
          permissions: REPOSITORY_LOOKUP_GITHUB_PERMISSIONS,
        });
        return {
          pin: {
            host: APP_HOST,
            token: Redacted.make(minted.token),
            // The rate-limit scope t3 keys its pauses by: one per installation, as GitHub counts.
            credentialFingerprint: `${APP_HOST}:t3flare-app:${owner}`,
          },
        };
      } catch (cause) {
        return { refusal: redact(mintRefusal(locator.owner, locator.name, cause)) };
      }
    });

  /** t3's generic sentence replaced by the refusal, else by the GitHub provider's own detail. */
  const explained = (error: SourceControlRepositoryError, prepared: Prepared): SourceControlRepositoryError => {
    if (error.detail !== GENERIC_DETAIL) return error;
    const detail =
      prepared !== null && "refusal" in prepared
        ? prepared.refusal
        : isProviderError(error.cause)
          ? redact(error.cause.detail)
          : undefined;
    return detail === undefined
      ? error
      : new SourceControlRepositoryError({
          provider: error.provider,
          operation: error.operation,
          detail,
          cause: error.cause,
        });
  };

  const run = <A>(
    provider: SourceControlProviderKind | undefined,
    repository: string | undefined,
    effect: Effect.Effect<A, SourceControlRepositoryError>,
  ): Effect.Effect<A, SourceControlRepositoryError> =>
    provider !== "github"
      ? effect
      : prepare(provider, repository).pipe(
          Effect.flatMap((prepared) =>
            (prepared !== null && "pin" in prepared
              ? effect.pipe(Effect.provideService(PinnedGitHubCredential, prepared.pin))
              : effect
            ).pipe(Effect.mapError((error) => explained(error, prepared))),
          ),
        );

  return SourceControlRepositoryService.SourceControlRepositoryService.of({
    ...stock,
    lookupRepository: (input) => run(input.provider, input.repository, stock.lookupRepository(input)),
    prepareClone: (input) => run(input.provider, input.repository, stock.prepareClone(input)),
    cloneRepository: (input, options) => run(input.provider, input.repository, stock.cloneRepository(input, options)),
  });
};

/** t3's repository service, its GitHub lookups on the Environment's GitHub App. */
export const layer = Layer.effect(
  SourceControlRepositoryService.SourceControlRepositoryService,
  Effect.map(SourceControlRepositoryService.make, (stock) =>
    withRepositoryLookupTokens(stock, () => environmentServices().github()),
  ),
);
