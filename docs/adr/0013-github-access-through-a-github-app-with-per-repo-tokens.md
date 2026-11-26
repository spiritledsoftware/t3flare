# GitHub access through a GitHub App with per-repo tokens

A dedicated `t3flare` GitHub App mints one-hour installation tokens, each scoped to the Workspace's one repo with an explicit permission list. Git network operations run in the Container through a credential helper; t3's PR features call the GitHub GraphQL API from the Environment DO, with the minted token supplied where t3 reads `GH_TOKEN`. A token pasted into t3's settings still works, as stock t3.

## Considered Options

- **A fine-grained PAT as a Worker secret**: no code, but a year-long token an agent can read.
- **Sharing another system's GitHub App**: each system should revoke separately.

## Refinement (step 2a)

How part 1 implements it, with evidence in `steps-evidence-1:docs/steps/step-2a/` (`m4-pr.json`, `m5-agent-push.json`):

- **Three permission lists** (`packages/github-app/src/permissions.ts`): the App asks for everything any token may need; a **Container token** is the Workspace's one repo with `contents` and `pull_requests` write; `workflows: write` is added only for a Workspace the owner opted in (a registry flag, off by default; the push of `.github/workflows/…` was refused by GitHub without it and accepted with it). An **Environment token** (t3's PR features) has the App's read permissions plus `pull_requests: write`, for the repos of the Environment's Projects in one installation.
- **t3's PR features read the Environment token from `gh auth token`**, which the Environment's process router answers; t3 then calls GitHub's REST API itself. t3 needs no other `gh` command (R6 settled). Not `GH_TOKEN`, which t3 reads only from a static environment.
- **Git network operations in the Container use a credential helper** that holds no token: for t3's own push, fetch and pull the router passes the Workspace's Container token in that one command's environment; for the agent's own `git push`/`fetch` from its shell, the helper asks the Workspace DO at that moment (through computer's egress host), which asks the Environment DO, the only minter. Nothing is written to disk or kept in the agent's shell, and the agent gets the same scoping as t3 (one repo; `workflows` only when opted in): its push to another installed repo failed with "Repository not found".
- **The Environment's GitHub client is the only minter**; the private key is a secret of the environment Worker alone.

## Refinement (step 3: pushes from linked work, owner decision D1)

**Superseded** by the back-to-stock refinement below (owner, 2026-11-12, back to stock).

Work started over a Peer link may `git push` the project's repo, but **every push needs its own approval**, which "accept for the session" never covers, in any mode. The gate is where the token is handed out, since a remote task runs in the project's shared checkout and the Container token is per Workspace: a Session whose thread carries a `linkOrigin` notes, before each of its commands, that linked work is active in its Workspace (for 30 minutes). While it is, the credential helper says what git is doing (its git ancestor: push, fetch or unknown). A fetch gets a **read-only token** (`contents: read`), so claiming "fetch" for a push only makes the push fail; anything else asks the owner on the linked thread (an approval titled "Allow git push?", showing the command) and gets the write token only if approved; with no live linked turn to ask, or no answer in 10 minutes, no token. Proved on the fixture (`steps-evidence-1:docs/steps/step-3/m3-push.json`): the fetch asked nothing, a declined `git push origin HEAD:main` left the remote `main` unchanged, an approved one pushed once, the next asked again although the one before was accepted "for the session".

**Residual risk, accepted for step 3:** an approved push hands git a write token that a hostile agent could capture (by wrapping the helper) and reuse until it expires (at most an hour). The fix is filed as a high-priority ticket, "Link-started pushes: keep the write token out of the Container": the Workspace DO's egress adds the auth header per approved push, so the token never enters the Container. Also residual: a detached process a linked thread started more than 30 minutes before its push is not counted as linked work.

## Refinement (SPI-1004): GitHub is the App's identity, and GitHub only (owner decision D2)

t3's GitHub features act as the **App**, not as the owner. They call GitHub with an installation token, so GitHub attributes what they do (a pull request opened, a comment, a review) to the App's bot account, and pushes use App tokens.

Some features need an owner's user token, and they are missing by this decision, not by a bug:

- "my PRs" filters
- starred repositories
- publishing a new repository

A token pasted into t3's settings still works as in stock t3, at the owner's choice. There is no owner token held by t3flare.

Other hosts (GitLab, Bitbucket, Azure DevOps, Forgejo) are out of scope for now: cloning works for public repos only, and t3's discovery reports their CLIs "not found". A later decision may add an owner token or a host, each with its own ADR.

## Refinement (SPI-992, SPI-1040): no write token in any Container; pushes go through the push gateway

**Superseded** by the back-to-stock refinement below (owner, 2026-11-12, back to stock). Kept as the record of what was built.

Supersedes step 3's residual risk and the write half of step 2a's Container token. Evidence in `steps-evidence-1:docs/steps/spi-992/`; the report is `docs-archive-1:docs/steps/spi-992.md`.

- **The Container token is read-only code** (`contents: read`, `pull_requests: write`, `metadata: read`): it clones and fetches, and lets an agent's `gh pr create`/`view` work, since a pull request carries no code. The credential helper (protocol `v=2`) answers only `https://github.com`, so it never hands a token to a `pushurl` on another host (a finding of the plan: the old helper did).
- **Every push to github.com goes through the push gateway**: the image's system gitconfig rewrites it (`pushInsteadOf` to `http://computer.internal/t3flare/git/`), and the agents Worker's outbound handler forwards it to GitHub with a **gateway token** (`contents: write`, plus `workflows: write` for an opted-in Workspace) that never enters a Container or a Session. Before forwarding, the gateway parses the receive-pack command list strictly, re-serialises it from what it parsed (no parser differential), and asks the Workspace DO's policy (`pushDecision`) about the exact ref updates:
  - **allow** when every update matches an **expectation** (t3's own push: the process router registers the updates of t3's push argv before the command and removes them after, review M2), or when the Workspace has no **taint**;
  - **ask** while the Workspace is tainted: on the linked thread whose work it is (its card says which link), else on the one owner thread pushing (a Durable Session with a command running, or one owner CLI process in a turn); the card carries its own buttons: an owner's card offers "Allow this push once" and, under t3's "more" menu with a warning, "Allow and trust this Workspace again (clears the linked-work mark)", the only answer that clears the taint (never t3's default "Always allow this session" wording); a linked card offers only "Allow this push" and "Decline", and never trusts;
  - **refuse** otherwise, with a named message (`t3flare: this Workspace ran linked work …`).
- **Taint** outlives the 30-minute linked-work window, Container stops and DO restarts (review H1): a planted `core.fsmonitor`, hook or detached loop that later runs as the owner still meets the ask. The owner clears it with the admin `workspace-trust` route or an owner card.
- **CLI threads are asked too (SPI-1040)**: the Environment DO's `approvePush` reaches the thread's CLI wrapper, which raises t3's "Allow git push?" card on its live turn and answers it itself (U37). Without a live turn the push is refused.
- **Who may call the policy.** `authorizePush` is called only by the gateway (`WorkspaceProxy`, in the agents Worker, on the Container's egress); `expectPush`/`unexpectPush` only by the Environment's process router (Environment DO → Workspace DO RPC). Neither is reachable from a Container (its egress reaches the DO only through `WorkspaceProxy`'s paths) or from a Session.
- **A card shows GitHub's truth** (the tips GitHub advertised, the exact refs and ids) beside what the Workspace reports (commit subjects, fast-forward), labelled as the Workspace's claim (review M6). A card whose git went away is withdrawn (review M7).

Accepted costs and residual risks:

- **100 MiB per push.** Cloudflare caps a request body through an outbound handler at 100 MiB (P3: 90 MiB landed, 110 MiB got 413). A bigger push fails; split it. A ticket asks Cloudflare to raise the cap.
- **Git LFS** uploads go to GitHub's LFS API, not receive-pack; with a read-only token they fail. Ticketed.
- **GitHub Actions.** An approved push can still change `.github/workflows` in an opted-in Workspace, and any pushed branch runs the repo's existing workflows with their secrets: approving a push is approving what CI will run. Recommended for the owner's repos: default workflow permissions read-only (`GITHUB_TOKEN`), and branch protection on the default branch.
- **What the gateway cannot see.** It sees refs and object ids, not intent. Expectations are bound to `{ref, new}` for 30 minutes, so a hostile process that makes the same update t3 is about to push races t3 and wins nothing it was not getting. The helper's host check keeps git from sending a token to a foreign `pushurl`, but it does not stop a hostile process, which can ask the helper's endpoint itself: what closes that is that every token the endpoint issues is read-only.

## Refinement (back to stock, owner 2026-11-12): the agent's git pushes with the Workspace's token; the mode is the gate

Owner, 2026-11-12, back to stock (scope audit row 1). Supersedes step 3's D1 refinement and the SPI-992/SPI-1040
refinement. t3flare behaves like stock t3: the agent's shell pushes with the repo's credential, and the thread's mode
is the only gate.

- **The Container token writes code again**, as in step 2a: the Workspace's one repo, `contents: write`,
  `pull_requests: write`, `metadata: read`, and `workflows: write` only for a Workspace the owner opted in (kept, K7).
  The credential helper hands it to any git in the Container that asks about `https://github.com`; it still answers no
  other protocol or host (SPI-992's early fix, kept as leak hygiene).
- **Removed**: the push gateway and its `pushInsteadOf` rewrite in the image's system gitconfig, Expectations, Taint
  (and the `workspace-trust` admin route), linked-work tracking, and the push cards on Durable and CLI threads
  (`SessionDO.approveGitPush`, the CLI wrapper's push half; its injected cards remain for the MCP relay's tool cards).
- **Linked work** pushes under its link's mode, with no card of its own.
- **Gone with the gateway**: its 100 MiB cap per push and its Git LFS gap. A push goes straight to GitHub.

Accepted, as in stock t3: a one-repo write token (at most an hour) is readable in the Container while an agent works;
an approved command, or any command at full access, can push. The leak scan (K6) still looks for the token in the
Workspace's files; finding it in the Container's memory or environment during work is stock behaviour, not a leak.

## Refinement (in-app updates, ADR-0037, 2026-11-17): a fourth permission list, for dispatching updates

`GITHUB_APP_PERMISSIONS` raises `actions` from `read` to `write`; the owner accepts the change on the App's
installation, which must include `ian-pascoe/t3flare`. Only a new, fourth list carries it:
`UPDATE_DISPATCH_GITHUB_PERMISSIONS` (`actions: write`, `metadata: read`), beside the Container's, the Environment's and
the skill fetch's. The Environment DO mints it for `ian-pascoe/t3flare` alone (the update target, set on prod only),
per dispatch and per poll of an in-app Update's run, uses it for those requests and drops it, as the skill fetch does.
It never reaches a Container, a Session or a log.

## Refinement (SPI-1398, 2026-11-25): t3's repository lookups get a token for the repo they name

Adding a Project by `owner/name` failed: t3 looks the repository up with the Environment token from `gh auth token`,
which names only the repos that are already Projects (none before the first), so the repo being added was never in it.
A fifth list, `REPOSITORY_LOOKUP_GITHUB_PERMISSIONS` (`metadata: read`), is minted for the one repo a lookup names, in
its owner's installation, whatever Workspaces exist, and pinned to that lookup's requests through t3's
`PinnedGitHubCredential` (a Layer over t3's `SourceControlRepositoryService`, `apps/environment/src/t3/repositoryLookup.ts`).
The Environment DO keeps it in its minters (`GitHubTokens`) until it expires, as it does every token it mints, and
hands it to the next lookup of the same repo while it has at least 15 minutes left; it never reaches a Container, a
Session or a log. Each lookup first forgets a remembered failure to mint for its repo, so an Owner who installs the App
or adds the repo and retries is answered by GitHub at once; a wait GitHub named itself (a rate limit) still holds until
its time. A token GitHub refuses (the App reinstalled) is dropped from
the minters and the lookup runs as t3's own. The Environment token keeps its scope for t3's PR features, and the
Container token its one repo. A lookup the App cannot mint for says why: the App is not installed on
the owner, or the repo is not among the installation's selected repositories (GitHub answers the same for a repo that
does not exist, so the two are named together).

## Refinement (2026-11-26): t3's PR features get a token for the owner of the repo each operation acts on

t3's PR features failed with 403 ("Resource not accessible by integration") on every repo of a second owner: t3 reads
one credential per host from `gh auth token`, and the Environment token it answers is minted for one installation, the
first Workspace's owner. An installation token cannot reach another installation's repos, so no single token covers an
Environment with Projects under two owners. Each operation of t3's GitHub pull request provider, source control
provider and issue tracker now runs with an Environment token minted for the owner of the repo it acts on (its
`repository`, the repos it reads across, an issue's scope, a link's URL, a remote, else the Workspace its `cwd` is in),
covering that owner's Projects and the repo named, and pinned to the operation's requests through t3's
`PinnedGitHubCredential` (Layers over t3's three provider registries, `apps/environment/src/t3/providerTokens.ts`). One
token per owner rather than per repo, because t3 batches reads across repos into one request per credential. An
operation naming no github.com repo, or repos of two owners, or an owner the App cannot mint for, runs as t3's own, on
`gh auth token`, which keeps its scope; a token GitHub refuses is dropped and the next operation mints another.

The Environment token no longer names its permissions: it takes every one the installation grants (owner, 2026-11-26:
the App acts as the owner would, so t3's PR and issue tools can merge, write issues and re-run checks).
`GITHUB_APP_PERMISSIONS`, the manifest a new App is registered from, mirrors the owner's App, which holds nearly every repository, organization, enterprise and account permission; an existing App's permissions change in its settings on GitHub, and each installation accepts
them. The Environment token still never reaches a Container or a Session, and the other tokens keep their own narrow
lists: a Container's token is readable by the agent.
