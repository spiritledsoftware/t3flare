# The Owner is trusted with their own settings, and a maximum is a named constraint or a sanity bound

Status: accepted (SPI-1319, Owner decisions, 2026-11-22). Refines
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) §6 and §7,
[ADR-0047](0047-every-container-starts-from-a-base-snapshot-the-builder-makes-from-the-image-setup.md) §9 (the three
setup time limits' maximums) and
[ADR-0010](0010-the-endpoint-is-public-behind-t3s-own-auth.md) (the Pairing window's "60 at most").

AGENTS.md has two rules about settings. Whatever an Owner could tune is a setting with a sensible default, fixed only
where Cloudflare or t3flare's own correctness forces it. And the Owner is trusted with their own settings: validation
keeps t3flare working and never protects the Owner from a choice they made. Three limits broke the second rule. The
Container budget stopped at 10, which its own comment called "a cost guard, far under the account's concurrent limits".
The idle time stopped at 60 minutes, so an Owner could not keep a Container warm overnight. The Pairing window was
clamped to 1 to 60 minutes without saying so. The setup time limits added later (ADR-0047 §9) carried maximums that no
constraint set: 60, 120 and 15 minutes.

1. **A maximum is a named constraint or a sanity bound.** A named constraint is a limit Cloudflare or t3flare's own
   correctness sets, and the code names it in a comment where the value is set: the setup output's 256 KiB (a Durable
   Object value holds at most 8 MB) and the rebuild interval's 29 days (a snapshot expires after 30) stay. (SPI-1359, 2026-11-23: a SQLite-backed DO row or value holds 8 MB; the earlier 2 MB was stale.) Anything
   else is a sanity bound: a number far beyond any real choice, kept because an integer setting's schema needs a
   maximum, with a comment saying nothing forces it.
2. **One sanity maximum for timed limits: 10,080 minutes (a week).** `MAX_TIMED_MINUTES` in
   `@t3flare/harness-registry` is the maximum of every limit t3flare times itself with its own alarm or timer. A week,
   because the longest single wait t3flare times, a Workspace's wait for a Base build (`waitLimitMs` =
   imageSetupMinutes + 2 × snapshotMinutes, `apps/agents/src/workspace/baseStart.ts`), stays at three weeks, under the
   24.8 days past which a JS timer overflows and fires at once. A value handed to a platform API instead takes that
   API's maximum, named in a comment where it is set. Later settings (SPI-1313, SPI-1315, SPI-1318) take the same
   maximum.
3. **The idle time** is 1 to 10,080 minutes, default 2. t3flare's own alarm does the idle stop (the Workspace DO's
   `#scheduleAlarm`); the platform's `setInactivityTimeout`, which takes at most 6 hours, is never set. Its tier
   becomes `down-free`: lowering it is free, raising it spends and is asked. Its description says a Container's memory and
   disk are billed while it waits idle.
4. **The Container budget** is 1 to 100, default 3, tier `down-free`. Nothing in t3flare forces 100: `max_instances`
   does not apply under `schedulingPolicy: "durable_object"`, and 100 of the largest size (standard-4: 4 vCPU, 12 GiB,
   20 GB) is 400 vCPU, 1.2 TiB and 2 TB, under the account's default concurrent limits (60 TiB of memory, 15,000 vCPU
   and 300 TB of disk when this was written). Those limits bound it in practice; t3flare does not read or check them.
   The Settings page states the consequence once, in a note under the budget field: "Each running Container is billed
   for its size; at this budget, up to N can run at once. Your Cloudflare account's own Container limits (concurrent
   memory, vCPU and disk) also apply; t3flare does not check them."
5. **The setup time limits** (`containerSetupMinutes`, `imageSetupMinutes`, `snapshotMinutes`) keep their defaults (5,
   30 and 5) and take the shared maximum.
6. **Where a consequence is stated.** Once, where the Owner sets the value: in the setting's own description when it
   does not change with the value (the idle time's), or in a note under the field when it does (the budget's, whose
   count the page rewrites as the input changes). A per-call value states it in the call's answer (the Pairing
   window's, §7).
7. **The Pairing window** stays a per-call argument of `POST /_t3flare/arm-bootstrap`, 15 minutes by default, opened
   for as long as asked. A `minutes` that is not a positive number is refused with 400 instead of being swapped for the
   default or clamped, as is one whose close a Date cannot hold (the stored close is a Date). The route's answer
   states the consequence once: "While the window is open, anyone holding the bootstrap token can pair a client." The
   window is closed by the Environment DO's alarm, not a JS timer, so no timer bound applies.

## Considered options

- **Keeping the cost guards** with a page note explaining them. Rejected: a guard against the Owner's own spending is
  the protection AGENTS.md rules out; the page states the cost instead.
- **No maximum at all.** Rejected: the settings' integer schema needs a maximum, and an unbounded timed limit could
  overflow a JS timer and fire at once, which breaks t3flare rather than protecting the Owner.
- **The Pairing window as an Environment setting** (`pairingWindowMinutes`). Rejected for now: it is opened per call
  by an admin, so the length belongs with the call.

## Consequences

- An Owner can run up to 100 Containers at once, keep one warm for a week, and leave pairing open as long as they ask;
  each costs what the page or the route says.
- A Base build may now run for days (the Image setup's and the snapshot's limits each up to a week). With
  `rebuildEveryDays` at most 29, a scheduled rebuild lands within a day of the 30-day expiry, so a slow build can
  outlast the last good Base snapshot. Starts then do what the second while-building setting says with no last good
  Base snapshot (ADR-0047 §6): by default they wait up to the time limits and then start from the Workspace image,
  which they use until the build ends. That is the Owner's choice of limits.
- Raising the idle time now goes through the Settings server's asking, as raising the budget already did.
- A new tunable limit takes its maximum from this ADR: a named constraint with its comment, the shared timed maximum,
  or a stated sanity bound.
