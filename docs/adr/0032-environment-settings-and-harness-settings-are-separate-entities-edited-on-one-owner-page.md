# Environment settings and Harness settings are separate entities, edited on one owner page

Status: accepted (SPI-1149, 2026-11-13; decided in SPI-1001's triage, the budget added at the owner's request the same
day). Report: [`docs-archive-1:docs/steps/environment-settings.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/environment-settings.md). Refines
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md). Refined by
[ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md)
(Environment skills: the same entity, revision and audit `entity`, applied at a turn, not a Container start), and by
[ADR-0049](0049-settings-follow-local-parity-and-guardrails-are-opt-in.md)
(which settings exist, and where the page shows them).

ADR-0026 gave t3flare one owner page and one settings entity, the **Harness settings**: Pi Durable's extensions and the
MCP server set, read by a Session at a turn's start. What every Workspace's Container gets (its size, how long it may
sit idle, how many run at once, and later the Global mise config and the Environment skills) is a different thing with
different readers, so it is a second entity, the **Environment settings**, modelled on t3's own
settings. Both are edited on the one page at `/_t3flare/harness`, the Environment ones in its Environment section.

1. **Keys, revisions and readers.**

   | Entity                                                                                                                                                                                    | Key in the Environment DO                                                        | Read by                                                                            | Applies at                                   |
   | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
   | Harness settings                                                                                                                                                                          | `t3flare:harness:settings`                                                       | a Session (`harnessSettings`)                                                      | the thread's next turn                       |
   | Environment settings                                                                                                                                                                      | `t3flare:environment:settings`                                                   | a Workspace DO (`environmentSettings`)                                             | the Workspace's next Container start         |
   | Environment skills (part of the Environment settings; [ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md)) | tables `t3flare_env_skills`, `t3flare_env_skill_files`, `t3flare_env_skill_meta` | the Pi Durable adapter (the set's hash) and a Workspace DO (`environmentSkillSet`) | the thread's next turn; the composer at once |

   Each has its own revision, bumped only by its own changes, so a size change never makes every Session take the
   Harness settings again. A Workspace DO reads them before each Container start with a 5 s bound and keeps the copy it
   took (`t3flare:environment`); with no answer in time it starts with that copy, else the defaults, as a Session does
   for the Harness settings. Neither read boots t3.

2. **One schema.** `@t3flare/harness-registry`'s `ENVIRONMENT_SETTINGS` is the Environment settings' only schema: the
   panel renders its section from it, the API validates against it, and `resolveEnvironment` gives every reader the
   resolved view, reading a stored value that no longer fits as its default. A later setting (SPI-1150, SPI-1152) is an
   entry there. Secrets are not offered (ADR-0016 A′).
3. **One audit log.** Every entry carries `entity`, an open field naming the entity changed: `"harness"` and
   `"environment"` today, and a later entity on the page adds its own name. An entry written before this has none and
   reads as harness. An Environment change records only the settings it moved, as resolved before and after; a save
   that moves none is not stored, bumped or logged.
4. **The Container size is chosen per start**, from five names: `cpu-1` (the default, the custom size t3flare ran
   before: 1 vCPU, 3 GiB, 12 GB; superseded: the SPI-1386 refinement below makes `standard-3` the default) and Cloudflare's `standard-1` to `standard-4`. The class runs under
   `schedulingPolicy: "durable_object"`, which takes an `instance` per `start()`. Every start passes one: an omitted
   `instance` starts `lite`, and a stored name t3flare does not offer starts the default. `lite` and `basic` (which the
   runtime refuses) are not offered, nor other custom sizes (superseded: the SPI-1365 refinement below offers any
   custom size). A stored name never changes meaning: adding a size is free, removing one needs a rename map.
5. **A running Container keeps what it started with.** The Workspace DO records each start's size, idle time and
   budget, and adopts a running Container with the `instance` it started with (computer relaunches one whose launch
   differs). A change never resizes or restarts it; its idle stop follows the idle time it started with.
6. **The idle time** (1 to 60 minutes, default 2; 1 to 10,080 since [ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)) replaces the `CONTAINER_IDLE_MS` constant.
7. **The Container budget is a setting** (1 to 10, default 3, today's value; superseded: off, no budget, by default
   since the SPI-1386 refinement below; a cost guard, far below the account's
   concurrent limits; 1 to 100, a sanity bound and no cost guard, since [ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)). It replaces `MAX_CONTAINERS` as a constant. The budget DO is a singleton in the agents Worker,
   so a Workspace DO carries the budget with a fresh start's lease request, and only when it read it from the
   Environment then: a kept copy or the defaults carry none, so they never overwrite the owner's newer budget. The
   budget DO judges the request by it and keeps the last one for renewals and status reads. `T3FLARE_MAX_CONTAINERS`
   still wins (tests). Raising it applies at the next lease request. **Lowering it stops nothing**: a holder is always
   renewed, and a new start is refused until fewer run than the budget. A refused start asks idle holders to stop only
   when enough of them are idle to bring the count under the budget, and otherwise asks none. A refusal names the
   budget and the panel section that changes it, whole on every t3flare surface (read from the error's cause chain,
   since computer cuts its own messages); t3's own git error text keeps only stderr's length, so its worktree setup
   error does not show it. The panel shows the budget beside the Containers running now and their Workspaces, and
   prices each size at the budget's Containers.

## Considered options

- **One entity, the Harness settings grown.** Rejected: every size change would move the revision every Session
  watches, and the two have different readers and application points.
- **A separate page for the Environment settings.** Rejected: the same guards (Access, CSRF, Origin, the hash-only CSP)
  and the same audit log; one page is less to secure.
- **The budget as a deploy constant shown read-only** (the triage's first answer). Reversed by the owner the same day.
- **The budget DO reading the Environment DO itself.** Rejected: a cross-Worker call on every lease from a singleton
  every start waits on; the Workspace DO already holds the settings when it asks.
- **Restarting a running Container on a size change.** Rejected: it would end terminals and CLI agents' processes
  mid-work.

## Consequences

- A size, idle-time or budget change shows in the next Container start, not at once; the panel says so.
- Old audit entries have no `entity`; every reader of the log goes through the store, which supplies it.
- The cost shown is a worst case (every vCPU busy); memory and disk are billed while a Container runs, CPU only while it
  works.
- A Workspace DO whose read gets no answer starts with its kept copy, which may be one revision behind.

## Refinement (SPI-1152): Variables

§2, §3 and §4, and §8 for a secret Variable's value, are **superseded** by
[ADR-0046](0046-a-variable-may-be-secret-as-stock-t3s-environment-variables-are.md) (Owner, 2026-11-22): a Variable is
a name, a string and a Secret toggle, refused only what breaks t3flare, and a secret one's value is never logged.

Report: [`docs-archive-1:docs/steps/spi-1152.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/spi-1152.md). The Environment settings gain **Variables**: plain
`NAME=value` pairs every command in a Workspace starts with. mise's `[env]` (the Global mise config, SPI-1150) does not
do this: it reaches a tool run through a shim or `mise exec`, not a plain shell line, an apt-installed tool, or a CLI
agent's own process, which are fixed-path binaries outside mise.

1. **Shape.** One setting, `variables`, of the schema's own `variables` type: at most 50, each name one a shell can
   export (up to 128 characters), each value up to 4,096 characters without a NUL (the limits superseded by the
   SPI-1365 refinement below). The panel shows
   them as a list in the Environment section, behind the same guards.
2. **Refused names**, checked by the API and again when read:
   - the names t3flare already sets or pins: every name `COMMAND_ENV`, a CLI profile's environment, Codex's shell
     policy, the managed settings' `env`, a Terminal's base environment or its rc file sets, listed in
     `SET_BY_T3FLARE` where no rule below covers it. A unit test derives the names from the code, with a launch of
     every CLI profile, and fails when the list misses one or keeps one nothing sets;
   - `PATH`, `HOME`, `PWD`, `SHELL`, `USER`;
   - the prefixes `T3`, `MISE_`, `GIT_`, `GH_`, `GITHUB_`, `SSH_`, `LD_`;
   - the loader hooks `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`;
   - a name with a `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` segment, in any case, singular or plural.
3. **Refused values**: credential patterns (`packages/harness-registry/src/variables.ts`). A Variable is
   agent-readable, so it is never a credential (ADR-0016 A′). These refusals are guard rails for the owner, not a
   boundary against him.
4. **A stored Variable a later rule refuses is dropped alone**, not the whole set: §2's "a value that no longer fits
   reads as its default" applies per Variable.
5. **Where they apply.** One function, `commandEnv`, puts the Variables under a command's own environment, at every
   point a command starts in a Workspace:
   - every command computer runs on the Container or the Worker Shell: a Durable agent's, and the Workspace DO's own.
     Each of the two backends is wrapped (`VariablesBackend`), which reads the Variables as the command is sent, after
     the Container has started for it;
   - Terminals, the agent's Terminals and CLI agent processes, at spawn, so a CLI agent's commands inherit them.

   A Session does not add them: it cannot know which Variables a command's Container will start with before the
   command starts it.

6. **When.** A Container start takes them with the rest of its launch and keeps them while it runs; a change applies
   at the Workspace's next start. The Worker Shell has the last start's, so before the Workspace's first Container
   start its commands have none.
7. **Precedence.** Variables are the lowest layer: `COMMAND_ENV`, a CLI profile's environment, t3's own variables,
   mise's `[env]` and whatever a command exports all win over them.
