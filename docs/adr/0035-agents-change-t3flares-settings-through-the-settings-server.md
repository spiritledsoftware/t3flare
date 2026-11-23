# Agents change t3flare's settings through the Settings server

Status: accepted (owner decisions, 2026-11-14; built and unit-tested through SPI-1202, stage-run on `psmcp`: report
[`docs-archive-1:docs/steps/settings-mcp.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp.md)). Where the
Owner-client endpoint lives:
[ADR-0036](0036-owner-clients-reach-the-settings-server-at-t3flare-mcp-behind-an-access-application-of-its-own.md),
whose sign-in probe (owner step 1) passed on 2026-11-15. Plan:
[`docs-archive-1:docs/steps/settings-mcp-plan.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/settings-mcp-plan.md). Supersedes
[ADR-0026](0026-pi-durable-harness-settings-live-in-the-environment-and-an-owner-only-panel-edits-them.md) §8 ("the agent
gets no settings tools", OD-T9). Refines ADR-0026, [ADR-0028](0028-mcp-tools-reach-agents-through-the-environments-mcp-host.md),
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) and
[ADR-0033](0033-environment-skills-are-pinned-copies-fetched-from-github-kept-by-the-environment-and-changed-only-by-the-owner.md) §7.

ADR-0026 kept settings away from agents: Linked work and prompt injection made an agent that edits its own MCP server
set a larger target, and t3 had no surface for such changes. The owner reversed that: "the whole point is that the agent
can modify its own environment", and later "make everything configurable by the agent. Since we are using elicitation,
it's not a big deal to expose these." So everything the Harness panel edits, but its Model endpoints, is changeable through one MCP server, the
**Settings server**, and what widens an agent's reach waits for an answer. Model endpoints
([ADR-0034](0034-model-endpoints-are-the-owners-set-in-the-harness-panel.md)) are panel-only: the Settings server neither reads
nor changes them, and `read_audit` shows their entries without key fingerprints.

1. **One server, two doors.** The Settings server covers the Harness settings, the Environment settings and the
   Environment skills, through the same functions the panel calls.
   - t3flare's own agents (Durable agents, and the CLI agents through the MCP relay) reach it as a member
     of the MCP server set of its own kind, beside the Direct servers (since SPI-1160 the only other kind; Commissary is
     one of them), served in-process by the MCP host, with no Access and no OAuth. It is on by default, with Exposure
     `deferred`, and `settings` is reserved with `t3` and `t3-code`.
   - **Owner clients**, MCP clients outside t3flare that the owner signed in, reach it at an HTTP endpoint behind an
     Access application of its own with managed OAuth.
2. **Panel parity.** An agent may ask for any change the panel can make (the Model endpoints, panel-only, apart), including the Guardian's switch and settings, a
   tool's class, and the Settings server's own entry. What the panel cannot change (a locked registry entry) nobody can.
3. **Two Change tiers, by direction.** A change is `free` when it narrows (turning something off, hiding a tool,
   lowering a budget, marking a tool write) and `asked` when it widens, spends, puts new text or code in front of agents,
   destroys something, turns off a **Guard**, or touches the Settings server's own entry. A setting with no declared tier
   is asked.
4. **The thread's mode still rules.** Plan mode refuses every write. Outside full access every write asks. In full
   access a free change runs and an asked change still asks, as an elicitation does in every mode. There is one card,
   never the generic write card followed by a second.
5. ~~**Linked work reads only.** A thread that carries a link's origin, or whose origin the Environment cannot establish,
   may read settings and change none. The laptop's way to change them is an Owner client.~~ Superseded by the SPI-1356
   refinement below: Linked work changes settings as the owner's own thread does.
6. **An asked change is an Open change**: kept by the Environment DO for at most 10 minutes, bound to the revision it
   was asked against, answered once.
7. **t3flare's own agents get the owner-only card.** An asked change raises a Server question as an approval card on the
   calling thread, which no agent can answer, with the change written by the server and a link to the **Change page**.
   The page can answer it too; the first answer wins.
8. **An Owner client's Elicitation mode is its own choice.** `?elicitation_mode=` on the endpoint's URL, with Executor's
   names, read on every request and trusted as sent (refined 2026-11-15: set per client on the Harness panel, the query
   kept as an override; see the refinement below):
   - `browser` (the default): the client is sent to the Change page, and the page applies the change;
   - `native`: the client shows a form, and its `accept` applies the change;
   - `model`: the result is a Pause, and the client's agent applies the change by calling `resume`.

   A fallback only ever moves toward `browser`.

9. **Secrets and sign-ins happen on the Change page only** (a secret Variable's value excepted: [ADR-0046](0046-a-variable-may-be-secret-as-stock-t3s-environment-variables-are.md) §4). An agent may ask to add a header-auth Direct server, set its
   header value, or start its OAuth sign-in; the value is typed, and the sign-in started, on the Change page under the
   owner's Access identity, in every mode. No tool argument or result carries a secret or an authorization URL. Two
   more kinds of change are answered on the page alone, in every mode: installing or updating Environment skills (only
   the page shows each skill's `SKILL.md` and files, so a card or a client would offer Approve on text it cannot show;
   SPI-1199 review), and a change whose text would not fit a card whole.
10. **Every write names the revision it expects**, and a moved revision refuses it.
11. **Every change is audited** with the door it came through, who asked, its tier, its mode and what answered it.
12. **The pi CLI gets the relay's servers.** Its built-in MCP client reads entries t3flare writes into its per-process
    agent directory, so the Direct servers (Commissary among them, since SPI-1160) and the Settings server reach it as
    they reach the other CLI agents.

## Considered options

- **No settings tools for agents** (ADR-0026 §8). Reversed by the owner.
- **A panel-only tier** for what judges agents (the Guardian, tool classes, the server's own entry). Proposed in the
  design interview; the owner chose panel parity.
- **A panel-side Proposal queue**. Rejected by the owner in favour of elicitation; an Open change lives
  only as long as its question.
- **Agents calling a public endpoint with a credential.** Rejected: a credential in a Container (ADR-0016), and the
  origin could not tell which thread called.
- **Every write asked.** Rejected: turning things down should be frictionless, and the owner spoke of "risky writes".
- **Linked work with writes at full access**, as t3's Link fence would allow. Rejected: the laptop already has an
  owner-authenticated door. (Reversed, and widened to every mode, by the SPI-1356 refinement below.)
- **The Owner-client endpoint under the existing `/_t3flare` Access application.** Rejected: a managed-OAuth token is
  valid for its whole application, so an Owner client's token would also be admitted at the panel and the Change page.
- **One answer path for Owner clients, the Change page.** Proposed in the design interview, because a client's answer
  to an elicitation is not proof of a person. The owner chose Executor's three modes, trusted as sent.
- **`model` as the default mode**, as Executor has it. Rejected: the weaker modes should be typed deliberately.

## Consequences

- An Owner client's Elicitation mode is whatever its URL says on each request; the Settings server checks it against
  nothing, and Access issues the same grant for all three. In `native` the client's `accept`, and in `model` the agent's
  `resume`, is recorded as the owner's answer and applies the change, although a client hook, an auto-approve policy or
  the agent itself may have produced it. So whatever holds an Owner client's token can make every Settings change except
  the page-only ones (typing a secret, completing an OAuth sign-in, installing or updating a skill, and a change too
  long to show, `oversize`), with no person involved, by asking in `model`: this includes turning the Guardian off,
  marking a tool read and changing the Settings server's own entry. Only `browser`, and the card t3flare's own agents
  get, show that the owner answered. The audit log records each change's mode and what answered it (page, card, client
  or agent), and that is the only trace of the difference.
- An agent in the Cloud Environment (a Durable or CLI agent) that reaches the Laptop Environment over an Outbound link
  could read an Owner client's stored token there and use `model`. The owner-only card holds only while no agent of ours
  can obtain such a token.
- An agent can ask the owner, on a card, to weaken what reviews it. The card says so in the server's own words; nothing
  else stands between the request and the owner's click.
- A server an agent asked for is added with its tools' own read-only hints trusted, as any Direct server is: after one
  card, a tool it marks read runs without one, in plan mode too.
- Once the Settings server is switched off or to read-only, the request to switch it back cannot be made through it;
  only the panel can.
- The Global mise config and the Variables reach every Workspace of every Project, so an approved change made from one
  thread runs in another Project's Container.
- Where the Owner-client endpoint lives is
  [ADR-0036](0036-owner-clients-reach-the-settings-server-at-t3flare-mcp-behind-an-access-application-of-its-own.md):
  a second Access application on the t3 host at `/_t3flare/mcp` (layout (B)), confirmed by the owner's sign-in probe (owner step 1, 2026-11-15; Cursor's redirect, step 2, is open),
  with a Worker on its own host (layout (C)) as the fallback.
- ADR-0033's title still says Environment skills are "changed only by the owner"; an agent may now ask for a change, and
  its §7 is refined.

## Refinement: an Owner client's mode is set on the panel, per client (SPI-1201, 2026-11-15)

§8's carrier changes; its three modes, their meaning and their fallbacks do not. A live stage run showed Claude Code
2.1.322 failing to sign in with any query on the endpoint's URL: its OAuth discovery then falls back to the origin's
root authorization server instead of following Access's per-path protected-resource metadata, and Access answers no
root document (ADR-0036). The same URL without the query signs in. Access's consent page is not ours, so the mode cannot
be picked there either. So, as Executor keeps a connection's mode on its own page:

- **An Owner client's mode is a setting the owner edits on the Harness panel**, kept per Owner caller's key (the Access
  `sub`, or the service token) and the client's own `clientInfo.name` (no version), in the Environment DO's SQLite
  (`t3flare_settings_clients`, `apps/environment/src/settings/clients.ts`). The Settings server's card on the panel
  lists each client the endpoint has seen, with its last request, a mode select and Remove, and shows the plain
  endpoint URL to add.
- **A request's mode**: an explicit `?elicitation_mode=` still wins (and an unknown, repeated or mis-cased one is still
  400); otherwise the client's kept mode; otherwise `browser`. A request with no client name is `browser`. §8's
  fallbacks toward `browser` apply after it, as before.
