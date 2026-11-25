# Cost

What t3flare costs on Cloudflare, what to look at to know, and when to act. From the cost audit of 2026-11-11, priced
against Cloudflare's pricing pages that day.

## Cost model

At light use the bill is mostly the **$5 Workers Paid minimum**; past it, Container memory leads. The Containers row is
priced at the default size, `standard-3` (2 vCPU, 8 GiB, 16 GB; SPI-1386), with the audit's CPU share kept; at the
audit's `cpu-1` (3 GiB, 12 GB) it was ≈ $0.20, $1.95 and $16.60, and the totals ≈ $5.20, $7.10 and $35. Each total is
the $5 minimum plus the rows below it.

|                                | Light        | Moderate      | Heavy                 |
| ------------------------------ | ------------ | ------------- | --------------------- |
| Client connected               | 3 h/day      | 10 h/day      | 24/7                  |
| Turns                          | 5/day        | 30/day        | 100/day               |
| Container-hours a month        | 15           | 60            | 360                   |
| Containers (memory, disk, CPU) | ≈ $0.87      | ≈ $4.70       | ≈ $33.15              |
| DO duration                    | 65k GB-s, $0 | 207k GB-s, $0 | 617k GB-s, **$12.50** |
| DO requests                    | $0           | ≈ $0.15       | ≈ $1.05               |
| **Total a month**              | **≈ $5.87**  | **≈ $9.85**   | **≈ $51.70**          |

What moves the total:

- **Container-hours.** About $0.076 each in memory and disk at the default `standard-3` (8 GiB, 16 GB), plus active
  CPU, past the plan's included 25 GiB-hours of memory (about 3 h at this size); `cpu-1` (3 GiB) is about $0.030.
  Every running Container also keeps its Workspace DO resident: 450 GB-s of DO duration per Container-hour.
- **The DO duration cliff.** 400k GB-s a month are included; anything over rounds up to the next 1M GB-s, $12.50. An
  Environment connected 24/7 is 324k GB-s on its own, and Workspace DOs (Container-hours) and Session DOs (turns) share
  the same allowance.
- **DO rows written** ($1.00 per million past 50 M). Not yet measured: see the checklist.

## Owner's dashboard checklist

1. **Billing → Billable Usage** (current and last period): DO duration (GB-s), DO requests, DO rows read and written, DO
   stored data, Containers (vCPU-s, GiB-s, GB-s), Workers requests and CPU, Dynamic Workers created, Workers Logs.
   This shows where the account sits against each allowance, and how far it is from the 400k GB-s cliff.