8. **Audit.** The audit log records the Variables' names and values before and after, as the page shows them to the
   owner anyway; the Workers Logs line of a change carries neither.

Considered and rejected:

- **Evaluating `mise env` in `BASH_ENV`.** It would switch on every repository's `[env]`, and Terminals and CLI
  processes do not read `BASH_ENV`.
- **Keeping Variables out of CLI agent processes.** A CLI agent's commands would get none.
- **Adding them in the Session**, beside `COMMAND_ENV`. The Session's command can be the one that starts the Container,
  with Variables the Session has not seen.

## Refinement (SPI-1150): the Global mise config

Report: [`docs-archive-1:docs/steps/global-mise.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/global-mise.md); plan and M0:
[`global-mise-plan.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/global-mise-plan.md). The Environment settings gain the **Global mise config**: the
owner's `mise.toml` text, which every Container's commands get as mise's global config.

1. **Shape.** One setting, `globalMiseConfig`, of the schema's `file` type: at most 16 KiB of UTF-8 (superseded by the
   SPI-1365 refinement below), no NUL, line ends stored as LF so a browser's round trip is not a change. The panel shows it as a text
   area of its own, without `maxlength` (which counts UTF-16 units; the API's refusal is the limit).
2. **Layers.** Every command's environment (`COMMAND_ENV`) makes the image's base file mise's _system_ config and the
   Container-local `/var/lib/t3flare/mise/config.toml` its _global_ config. mise layers system < global < project and
   merges `[tools]` per tool, so the image's `git` and `gh` stay under the owner's file, and a repository's own
   `mise.toml` wins per tool over both. With no text nothing is written there and mise resolves as before.
   `COMMAND_ENV` also pins mise's data, cache, state and config directories to the image's defaults under `/root`, so
   a CLI profile that moves `XDG_*` (OpenCode's own home) still finds the lay-down's installs instead of installing
   the pins again.
3. **Laid down per Container.** The Workspace DO runs the lay-down (`@t3flare/sandbox-image/globalMise`) on each new
   Container, keyed by computer's runtime id. Every command sent to the Container that is not a passive read waits for
   it where it is sent, whoever sends it (a Durable agent's command, the Workspace DO's own); a Terminal or a CLI process
   waits before its spawn, on the runtime id computer keeps in the Workspace DO's storage
   (`computer:container-runtime-identity`, a lean on computer's internals: U23). A passive read never runs it. It installs the owner's tools with the text as a
   staging global config (`mise install` from `/`), and keeps the file only when `git --version` and `gh --version`
   still run under it, with mise's auto-install off: invalid TOML fails every shim, git's included, so laying it down
   unchecked would break t3's git. The launch records the text, so a running Container keeps what it started with, a
   change applies at the next start, and an agent's edit of the file is gone then.
4. **Held and bounded.** The lay-down counts as a command: no idle stop and no reclaim under it, and the idle time
   counts from its end. The script bounds its lock (60 s), install (600 s, KILL 10 s later) and checks (20 s each); the
   Workspace DO waits their sum and a minute, then kills it and takes the file as not laid down, final for that
   Container. An exec that failed is tried again at once, then by the next command, Terminal, CLI process or alarm, at
   most three times per Container; the alarm also runs it for a running Container only passive reads have reached. The
   outcome is kept in the Workspace DO's storage, so a new instance does not run a finished lay-down again; its answer
   is kept on the Container's disk by revision and SHA-256, on the assumption that a Container's disk never outlives it
   (one that did would at worst skip laying down the same text again). A Durable agent's command cut off while it waited
   (a timeout or an abort during the install) is never sent afterwards: the Session hands its id to the Workspace DO
   when it stops it, and the Workspace DO refuses to dispatch it once the lay-down ends; one already sent is killed as
   soon as it is. The lock's descriptor is closed for the install and the checks, so a child left after a timeout's KILL
   never holds it.
5. **No GitHub token.** `COMMAND_ENV` sets `MISE_GITHUB_GH_CLI_TOKENS=false`, `MISE_GITHUB_USE_GIT_CREDENTIALS=false`
   and an empty `MISE_GITHUB_CREDENTIAL_COMMAND`, and an environment variable beats the owner's and a repository's
   files: mise sends no token from gh's `hosts.yml`, git's credential helper (the Workspace's one-repo token) or a
   credential command, any of which could fail an install that works without one. `MISE_DISABLE_TOOLS` and
   `MISE_DISABLE_BACKENDS` are held empty, so no file disables git or gh by name. The stage showed each of the five
   arriving whole, empty values included, in a Durable agent's command, a Terminal, the Workspace DO's command and a
   command of each of Codex, Claude Code, OpenCode and pi. A Variable cannot set any of them (the `MISE_` prefix is
   refused).
6. **Reported.** Each lay-down is logged (the text's size and SHA-256, never the text) and sent to the Environment DO;
   the panel's Status shows the last one across all Workspaces: laid down or not, and why. A start with no Global mise
   config reports too ("no Global mise config"), so a cleared config replaces an older "not laid down".
7. **Audit.** A `file` setting is audited as its size and SHA-256, not its text, a departure from §3's "as resolved
   before and after": the audit log is one stored value of up to 1,000 entries, and a Durable Object value is at most
   8 MB. The current text is on the panel. (SPI-1359, 2026-11-23: a SQLite-backed DO row or value holds 8 MB; the
   earlier 2 MB was stale.)
8. **No install cache.** Every Container start installs the owner's tools again; mise's data stays in its default
   place on the Container's disk, never under the synced `/workspace/.t3flare/`. A cache is follow-up work.

Considered and rejected:

- **Laying a file down whatever git and gh do under it.** One typo would break t3's git status and commit in every
  Workspace.
- **Putting the file under the Workspace.** It would sync, and an agent's edit would outlive the Container.
- **An empty `MISE_GITHUB_TOKEN` alone.** mise falls through to the next source.

## Refinement (ADR-0035, 2026-11-14): the Settings server changes both entities

[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md); plan:
[`docs-archive-1:docs/steps/settings-mcp-plan.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp-plan.md). Agents may ask for changes to the Harness settings
and the Environment settings through the Settings server, which calls the same functions as the page.

1. **Keys, revisions, readers and application points are unchanged** (§1). A change through the Settings server names
   the revision of the entity it changes and is refused when that revision has moved.
2. **Each setting declares its tier in the one schema** (§2): `containerIdleMinutes` is free (`down-free` since [ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)), `containerBudget` is free
   when lowered and asked when raised, and `containerSize`, `variables` and `globalMiseConfig` are asked. A setting
   added later without a tier is asked.
3. **One audit log still** (§3); its entries gain who asked, through which door, the tier and what answered.
4. **A running Container still keeps what it started with** (§5): no tool restarts one, and every answer to a change
   says when it applies.
5. (Superseded by ADR-0046: Variables refuse only what breaks t3flare.) The Variables refinement's "guard rails for
   the owner, not a boundary against him" now also stand between an agent's request and the store: its refused names
   and values are refused through the Settings server as on the page.

## Refinement ([ADR-0047](0047-every-container-starts-from-a-base-snapshot-the-builder-makes-from-the-image-setup.md), 2026-11-22): the Image setup and the Container setup

The Environment settings gain the Image setup, the Container setup and the settings around them (ADR-0047 §9). The
Image setup, the Global mise config and the Variables are a Base snapshot's key, read by the Builder; a Workspace DO
reads the rest at a Container start as §1 says. The Global mise lay-down also runs in the Builder before the Image
setup, so a Base snapshot carries its installs: the cache mise §8 deferred, whenever a Base snapshot is in use. With
no Global mise config, mise's global config is the dotfiles' own `~/.config/mise/config.toml`, under the same git and
gh check (ADR-0047 §10), where mise §2 left none.

## Refinement ([ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md), 2026-11-22): no cost guards

§6 and §7 bounded the idle time and the budget to protect the Owner. The idle time is now 1 to 10,080 minutes, the
shared maximum for limits t3flare times itself (its own alarm does the idle stop; `setInactivityTimeout` is never set),
and its tier is `down-free`. The budget is 1 to 100, a sanity bound: the account's own concurrent limits bound it in
fact, and the Settings page says so in a note under the budget field. Defaults are unchanged (2 minutes, 3 Containers).

## Refinement (SPI-1313, 2026-11-22): the Global mise install time limit

The install's 600 s bound in the Global mise config refinement's §4 is the Owner's toolchain's, so it is the setting
`globalMiseInstallMinutes`: 10 minutes by default, 1 to the shared maximum of 10,080 (ADR-0048), tier `down-free`,
shown in the Global mise config's row. The launch carries it (`ContainerLaunch.globalMise.installMinutes`), so a running
Container keeps what it started with; a launch kept from before it reads the default. The lock follows it: a second
lay-down waits for one run's whole install, KILL and checks, and 30 s more. The KILLs, the Workspace DO's wait and the
attempts stay derived or fixed: t3flare's own robustness. The git and gh checks stay at 20 s each, t3flare's own proof
that its git still runs. The Builder's lay-down in a Base build gets the same bound; the bound is not part of the Base
key, so changing it alone leaves a Base snapshot current.

## Refinement (SPI-1318, 2026-11-22): the CLI agents' processes per Workspace and the reclaim delay

The Workspace DO's fixed cap of 4 CLI processes and its fixed 30 s reclaim delay were measured against `cpu-1`; since
the Container size is a setting, both are the Owner's. `cliProcessesPerWorkspace`: 4 by default, 1 to 100, tier
`down-free`, counted as before (Claude Code and OpenCode count two each; superseded by the SPI-1364 refinement: each
process counts once). 100 is a sanity bound (ADR-0048): the
Container's memory bounds it in fact, and the description states that once ("Each CLI agent's process takes about 150
to 200 MB of the Container's memory; past what the Container size has, commands fail for memory."). `cliReclaimSeconds`:
30 by default, 0 to 660, tier `free`. 660 is a named constraint: a CLI process holds the Container for
`CLI_IDLE_HOLD_MS` (11 minutes) after its last turn, forced by t3's 10-minute session release, so a longer delay changes
nothing. Both show in the Containers row.

The Environment DO reads both at each CLI spawn and carries them with the start request (`ProcessStartInput`), as the
budget rides the lease request (§7); a carried value that is absent or out of bounds reads as its default. The count
applies at the next start: lowering it ends no running process, and new starts are refused, naming the setting, until
fewer run. The reclaim delay is kept with each process, so a change applies to processes started after it.

## Refinement (SPI-1315, 2026-11-22): the Turn limit

The fixed 2 h limit on a turn was a cost policy, not a platform limit, and the Durable agent's (`TURN_DEADLINE_MS`) and the CLI
agents' (`TURN_CAP_MS`, ADR-0015) were two constants that had to agree. Both are now one Environment setting, not a
Harness setting (it bounds the CLI agents too): `turnLimitMinutes`, 120 by default (superseded: off by default, the
SPI-1386 refinement below), 1 to `MAX_TIMED_MINUTES` (ADR-0048
§2: t3flare times it with its own alarm and timer), tier `down-free`. It opens a new Agents row on the Settings page
(`AGENT_SETTING_KEYS`), which the CLI agents' processes per Workspace and the reclaim delay (SPI-1318) move into from
the Containers row: they bound agents, not a Container start. The page's header and sidebar no longer say every
Environment setting applies at a Container start. Its consequence is stated
once, in its description (ADR-0048 §6): "A turn longer than this is ended (a CLI agent's process with it), and the thread
shows it failed. Each minute of a turn can spend model tokens and hold a Container."

It applies at each thread's next turn; a running turn keeps the limit it started with. The Environment DO reads it at
each turn's start (`EnvironmentServices.turnLimitMs`, as `agentsReadDotfiles` is read). The CLI wrapper sleeps the limit
it read and ends the process at it. The Durable agent's adapter carries it with `submitTurn` (`turnLimitMs`), and the
Session keeps it on the turn's record (`TurnState.turnLimitMs`): its alarm ends each turn at its start plus its own
limit, where it once recomputed one limit for every live turn at each alarm. A start or a record without one reads as
the default, `DEFAULT_TURN_LIMIT_MS` (harness-registry, its one source). The deploy's `T3FLARE_TURN_DEADLINE_MS` (tests
and the stage's Turn limit check) still wins over both.

The Workspace DO's process backstop (`BACKSTOP_MS`, 130 minutes) stays fixed and does not follow the limit: it applies
only to a process out of a turn, where the Turn limit bounds nothing. (Its 130 minutes are superseded by the SPI-1364
refinement: it is derived from the cleanups it backs up; it still does not follow the Turn limit.)

## Refinement (SPI-1314, 2026-11-23): the settings read wait

§1's "5 s bound" was a trade of start latency against freshness, not a platform limit, and two constants made it: the
Workspace DO's `ENVIRONMENT_READ_MS` and the Session's `HARNESS_READ_MS`. Both are now one Environment setting,
`settingsReadSeconds`, 5 by default, 1 to `MAX_TIMED_MINUTES * 60` (ADR-0048 §2: t3flare times it with its own timers),
tier `free`. It sits in the Containers row of the Settings page. Its consequence is stated once, in its description
(ADR-0048 §6): "A long wait holds a start or a turn that long whenever the settings are slow to answer."

The Session gets it the way it gets the Turn limit: the Environment DO reads it at each turn's start
(`EnvironmentServices.settingsReadMs`), and the Durable agent's adapter carries it with `submitTurn` (`settingsReadMs`).
It bounds that turn's reads of the Harness settings, the Model endpoints and the MCP view, and each read's timer is
cleared when the read wins. A start without it (an Environment before it) waits the default, `DEFAULT_SETTINGS_READ_MS`.

The Workspace DO cannot be told before it reads, so it bootstraps from the copy it kept: each read of the settings at a
start waits as long as that copy says (the default before it kept one). A fresh start reads twice, before computer's
connect (`#waitForBase`) and at its launch, so a new wait it keeps at the first read already bounds the second; a change
can take one more start to apply fully. The same wait bounds the start's reads of the Builder (`BUILDER_READ_MS`
before). The skill set's copy (`SKILLS_TAKE_MS`) stays fixed: it
bounds a copy of files, not a read of settings.

## Refinement (SPI-1316, 2026-11-23): the Answer wait

How long a card waits for the Owner was 10 minutes in four constants that had to agree: the MCP host's question wait
(`QUESTION_WAIT_MS`), the CLI card's (`CLI_ASK_MS`), the Open change's lifetime (`CHANGE_TTL_MS`), and the library
default they all came from (`MCP_ELICITATION_WAIT_MS`). They are now one Environment setting, not a Harness setting (it
spans MCP questions, CLI approval cards and Open changes, for Durable and CLI agents alike, all in the Environment DO):
`ownerAnswerMinutes`, 10 by default, 1 to `MAX_TIMED_MINUTES` (ADR-0048 §2: t3flare times it itself), tier `down-free`.
It sits in the Agents row after the Turn limit. Its consequence is stated once, in its description (ADR-0048 §6): "An
unanswered card is refused after this long. While it waits, the turn stays open and may hold its Container."

It applies to the cards raised after a change; a card already waiting keeps its deadline. The Environment DO reads it
when a card is raised (`EnvironmentServices.ownerAnswerMs`, `ownerAnswerMsNow`): the MCP host once per call, for the
engine's input bound and each card's timer; the Settings server when it opens an Open change, whose `expiresAt` is its
own deadline (its expired text names that record's wait); the CLI cards at the ask. `packages/mcp` keeps its 10 and 12
minutes only as its defaults for a caller that passes no `inputWaitMs`, which t3flare's host never is. The unused
prompt-time wait (`MCP_PROMPT_QUESTION_WAIT_MS`) is gone.

A CLI agent's MCP tool timeout is written at its spawn, so it follows the wait at the spawn: `cliToolTimeoutSec(wait) =
2 × wait + 300 s` (a relayed call can wait on an approval card and then an in-call question, each up to the wait, while
the call's own 270 s clock is paused, plus a 30 s margin), carried as `relay.toolTimeoutSec` into Codex's
`tool_timeout_sec` and pi's `mcp.json` `timeout`; 1,500 s at the default. Claude Code and OpenCode get no MCP timeout.
So that a raised wait never outlasts the CLI's own timeout, a live CLI process's relay cards (its tool approvals, its
servers' questions, and its Settings server's Open changes) keep the wait it was spawned with: the process channel keeps
it with the process (`ChannelStart.answerMs`) and forgets it with the process, and the Workspace DO names the calling
process's key with each relay message. Two processes of one thread each keep their own. The Settings server's
instructions are built when served, with the wait they will apply.

Unanswered strikes depend on it: one Open change per thread means three expiries span at least two waits, so a fixed
hour would never see a run past a 30-minute wait. A run's window is `max(STRIKE_WINDOW_MS, (STRIKES - 1) × wait + 5
min)` (`strikeWindowMs`), the hour at the default, where the wait is the longest its own changes took (`expiresAt -
createdAt`), not the setting's: a CLI agent's changes take its spawn-time wait. A closed row is kept that window plus
the lock (`closedKeptMs`) for the longest wait still kept, the setting's or a kept change's, so a run's rows outlast it.

## Refinement (SPI-1317, 2026-11-23): the Terminals' holds and counts

ADR-0021's fixed Terminal holds and Terminal caps are the Owner's. `terminalBusyHoldMinutes` (30 by default) and
`terminalPromptHoldMinutes` (10) take 1 to `MAX_TIMED_MINUTES`: t3flare's own alarm releases the Container, so ADR-0048
§2's sanity maximum applies. `terminalsPerWorkspace` (t3's Terminals) and `agentTerminalsPerWorkspace` (Pi Durable
agents' running Terminals and Background jobs) stay two caps, 8 each by default, as the two hosts had: one key would
change the total and mix the Owner's panels with an agent's jobs. They take 1 to 32, a named constraint and a
provisional figure: each Terminal's handle, and an agent's Terminal's headless xterm, lives in the Workspace DO's 128 MB
isolate, and SPI-978's measurement of that memory sets the figure. An agent's exited Terminals keep their xterm outside
the live count, bounded by `MAX_KEPT` (32) per Session only: their Workspace-wide total grows with the Sessions the
Workspace serves until the DO restarts, pending SPI-978's measurement. All four are `down-free` and show in the
Containers row, the holds after the idle time and the counts after the budget; each states its consequence once ("Open
Terminals keep the Container running, and billed, for this long after their last input"; "Each Terminal uses memory in
the Container", and for the agents' count "Each Terminal and Background job uses memory in the Container"). The holds
say they keep it even past the Idle time.

All four ride the launch (`ContainerLaunch`, as `idleMs` and `terminalsReadBashrc` do), so they apply at each
Workspace's next Container start and a running Container keeps what it started with; a launch recorded before them
reads as the defaults (`terminalLimitsOf`). Lowering a count closes no open Terminal; the next open or start is refused,
naming the setting. The stage checks' `T3FLARE_TERMINAL_IDLE_MS` and `T3FLARE_TERMINAL_PROMPT_IDLE_MS` still win over
the launch's holds (`terminalHoldOf`), and a Container preview's hold follows the busy hold.

## Refinement (SPI-1324, 2026-11-23): the clone and checkpoint time limits

The Workspace DO's fixed time limits on its git in the Container are the Owner's (both off by default since the SPI-1386
refinement below). `cloneMinutes` (15 by default) bounds
a project's clone and a worktree Workspace's clone and checkout; `checkpointMinutes` (10) bounds a turn's checkpoint
(the capture, and the diff and authored-paths reads above the isomorphic-git guard, which may wait for a cold start as
long as a capture) and its restore, a worktree's seed bundle in its project, and carrying a removed worktree's commits
home (its carry out and carry in). Two keys, not one with a ratio, as every other time limit: a big history and a big
working tree are different costs. Both take 1 to `MAX_TIMED_MINUTES`: computerd times each exec with its own timer and
no maximum (computer 0.11.2), so ADR-0048 §2's sanity maximum applies. Both are `down-free` (a longer limit holds the
Container longer) and show last in the Containers row; each states its consequence once, scoped to its own operations
("A clone or checkout that runs longer than this fails"; "A checkpoint, bundle or carry that runs longer than this
fails"; while it runs it holds the Container). A worktree's creation runs under both, which each says. A removed
worktree whose carry fails is a Tombstone that is never purged, which the checkpoint limit says.

The Environment DO reads each at every call and carries it to the Workspace DO as `timeoutMs` (`cloneMsNow`,
`checkpointMsNow`), as the CLI agents' processes per Workspace ride their start: a copy kept in the Workspace DO would
not exist yet for a new Workspace's first clone, the case that most needs a longer limit. So a change applies at the
next clone, checkout or checkpoint, and one already running keeps its limit. A call that carries none (an older
Environment, the admin route's `checkpoint`) gets `DEFAULT_CLONE_MINUTES` or `DEFAULT_CHECKPOINT_MINUTES`
(`gitLimits.ts`).

The checkpoint limit also bounds the two Container git reads that were a fixed 120 s: the authored paths of a range
where HEAD moved (part of a turn's checkpoint) and a project's ref tips before a worktree's removal (`refTips`, part of
the carry). No Cloudflare limit fixes either, and a repo with very many refs can pass any fixed bound.

t3's own `sourceControlCloneRepository` WebSocket method still applies its 120 s `CLONE_TIMEOUT_MS`
(`SourceControlRepositoryService`), so `cloneMinutes` cannot lengthen a clone started that way. t3's web client clones
through `startProjectClone` (`ProjectCloneTracker`), which sets no t3-side deadline, so the clone limit is the only one
there.

## Refinement (SPI-1323, 2026-11-23): how long usage records and pi sessions are kept

How long t3flare keeps its own history is the Owner's. `usageRetentionDays` (92 by default, matching t3's own usage
cache) bounds t3flare's usage records in the Environment DO; `piSessionRetentionDays` (60, review F2's) bounds the pi
sessions synced beside the repo (superseded: both off, kept as locally, by default since the SPI-1386 refinement below,
whose off ranks above every limit in a tier). Both take 1 to `MAX_RETENTION_DAYS`, the Grace's 3650 days: a sanity bound
that nothing forces (ADR-0048 §1). "Keep for good" is that maximum, ten years, not a 0 sentinel: under `up-free` a 0 would
make 0 → 60 read as turned up, and so free, while it deletes every session older than 60 days. Both are `up-free`, as
the Grace is: a shorter value destroys history, so it is asked.

Each states its consequence once, in its description (ADR-0048 §6). `usageRetentionDays`: "Shortening this deletes the
older records at the next prune; they cannot be restored. t3's Usage page shows at most 90 days, so records older than
that are kept but shown nowhere until t3 widens its window." `piSessionRetentionDays`: "An older one is deleted at the
next Pi start; t3 can no longer resume that thread's Pi conversation." (Superseded by the SPI-1367 refinement below:
it also sets Claude Code's `cleanupPeriodDays`.)

The usage store reads `usageRetentionDays` at each record and passes it to that record's prune (`usageStore`'s
`retentionDays`), so a change applies at the next prune, at most once an hour as usage is recorded, and to entries
recorded from then on. Its runaway-writer guard scales with it (superseded by SPI-1366's refinement below: the guard is
removed, and the retention alone bounds the rows): `usageMaxRows(days)` is `MAX_USAGE_ROWS` (50,000, sized
for 92 days) times `days / 92`, never below 50,000, so a long retention is not cut by a guard sized for a short one; at
3650 days that is about 2M small rows, well within a DO's SQLite, and a read stays bounded by the page's window. Its
consequence, stated once, here: at 92 days or more, a writer averaging above about 543 rows a day (50,000 / 92) has its
oldest rows trimmed before the Owner's chosen retention. The Environment DO reads `piSessionRetentionDays` at each CLI
spawn into the profile's context, as it reads `agentsReadDotfiles`, so a change applies at each pi start.

The Settings page shows both in a History row of their own, after the Agents row: they bound no Container start, so not
the Containers row, and they are not the Sweep's, so not the Workspaces section beside the Grace. The Settings server's
answer and card say, per key, when each applies instead of the Container start.

t3's own `usageHistoryRetentionDays` (default 92, or unlimited) is left alone: it governs t3's transcript cache, and our
scan readers ignore its `retentionCutoffMs`, so the Owner controls t3flare's records with one setting.

## Refinement (SPI-1359, 2026-11-23): the MCP calls, the Base build retry, the CLI hold and the Terminals' maximum

- **The MCP calls' time limit and result size are settings.** The MCP host's fixed 270 s call time limit and 1 MiB
  result bound become `mcpCallSeconds` (270 by default; superseded: off by default since the SPI-1386 refinement below; 1 to `MAX_TIMED_MINUTES` × 60, tier `down-free`; t3flare's own
  timer times it, so ADR-0048 §2's sanity maximum applies) and `mcpResultKiB` (1024 by default, 1 to 8192, tier
  `down-free`; a provisional bound from an estimate of the Environment DO's isolate memory, about six times a result
  while it is read). They show in an MCP calls row of their own between the Agents and History rows, and apply at the
  next call. 270 is a little past Commissary's own 240 s, but it applies to every server, Environment-wide. A CLI
  process's tool timeout (`cliToolTimeoutSec`) takes the call time limit at its spawn in place of the fixed 270 s. A
  streamed result past the size is refused whole (JSON cannot be read in part), naming the setting; an inline one is cut
  to it, in bytes of UTF-8 rather than characters, and its structured content dropped. Each states its consequence
  once ("it may have run on the server"; "a larger size uses more of its memory").
- **The Base build retry is a setting**, `baseRetryMinutes` (60 by default, 1 to `MAX_TIMED_MINUTES`, tier `up-free`, in
  the Image setup's row): it replaces the fixed hour of ADR-0047's SPI-1332 refinement §4 (recorded in
  ADR-0047's SPI-1359 refinement). Its consequence: "A shorter wait runs the Builder's Container, and bills it, more
  often while a build keeps failing."
- **The CLI hold is derived.** The SPI-1318 refinement's 660 is no longer "forced by t3's 10-minute session release":
  that release is t3flare's own Patch 0003, a cost choice. `CLI_SESSION_RELEASE_MS` (10 minutes) in
  `packages/harness-registry/src/environment.ts` names it, beside `CLI_IDLE_HOLD_MS` (the release plus a minute) and
  `MAX_CLI_RECLAIM_SECONDS` (the hold), and a test holds the patch and the constant to the same minutes. The release
  stays fixed, not a setting: making it one would need Patch 0003 to read a setting at t3's boot.
- **The Terminals' maximum is split.** This supersedes the SPI-1317 refinement's "They take 1 to 32".
  `agentTerminalsPerWorkspace` keeps 32 (`MAX_AGENT_TERMINALS_PER_WORKSPACE`), the named, provisional constraint: an
  agent's Terminal keeps a headless xterm in the Workspace DO's 128 MB isolate. `terminalsPerWorkspace` takes 1 to 1000
  (`MAX_TERMINALS_PER_WORKSPACE`), a sanity bound (ADR-0048 §1): an Owner's Terminal keeps no xterm in the DO, only its
  handle and a share of one 1 MiB pending-output buffer, and its shell's memory is the Container's.

## Refinement (SPI-1365, 2026-11-23): what the Owner enters is bounded by what holds it

This supersedes the Variables refinement's §1 limits (50 Variables, 128-character names, 4,096-character values), the
Global mise config refinement's 16 KiB, §4's "nor other custom sizes", and the ADR-0047 refinement's 256 KiB setups.

- **One stored value bounds the settings together.** The Environment settings are one Durable Object KV value, which
  holds 8 MB (`DO_VALUE_BYTES` in `packages/harness-registry/src/storedValue.ts`, read as 8,000,000 bytes less a margin
  for the key). A change whose settings together would pass it is refused, naming the bound; `storedBytes` counts
  three bytes a character of their JSON, the most UTF-8 takes, which is above what V8's serializer stores. The Model
  endpoints, the Harness settings and the audit log are each one value too, bounded the same way: no count of
  endpoints, models, headers or t3 tools set one by one, and the audit log keeps its newest entries that fit.
- **Variables are bounded by Linux, not by a count.** A Variable reaches every command through execve's environment,
  so each `NAME=value` with its NUL is at most `MAX_ENV_STRING_BYTES`, 128 KiB (Linux's `MAX_ARG_STRLEN`, past which
  execve refuses with E2BIG), in bytes of UTF-8; a name has no length of its own. All of them together, each with its
  envp pointer, take at most `MAX_VARIABLES_BYTES`, 1 MiB: half of `ARG_MAX` at the default 8 MiB stack, the other
  half left to the command's own argv (an agent's `bash -c` script) and t3flare's environment. Provisional: the
  Container's stack limit is not documented. A stored set past the total reads as the Variables that fit, in order.
  The Container setup's secret margin (`SECRET_MARGIN_BYTES`) follows: 128 KiB, at least any one value.
- **The file settings are derived from the value.** The Global mise config, the Image setup and the Container setup
  are each at most `MAX_FILE_SETTING_BYTES`, a third of the value (a byte of UTF-8 is at most one character, counted as
  three); with escaping and the other settings, the whole-value check is what binds.
- **The Settings server reads one value's change.** Its body limit is `BODY_MAX` = `DO_VALUE_BYTES` + 64 KiB: a whole
  value's settings as a client's JSON sends them, and the JSON-RPC envelope. The old 256 KiB was exactly the setups'
  size, so a setup at its maximum could not be sent.
- **A custom Container size.** `containerSize` and `builderSize` offer `custom`, whose vCPU, memory and disk are the
  settings `customVcpu`, `customMemoryMib` and `customDiskMb` (default `cpu-1`'s 1, 3072 and 12,000; asked either
  way; superseded: the default size's, `standard-3`'s, since the SPI-1386 refinement below). Each is at least Cloudflare's minimum for a custom instance (1/16 vCPU, 256 MiB, 2 GB); there is no maximum
  of t3flare's, since the account's limits (4 vCPU, 12 GiB, 20 GB by default, raised on request) are Cloudflare's to
  check, and a start past them is refused. The cost table prices the custom size at its settings.
- **One Outside request time limit.** `outsideRequestSeconds` (15 by default, tier `down-free`, a row of its own)
  bounds each request to GitHub (Environment skills' reads, an Update's requests) and to a sign-in's vendor (each
  request, a renewal; a ChatGPT revocation with its retries takes twice it). The skills API's 60 s budget for a whole
  request goes: each read has its own bound and the reads are counted, and an awaited read does not hold the
  Environment DO. An own agent's wait for its applying change is derived from it (every read of the largest install at
  the limit, at most a JS timer's longest wait).
- **How far skills are read is a setting.** `repoSkillsListed` (100), `skillsDirectoryEntries` (5000),
  `skillsLinkEntries` (200) and `promptsDirectoryEntries` (1000), in a Repo skills and Prompt templates row, each
  `down-free`, read by the Workspace DO from the settings its last Container start kept. Prompt templates have no
  count and no size.

## Refinement (SPI-1362, 2026-11-23): what a model and the Owner's client are shown

- **The Tool output limit is a Harness setting.** pi-durable cut every tool result the model reads at its own default,
  50 KiB or 2,000 lines, since no tool t3flare registers named `outputLimits`. A `tool-output` entry, "Always on", holds
  `outputKiB` (50) and `outputLines` (2000), both `down-free`; the Session wraps every tool but code mode (pi-durable's
  own limits) with them, a tool's own `maxBytes` or `maxLines` kept. Its maximum, `MAX_TOOL_OUTPUT_KIB`, is a named
  constraint from the Session row: the text at six JSON bytes per byte takes at most half the row. Its minimums, 4 KiB
  and 50 lines, are t3flare's own: each tool keeps room for its notes inside the limit. The tools that size their own
  text to it take it: `ls`, `find` and `grep` (grep's context share), the web tools (`web_search`'s stored result lists,
  `resultsBytes`, from what it leaves), a Terminal's screen beside its scrolled-off lines, a Background job's tail, and
  a `context_history` read's page. `read` still reads at most pi-durable's 50 KiB or 2,000 lines of a file per call,
  which its description names.
- **New Harness settings, today's values as defaults:** `web.searchContextCharacters` (6000), `context.previewCharacters`
  (120: a list line; a tool call's argument half, a search match a sixth before and half after), `termctrl.startWaitMs`
  (2000, also bash's background threshold), `inputWaitMs` (500), `pollWaitMs` (30000), `scrollbackLines` (100) and
  `scrollbackKiB` (16, at most half the Tool output limit in effect), `guardian.batchArgumentCharacters` (2000, at most
  the evidence budget; asked, as every Guard's setting), and a `prompt-suggestions` entry, "Always on" (t3's Labs flag
  turns suggestions on), with `excerptCharacters` (4000) and `timeoutSeconds` (20).
- **A new Environment setting:** `agentTerminalScrollbackLines` (1000, 0 to 10,000, `down-free`, in the Containers row
  after the agents' Terminal count), riding the launch as the SPI-1317 refinement's four do. Its maximum is a named,
  provisional constraint, as the agents' Terminal count's: each line of an agent's Terminal takes about 12 bytes per
  column in the Workspace DO's 128 MB isolate.
- **Derived, not set:** what t3 is shown follows t3's own display caps (docs/upstream-fragility.md U100): a finished
  tool result's text at t3's 256 KiB on-demand size, a nested call's arguments at its 32 KiB wire detail size, and
  running output tails at its 64 Ki live tail. The approval card's script is shown by the card's own rule
  (`cardText`) and kept once per code mode call. The Guardian's evidence budget takes trusted messages first, newest
  first, then the newest untrusted ones; its History read stops once trusted evidence fills the budget (or, on a linked
  thread, any evidence does) (read pattern superseded by the SPI-1378 refinement below). A push's page (`PUSH_ENTRIES_BYTES`) holds a burst of 16 full-size tool results, so a
  round of parallel calls settles without a snapshot; with one whole Session row past it, it stays well inside the
  32 MiB a Durable Object RPC carries.
- **Removed:** the 10-minute default of a t3 wait with no `timeoutMs` (it waits until what it waits on happens, or the
  turn is interrupted), termctrl's 20-line exit tail (a job's tail bounds it), and the 64 KiB cuts of an owner's message
  and a tool's `details` in a push (both fit the Session row they come from).

## Refinement (SPI-1366, 2026-11-23): the Environment's housekeeping caps and fixed waits

The Environment's housekeeping kept counts and waits nothing forced. Supersedes the usage records' row cap of the
SPI-1323 refinement above, and widens SPI-1365's Outside request time limit.

- **Removed: what dropped data or work.** The usage records keep every row inside the retention (no `MAX_USAGE_ROWS`).
  The Sweep destroys every deleted thread's Session that is due in one run (no 50), lists every holder of a Workspace
  (no 5), and remembers the Sessions it destroyed one key a thread, forgetting a thread once t3's projection no longer
  holds it (no 5,000). The GitHub App lists every page of its installations and lists them again at once for an
  account it does not know (no single page, no 5-minute cache). The audit log reads any page size and the Settings
  page pages it (no 50). An Update waits as long as GitHub queues it (ADR-0037's refinement). A model sign-in waits as
  long as its vendor takes the code (no 30 minutes). Endpoint labels, API keys and pasted redirects, model names in
  `codex exec`, a model's listing's pages, a cause chain's depth and the fixtures route's runs lose their counts.
- **Reused: the Outside request time limit.** `outsideRequestSeconds` now also bounds a Model endpoint's model listing
  (all its pages together), T3 Connect's sign-in code and its relay unlink, and each GitHub App request. The Connect
  probe and the relay status view end with the admin request that asked for them.
- **New settings**, each with today's value as default and read at its own next use (the Settings server says so). A
  tier follows ADR-0035 §3: what spends, holds, destroys or widens a window is asked in that direction.

  | Setting                       | Default | Tier                                                         | Row              |
  | ----------------------------- | ------- | ------------------------------------------------------------ | ---------------- |
  | `githubRetrySeconds`          | 60      | `up-free` (a shorter wait asks GitHub more often)            | Outside requests |
  | `textGenerationSeconds`       | 110     | `down-free`                                                  | Outside requests |
  | `mcpPausesPerCall`            | 16      | `down-free`                                                  | MCP calls        |
  | `cliMcpStartSeconds`          | 20      | `free`                                                       | MCP calls        |
  | `mcpSignInMinutes`            | 10      | `down-free` (a longer window keeps a sign-in's state longer) | MCP calls        |
  | `idleAfterSeconds`            | 60      | `down-free` (longer keeps t3 resident, and billed)           | Sleep and wake   |
  | `prWatchWakeMinutes`          | 10      | `up-free` (shorter boots t3 more often)                      | Sleep and wake   |
  | `remoteRetryMinutes`          | 30      | `up-free` (shorter boots t3 more often)                      | Sleep and wake   |
  | `safeModeAfterFailures`       | 3       | `down-free` (more lets a failing boot loop longer)           | Sleep and wake   |
  | `browserProfileSaveSeconds`   | 60      | `up-free` (shorter spends Browser Run time)                  | Previews         |
  | `htmlBrowserKeepAliveSeconds` | 120     | `down-free` (longer bills Browser Run time)                  | Previews         |
  | `pageTokenHours`              | 1       | `down-free` (longer keeps a copied token valid longer)       | access           |
  | `clientsPerKey`               | 50      | `up-free` (fewer forgets modes the Owner set)                | access           |
  | `connectPublishLogKept`       | 100     | `up-free` (fewer deletes log entries)                        | access           |

  (Superseded for `textGenerationSeconds`: 180 by default since the SPI-1386 refinement below.)
  - The GitHub App's back-off doubles to 15 times `githubRetrySeconds`; GitHub's own named time is always kept; an
    account it is not installed on is listed again at most once a retry.
  - The agents Worker ends text generation at `textGenerationSeconds`, and the Environment waits
    `TEXT_GENERATION_MARGIN_MS` more, today's 120 s.
  - `mcpSignInMinutes` also deletes abandoned sign-in states. `pageTokenHours`: the page asks for a new token when its
    own runs out.
  - `htmlBrowserKeepAliveSeconds` is Browser Run's `keep_alive` (at most its 10 minutes), the one knob: t3flare's own
    60 s close beside it is gone, and the default is the 120 s `keep_alive` it used.
  - T3 Connect's republish after a boot reads each live thread's last phase from a map of its own, never cut by the
    log's length.

- **The Sweep at the platform's limit.** Each Session destroy is one RPC, and a Workers invocation makes at most 10,000
  subrequests. Past the limit the Session pass stops, records what it destroyed, skips the cost guard, and comes back
  a minute later, not a day.
- **Derived.** A new Environment's first Sweep comes one Sweep cadence after its first look, not an hour.
- **Kept.** The stage-only process check's parameters and the preview spike's CDP command wait are diagnostics' own,
  not the Owner's.

## Refinement (SPI-1367, 2026-11-23): retries, a stopped command's kills, t3's trace, and Claude Code's sessions

Behaviour t3flare forced to one value becomes the Owner's, each new setting at today's value and read at its own next
use (`NEXT_USE_SETTING_KEYS`). A tier follows ADR-0035 §3: what spends or keeps a Container awake is asked upward, what
deletes is asked downward.

| Setting          | Default | Tier                                                     | Row               | Applies at                  |
| ---------------- | ------- | -------------------------------------------------------- | ----------------- | --------------------------- |
| `durableRetries` | 3       | `down-free` (each retry is a request the endpoint bills) | Retries and kills | each thread's next turn     |
| `cliRetries`     | 1       | `down-free`                                              | Retries and kills | each CLI agent's next start |
| `killAttempts`   | 12      | `down-free` (each kill keeps the Container awake)        | Retries and kills | each thread's next turn     |
| `traceKiB`       | 1024    | `down-free` (each trace write rewrites the whole file)   | t3's trace        | t3's next start             |
| `traceFiles`     | 1       | `up-free` (fewer deletes the oldest files)               | t3's trace        | t3's next start             |

- `durableRetries` is pi-durable's `settings.retry.maxRetries`, which the Session reads at each use, as the latest
  turn's start carried it (`turnRetries.ts`). The reset a rate limit is waited through is the span of those retries
  (`retriedSpanMs` in `@t3flare/harness-registry`, a mirror of pi-durable's backoff, fragility U105; 14 s at 3), so 0
  pauses at any reset. 0 to `MAX_MODEL_RETRIES` (100), a sanity bound.
- `cliRetries` is Codex's `request_max_retries` and `stream_max_retries`, Claude Code's `CLAUDE_CODE_MAX_RETRIES` and
  pi's `retry.maxRetries`, written at each spawn. OpenCode keeps its own. Replaces "nothing retries into spend" as a
  fixed rule: the Owner sets how much a retry may spend.
- `killAttempts` was `MAX_ATTEMPTS`; the Session reads it at each kill. Some count is needed: a kill that keeps finding
  survivors keeps the Container awake, so "Container not running" never ends it. 1 to `MAX_KILL_ATTEMPTS` (1000, about
  tries `KILL_RETRY_MS` apart), a sanity bound.
- `traceKiB` and `traceFiles` are t3's `traceMaxBytes` and `traceMaxFiles`, read when t3 boots. `MAX_TRACE_KIB` is a
  named constraint, one inline State directory row (4 MiB, `CHUNK_BYTES`): the State directory appends by reading and
  rewriting the whole file, and t3 flushes its trace about five times a second, so each flush holds about three times
  the file in the Environment DO's 128 MB isolate, which also runs t3. `traceFiles` takes 1 to 100: t3 refuses fewer than 1, and deletes files
  past the count when it starts.
- **Reused: `piSessionRetentionDays`** now also sets Claude Code's `cleanupPeriodDays`, which was fixed at 60. Both
  delete a session nobody wrote to for that many days at the CLI's start. The key keeps its name, so stored values
  carry over; its title is "Pi and Claude Code sessions kept (days)".
- **Fixed, named:** the HTTP router's `maxParamLength` is 16 KB, the Workers request URL ceiling, in place of an
  unexplained 512: no route parameter can be longer than the URL that carries it.
- Git's automatic fetch is t3's own setting, off by default (ADR-0023's and ADR-0009's SPI-1367 refinements), so it
  has no row here. Idle compaction stays locked off: it needs a provider turn's prompt cache expiry, which Claude Code
  over ACP never reports (ADR-0023's SPI-1367 refinement). t3's product analytics stays off (Owner decision D1).

## Refinement (SPI-1364, 2026-11-23): the Workspace's commands, Terminals, previews and what it keeps

The Workspace DO's and the Container operations' fixed values were each removed, derived, or made a setting; this
supersedes the SPI-1318 refinement's "Claude Code and OpenCode count two each" and the SPI-1315 refinement's fixed
130-minute backstop.

New Environment settings, each with today's value as its default and its consequence stated once in its description:

- A Commands row (superseded: `commandMinutes` off and `containerConnectSeconds` 120 by default since the SPI-1386
  refinement below): `commandMinutes` (2), the deadline of a Container command that carries none of its own (an agent's
  search of a Container-only path, the credential helper's install; not t3's git, below), `down-free`.
  - `containerConnectSeconds` (60), computer's connect deadline, `down-free`.
  - `reclaimProtectionSeconds` (30), the reclaim protection: how recent use keeps a Container from a reclaim, which some
    value must keep or two Workspaces under a full budget stop each other between commands, `free`.
  - `skillsWaitSeconds` (5), the wait for a running Container's copy of new Environment skills, whose exec deadline is
    derived from it (its looks plus a 10 s margin), `free`.
  - `abortGraceSeconds` (2) and `portStopGraceSeconds` (3), TERM before KILL for a stopped command's processes
    (t3flare's kill script's 2 s) and a stopped port's group (stock t3's `STOP_GRACE_MS`), `free`, with a sanity maximum
    of 600 (`MAX_STOP_GRACE_SECONDS`). The kill script gives up `KILL_GIVE_UP_MS` (1 s) after its KILL.
- A Terminals row: `firstPromptSeconds` (20), how long input to a new t3 Terminal waits for its first prompt, `free`;
  `terminalHistoryKiB` (1024) and `exitedTerminalsKept` (16), t3's TerminalManager history in the Environment DO,
  `down-free`, with stock t3's 8 MiB and 128 as sanity maxima; the 128 MB isolate bounds their product, which their
  descriptions state. They apply when the Environment next restarts: t3 takes them when its layer is built.
- In the Previews row, first, before SPI-1366's preview browser cadences: `previewPorts`, the Container ports a preview
  browser routes (default the eight of ADR-0031), a new `ports` field type, at most `MAX_PREVIEW_PORTS` (8, Browser
  Run's hosts) and never `RESERVED_CONTAINER_PORTS` (computerd's 8080, the MCP bridge's 17781), asked either way;
  `portProbeMs` (1000), a port check's wait, `free`. `previewPorts` and `routerTraceEntries` apply at their next use
  (`NEXT_USE_SETTING_KEYS`), and `terminalHistoryKiB` and `exitedTerminalsKept` at the Environment's next restart
  (`ENVIRONMENT_RESTART_SETTING_KEYS`); the Settings server says so.
- The History row gains `tempFilesHours` (24), harness temp files' retention, read at an agent's first file operation
  after the Workspace wakes, `up-free` as the other retentions;
  `gitReadsKept` (500), the passive git answers a Workspace keeps (their only deletion), `down-free`; and
  `routerTraceEntries` (300), the Environment's in-memory command trace, `down-free`.

The Workspace DO's settings are read from the copy its last Container start took, so they apply at a Workspace's next
Container start. `containerConnectSeconds` is read when computer's backend is made, before that start takes the
settings, so a change can take one more start to apply, as the settings read wait's does.

Two Harness settings: termctrl's `quietMs` (250) and `stopGraceSeconds` (3), carried on each agent Terminal settle and
stop; and code mode's `interruptBudget` (100,000 polls, pi-codemode's default), at most `MAX_CODEMODE_INTERRUPT_BUDGET`,
derived from the sandbox Worker's CPU limit (a Durable Object's default 30 s, which apps/environment/alchemy.run.ts
leaves unset) at pi-codemode's measured 10,000 polls a CPU second.

Derived, not set: t3's git commands end when t3 gives up on them. t3 times each git command by interrupting its own wait
(30 s by default, 5 minutes for a fetch, none for a push), which the spawner sees only as its scope closing; the router
then asks the Workspace to end that run (`cancelRun`, TERM then KILL after t3's own 1 s), however long the run's
Container took to start. A run t3 can cancel takes no `commandMinutes` cut: its deadline is `CANCELLABLE_RUN_MS`, the
shared sanity maximum (`MAX_TIMED_MINUTES`), a backstop for a run whose cancel cannot come (the Environment restarted).
(Superseded in part by the SPI-1382 refinement below: such a run is ended once the Workspace learns of the restart.)
A killed read's answer is never cached (computer's `cancelled` status; a timeout's kill was cached before, since
computer never reports `timeout`). The process backstop is later than both cleanups it backs up, so only a process both
missed reaches it: t3 releases a silent session `CLI_SESSION_RELEASE_MS` after it goes idle, but pins it instead while
its runtime reports background work (Claude's scheduled wakeups, background tasks, subagents), for at most t3's
`DEFAULT_MAX_IDLE_PIN_MS` (4 hours, `T3_MAX_IDLE_PIN_MS`), rechecking once per release; so the backstop is two releases
plus that pin plus `HEARTBEAT_LAPSE_MS` (about 4 h 21 min). A session `get` that restarts t3's idle clock with no I/O is
not covered (docs/upstream-fragility.md U106). The process channel gives up on a Workspace once its reads or a stdin
write have failed for the heartbeat lapse, not after a count of tries.

Removed: the count weight of Claude Code and OpenCode (each process counts once; `cliProcessesPerWorkspace`'s
description states each CLI's memory instead), the project-root view's 1,000 files and 20 MiB, its find's 50,000, the
leak check's 200 matches (it pages), the leak dump's 1 MB file size, 5,000 files and 32 MiB (it is written to a file in
the Container and read back in `DUMP_SLICE_BYTES` slices, scanned in the Environment, so no secret enters the
Container), the scratch checkouts' 2-hour
TTL, the relay keys' 32 endpoints, the credential helper's 60 s, the separate deadlines of the ref priming (60 s) and
of starting the Container (180 s), content search's 50 highlights a line, and the metadata batch's concurrency of 8.

Kept, with their constraints named where they are set: the MCP relay's body, raised to 16 MiB less 64 KiB (half the 32
MiB DO RPC message, since a string may cross as UTF-16); the file index, bounded by the bytes of its DO RPC answer, not
5,000 entries, its cut stated; a file read, stock t3's 1 MiB, now read as a range; the terminal shells, bash and sh
only, which the Container's terminal host runs; pi-durable's `listFiles` defaults, its interface's.

A script that bounds its own output is answered whole. computer keeps, by default, only the last 2,000 lines or 64 KiB
of each stream of an exec, and the Workspace DO's `exec` does not pass on the flag that says so, so a Container listing
or a leak dump's slice came back silently cut to its end. Those run whole now, with nothing saved in the Workspace's
files (`wholeOutput`): the Container file tools' scripts, the listings (`readdir`, `find`) bounded at `LISTING_BYTES` (1
MiB) and failing past it, saying so, grep at `GREP_OUTPUT_BYTES`, the leak dump's slices at `DUMP_SLICE_BYTES` (4 MiB),
and a checkpoint diff, which the Container cuts to the size t3 asks for (`head -c`). Each bound is named by the
Workspace DO's isolate memory, not the DO RPC message: whole, an output is held about 3 to 4 times its size at its peak,
and a parsed listing about 20 times. Every other command, t3's git reads and actions among them, keeps computer's
default as before: its answer is still tailed to 64 KiB without a word, which a follow-up ticket owns; failing those
past a size broke t3 features that read a long answer's head (a generated commit message's staged patch, a PR's range,
the review panel's diff).

## Refinement (SPI-1363, 2026-11-23): the MCP layer's time limits, sizes and logs

The MCP engine's, the MCP Worker's and the MCP host's fixed values were each removed, derived, or made a setting.

New Environment settings in an MCP servers row of their own, after the MCP calls row (`MCP_SERVER_SETTING_KEYS`), each
with today's value as its default, read as each call's target is
made, and `down-free` (longer holds a dead or slow server longer; more logs take more of the MCP Worker's memory):

| Setting             | Default | Maximum                                     | What it bounds                                              |
| ------------------- | ------- | ------------------------------------------- | ----------------------------------------------------------- |
| `mcpConnectSeconds` | 15      | `MAX_TIMED_SECONDS` (a week)                | a connection's probe and `initialize`                       |
| `mcpListSeconds`    | 120     | `MAX_TIMED_SECONDS` (a week)                | one listing of a server, all its pages together             |
| `mcpLogEntries`     | 50      | `MAX_MCP_LOG_ENTRIES` (200, a sanity bound) | a call's last server logs, up to 128 KiB each in the Worker |

(Superseded for `mcpConnectSeconds`: 30 by default since the SPI-1386 refinement below.)

Reused: the Outside request time limit (`outsideRequestSeconds`) now bounds each request of an MCP server's OAuth
sign-in and token refresh in the MCP Worker, and its revocation and Client Credentials grant where they are called; its
default is the 15 s each had (revocation's 5 s is gone).

Derived from the server's call timeout (`mcpCallSeconds`), with no lower bound under it: a `resources/read`, a
`prompts/get` and a one-page list (no 30 s clamp), each `tasks/*` request (not 30 s), a completion (not 5 s) and a
listen's acknowledgement (not 10 s). A list page has no deadline of its own: the listing's does it. The tap waits a
`Retry-After` as long as the server asks, unless the request has no time left for it, and then does not retry; it waits
a resume's `retry` as asked, unless that reaches the request's whole time limit, and then cuts the request.

Removed: the elicitation form's bounds (32 fields, 100 options, 64 KiB of schema, 16 KiB a value, 64 KiB an answer) and
its labels' cuts (the message's 4,000, titles' 120, descriptions' 500, options' 200, quoted names' 60); the card's own
cuts of the agent's call (8 KiB) and its titles (200); a page question's 8,192-character address, which now stays outside
the card's cut, whole; a `ui://` URI's 2,048; an App's 4 MiB of HTML and its 12 MiB read (the App's read is now held to the MCP result
size, below); the 64 KiB a Modern server's `server/discover` was kept to; the 20 characters of a direct server's name
(its tools' names stay held to 64); a structured result's 5 validation errors; the 32 and 64 characters a token type and
an OAuth error code were cut to; and the dead `MCP_ELICITATIONS_PER_CALL`, `MCP_PROMPT_GET_TIMEOUT_MS`,
`MAX_TOKEN_BYTES`, `MCP_MAX_WAIT_MS` with the request-start schema that named it, and the stdio bridge's connect
timeout (stdio is refused; when it returns, its connect limit follows the Container's start limits).

Kept, with their constraints named where they are set: the tool definitions one server's inventory keeps, now half of
its one 8 MB Durable Object value in stored bytes (`MAX_SCHEMA_BYTES`), with no count of tools (was 200 tools and 256
KiB); and the remote-controlled bodies of a sign-in (metadata, discovery, a token response), raised to 1 MiB, the tap's
bound on any other MCP answer, under the 128 MB isolate they are read into and the 8 MB value they may be kept in.

Bounded by what carries them: a server's question is declined unseen, saying why, when its card would pass 1 MiB stored
(`MCP_CARD_BYTES`), since a card is pushed to t3 as one request and kept in its 8 MB event row, and a question arrives in
a `tools/call` body or a pause's result, which hold far more; an App's resource is read at the MCP result size
(`mcpResultKiB`, at most 8 MiB) and refused past it in characters, since it crosses the relay's 32 MiB RPC as UTF-16; and
a server's refused tools are cut, names and reasons to 300 characters (superseded by the SPI-1360 refinement: kept
whole) and the list to what the inventory's value has left, ending with how many more were refused.

## Refinement (SPI-1360, 2026-11-23): error, log and reason text is not cut

Supersedes the SPI-1363 refinement's 300 characters of a refused tool's name and reason: both are kept whole, and the
refused list alone is cut, where it would pass the inventory's one Durable Object value. The rule this follows, for every
error, log line, reason and list t3flare shows the Owner or an agent, is in
[ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)'s
SPI-1360 refinement.

## Refinement (SPI-1368, 2026-11-23): the last fixed values, named, removed, derived or settings

New Environment settings, in the MCP servers row (`MCP_SERVER_SETTING_KEYS`), each with today's value as its default and
read as each call's target is made:

| Setting                 | Default | Maximum                                               | Tier        | What it bounds                                              |
| ----------------------- | ------- | ----------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `mcpProgressPerSecond`  | 10      | `MAX_MCP_PROGRESS_PER_SECOND` (1,000, a sanity bound) | `down-free` | progress notices one call passes on to its Session a second |
| `mcpLegacyRecheckHours` | 24      | `MAX_TIMED_MINUTES` / 60 (a week)                     | `free`      | how long a server found speaking Legacy is taken as Legacy  |

`mcpLegacyRecheckHours` takes 0, which probes at every connection.

New Harness settings of the `web` extension: `fetchRedirects` (default 10, at most `MAX_REDIRECTS`, 100, a sanity
bound; `down-free`, since each hop spends up to three of the turn invocation's subrequests) and `fetchTitleCharacters`
(default 200, at most 10,000; `down-free`, since a longer title takes more of the thread's stored history). The 4,000-character window the title was
searched in is gone, as are the 300-character cuts of `web_fetch`'s and `web_search`'s snippets: `web_fetch`'s snippet
is the model's text, cut only where the result's Session row has no more room, and `web_search`'s are whole, within the
result lists' share of the row.

Changed Harness settings: `codemode.inlineBudget` takes any whole number from 0, with no maximum (was 500 to 20,000),
and becomes `down-free` (was `free`), since a larger budget puts more in every request's prompt; the Guardian's
`tools`, `commands` and `policy` and the model settings (`guardian.model`, `advisor.model`, `web.searchModel`) have no
length of their own (were 4,000, 4,000, 8,000 and 300 characters): an extension change is checked against the Harness
settings' one Durable Object value instead, as a tools change already was. `termctrl.cols` and `termctrl.rows` take
1 up to `MAX_TERMINAL_COLS` and `MAX_TERMINAL_ROWS` (were 40 to 400 and 10 to 200), derived from the Workspace DO's
128 MB shared among `MAX_AGENT_TERMINALS_PER_WORKSPACE` Terminals at about 12 bytes a cell, each with the other's
default and the default scrollback, and within a PTY's 16-bit size: 320 and 1,777 today, provisional with the
estimate they share.

An extension change keeps the rest of Global: before, it stored Global as only its `extensions`, which dropped the
tools' Exposures and t3's tools set before it.

Removed: the MCP core's 10 rounds of questions (`MCP_INPUT_ROUNDS`) and the 1 MiB of a resume or resend state
(`MCP_RESUME_STATE_MAX_BYTES`, which no caller stored); a Model endpoint model's 100,000,000 ceiling on its context
window and output limit; the leak scan's 64 MiB per file, which left a larger file unscanned: it now reads every file in
overlapping 8 MiB chunks. The skills change's 32 KiB of SKILL.md and 200 paths per skill are derived instead: the skills
shown share half the change record's one SQLite row evenly (`SHOWN_SKILLS_BYTES`), each its paths first, then its
SKILL.md. The State directory's `statfs` reports the Durable Object's 10 GB less its database's size, not a fixed 10 GiB
free.

## Refinement ([ADR-0049](0049-settings-follow-local-parity-and-guardrails-are-opt-in.md), 2026-11-24): which settings exist, and where the page shows them

§2's one schema keeps a setting only where the Owner would choose its value: cost, size, what agents may do, setup,
retention. A value that only guards t3flare's own machinery leaves the schema for a named, generous constant, and with
it leaves the Settings page, the Settings server and the Change tiers; a stored value for it is ignored when the
settings are resolved, never refused, and earlier audit entries that name it stay as written. A limit with a local
equivalent defaults to the local behaviour, usually no limit, and a cloud-only guardrail is off by default, the Terminal
holds and the setup time limits excepted.

Each setting that stays is to declare its disclosure in the one schema: visible, contextual (with the condition that
shows it) or Advanced, and the page is to render each section from it: visible settings always, contextual ones while
their condition holds, and the Advanced ones collapsed. A limit that is a contextual or Advanced setting is to name,
when hit, the setting and where it lives on the page. SPI-1385 implements the disclosure; the settings this changes, and
their values, are the other tickets of SPI-1357's prune, each with its own refinement here.

## Refinement (SPI-1382, 2026-11-24): a git run whose Environment restarted is ended

Supersedes, in the SPI-1364 refinement, `CANCELLABLE_RUN_MS` as the end of a run whose cancel cannot come because the
Environment restarted. Such a run kept the Workspace's running count above zero, which blocked its idle stop and a
reclaim, so a billed Container could stay up for the week.

- **A git run t3 can cancel carries the Environment's epoch** (`GitRun.environmentEpoch`), the Environment DO's boot
  count, which the process channel already gives its CLI processes. The t3 that awaits a run lives in one boot of the
  Environment DO: an idle reset (ADR-0003), an eviction and a deploy each end it with that boot, and every new boot
  counts one more. So a run sent under an older epoch has nothing left to cancel it or read its answer.
- **The Workspace ends the runs of an older epoch** as a cancel ends them (TERM, then KILL after t3's 1 s), and logs
  each as `git-run-dropped` with both epochs and why. It learns of a newer epoch from any call that carries one (a git
  run, a CLI process start) and, while a run that carries an epoch is open, from its alarm, which asks the Environment
  (`environmentEpoch`, which never boots t3). With no such run open, the alarm asks nothing.
- No time limit or setting is added (the Owner, 2026-11-24). `CANCELLABLE_RUN_MS` stays, as the backstop for a run
  neither a cancel nor the epoch ends.

## Refinement (SPI-1378, 2026-11-24): the Guardian reads the History since its last review

Supersedes, in the SPI-1362 refinement, the Guardian reading its History from the newest entry on every review. With
`trustUser` on, trusted evidence rarely fills the budget, so each reviewed call read the whole History. Which evidence a
review selects does not change.

- **An evidence index per conversation, in memory:** each entry's id and the size its evidence takes (a trusted
  message's JSON length, an untrusted one's shown form), the newest and oldest entry read, and the texts of the last
  selection. Entries never change and ids are never reused, so the index stands for the History it read.
- **The next review reads only the entries newer than the newest it read**, then selects over them and the index by the
  same rule a whole read uses, back-fill included. A review reads, newest first, a page at a time: the entries newer
  than the newest it read; the History past the oldest entry read, only when the selection reaches past it; the texts of
  older entries it newly selects, as one id range spanning them; and, when a full budget stopped the selection where
  nothing read shows an older entry, one read of up to two entries to learn whether older History exists. That is at
  most one read call more than an uncached review's: the read since the newest entry comes before the selection knows
  which older texts it needs.
- **The Reviewed Call's own response is skipped by its entry id.** Before, every response holding one of its call ids
  was left out; where a provider leaves call ids empty or reuses them (pi-ai's openai-completions adapter writes
  `toolCall.id || ""`), older responses sharing the id are now evidence too.
- **It reads the whole History again** on a new isolate, a Guardian installed again (a settings change), another
  `trustUser` or budget, a review of another conversation (a fork is one; the index holds one conversation), and when the
  History no longer holds the newest entry read. No limit or setting is added.
- **The omission note's "older History not read"** names a full budget with any entry older than where the read
  stopped, not only a next page, so it reads the same on both paths.

## Refinement (SPI-1386, 2026-11-24): local-parity defaults, and off

[ADR-0049](0049-settings-follow-local-parity-and-guardrails-are-opt-in.md)'s rule applied to the defaults. A stored value
is kept: only the defaults move. Each value is the Owner's (SPI-1386).

- **Off.** A guardrail with no local equivalent takes 0 as off, no limit: its schema says so (`off: true`, its minimum
  0), the Settings page shows 0 as an empty field with "off" its placeholder and takes one empty, the Settings server
  takes 0, and its description says "Empty or 0 is off" with what that means. In a Change tier off ranks above every
  limit (`offRank`), so turning a guardrail off is the widening direction and setting one from off the narrowing one:
  this supersedes, in the SPI-1323 refinement, "keep for good" as the maximum in place of a 0 sentinel.
- **What off does.** A timer t3flare can leave unarmed arms nothing: the Turn limit's Session alarm and the CLI
  wrapper's timer. A deadline that cannot be left out takes `OFF_DEADLINE_MS`, the shared sanity maximum, a week:
  computerd's exec (its handling of an absent `timeoutMs` is unverified) for the clone, checkpoint and command limits,
  and the MCP engine's requests for the call limit (its SDK times a request it gives none at 60 s). A CLI's tool timeout
  counts an off call limit as that deadline. The Sweep counts an off clone limit as it too, so it never purges a
  Workspace whose clone may still run. The budget DO refuses no start with no budget, and still keeps the leases. The
  usage records prune nothing with no retention; pi gets no prune, and Claude Code's managed settings leave
  `cleanupPeriodDays` unset, so its own 30 days apply (`cleanupPeriodDays` takes no 0: at least 1).
- **The defaults:**

  | Setting                   | Before  | Now                                               |
  | ------------------------- | ------- | ------------------------------------------------- |
  | `containerSize`           | `cpu-1` | `standard-3` (the custom size's fields follow it) |
  | `containerBudget`         | 3       | off: the account's own limits                     |
  | `turnLimitMinutes`        | 120     | off: stock t3 has none                            |
  | `cloneMinutes`            | 15      | off                                               |
  | `checkpointMinutes`       | 10      | off                                               |
  | `commandMinutes`          | 2       | off                                               |
  | `usageRetentionDays`      | 92      | off: kept for good, as local t3 keeps them        |
  | `piSessionRetentionDays`  | 60      | off: each agent's own (pi for good, Claude 30)    |
  | `mcpCallSeconds`          | 270     | off: the server's own timeout applies             |
  | `mcpConnectSeconds`       | 15      | 30: a cold-starting server can take longer        |
  | `textGenerationSeconds`   | 110     | 180: stock t3's own for Claude and Codex          |
  | `containerConnectSeconds` | 60      | 120: a large image or a slow cold start           |

  The Terminal holds (30 and 10 minutes) and the setup scripts' time limits (the Global mise install's 10, the
  Container setup's 5 and the Image setup's 30 minutes) stay on, the Owner's exceptions. The text generation margin
  (`TEXT_GENERATION_MARGIN_MS`, 10 s) is unchanged: nothing of t3's times a Model endpoint's text generation around it.

- **The budget off on the page.** The cost table's budget column reads "No budget" and "no cap", its summary prices one
  Container of the size, and the budget's note says that as many run as the account's own Container limits allow.
  Running now shows the count with "no budget".
- **The Turn limit's cards.** With the Turn limit off, nothing in a turn has it as its cap; no card did in code.
