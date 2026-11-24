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
   Object value holds at most 8 MB; superseded as an example: 256 KiB is not derived from 8 MB, see the SPI-1365
   refinement below) and the rebuild interval's 29 days (a snapshot expires after 30) stay. (SPI-1359,
   2026-11-23: a SQLite-backed DO row or value holds 8 MB; the earlier 2 MB was stale.) Anything else is a sanity bound:
   a number far beyond any real choice, kept because an integer setting's schema needs a maximum, with a comment saying
   nothing forces it.
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
  overflow a JS timer and fire at once, which breaks t3flare rather than protecting the Owner. (Refined by the SPI-1368
  refinement below: a setting nothing breaks past at any value takes the largest safe integer as its maximum.)
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

## Refinement (SPI-1365, 2026-11-23): a value's size is bounded where it is stored, not field by field

§1's first example does not hold as written: the setup output's 256 KiB is a number under the 8 MB a Durable Object
value holds, not one derived from it, as the setups' own 256 KiB was. Where several things share one stored value, the
named constraint is that value as a whole: the Environment settings, the Harness settings, the Model endpoints, the
audit log and t3's tool listing are each checked once against `DO_VALUE_BYTES` (`storedValueProblem` in
`packages/harness-registry/src/storedValue.ts`), and an Open change's record against its one SQLite row
(`CHANGE_RECORD_BYTES`). A per-field size, where one is kept, is derived from that value (the file settings take a
third of it) or from another named constraint (a Variable's 128 KiB is Linux's `MAX_ARG_STRLEN`). Counts that only
stood in for a size (Variables, endpoints, models, headers, t3 tools, Environment skills) are removed. The setup
output's 256 KiB itself is unchanged here; it is SPI-1360's (superseded by the SPI-1360 refinement below: derived from
the value).

## Refinement (SPI-1360, 2026-11-23): error, log and reason text is not cut

About sixty places cut an error, a log line, a refusal's reason or a list shown to the Owner or an agent, to between 20
and 4,000 characters (`String(error).slice(0, 300)`, `BASE_BUILD_CAPS`, `MAX_SIGN_IN_ERROR_LENGTH`, the MCP log data's
2 KiB, a Codex failure's last 1,500 characters of stderr). None was forced. They are removed: such text is kept whole.

Where the text goes into something whose size is really bounded, it is cut at that bound, named where the cut is:

- **A stored value:** the Builder's build under way is one Durable Object value (`DO_VALUE_BYTES`), so its reason, its
  last error and its failure's message are each cut at `BASE_BUILD_TEXT_CHARACTERS`: what the most output and the
  secret Variables' values leave of the value, split between the three (`packages/harness-registry/src/baseBuild.ts`).
  The record it reports carries two of them. A credential leak's flag keeps the hit paths that fit its one value and
  counts the rest, and is written after the processes are signalled, so a write that failed never leaves them running.
  A failed MCP listing's error is cut to what its inventory's value has left beside the last good tools.
- **A protocol frame:** a carried WebSocket's close reason is cut at the 123 bytes of UTF-8 a close frame holds (RFC 6455
  §5.5), on a character.
- **A Workers Logs line:** Cloudflare cuts a log past 256 KB itself, so a log line's text is not cut first. The one
  buffer kept for a log line, a CLI process's rolling stderr (`STDERR_TAIL`), is bounded at that 256 KB.
- **An isolate's memory:** the router trace, which keeps its entries' texts whole, is bounded once by bytes
  (`ROUTER_TRACE_BYTES`, a sanity bound under the 128 MB isolate) as well as by `routerTraceEntries`, not by a cut per
  entry. An MCP call's log entries keep 64 Ki characters each (`RAW_LOG_CHARACTERS`), as before; past that cut, no part
  of a token is left.
- **An argument, then an answer:** the prime of a worktree launch's `.git` reads covered the first 100 branches and 100
  remote refs, which kept its script under the 128 KiB Linux allows one argument. The script now goes on stdin, with no
  count. Its ref listing and its answers run whole (computer otherwise keeps their last 64 KiB, dropping the head), each
  cut at `PRIME_OUTPUT_BYTES`, a sanity bound under the Workspace DO's 128 MB isolate, with the fixed reads first, then
  the local branches, then the remote refs, so a cut leaves the last refs unprimed. The count is bounded too, by
  where the answers are kept: the read cache keeps `gitReadsKept` answers and deletes the least recently used past it,
  so a prime keeps at most half of that (`primeReadsFor`), leaving the rest to t3's own reads, and puts its most needed
  answers last. Its answers are kept at the `.git` revision read before it ran. A clone or a worktree's checkout no
  longer waits for the prime.

§1's example, the setup output's 256 KiB, becomes a derived maximum: `MAX_SETUP_OUTPUT_KIB` is a third of
`DO_VALUE_BYTES` in KiB. A report keeps its output as UTF-8 decoded to a string, which a Durable Object value stores in
at most two bytes a UTF-16 unit, so the output takes at most two thirds of the value; the rest is the record's other
fields.

Left as they are: the stage-only check harnesses (`acpCheck.ts`, `agentsCheck.ts`), whose cuts end a Maintainer's check,
and the stage-only Browser Run spike (`preview/spike.ts`), whose error cuts only shape its result lines;
the reboot check's module-state fingerprint (`moduleState.ts`), which no one reads as text; and the dead stdio path's
`STDERR_QUOTE_BYTES`, which goes when that path returns or is deleted. An MCP server's `instructions` are no longer
stored: nothing read them.

## Refinement (SPI-1368, 2026-11-23): the last fixed values

The rest of the audit's fixed values (SPI-1357) were each confirmed against the code and named, removed, derived or
made settings; ADR-0032's SPI-1368 refinement lists the settings. Two points of rule:

- **A setting with no failure past any value has no maximum of its own.** `codemode.inlineBudget` decides only how many
  tool declarations go inline: a budget past every declaration inlines them all, 0 defers them all, and neither breaks
  anything. The integer schema still needs a maximum, so it takes `Number.MAX_SAFE_INTEGER`, which reads as none: the
  Settings page gives its field no `max` and its description says "No maximum". This
  refines the considered option "No maximum at all" for such settings; a timed limit keeps the shared timed maximum.
- **A text setting needs no length of its own.** The text schema's `maxLength` is optional, kept only where a constraint
  sets one. The Guardian's rules and policy and the model settings had 4,000, 8,000 and 300 characters; they are bounded,
  as the SPI-1365 refinement does for the other entities, by the one Durable Object value that stores the Harness
  settings.

A fixed value that stays names its constraint where it is set: Cloudflare's (a Durable Object's 30 seconds in
`blockConcurrencyWhile`, its 10 GB of storage, an RPC's 32 MiB, an isolate's 128 MB), an external one (t3's contract's
1,024 characters of an ACP agent's description, a PTY's 16-bit size), or a sanity bound, said to be one.