- **The endpoint records a client as seen**, in `browser`, at its first request with a name, and writes its last-seen
  time at most once an hour. At most 50 clients per key; a new name past that evicts the least recently seen, so a
  client cannot grow the table by sending random names. A name is cut to 60 characters, stripped of hidden characters
  and rendered escaped.
- **Only the panel sets a mode**, with the panel's write guard (JSON, same Origin, the CSRF token for a browser), and
  each change is audited (entity `owner-clients`). No MCP door and no Settings tool reaches it: the endpoint is handed
  the store's read-and-record function alone. A client in `model` cannot move itself to another mode.
- **A mode change applies at the client's next request.** An Open change keeps the mode it was asked in: a retry or a
  form answer in another mode is refused as before, and the Change page still answers it.

The client name is the client's own label and carries no security weight. That changes nothing in the Consequences
above: the mode was always the client's choice, trusted as sent (E1); a client that names itself as another gets that
client's mode, which it could already have asked for with the query.

## Refinement: the Settings server also carries a Workspace's Purge (2026-11-21)

[ADR-0044](0044-a-workspace-is-purged-by-the-owner-or-at-an-agents-asking-through-the-settings-server.md) adds
`list_workspaces` and `purge_workspace`: the server's first action that is no Settings change. It is always asked, waits
as an Open change, and names no revision (§10 does not apply to it).

