# Every Container starts from a Base snapshot the Builder makes from the Image setup, and runs the Container setup

Status: accepted (Owner decisions, 2026-11-22). Refines
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) (new
Environment settings, read at a Container start) and
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) (new Settings server tools). Leans on
Cloudflare's Container snapshots, a public beta. Evidence: a snapshot spike on a throwaway Stage, 2026-11-22; its
findings are the facts cited below.

The Owner wants their Workspaces' Containers to carry what their agents need, such as their dotfiles, without a
redeploy: an **Image setup** run once to make what every Container starts from, and a **Container setup** run at every
new Container's start. Both are Environment settings, bash scripts of up to 256 KiB each (superseded: see the SPI-1365
refinement below), run as root with
`HOME=/root`, `COMMAND_ENV` and every Variable, secret ones included
([ADR-0046](0046-a-variable-may-be-secret-as-stock-t3s-environment-variables-are.md)).

1. **The Base snapshot is a platform Container snapshot.** The **Builder**, one reserved-name instance of the Workspace
   DO's class (so the same Container application and image), starts a Container from the Workspace image with its
   entrypoint replaced (`sleep infinity`, so computerd never writes a store into it), lays down the Global mise config,
   runs the Image setup, and calls `snapshotContainer()`. A start from a snapshot runs the image's own entrypoint
   whatever the source ran, and the snapshot holds only the changes over the image (34.5 MB for one apt package).
2. **A Base snapshot is accepted when the Image setup exits 0 and a Container starts from it.** Nothing else is
   checked: what the script does to the disk is the Owner's.
3. **t3flare keys a Base snapshot to what made it,** since the platform does not: an old snapshot starts, silently, on
   the old image after the image changes. The key is the Workspace image's digest
   (`ctx.container.images.WorkspaceContainer`, stable across a deploy that leaves the image alone), the Image setup,
   the Global mise config, and the Variables (secret values by a keyed digest). The Container size is not in it: every
   size starts from any snapshot, a smaller disk included. A Base snapshot older than 29 days counts as gone (the
   platform's TTL is 30 days from creation or last restore). (Superseded by the SPI-1359 refinement: the 29 days now
   count from the later of its creation and its last restore.)
4. **The Builder holds the record** (the current key, its state and output, the last good Base snapshot and its key);
   the agents Worker is the only one that knows the image digest. A Workspace DO asks it at a fresh start, and the
   Environment DO gets reports for the Settings page.
5. **A Base build starts** when the Image setup, the Global mise config or the Variables change, when the Environment
   boots (a deploy), when a start finds no Base snapshot for its key, when one fails to start, on the Owner's Rebuild or
   an agent's, and every N days when the Owner sets a scheduled rebuild. An edit mid-build cancels it and builds the
   new key.
6. **While a Base build runs,** a new Container starts as the Owner sets: from the last good Base snapshot when it was
   made on the current Workspace image (the default), or by waiting for the build, or from the Workspace image. When
   the last good one was made on an older image, it waits (the default) or starts from the Workspace image. A start
   whose snapshot the platform refuses (missing or expired) is seen in the platform's `monitor()` within a second,
   not after computer's two 60 s connects, and starts from the Workspace image; the Builder rebuilds. A running
   Container keeps what it started from (ADR-0032 §5).
7. **The Container setup** runs once per new Container (per runtime id), after the Global mise lay-down, on that
   lay-down's model: held, bounded, retried on an exec failure, reported. Every command, Terminal and CLI process waits
   for it; a passive read never runs it. On failure the Container carries on, or refuses commands, as the Owner sets.
   The Worker Shell has no Container, so neither script reaches it.
8. **A Test base build** runs a proposed Image setup in a second reserved Builder, so an agent or the Owner sees its
   result before saving; its snapshot is never used.
9. **Everything tunable is a setting** (AGENTS.md), with these defaults: the Image setup's time limit (30 minutes), the
   Container setup's (5 minutes) and the snapshot's (5 minutes); what a start does while building (§6); what the
   Container setup's failure does (carry on); the Builder's size (the Container size) and whether it counts against the
   Container budget (no); a scheduled rebuild (off); and whether Terminals read `~/.bashrc` and CLI agents read the
   dotfiles' own agent config, `~/.claude.json` included (both on; t3flare's model routing and managed settings stay on
   top). Fixed only by constraint: 256 KiB per script (every Environment setting is one stored value of at most 8 MB;
   superseded by the SPI-1365 refinement below)
   and the rebuild after an image change. The three time limits' maximums (60, 120 and 15 minutes) were no
   constraint: since
   [ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)
   each takes the shared 10,080-minute maximum for limits t3flare times itself. (SPI-1359, 2026-11-23: a SQLite-backed
   DO row or value holds 8 MB; the earlier 2 MB was stale.)
