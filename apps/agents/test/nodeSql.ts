// A `SqlStorage`-shaped view of Node's own SQLite, so the agent Terminals' scrollback (SPI-1397) is tested on Node
// against a real SQLite (DO SQLite's own row limit is tested in workerd: test/*.workerd.test.ts).
// @effect-diagnostics nodeBuiltinImport:off
import { DatabaseSync } from "node:sqlite";

import { type ScrollbackStore, scrollbackStore } from "../src/workspace/agentScrollback.ts";

export const nodeSql = (db: DatabaseSync = new DatabaseSync(":memory:")) => ({
  db,
  exec<T>(query: string, ...params: Array<unknown>): { toArray(): Array<T> } {
    const statement = db.prepare(query);
    if (!/^\s*SELECT\b/i.test(query)) {
      statement.run(...(params as Array<never>));
      return { toArray: () => [] };
    }
    const rows = statement.all(...(params as Array<never>)) as Array<T>;
    return { toArray: () => rows };
  },
});

/** A scrollback store over a fresh in-memory SQLite. */
export const nodeScrollbackStore = (maxBytes?: number): ScrollbackStore & { readonly db: DatabaseSync } => {
  const sql = nodeSql();
  return Object.assign(scrollbackStore(sql, maxBytes), { db: sql.db });
};
