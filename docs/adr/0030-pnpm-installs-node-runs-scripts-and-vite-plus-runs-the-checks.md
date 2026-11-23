# pnpm installs, Node runs scripts, and Vite+ runs the checks

Supersedes the install-and-run half of [ADR-0019](0019-bun-installs-and-runs-scripts-tsrs-typechecks-and-vitest-stays-on-node.md); its other half stays: each package typechecks with `effect-tsgo tsrs`, and Vitest runs on Node.

Under Bun, every nightly bump re-translated t3code's pnpm settings into Bun's. Catalogs, overrides and patch keys were translated, and 1,572 per-name lock pins were written. Bun had no way to express pnpm's `"-"` removals and `parent>child` overrides, so those were dropped, and it skipped a patch that matched nothing without a word (U20). Per-name pins also forced one version of a name on every package, so some of our packages ran outside their declared ranges: pi-ai, which pins `@anthropic-ai/sdk` 0.129.0, ran on 0.93.0. So the repo now uses t3's own toolchain:

- **pnpm** installs, at t3's `packageManager` version. `scripts/gen-workspace.ts` writes the root `pnpm-workspace.yaml` from t3's.
  - Members are our packages plus the t3 packages we import.
  - t3's settings are copied unchanged through an allowlist, and an unknown key fails the bump.
  - t3's patches are kept only for packages we install.
  - Every dependency build script is denied.
  - `verifyDepsBeforeRun` is `error`.
  - It also writes `engines.node`, `packageManager` and `mise.toml`.
- **The lock is seeded from t3's lock.** `scripts/seed-lock.ts` copies t3's importers, packages and snapshots, then pnpm resolves only ours (`scripts/relock.ts` runs both until the workspace settles).
  - `scripts/verify-lock.ts` asserts that each t3 importer's transitive closure equals its closure in t3's lock. Three peer choices that a shared workspace moves are listed in the script with their reasons.
  - pnpm fails on a patch that matches nothing or does not apply.
- **Node runs our scripts** (`node x.ts`, type stripping), at t3's `engines.node`. alchemy then runs under Node with its Oxc loader. `erasableSyntaxOnly` keeps every file strippable.
- **Vite+ runs the check.** `pnpm run check` is `vp run check:all` (root `vite.config.ts`): the same tasks `scripts/check.ts` ran, plus `check:workspace`, run at once and uncached. The bump job runs the whole check (closes U27).
- **tsrs's `tsrs-lint` is oxlint's type-aware backend** (2026-11-13; it replaced the interim `@maschwenk/tsrslint`).
  - Every lint script sets `OXLINT_TSGOLINT_PATH` to the root `node_modules/.bin/tsrs-lint` itself. An inherited value, such as a stale path from another repo's mise `[env]`, otherwise overrides any link, and oxlint fails or lints on another backend.
  - `vp run` passes its tasks the caller's environment; a `process.env` assignment in `vite.config.ts` does not reach them. So the variable is set in the scripts, not the config.
  - `prepare` runs `scripts/link-tsrs-lint.sh`, which links `node_modules/.bin/tsgolint` to `tsrs-lint`. A bare `oxlint --type-aware` and editors then use tsrs-lint when the variable is unset.
- **CI** uses `voidzero-dev/setup-vp` (`.github/actions/setup`). The pnpm store is cached on the lock. Secrets reach only the steps that deploy.

**Nested workspace.** A pnpm or `vp` command whose working directory is inside `t3code/` finds t3's `pnpm-workspace.yaml` and installs t3code as its own workspace. Guards:

- mise, `stage.ts`, `bump.ts`, `relock.ts` and CI export `NPM_CONFIG_WORKSPACE_DIR=<root>`. (mise no longer does: the SPI-1336 refinement below.)
- `check:workspace` and `stage.ts deploy` fail when `t3code/node_modules/.pnpm` exists.

**Costs.**

- Installs are slower: a warm install without `node_modules` takes 6.6 s against Bun's 3.3 s, and a cold store 19.5 s.
- vp's runner fails fast, so a red check shows its first failure rather than all of them.
- On the command line, a misspelt package in `vp run <pkg>#<task>` exits 0. `check:all`'s `dependsOn` rejects one.

**Rollback.** The swap is one commit (code, generated files and docs), so `git revert` of it restores Bun, `bun.lock` and the docs at once. Bump PRs made after the swap are held unmerged until two nightlies have passed and prod has deployed once more on pnpm. If one merged anyway, revert only the swap and keep the pin: reverting the pin would run t3 backwards over Durable Object SQLite it has already migrated (review H5). Then regenerate under Bun (`bun scripts/gen-workspace.ts && bun install`).