10. **With no Global mise config, mise's global config is the dotfiles' own** (`~/.config/mise/config.toml`), not
    t3flare's empty file, so a dotfiles manager such as chezmoi declares the Owner's tools. The lay-down's check still
    runs on it: under a file that breaks git or gh, t3flare points mise back at its own file and the Settings page says
    why. A Global mise config with text wins, as before (refines ADR-0032's Global mise config §2). The dotfiles' file
    is checked at the Container's lay-down and, when the Container setup wrote or changed it, once more after the
    setup, then used through a link: a later write to it reaches mise unchecked, and is checked only at the next
    Container start.

## Considered options

- **The Image setup baked into the Workspace image by Docker at a deploy.** No beta, no expiry, and a CLI bump
  rebuilds it free; but every change needs a redeploy, and neither the Settings page nor an agent could make one.
- **A Workspace's own Container snapshotted as the base.** Its disk holds that Project's files in computerd's store
  and its CLI homes, which would reach every other Workspace.
- **Directory snapshots** over a fresh image, which would keep t3flare's binaries current: flag-gated, not in the
  stable API, and they lose what an apt install writes under `/usr`.
- **Health checks before accepting a Base snapshot** (t3flare's files unchanged, git's credential helper still first).
  Rejected by the Owner: validation keeps t3flare working, it never protects the Owner from their script.
- **Per-Workspace snapshots at idle stop**, so Container-only paths survive a stop: a separate feature, SPI-1325.
- **`claude` in a Terminal**: Claude Code reaches a model only as the agent t3 starts, which holds a Handle; a
  Terminal's would need the Model relay to issue one. A separate feature.

## Consequences

- Snapshots cannot be listed or deleted. Each rebuild, each Test base build and a destroyed Stage leave theirs to
  expire 30 days after last use. Free during the beta; the price after it is unannounced.
- The fast fallback and the snapshot passthrough lean on computer's start (`containerSnapshot` in `#launchAs`, and
  `sameLaunch`, which ignores the snapshot): the code that adds them adds an entry to `docs/upstream-fragility.md`,
  and the snapshots' cost goes in `docs/cost.md`.
- A Base snapshot holds the CLIs at their pins, in the Owner's own account, never published (ADR-0040).
- Whatever the Image setup writes, a secret Variable included, is in every Workspace's Container until the next Base
  build.

## Refinement (SPI-1332, 2026-11-22): the Builder as built

1. **Nothing to build:** with no Image setup and no Global mise config, the Builder builds nothing and records `none`;
   a snapshot of the image alone would only cost a build per deploy.
2. **Time limits:** the Image setup's time limit counts from the Builder's Container's first start (a wait for room under
   the Container budget, or for a canceled build's snapshot, is not in it) and covers that start; the start that proves
   the snapshot (§2) counts in the snapshot's. A step that keeps throwing fails at its limit.
3. **No automatic rerun of a failing script:** a key whose last build failed in the Image setup (a non-zero exit) is not
   built again by a boot or a Workspace's report; a change of key, Rebuild, or `rebuild_base` builds it. A failure that
   was not the script's (a lost Container, a snapshot, a refused proof) is retried by any trigger, and so is a key whose
   Base snapshot once worked and is gone (expired, or refused at a start): its script ran before.
4. **A Rebuild while a build of the same key runs** leaves that build going, and while a late snapshot of the current
   key is still being taken, no trigger starts another build: the late result is proved. The scheduled rebuild fires
   this many days after the last good Base snapshot, and at the latest a day before it counts as gone; every failing
   rebuild of one key, whatever its trigger (the schedule included), waits an hour, then twice as long each time (at
   most a day), before the next; a change of key and a Rebuild run at once. (Superseded by the SPI-1359 refinement: the
   margin before expiry is derived, not a day, and the first wait is the `baseRetryMinutes` setting.) The schedule is
   armed again from the last good one after every build. A failed rebuild leaves the last good Base snapshot in use
   (still for the same key), shown as ready with the failure beside it. Any Builder setting saved alone pokes the
   Builder, so it reads and arms it again.
