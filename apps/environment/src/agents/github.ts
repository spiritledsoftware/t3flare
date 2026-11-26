// @effect-diagnostics globalDate:off globalFetch:off
// GitHub tokens from the t3flare GitHub App (ADR-0013), minted by the Environment DO alone (ADR-0018's broker): the
// private key is a secret of the environment Worker only. Every token names its repositories, and every token but the
// Environment's names its permissions (`@t3flare/github-app/permissions`): a Workspace's Container token is its one
// repo, with its own narrow list; the Environment's own token (t3's PR and issue features) names an owner's repos and
// takes all the installation grants.
import { GitHubApp, type MintedToken } from "@t3flare/github-app/app";
import type { GitHubPermissions } from "@t3flare/github-app/permissions";

export interface GitHubAppSecrets {
  readonly appId: string | undefined;
  readonly privateKey: string | undefined;
}

/**
 * The waits the minters use (SPI-1366, SPI-1387): one request's time limit (`OUTSIDE_REQUEST_SECONDS`) and the first
 * wait after a failure GitHub named no time for (`GITHUB_RETRY_SECONDS`). Absent: the App's own, the same values.
 */
export interface GitHubWaits {
  readonly requestTimeoutMs?: (() => number) | undefined;
  readonly retryMs?: (() => number) | undefined;
}

export interface MintRequest {
  /** The installation's account (the repos' owner), lower case. */
  readonly owner: string;
  /** Repository names, without the owner. */
  readonly repositories: ReadonlyArray<string>;
  /** Absent: every permission the installation grants (the Environment token's). */
  readonly permissions: GitHubPermissions | undefined;
}

export interface Minted {
  readonly token: string;
  readonly expiresAt: number;
}

/** A token handed out has at least this long left: t3 caches `gh auth token`'s answer for 5 minutes. */
export const HANDED_OUT_MIN_MS = 15 * 60_000;

/** The minters, one `GitHubApp` per (owner, repositories, permissions), each keeping its own tokens. */
export class GitHubTokens {
  readonly #secrets: GitHubAppSecrets;
  readonly #waits: GitHubWaits;
  readonly #apps = new Map<string, GitHubApp>();
  readonly #minted = new Map<string, Array<MintedToken>>();

  constructor(secrets: GitHubAppSecrets, waits: GitHubWaits = {}) {
    this.#secrets = secrets;
    this.#waits = waits;
  }

  get configured(): boolean {
    return Boolean(this.#secrets.appId && this.#secrets.privateKey);
  }

  #app(request: MintRequest): { readonly app: GitHubApp; readonly key: string } {
    if (!this.configured)
      throw new Error(
        "t3flare: the GitHub App is not configured (T3FLARE_GITHUB_APP_ID, T3FLARE_GITHUB_APP_PRIVATE_KEY)",
      );
    const repositories = [...request.repositories].map((name) => name.toLowerCase()).sort();
    const key = JSON.stringify([request.owner.toLowerCase(), repositories, request.permissions]);
    let app = this.#apps.get(key);
    if (app === undefined) {
      app = new GitHubApp({
        appId: this.#secrets.appId!,
        privateKey: this.#secrets.privateKey!,
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        requestTimeoutMs: this.#waits.requestTimeoutMs,
        retryMs: this.#waits.retryMs,
        permissions: request.permissions,
        repositories,
        kept: {
          load: () => this.#minted.get(key),
          save: (minted) => void this.#minted.set(key, [...minted]),
        },
      });
      this.#apps.set(key, app);
    }
    return { app, key };
  }

  /** A token for `request` with at least HANDED_OUT_MIN_MS left (GitHubApp mints again below 45 minutes). */
  async mint(request: MintRequest): Promise<Minted> {
    const { app, key } = this.#app(request);
    const token = await app.token(request.owner);
    const expiresAt =
      this.#minted.get(key)?.find((minted) => minted.token === token)?.expiresAt ?? Date.now() + 45 * 60_000;
    return { token, expiresAt };
  }

  /**
   * Forget the last failure to mint for `request`, so its next `mint` asks GitHub at once rather than telling the failure
   * again (a wait GitHub named, a rate limit, still holds): for a mint the Owner asks for and retries (a repository
   * lookup, SPI-1398), never for one t3flare repeats.
   */
  forget(request: MintRequest): void {
    if (!this.configured) return;
    this.#app(request).app.forget(request.owner.toLowerCase());
  }

  /** Tell every minter GitHub refused `token` (a 401), so the next `mint` for its request mints another. */
  invalidate(token: string): void {
    for (const app of this.#apps.values()) app.invalidate(token);
  }

  /** Every token minted that has not expired, for taking out of output. */
  live(): ReadonlyArray<string> {
    return [...this.#apps.values()].flatMap((app) => app.live());
  }
}
