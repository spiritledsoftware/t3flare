# Every Container starts from a Base snapshot the Builder makes from the Image setup, and runs the Container setup

Status: accepted (Owner decisions, 2026-11-22). Refines
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) (new
Environment settings, read at a Container start) and
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md) (new Settings server tools). Leans on
Cloudflare's Container snapshots, a public beta. Evidence: the snapshot spike of 2026-11-22 on the throwaway Stage
`snapspike1` (destroyed); prior art: cloudpid's Builds (`~/src/cloudpid/apps/server/src/workspace/launch.ts`,
`registry/builds.ts`, `workspace/snapshots.ts`).

The Owner wants their Workspaces' Containers to carry what their agents need, such as their dotfiles, without a
redeploy: an **Image setup** run once to make what every Container starts from, and a **Container setup** run at every
new Container's start. Both are Environment settings, bash scripts of up to 256 KiB each, run as root with
`HOME=/root`, `COMMAND_ENV` and every Variable, secret ones included
([ADR-0046](0046-a-variable-may-be-secret-as-stock-t3s-environment-variables-are.md)).

1. **The Base snapshot is a platform Container snapshot.** The **Builder**, one reserved-name instance of the Workspace
   DO's class (so the same Container application and image), starts a Container from the Workspace image with its
   entrypoint replaced (`sleep infinity`, so computerd never writes a store into it), lays down the Global mise config,
   runs the Image setup, and calls `snapshotContainer()`. A start from a snapshot runs the image's own entrypoint
   whatever the source ran (spike S3), and the snapshot holds only the changes over the image (S5).
2. **A Base snapshot is accepted when the Image setup exits 0 and a Container starts from it.** Nothing else is
   checked: what the script does to the disk is the Owner's.
3. **t3flare keys a Base snapshot to what made it,** since the platform does not: an old snapshot starts, silently, on
   the old image after the image changes (S8). The key is the Workspace image's digest
   (`ctx.container.images.WorkspaceContainer`, stable across a deploy that leaves the image alone, S7), the Image setup,
   the Global mise config, and the Variables (secret values by a keyed digest). The Container size is not in it: every
   size starts from any snapshot (S6). A Base snapshot older than 29 days counts as gone (the platform's TTL is 30 days
   from creation or last restore).
4. **The Builder holds the record** (the current key, its state and output, the last good Base snapshot and its key);
   the agents Worker is the only one that knows the image digest. A Workspace DO asks it at a fresh start, and the
   Environment DO gets reports for the Settings page.
5. **A Base build starts** when the Image setup, the Global mise config or the Variables change, when the Environment
   boots (a deploy), when a start finds no Base snapshot for its key, when one fails to start, on the Owner's Rebuild or
   an agent's, and every N days when the Owner sets a scheduled rebuild. An edit mid-build cancels it and builds the
   new key.
6. **While a Base build runs,** a new Container starts from the last good Base snapshot when it was made on the current
   Workspace image; otherwise it waits for the build or starts from the Workspace image, as the Owner sets. A start
   whose snapshot the platform refuses (missing or expired) is seen in the platform's `monitor()` within a second (S8),
   not after computer's two 60 s connects, and starts from the Workspace image; the Builder rebuilds. A running
   Container keeps what it started from (ADR-0032 §5).
7. **The Container setup** runs once per new Container (per runtime id), after the Global mise lay-down, on that
   lay-down's model: held, bounded, retried on an exec failure, reported. Every command, Terminal and CLI process waits
   for it; a passive read never runs it. On failure the Container carries on, or refuses commands, as the Owner sets.
   The Worker Shell has no Container, so neither script reaches it.
8. **A Test base build** runs a proposed Image setup in a second reserved Builder, so an agent or the Owner sees its
   result before saving; its snapshot is never used.
9. **Everything tunable is a setting** (AGENTS.md): the two time limits (30 and 5 minutes), the snapshot's (5
   minutes), what a start does while building, what the Container setup's failure does, the Builder's size and whether
   it counts against the Container budget (off), a scheduled rebuild (off), and whether Terminals read `~/.bashrc` and
   CLI agents read the dotfiles' own agent config (both on; t3flare's model routing and managed settings stay on top;
   Claude Code's includes `~/.claude.json`). Fixed only by
   constraint: 256 KiB per script (every Environment setting is one stored value of at most 2 MB) and the rebuild after
   an image change.

10. **With no Global mise config, mise's global config is the dotfiles' own** (`~/.config/mise/config.toml`), not
    t3flare's empty file, so a dotfiles manager such as chezmoi declares the Owner's tools. The lay-down's check still
    runs on it: under a file that breaks git or gh, t3flare points mise back at its own file and the Settings page says
    why. A Global mise config with text wins, as before (refines ADR-0032's Global mise config §2).

## Considered options

- **The Image setup baked into the Workspace image by Docker at a deploy.** No beta, no expiry, and a CLI bump
  rebuilds it free; but every change needs a redeploy, and neither the Settings page nor an agent could make one.
- **A Workspace's own Container snapshotted as the base.** Its disk holds that Project's files in computerd's store
  and its CLI homes, which would reach every other Workspace.
- **Directory snapshots** over a fresh image, which would keep t3flare's binaries current: flag-gated, not in the
  stable API, and they lose what an apt install writes under `/usr`.
- **Health checks before accepting a Base snapshot** (t3flare's files unchanged, git's credential helper still first).
  Rejected by the Owner: validation keeps t3flare working, it never protects the Owner from their script.
- **Per-Workspace snapshots at idle stop** (cloudpid's): a separate feature, SPI-1325.
- **`claude` in a Terminal**: Claude Code reaches a model only as the agent t3 starts, which holds a Handle; a
  Terminal's would need the Model relay to issue one. A separate feature.

## Consequences

- Snapshots cannot be listed or deleted. Each rebuild, each Test base build and a destroyed Stage leave theirs to
  expire 30 days after last use. Free during the beta; the price after it is unannounced (`docs/cost.md`).
- The fast fallback and the snapshot passthrough lean on computer's start (`containerSnapshot` in `#launchAs`, and
  `sameLaunch`, which ignores the snapshot): an entry in `docs/upstream-fragility.md`.
- A Base snapshot holds the CLIs at their pins, in the Owner's own account, never published (ADR-0040).
- Whatever the Image setup writes, a secret Variable included, is in every Workspace's Container until the next Base
  build.