5. **The poke carries only its reason:** the Builder reads the Environment settings itself, through the read a Container
   start takes (secret Variables opened), which Status does not count as a Workspace's.
6. **The key's Variables** are those that reach a command (`variableEnv`), in any order. The 29 days count from the
   snapshot's creation: the Builder does not see a Workspace's restore. (Superseded by the SPI-1359 refinement: a
   Workspace's start reports its restore, and the 29 days count from the later of the two.)
7. **One output setting, one blanking:** a failed Base build keeps the last `setupOutputKiB` of its output, the Container
   setup's setting (SPI-1330), read and blanked as a Container setup's report is (`blankSecrets`, with its margin and
   mark). The Builder's settings join the Image setup's row on the Settings page.

## Refinement (SPI-1334, 2026-11-22): the Test base build as built

1. **The same machine, a `test` flag:** the test Builder (`BUILDERS.test`) is its own object, storage and Container, so a
   test never cancels, waits on or changes a real build. It runs the proposed Image setup, kept in its storage, with
   the saved Global mise config, Variables (secret ones opened), limits, Builder size and budget setting, read as a
   Base build reads them; same steps, time limits, blanking, proof and late-snapshot rule.
2. **Its result is the test's alone:** a proved snapshot is the test's record (`test: true`, its size and time), never
   the Base snapshot, and the Environment DO keeps that record apart, refusing either kind as the other. It is kept
   until the next test. A test has no schedule, no backoff and no pokes: a new test, of any text, runs at once and
   cancels one under way. An empty proposal with no Global mise config has nothing to build, as a Base build has not.
3. **Where it runs from:** the Settings page's Test, beside the Image setup's text area, tests the text in the box,
   unsaved; the page follows it by reading the last test, with no reload (which would lose the text). A test's record
   carries the SHA-256 of the text it ran, so the page marks a result stale once the box holds another text. The Settings
   server's `test_base_build` takes the whole proposed text, free and with no revision, as `rebuild_base` is; plan mode
   refuses it as it refuses every write. `get_status` shows the result as `testBaseBuild`.

## Refinement (SPI-1333, 2026-11-22): the start as built

1. **The Builder's key, trusted once it read the start's settings:** a Workspace cannot compute the key (a secret
   Variable enters it under the Builder's own HMAC key), so the record carries the Environment settings' revision the
   Builder last read. A start whose settings are newer first asks the Builder to read them (a `missing` report, which
   also builds a key with no Base snapshot), then picks from its answer. A Base snapshot is started only when it was made
   on this Workspace image's digest.
2. **While a build runs,** each setting holds, a rebuild of the current key's included (a Rebuild, a scheduled rebuild):
   the last good one starts its good Base snapshot, Wait waits for the build, the Workspace image starts at once. The
   second setting applies when the first starts from the last good one and none was made on the current Workspace image
   (an older image, or none at all).
3. **A failed build of the current key** starts from the Workspace image, not the last good one of older settings; the
   start reports `missing`, and the Builder's backoff decides whether to build (Refinement SPI-1332 §3, §4).
4. **A wait** is bounded by the build's own limits, the Image setup's then the snapshot's twice (the snapshot and its
   proof). A start that reaches the gated start still waiting (the wait gave up, or a start with no connect) starts
   from the Workspace image. The Builder not answering within 5 seconds starts from the image.
5. **The fast fallback** watches `monitor()` for one second after a start from a Base snapshot (the platform refuses in
   about 0.3 s), then goes once more from the Workspace image; a refusal after that second is still reported, so the
   Builder marks the snapshot gone and the next start does not pick it. A running Container that computer adopts is not
   watched, and keeps what it started from.
6. **A new Container while one runs:** computer's restart (computerd unhealthy) and a start that cannot adopt the
   running Container (its launch spec differs after a deploy, or it exited) make a new Container. Such a start picks its
   base as a fresh one does, against the Builder's current key, without asking the Builder anything, and records it; it
   keeps the running Container's launch otherwise (its size, its Variables). So a relaunch after an Image setup change
   starts from the new Base snapshot with the old launch's Variables, until the next fresh start. One computer adopts
   keeps what it started from.
7. **A deploy's new image reaches each object in its own time** (about 4 minutes on a Stage): the record carries the
   image the Builder read, and a start on another one asks it to read again and is treated as a start during a build
   on a new image (the second setting) only while the Builder builds; otherwise it starts from the Workspace image it
   runs, since which of the two images is newer cannot be told. A record still behind the start's settings after it asked
   counts as a build under way, never as ready for them. After every trigger, the Builder reads the image on its alarm for 10 minutes and
   builds when it moves, so a boot poke that still read the old image does not leave the new one unbuilt.
8. **A `missing` report answers once the Builder read the settings and began a build,** before the build's first step;
   a start whose report gets no answer within 5 seconds reads the record again (it is not serialised behind the alarm).
   The fast fallback's 60 s (§6 says two connects) is computer's one connect deadline, which its attempts share.

## Refinement ([ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md), 2026-11-22): the time limits' maximums

§9's Container setup, Image setup and snapshot time limits keep their defaults (5, 30 and 5 minutes) and take
`MAX_TIMED_MINUTES`, 10,080 minutes, as their maximum. A week keeps a Workspace's longest wait for a Base build
(`waitLimitMs`: the Image setup's limit plus twice the snapshot's) at three weeks, under a JS timer's 24.8-day overflow.

## Refinement (SPI-1359, 2026-11-23): the restore, the margin and the retry

This supersedes §3's 29 days counted from creation, and the SPI-1332 refinement's §4 (the day's margin and the fixed
hour's retry) and §6 (the Builder does not see a restore).

- **The 29 days count from the last restore.** A Workspace DO whose fresh start from the Base snapshot was not refused
  reports `restored` to the Builder, which keeps the time (`restoredAt`) beside the snapshot. It counts as gone 29 days
  after the later of its creation and its last restore, as the platform's 30 days run. A refusal at a later start still
  marks it gone at once. The scheduled rebuild still counts its days from the snapshot's creation.
- **The scheduled rebuild's margin is derived, not a day.** It fires at the latest `expiryMarginMs` before the snapshot
  counts as gone: two builds at the settings' time limits (`waitLimitMs`) and the first retry's wait, so a rebuild that
  fails at its full limit and its retry both end before the snapshot counts as gone. At the defaults that is 2 hours 20
  minutes. The margin is clamped so the expiry never makes a rebuild due sooner than one build after the last good one:
  otherwise time limits and a retry that long would leave the next build due as soon as one ends, back-to-back billed
  builds. The Owner's own "Rebuild every" interval is not clamped. `rebuildEveryDays`' description states the
  consequence: with such settings rebuilds follow one another, and a failed one can outlast the snapshot. ADR-0048's
  consequence of a slow build outlasting the last good Base snapshot holds there.
- **The retry is a setting**, `baseRetryMinutes` (superseded by the SPI-1387 refinement: a fixed 60 minutes) (60 by default, 1 to `MAX_TIMED_MINUTES`, tier `up-free`, in the
  Image setup's row): a failing key's first retry, doubling, at most a day or the setting itself when that is longer.
  Some backoff is needed: without it a failing key's next trigger would build at once, a loop of Builder Containers.

## Refinement (SPI-1365, 2026-11-23): the setups' size

The 256 KiB per script is superseded: it was not derived from the 8 MB value it cited. Each setup is at most
`MAX_FILE_SETTING_BYTES` (a third of one Durable Object value), and the Environment settings together are checked
against the value whole ([ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)'s
SPI-1365 refinement). The Settings server's body limit follows, so a setup at its maximum can be sent, and a Test base
build's proposal takes the same bound.

## Refinement (SPI-1387, 2026-11-24): the Builder's size, the retry and the output kept are fixed

Supersedes §9's Builder size and the SPI-1359 refinement's retry setting. The Builder's Container runs at the Container
size (custom included): the Builder size, which defaulted to it, is removed, and a stored one is ignored. The Base build
retry is `BASE_RETRY_MINUTES` (60), doubling to a day, and a retry still comes at every start that finds no Base
snapshot. The output a report keeps is `SETUP_OUTPUT_KIB` (32 KiB); a report kept larger before reads as it was.
