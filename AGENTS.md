# t3flare

## Rules

- In a new git worktree of this repository, run `node scripts/worktree-setup.ts`, then `pnpm install --frozen-lockfile` at the root, before any other command: a prepared checkout's `t3code/.git` can point nowhere, and then `git switch`, `git status` and `git add` fail; until the install, `pnpm run` and `pnpm exec` fail.
- CI's `check` is required on every pull request and runs the full suite. Locally, verify a change with targeted checks, from the root: the test files it touches, one at a time; `pnpm --filter @t3flare/<pkg> run typecheck` for the package it changed (`vp run typecheck:scripts` for root `scripts/`); `vp fmt --check` and `oxlint --type-aware --deny-warnings` on the changed files. The typecheck runs the Effect diagnostics (`globalDate`) that vitest skips; a bare `tsc --noEmit` is not the same. `pnpm run check` stays for a person who wants the full run; agents leave it to CI.
- When `check` fails, its last lines name the failing task; tasks vp stopped (exit 137) are not failures, and `[t3, not failing]` lines are t3's own.
- Test deploys go to a throwaway Stage of your own Deployment, from `apps/environment/scripts/stage.ts`, which needs Docker running. `prod` belongs to its Deployment repository's CI.
- Render the Settings page locally with `node apps/environment/scripts/panel-preview.ts serve`, which answers its API from in-memory fixture state: the live page sits behind Access.
- Credential files stay unread and unprinted: `~/.config/t3flare/dev.env`, `~/.alchemy/**`, `apps/environment/.alchemy/stages/*`, the gh config.
- A Deployment's values (emails, domains, account and zone ids, repository names) stay out of the source: they are Deployment settings ([ADR-0038](docs/adr/0038-a-deployment-is-configured-outside-the-source-tree.md)).
- Settings follow local parity ([ADR-0049](docs/adr/0049-settings-follow-local-parity-and-guardrails-are-opt-in.md)): out of the box t3flare behaves like stock t3 and agents on the Owner's machine, so a limit with a local equivalent defaults to the local behaviour, usually none.
- A cloud-only cost or safety guardrail is off until the Owner turns it on; the Terminal holds, the setup time limits and Park after are on by default (Park after keeps a CLI agent's card up while its Container stops, so the agent meets no limit).
- A value is a setting only where the Owner would choose it: cost, size, what agents may do, setup, retention. Each setting's disclosure is visible, contextual or Advanced. A value that only guards t3flare's own machinery is a named, generous constant, with a comment saying what it guards.
- Every limit names itself and its value when hit; a contextual or Advanced setting's message also says where to change it. A limit Cloudflare forces stays, names itself, and gets a follow-up to engineer it away.
- Limit values are the Owner's to approve: use the values a ticket names, and never invent or change one silently.
- The Owner is trusted with their own settings: give the capability and state its consequence once. Validation keeps t3flare working; it never protects the Owner from a choice they made.
- Never run pnpm or `vp` with a working directory inside `t3code/`: they install it as its own workspace and repoint t3's packages. Run t3 package scripts from the repo root (`pnpm --filter <name> run <script>`). `check` and `stage.ts deploy` fail on such a nested install; fix it with `rm -rf t3code/node_modules`, then `pnpm install --frozen-lockfile` at the root.
- The workspace and the lock are generated from t3code's: change them with `node scripts/relock.ts`, never by hand ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)). Relock keeps t3flare's own resolutions; `node scripts/relock.ts --refresh` is the one way to re-resolve them.
- oxlint's type-aware backend is tsrs's `tsrs-lint`, which oxlint finds by itself. An `OXLINT_TSGOLINT_PATH` in your environment overrides it, so unset a stale one ([ADR-0030](docs/adr/0030-pnpm-installs-node-runs-scripts-and-vite-plus-runs-the-checks.md)).
- The `t3code` submodule tree stays as pinned. Change t3code behaviour by Layer, then Shadow, then Patch ([ADR-0001](docs/adr/0001-t3code-is-a-pinned-submodule-changed-by-layer-then-shadow-then-patch.md)).
- A failed t3 bump, or a change to code that leans on t3's internals: read [`docs/upstream-fragility.md`](docs/upstream-fragility.md) first.

## Maintainer

These apply only with the Maintainer's access: write access to the Canonical repository, `spiritledsoftware/t3flare`, and its Linear project.

- A pull request squash-merged into the Canonical repository's `main` deploys the Maintainer's `prod` through `.github/workflows/deploy-prod.yml` ([ADR-0039](docs/adr/0039-outside-changes-are-checked-without-secrets-and-a-maintainers-merge-is-the-deploy.md)).
- An in-app Update lands by itself: `land.yml` fast-forwards `main` with a deploy key, whose push starts `deploy-prod.yml` ([ADR-0037](docs/adr/0037-stock-clients-update-buttons-land-a-bump-the-do-dispatches-ci-which-proves-and-fast-forwards-main.md)). Never dispatch `bump.yml` with `land`, `cli-bump.yml` without `dry_run`, or `land.yml` without `dry_run` by hand: each deploys prod.
- Issues are worked in Linear (team SPI, project t3flare); GitHub Issues sync one-way into it. See `docs/agents/issue-tracker.md`.

## Agent skills

### Issue tracker

Contributors use GitHub Issues through `gh`; the Maintainer works them in Linear. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