## Refinement ([ADR-0047](0047-every-container-starts-from-a-base-snapshot-the-builder-makes-from-the-image-setup.md), 2026-11-22): Base builds

The Settings server gains a Rebuild of the Base snapshot and a Test base build, both free, and reads of the Base
snapshot's state and the last Container setup's report, output included. The new settings' tiers follow §3: a
lowered time limit is free, every other change asked.

## Refinement (SPI-1316, 2026-11-23): an Open change waits the Answer wait

§6's "at most 10 minutes" is now the Answer wait, an Environment setting (`ownerAnswerMinutes`, 10 by default;
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)'s SPI-1316
refinement). An Open change takes the wait when it opens, as its `expiresAt`, and keeps it; one asked from a CLI agent
takes the wait that agent's process was spawned with. The strike window widens with a long wait, so unanswered strikes
still form a run.

## Refinement (SPI-1322, 2026-11-23): the Settings server's limits are its entry's settings

Plan D16's caps are now limits on the Settings server's own entry in the MCP server set (`limits`, kind `settings`
only), each with today's value as its default: the run of strikes (`strikes`), the strike window and lock
(`strikeWindowMinutes`, `strikeLockMinutes`; a lock of 0 turns it off), the declined repeat (`declinedRepeatMinutes`),
the applied, asked, read and network-read caps per hour, and the open changes per thread and per Owner client. The Owner
sets them in a Limits form on the Settings server's card. As every change to that entry, a change to them is asked in
either direction (§3, plan D5). Each applies at the caller's next request, and the counts already recorded are judged by
the new values. The strike window keeps the SPI-1316 refinement's run-based widening, with the strikes and the window in
place of the constants.