2. **Workers & Pages → Durable Objects**, for each namespace (`EnvironmentDO`, `SessionDO`, `WorkspaceDO`,
   `ContainerBudget`, on each deployed stage's scripts): the Requests, Duration, Rows written and Stored data graphs.
   The question is whether `EnvironmentDO` or `SessionDO` rows written come anywhere near 50 M a month.
3. **Containers → WorkspaceContainer** (prod and bump): instance count over time, and memory and CPU use. A Container
   that stays up for hours on deploy days is a terminal hold at work.
4. **Observability → Billable Usage** from 2026-12-01, when Workers Logs is billed per GB: GB ingested against the 50 GB
   included. If it ever comes near, set a head sampling rate on the agents Worker's invocation logs first; per-push RPCs
   dominate its event count.
5. Optionally, the GraphQL Analytics API with an account-scoped read token: `durableObjectsPeriodicGroups` (activeTime,
   rowsRead, rowsWritten by namespace), `durableObjectsStorageGroups` (storedBytes), and
   `workersInvocationsByOwnerAndScriptGroups.uniq.distinctDynamicWorkerCount`.

## What t3flare measures itself

- **`container-idle-stop`** (agents Worker logs): `memoryPeakBytes` and `cpuUsageUsec` from the Container's cgroup, and
  `ranMs` since its start, at every idle stop; and `terminalHold` and `agentTerminalHold`, the hold t3's and the agent's
  open Terminals got (`busy` or `prompt`, and its `minutes`), or null with none open (SPI-1431).
- **`GET /_t3flare/health` → `sql`**: `rowsWritten` and `rowsRead` of t3's statements through the SQL adapter since
  `isolate.startedAt`, and the Environment's `databaseSize`. Divide by the isolate's age for a rate.
- **`GET /_t3flare/agents/workspaces` → `terminals.pushes`**: terminal output batches each Workspace DO pushed since it
  started.

- **`process-started`, `process-exited`, `container-stop-cli`** (agents Worker logs, step 4a): CLI
  agent processes (the key helper's `model-key` grants went at the hard cut, SPI-1176). A CLI process holds its Container while its thread is in a turn and
  for 11 minutes after (t3 releases the session at 10, Patch 0003), so an idle CLI session costs at most about
  11 Container-minutes beyond its last turn (about $0.006). The Environment's own idle reset (60 s without a client)
  ends idle CLI processes earlier, at the Workspace's 90 s lapse; a full budget reclaims Containers whose CLI sessions
  sit idle.
- **Step 4b: the image and the CLIs' weight.** Claude Code and OpenCode add about 0.3 GB to the Workspace image
  (1.05 GB against 751 MB, `steps-evidence-1:docs/steps/step-4b/m1-image.json`), registry storage and a slower first pull, not a running
  cost. A cold Claude Code session answered its first prompt 18 s after its Container was stopped. Claude Code (its
  Node adapter and `claude`) peaked at 344 MiB and OpenCode (`opencode acp` and its `serve` child) at 439 MiB in a turn
  running `npm ci && npm test`, about twice an idle Codex app-server. Each process counts once against a Workspace's
  CLI agents' processes, derived from the Container size's memory: one per 440 MiB past 1 GiB, 4 on `cpu-1` and 16 on
  `standard-3` (`cliProcessesPerWorkspace`; SPI-1364, SPI-1387). An
  `acp-request` log line (Environment Worker) records each session's `initialize`, `session/new` and `session/load`.

## Base snapshots (SPI-1332, ADR-0047)

- **Each Base build is a Container while it runs.** The Builder starts one at the Builder size (the Container size by
  default) for the Image setup, the Container snapshot and the start that proves it, then destroys it: priced as any Container
  for those minutes. It runs beside the Container budget unless the Owner sets it to count against it. A build starts
  on a change to the Image setup, the Global mise config or the Variables, at each deploy whose image or settings
  changed the key, on a Rebuild, and on the scheduled rebuild when the Owner sets one; with no Image setup and no
  Global mise config there is nothing to build.
- **A Test base build (SPI-1334) costs what a Base build does:** a Container in the test Builder, at the Builder size and
  under the same budget setting, for its minutes; each Test, the Owner's or `test_base_build`'s, starts one, and a new
  test ends the one under way. Its snapshot cannot be deleted (there is no API) and no Container ever starts from it,
  so it expires 30 days after its creation.
- **Container snapshots cannot be listed or deleted.** Each Base build and a destroyed Stage leave theirs to expire 30
  days after their creation or last restore. A Container snapshot holds only the changes over the
  image (34.5 MB for one apt package on the spike, 33.5 MB on a Stage).
- **Price.** Container snapshots are a public beta: free during it, the price after it unannounced. When Cloudflare
  prices them, count a Container snapshot per Base build for 30 days.
- **`base-build`, `base-build-ready`, `base-build-failed`** (agents Worker logs): each phase of a build, its size and time
  taken (`tookMs`) when ready; a Test base build's lines carry `test: true`.
- **A Workspace's start from the Base snapshot costs what a start from the image costs** (SPI-1333): the same Container,
  started about as fast. A start set to wait for a Base build holds no Container while it waits. Each start from a Base
  snapshot is a restore, which the platform counts toward its 30 days. `container-launch` (agents Worker logs) names what
  each Container started from (`from`); `container-base-wait` each wait, `container-base-refused` each refused snapshot,
  `container-base-replanned` each new Container computer made while one ran, and `base-build-image-moved` each new
  image the Builder's watch saw. The watch is one alarm every 30 seconds for 10 minutes after a trigger, on the
  Builder's Durable Object alone.

## When to act

- **Right-size the Container below the default `standard-3`'s 8 GiB (audit F3, which proposed 3 GiB to 2 GiB)**: to a
  2 GiB custom size once at least ~20 idle stops are logged and the p95 of
  `memoryPeakBytes` is under 1.4 GiB, counting CLI-agent turns (an idle Codex app-server is about 160 MB; up to
  `cliProcessesPerWorkspace`, derived from the size: 16 on `standard-3`, CLI processes per Workspace). From `standard-3`, that saves about $3.24 a month at
  moderate use and $19.44 at heavy (6 GiB less, $0.009 a GiB-hour). The `durable_object`
  scheduling policy allows any size above 1/16 vCPU, 256 MiB and 2 GB.
- **Hibernatable client sockets for the Environment DO (audit F5, ADR-0002)** when a month's DO duration goes over
  400k GB-s (start the plan at about 350k). Saves $12.50 a month, at heavy use only; effort L.
- **Rows written** projecting above 40 M a month: look at the per-namespace split before tuning further.
- **Terminal holds**: if idle stops still show long `ranMs` on days with terminal panels open (more than about 30% of
  Container-hours), spike not starting a re-attached terminal's Container until the first keystroke (ADR-0021).
