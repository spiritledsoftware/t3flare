# Settings follow local parity, and guardrails are opt-in

Status: accepted (SPI-1384, Owner decisions, 2026-11-24; the rule of SPI-1357's prune). Supersedes
[ADR-0048](0048-the-owner-is-trusted-with-their-own-settings-and-a-maximum-is-a-named-constraint-or-a-sanity-bound.md)
where they differ. Refines
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md) and
[ADR-0035](0035-agents-change-t3flares-settings-through-the-settings-server.md).

ADR-0048 rested on an AGENTS.md rule: whatever an Owner could tune is a setting with a sensible default. The audit that
followed (SPI-1357) turned nearly every fixed value into a setting, and the Settings page grew past what an Owner reads.
Many of those settings guarded only t3flare's own machinery, a value no Owner would choose. Others, as defaults, made
t3flare stricter than the same agents running on the Owner's machine: a turn limit, a clone time limit, a command time
limit, where stock t3 and a local agent have none. The Owner chose a different rule.

1. **Local parity by default.** Out of the box, t3flare behaves like stock t3 and the agents running on the Owner's
   machine. A limit with a local equivalent defaults to the local behaviour, which is usually no limit.
2. **Guardrails are opt-in.** A guardrail is a limit that exists only because t3flare runs in the cloud, to bound cost
   or contain a failure. It is off by default, a setting the Owner turns on. Two stay on by default, by the Owner's
   choice, as tunable settings: the Terminal holds (how long a running or prompting Terminal keeps its Container), and
   the setup scripts' time limits.
3. **A setting only where the Owner would choose its value.** That is cost, size, what agents may do, setup, and
   retention. A value that only guards t3flare's own machinery is a **named, generous constant**: named where it is
   set, generous enough that no real use meets it, with a comment saying what it guards. It is not a setting.
4. **Every limit names itself when hit**, with its value, wherever it shows: a refusal, an agent's tool result, the
   Status section. When the limit is a contextual or Advanced setting, its message also says where to change it.
5. **A limit Cloudflare forces stays**, names itself, and gets a follow-up to engineer it away. The ones t3flare meets:
   - a SQLite-backed Durable Object row or value holds 8 MB;
   - a Durable Object RPC or WebSocket message holds 32 MiB;
   - an isolate has 128 MB;
   - an invocation has 10,000 subrequests.
6. **Progressive disclosure.** Each setting declares where the Settings page shows it:
   - **visible**: always shown;
   - **contextual**: shown only while its feature is in use, with the condition that shows it (the size being custom, a
     setup having a script, the Guardian being on);
   - **Advanced**: collapsed under its section's Advanced.

   Disclosure decides only where a setting is shown. A contextual or Advanced setting is a setting like any other: the
   Settings server reads and changes it, and a value stored for it applies whether or not the page shows it.

7. **Every limit value is the Owner's to approve.** A value that turns out wrong goes back to the Owner; it is never
   changed silently.

ADR-0048's other rules stand: the Owner is trusted with their own settings, a consequence is stated once where the value
is set, and a setting's maximum is a named constraint or a sanity bound, or none where no value breaks anything.

## Considered options

- **Keeping every tunable a setting** (ADR-0048's premise) and hiding the rarely used ones. Rejected: a setting for a
  value no Owner would choose is still read, audited, tiered and documented; a named constant is less to keep.
- **Guardrails on by default**, as the cost guards were before ADR-0048. Rejected: they make the cloud stricter than the
  Owner's machine, which surprises an Owner who moved a task there. The Terminal holds and the setup time limits are
  the Owner's exceptions.
- **Removing guardrails entirely.** Rejected: an Owner who wants a cost bound or a bound on a hang needs one.

## Consequences

- Most limits of SPI-1357's audit change: some become named constants and leave the Settings page, the Settings server
  and the audit's tiers; some default to no limit; the rest each declare a disclosure. The tickets of SPI-1357's prune
  make those changes; this ADR changes no value.
- A stored value for a setting that becomes a constant is ignored when the settings are resolved, never refused.
- A limit message carries its value and, for a contextual or Advanced setting, its place on the page, so it changes when
  the setting moves.
- A new limit starts from this rule: local behaviour by default, a setting only where the Owner would choose its value,
  a named constant otherwise.
