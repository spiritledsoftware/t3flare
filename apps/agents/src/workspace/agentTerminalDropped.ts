// What an agent is told when it names a Terminal or Background job the Workspace's exited bound forgot (SPI-1397,
// ADR-0049 §4): the bound and its value, `AGENT_EXITED_TERMINALS_KEPT`. Apart from `agentTerminals.ts`, so the Session's
// termctrl tool can tell it from other failures without loading the Workspace's xterm.
import { AGENT_EXITED_TERMINALS_KEPT } from "@t3flare/harness-registry";

export const agentTerminalDropped = (id: string, logPath: string | undefined): string =>
  `${id} is no longer kept: a Workspace keeps its last ${AGENT_EXITED_TERMINALS_KEPT} exited Terminals and Background jobs, across its threads, and past that forgets one: first those whose exit was already seen, oldest exit first, then those not yet seen.${logPath === undefined ? "" : ` Its whole output is still in ${logPath}.`}`;

/** Whether `error` is `agentTerminalDropped`'s answer for `id`. */
export const isAgentTerminalDropped = (error: string, id: string): boolean =>
  error.startsWith(`${id} is no longer kept: a Workspace keeps its last `);