## Considered Options

- **Stay on Bun**: fastest installs, but the translation and its silent gaps stay.
- **A `.pnpmfile` hook that merges t3's settings at install time**: no generated file, but it hides the effective settings from readers and from Vite+.
- **Wholesale `t3code/apps/*` and `t3code/packages/*` globs**: about 800 more packages (Electron, Expo) and native build gates we never run.
- **`tsx` to run scripts**: we have no syntax that Node's stripping rejects.

Evidence: `docs-archive-1:docs/steps/pnpm-plan.md` (with its review changelog), `docs-archive-1:docs/steps/pnpm.md` and `steps-evidence-1:docs/steps/pnpm/`.

## Refinement (in-app updates, ADR-0037, 2026-11-17): a bump keeps t3flare's own resolutions

`seed-lock.ts` now carries t3flare's own importers over from the current lock, with what they install that t3's graph
does not name, and `relock.ts` installs with `--fix-lockfile`, so pnpm keeps those resolutions and mends their references
into t3's graph. Before, every bump re-resolved t3flare's own packages against the registry, so a bump's lock drifted
wherever a registry release had landed since the last one (the first trial: `@smithy/core` 3.40.0 to 3.41.0, through
alchemy's dependencies), and nothing tied that drift to t3. Now a bump's lock moves only where t3 moved (its own graph,
its catalog, overrides and patches), which is what the land check holds it to (ADR-0037 §5). t3flare's own packages move
when their manifests do, or when the owner refreshes them: `pnpm run relock -- --refresh` carries none of their
resolutions over, so pnpm resolves them again, as every relock did before. That is the one way to refresh them, still
through relock; it lands as an ordinary reviewed change, never as an Update. Names t3 installs are still resolved against t3's graph, never
carried over (step 4 above, measured in M0), and `verify-lock.ts` still fails on any move of t3's graph. Measured on
`v0.1.11-nightly.20261117.4851`: verify-lock passed, and the lock's diff was t3's (`@legendapp/list` 3.7.3, its patch
dropped, the peer variants that follow).

## Refinement (official tsrs support, 2026-11-17): oxlint finds tsrs-lint by itself

Since oxlint 1.94.0 and tsrs 0.25.0 ([official support](https://oxc.rs/blog/2026-11-17-faster-type-aware-linting-with-tsrs)),
oxlint `--type-aware` finds tsrs's `tsrs-lint` by itself and prefers it to the `oxlint-tsgolint` that vite-plus brings
(checked: with the variable unset and no link, oxlint 1.94.0 spawned `tsrs-lint headless`). So the two workarounds above
are gone: the lint scripts no longer set `OXLINT_TSGOLINT_PATH`, and `prepare` no longer runs `scripts/link-tsrs-lint.sh`,
which is deleted. An inherited `OXLINT_TSGOLINT_PATH` still overrides oxlint's choice, and the scripts no longer guard
against it: unset a stale one (AGENTS.md). An editor bundling an oxlint older than 1.94.0 no longer gets tsrs-lint
through the link.

## Refinement (SPI-1272, 2026-11-20): relock runs as `node scripts/relock.ts`

`verifyDepsBeforeRun: error` makes pnpm check, before any `pnpm run <script>`, that the install matches the manifests
and the lock, and refuse with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` when it doesn't. Relock is for exactly those states: a
moved pin, an edited manifest, a fresh worktree. So `pnpm run relock` failed every time it was needed, while
`node scripts/relock.ts` always works. The command is now `node scripts/relock.ts`, and `node scripts/relock.ts --refresh`
where the text above says `pnpm run relock -- --refresh`; the root `package.json` has no `relock` script, since it could
run only when nothing needed relocking. `verifyDepsBeforeRun` stays `error`: it protects every other script.

## Refinement (SPI-1290, 2026-11-20): a guard refuses another checkout's workspace dir, and root scripts test on `node --test`

The first guard under **Nested workspace** sets `NPM_CONFIG_WORKSPACE_DIR`, but mise sets it once, in the checkout a shell
started in. A shell that then moves into a worktree keeps the main checkout's path, and pnpm installs and checks that
checkout instead. So a third guard: `pnpm run check` first runs `scripts/workspace-guard.ts`, which exits 1 when
`NPM_CONFIG_WORKSPACE_DIR`, else `npm_config_workspace_dir`, as pnpm reads them (resolved against the directory the command was typed in) is not
the root of that checkout, inside `t3code/` its superproject's, and names the `export` that fixes it. Where it can't find
a checkout, it allows the command and says so. No install hook runs it: pnpm runs the root `preinstall` in the target
checkout, with `INIT_CWD`, `PWD` and the working directory all that checkout's root, so the typed-in directory is
unknowable there. When the target checkout's install is stale, pnpm's `verifyDepsBeforeRun` refuses before the guard runs.

The root has no Vitest dependency, so the tests of root `scripts/` run on `node --test` (`test:scripts` in `check:all`),
beside Vitest for the packages.

## Refinement (SPI-1335, 2026-11-22): `check` first repairs a checkout whose `t3code/.git` points nowhere

A git worktree prepared from T3's checkout cache can get a `t3code/.git` written relative to another checkout's module
dir, which resolves nowhere, and then `git switch`, `git status` and `git add` fail in it. So `pnpm run check` now runs
`scripts/worktree-setup.ts` first, before the workspace guard, and AGENTS.md names it as the first command in a new git
worktree. Unlike the guard, which only reads, it writes to the checkout: it gives the checkout its own
`<git-dir>/modules/t3code`, borrowing the main checkout's objects through `objects/info/alternates` (no network), with
HEAD at the pinned commit and the index reset; the files on disk are left as they are. The module dir is prepared beside
its place and the dangling pointer replaced only once it holds the pinned commit, so a failed repair leaves the checkout
as it was and fails again on the next run. It never points a checkout at another's module dir: two checkouts sharing one
move each other's HEAD and index. A healthy checkout, one whose `t3code/.git` names its own module dir with a commit at
HEAD, is not written to; an uninitialised submodule is reported with `git submodule update --init t3code` and left alone.
Like the guard it is plain node, so it runs before anything is installed.

## Refinement (SPI-1336, 2026-11-22): mise no longer exports `NPM_CONFIG_WORKSPACE_DIR`

The mise leg of the first guard under **Nested workspace** is retired: `gen-workspace.ts` no longer writes an `[env]`
table into `mise.toml`. mise evaluates `{{config_root}}` once, in the checkout a shell starts in, and an agent's shell
that then moves to another checkout keeps that path. The SPI-1290 guard refuses this only in `check`; an install has no
hook to refuse it in, so on 2026-11-22 a stale export sent `pnpm install` from a second worktree into the first three
times, breaking the first's tests until it was reinstalled. Without the export, pnpm finds the workspace of the checkout
it runs in. The other guards stay: `stage.ts`, `bump.ts`, `cli-bump.ts`, `relock.ts` and CI each export their own root;
`workspace-guard.ts` still refuses a hand export, or one from a shell started before this change, that names another
checkout; and a nested install inside `t3code/` is caught by `check:workspace` and `stage.ts deploy`. Its fix: `rm -rf
t3code/node_modules`, then `pnpm install --frozen-lockfile` at the root. Rejected: a pnpm and vp wrapper on `PATH` that
derives the root from the git top-level, which would be a permanent shim and needed a spike.

## Refinement (SPI-1339, 2026-11-23): `check` runs the formatter, at 120 columns

The repo had no formatter configuration, so `vp fmt` ran at Oxfmt's default width, and agents reverted its output by
hand. The code had no single style for it to keep: 14,478 lines were longer than 120 columns, while other files were
wrapped near 80, so no width made `vp fmt` a no-op (from 868 changed files at 120 to 669 at 200). The `fmt` block in the
root `vite.config.ts` now sets `printWidth: 120` and `sortPackageJson: false` (a reformat doesn't reorder
manifests) and keeps Oxfmt's other defaults, and one commit reformatted every file
to it. `check:fmt` (`vp fmt --check`) runs in `check:all`, so the style can't drift again; the fix for a red one is
`vp fmt`. Ignored: `t3code/` (pinned), `tools/demo-video/` (its own workspace), and the files `gen-workspace.ts` and
`seed-lock.ts` write, so a regeneration never fights the formatter (`check:workspace` compares its three byte for
byte, and pnpm rewrites the lock), and tests' `test/fixtures/` and `__snapshots__/`, which hold recorded or rendered
bytes (`harnessPage.test.ts` compares its snapshot file whole). The reformat commit is
listed in `.git-blame-ignore-revs`, so `git blame` passes over it (`git config blame.ignoreRevsFile
.git-blame-ignore-revs`; GitHub reads the file by itself).