Fixed: the Environment-wide bound on open changes (16, a storage bound: every access to the changes table reads every
open row, and it is the most either open count may be), and the hour each per-hour cap counts over.

A closed change is kept the longest any check looks back: the strike window plus the lock, the declined repeat, or an
hour, whichever is longest. Lowering a limit prunes sooner; rows pruned under a shorter earlier limit are not recovered
when it is raised again.

## Refinement (SPI-1356, 2026-11-23): Linked work changes settings as the owner's own thread does

Supersedes §5. The owner reversed it after a delegated task and a top-level thread, both started from the laptop over
its Peer link, were refused every write (a Test base build included) while saving an Image setup and a Container setup:
"That constraint is ridiculous… It literally defeats the purpose of linked environments." A linked environment exists so
the owner's other machine can run their agents' work there, settings included; an Owner client is a second sign-in for
the same person, not the laptop's way in.

- **Linked work takes the own agents' write path.** The Settings server no longer asks where a thread came from: a
  thread with a link's origin, its children, and a thread t3's projection has no row for write as the owner's own thread
  does. Everything else in this ADR holds for them: the access switch (§1, read-only and off), plan mode refuses (§4),
  outside full access every write asks and an asked change asks in every mode (§3, §4), an asked change is an Open
  change on the owner-only card and the Change page (§6, §7), secrets, sign-ins, skill installs and `oversize` changes
  happen on the Change page only (§9), Model endpoints stay panel-only, and the caps count per thread (plan D16).
- **What still fails closed** is the thread's modes: the Environment's own record (the Durable adapter's, or a CLI's
  live session), never the caller's word. A thread with no record, and a call that names no thread, is refused
  (`NO_MODES_REFUSAL`).
- **A link below full access** caps the modes of the work it starts (t3's Link fence), so its threads' writes ask on a
  card, as an approval-required thread's of the owner's own do.
- **Gone**: `threadLinkIn` (the projection read, [U70](../upstream-fragility.md#u70-the-settings-servers-caller-retired-at-spi-1356)), the `link` dependency, and the
  `linked` and `unknown-thread` refusals. `linkedWorkOf` (the adapter's, for ADR-0013's push gate) and the step-3 check
  in `host/admin.ts` are unrelated and stay.

**Where a linked thread's card appears.** The card is a runtime request on the calling thread, which lives in the
Environment the link signed in to (the Cloud Environment), marked "From <the laptop's label>". The owner answers it
there in any t3 client connected to that Environment (the web client at its host, or a desktop or mobile client that has
added it); the laptop's own client shows another Environment's thread only when it is connected to that Environment too
(t3's `ChatView`: "Only an environment this client is connected to can open the parent"). It can also be answered on the
Change page, whose link the card carries when the host is configured, or from the Settings page's Open changes list; the
first answer wins. No agent answers it, the laptop's included: the laptop's `t3_pending_request` is forwarded over the
link to the Cloud Environment's `/mcp`, where `refuseOwnerOnly` (`mcp/ownerOnly.ts`, SPI-1079) refuses `read` and
`respond` on the card and `list` only shows its id.

**Consequence**: an agent on the laptop that can start or steer Linked work in the Cloud Environment can now ask for any
Settings change there, as an agent in the owner's own cloud thread can. Each one it asks for still needs the owner's
answer on a card or the Change page unless it is a free change in a full-access thread, the same as for the owner's own
thread.
