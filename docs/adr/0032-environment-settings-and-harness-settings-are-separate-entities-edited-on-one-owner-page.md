# Environment settings and Harness settings are separate entities, edited on one owner page

Status: accepted (SPI-1149, 2026-11-13; decided in SPI-1001's triage, the budget added at the owner's request the same
day). Report: [`docs-archive-1:docs/steps/environment-settings.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/environment-settings.md). Refines
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md). Refined by
[ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md)
(Environment skills: the same entity, revision and audit `entity`, applied at a turn, not a Container start).

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
   before: 1 vCPU, 3 GiB, 12 GB) and Cloudflare's `standard-1` to `standard-4`. The class runs under
   `schedulingPolicy: "durable_object"`, which takes an `instance` per `start()`. Every start passes one: an omitted
   `instance` starts `lite`, and a stored name t3flare does not offer starts the default. `lite` and `basic` (which the
   runtime refuses) are not offered, nor other custom sizes. A stored name never changes meaning: adding a
   size is free, removing one needs a rename map.
5. **A running Container keeps what it started with.** The Workspace DO records each start's size, idle time and
   budget, and adopts a running Container with the `instance` it started with (computer relaunches one whose launch
   differs). A change never resizes or restarts it; its idle stop follows the idle time it started with.
6. **The idle time** (1 to 60 minutes, default 2; 1 to 10,080 since [ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)) replaces the `CONTAINER_IDLE_MS` constant.
7. **The Container budget is a setting** (1 to 10, default 3, today's value; a cost guard, far below the account's
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
   export (up to 128 characters), each value up to 4,096 characters without a NUL. The panel shows
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

1. **Shape.** One setting, `globalMiseConfig`, of the schema's `file` type: at most 16 KiB of UTF-8, no NUL, line ends stored as LF so a browser's round trip is not a change. The panel shows it as a text
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
   2 MB. The current text is on the panel.
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
`down-free`, counted as before (Claude Code and OpenCode count two each). 100 is a sanity bound (ADR-0048): the
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
Harness setting (it bounds the CLI agents too): `turnLimitMinutes`, 120 by default, 1 to `MAX_TIMED_MINUTES` (ADR-0048
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
only to a process out of a turn, where the Turn limit bounds nothing.

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
servers' questions, and its Settings server's Open changes) keep the wait it was spawned with (`noteCliSpawnWait`,
`cliAnswerMs`, by thread); its next spawn takes the wait then. The Settings server's instructions are built when served,
with the wait they will apply.

Unanswered strikes depend on it: one Open change per thread means three expiries span at least two waits, so a fixed
hour would never see a run past a 30-minute wait. A run's window is `max(STRIKE_WINDOW_MS, (STRIKES - 1) × wait + 5
min)` (`strikeWindowMs`), the hour at the default, and a closed row is kept that window plus the lock (`closedKeptMs`),
which the Change page's gone text names. Both read the wait now.
