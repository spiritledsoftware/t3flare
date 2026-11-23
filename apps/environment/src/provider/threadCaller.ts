// Who a Settings server call comes from, as the Environment derives it (ADR-0035, plan D3): never what the caller
// states. A Durable thread's modes (`durableModes`): the record the pi Durable adapter writes when it calls `open` and
// `submitTurn`, cleared when its provider session unregisters. Memory only: after an Environment restart there is none,
// and writes are refused until the next turn writes it again. A CLI thread's modes are `cliThreadState`'s. Linked work
// is judged as the owner's own (ADR-0035's SPI-1356 refinement), so where a thread comes from is not read here.
import type { ThreadModes } from "../settings/caller.ts";

/** The agent kind of a Durable Session's call (only Sessions call `EnvironmentDO.mcpCall`). */
export const DURABLE_AGENT = "piDurable";

const records = new Map<string, { readonly modes: ThreadModes; readonly owner: object }>();

/** The adapter's record of a Durable thread's modes, written at `open` and `submitTurn` by the session that owns it. */
export const noteDurableModes = (thread: string, modes: ThreadModes, owner: object): void => {
  records.set(thread, { modes, owner });
};

/** The provider session unregistered: its threads' records go (only those it wrote last). */
export const forgetDurableModes = (thread: string, owner: object): void => {
  if (records.get(thread)?.owner === owner) records.delete(thread);
};

/** A Durable thread's modes, or undefined when no live provider session recorded them. */
export const durableModes = (thread: string): ThreadModes | undefined => records.get(thread)?.modes;

/**
 * One provider session's part of the record (plan D3): the adapter notes a thread's modes at `open` and at each
 * `submitTurn`, and forgets every thread it noted when the session unregisters (its scope's finalizer). A newer session
 * that took a thread over keeps its own record.
 */
export const durableModeRecord = () => {
  const owner = {};
  const noted = new Set<string>();
  return {
    note: (thread: string, modes: ThreadModes) => {
      noted.add(thread);
      noteDurableModes(thread, modes, owner);
    },
    forgetAll: () => {
      for (const thread of noted) forgetDurableModes(thread, owner);
      noted.clear();
    },
  };
};
