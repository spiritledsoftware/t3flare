# A Variable may be secret, as stock t3's environment variables are

Status: accepted (Owner decisions, 2026-11-22). Supersedes
[ADR-0016](0016-no-vendor-credential-enters-a-container-and-cli-agents-reach-the-model-proxy.md)'s SPI-1152
refinement ("Variables are never credentials") and §2 and §3 of
[ADR-0032](0032-environment-settings-and-harness-settings-are-separate-entities-edited-on-one-owner-page.md)'s
Variables refinement (the refused names and values). ADR-0016's rule for t3flare's own credentials (Model endpoints'
keys, Subscriptions, MCP servers' sign-ins, the Environment token) is unchanged.

Variables were never credentials: names with a `KEY` or `TOKEN` segment, the `GH_` and `GITHUB_` prefixes and
credential-looking values were refused, so an Owner had no way to give their Workspaces an npm token or the token that
clones their private dotfiles. The Owner decided that Variables work as stock t3's provider environment variables do
(`t3code/packages/contracts/src/providerInstance.ts`): a name, a string value and a Secret toggle, with no rule that
protects the Owner from their own choice.

1. **Shape.** Each Variable is a name, a string value and `secret`. A secret value is sealed with the Stage's
   credentials key, as a Model endpoint's key is (`apps/environment/src/credentials/sealed.ts`), and no read returns it:
   the Settings page and the Settings server show it as set, as t3 shows a redacted value. The audit log records a
   secret Variable's name only, and Workers Logs never carry a value.
2. **Reach.** Unchanged from ADR-0032's Variables §5, secret or not: every command on the Container or the Worker Shell,
   Terminals, CLI agent processes, a Durable agent's Container commands, and the Image setup and the Container setup.
   Any agent can read a secret Variable, as on stock t3.
3. **Validation keeps t3flare working, nothing more.** A name must be one a shell can export; a value holds no NUL; the
   count and length limits stay, since every Environment setting is one stored value of at most 2 MB. Every other
   refusal goes. A name t3flare sets itself (`PATH`, `HOME`, `COMMAND_ENV`'s, a CLI profile's) is still overridden by
   t3flare (ADR-0032's Variables §7), and the Settings page says so beside it.
4. **Through the Settings server,** an agent sets a Variable as any Settings change, a secret value included; the
   tier is the Variables' (asked).

## Considered options

- **Setup secrets**: credentials given to the Image setup and the Container setup only, scoped per script, with a leak
  scan refusing a Base snapshot that held one. Rejected by the Owner as treating Owners like children.
- **A secret toggle that keeps the old refusals for plain Variables** (a credential-looking plain value refused with
  "mark it Secret"). Rejected for the same reason.

## Consequences

- Anything run in a Workspace, an agent or a repository's install script, can read and send a secret Variable. That is
  the Owner's call, as it is on their own machine.
- A setup script that writes a secret to disk leaves it in that Container, or, for the Image setup, in the Base
  snapshot every Workspace starts from.
- `SET_BY_T3FLARE` stops being a refusal list and becomes the page's "t3flare sets this" note.
