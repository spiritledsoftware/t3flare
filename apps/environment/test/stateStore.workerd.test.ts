// The State directory (ADR-0007) on real DO SQLite: files above CHUNK_BYTES are split across rows, and every
// operation keeps the chunks consistent.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TRACE_KIB } from "@t3flare/harness-registry";
import { describe, expect, it } from "vitest";

import * as store from "../src/platform/stateStore.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly TEST_OBJECTS: DurableObjectNamespace;
    }
  }
}

const bytes = (length: number, seed = 7) => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

/** Byte equality without Vitest's element-by-element diff, which takes seconds on megabytes. */
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

const inObject = <T>(name: string, run: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.TEST_OBJECTS.getByName(name), async (_instance, state) => {
    store.bindStateStorage({
      sql: metered(state.storage.sql),
      transactionSync: (f) => state.storage.transactionSync(f),
    });
    return run(state);
  });

/** The bytes the store binds into SQL and reads back, as it runs: the store reads every result through `toArray`. */
const meter = { bound: 0, read: 0 };
const blobBytes = (value: unknown) =>
  value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value) ? value.byteLength : 0;
const metered = (sql: SqlStorage): SqlStorage =>
  new Proxy(sql, {
    get: (target, key) =>
      key === "exec"
        ? (query: string, ...bindings: Array<unknown>) => {
            for (const binding of bindings) meter.bound += blobBytes(binding);
            const cursor = target.exec(query, ...bindings);
            return new Proxy(cursor, {
              get: (inner, name) =>
                name === "toArray"
                  ? () => {
                      const rows = inner.toArray();
                      for (const row of rows) for (const value of Object.values(row)) meter.read += blobBytes(value);
                      return rows;
                    }
                  : Reflect.get(inner, name, inner),
            });
          }
        : Reflect.get(target, key, target),
  });
/** What `run` bound and read. */
const metering = (run: () => void) => {
  meter.bound = 0;
  meter.read = 0;
  run();
  return { ...meter };
};

const rowCount = (state: DurableObjectState, table: string) =>
  (state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one() as { n: number }).n;

describe("State directory", () => {
  // SPI-1367: t3's trace file, rewritten whole at each flush, is held to one inline row (`TRACE_KIB`).
  it("holds t3's trace file (TRACE_KIB) in one inline row", () => {
    expect(TRACE_KIB * 1024).toBeLessThanOrEqual(store.CHUNK_BYTES);
  });

  it("keeps small files inline and large ones in 4 MiB chunks", async () => {
    await inObject("chunks", (state) => {
      store.mkdir("/t3/attachments", { recursive: true });
      store.writeFile("/t3/attachments/small.bin", bytes(1000));
      const large = bytes(store.CHUNK_BYTES * 2 + 12345);
      store.writeFile("/t3/attachments/large.bin", large);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(3);
      expect(store.get("/t3/attachments/large.bin")?.size).toBe(large.byteLength);
      expect(same(store.readFile("/t3/attachments/large.bin"), large)).toBe(true);
      expect(store.readFile("/t3/attachments/small.bin")).toEqual(bytes(1000));
      // A range across a chunk boundary reads only what it needs, and equals the same slice.
      const from = store.CHUNK_BYTES - 10;
      expect(store.readRange("/t3/attachments/large.bin", from, 30)).toEqual(large.slice(from, from + 30));
      expect(store.usage()).toEqual({ files: 2, bytes: 1000 + large.byteLength, chunked: 1 });
    });
  });

  it("appends, truncates, renames and removes chunked files without stray chunks", async () => {
    await inObject("ops", (state) => {
      store.mkdir("/t3/a", { recursive: true });
      const first = bytes(store.CHUNK_BYTES - 5, 1);
      store.writeFile("/t3/a/f.bin", first);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      store.writeFile("/t3/a/f.bin", bytes(20, 2), { append: true });
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);
      const joined = store.readFile("/t3/a/f.bin");
      expect(joined.byteLength).toBe(first.byteLength + 20);
      expect(same(joined.slice(0, first.byteLength), first)).toBe(true);

      store.truncate("/t3/a/f.bin", 100);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      expect(store.readFile("/t3/a/f.bin")).toEqual(first.slice(0, 100));

      store.writeFile("/t3/a/g.bin", bytes(store.CHUNK_BYTES + 1));
      store.rename("/t3/a", "/t3/b");
      expect(store.readFile("/t3/b/g.bin").byteLength).toBe(store.CHUNK_BYTES + 1);
      expect(() => store.readFile("/t3/a/g.bin")).toThrow(/ENOENT/);
      store.remove("/t3/b", { recursive: true });
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      expect(store.get("/t3/b")).toBeUndefined();
    });
  });

  // SPI-1391: a Terminal's log file takes an append every quarter second and up to 16 MiB, read as its tail on attach.
  it("appends by rewriting only the last chunk, and reads a range from only its own bytes", async () => {
    await inObject("append", (state) => {
      store.mkdir("/t3/logs", { recursive: true });
      const file = "/t3/logs/terminal.log";
      const expected: Array<Uint8Array> = [];
      const append = (data: Uint8Array) => {
        store.writeFile(file, data, { append: true });
        expected.push(data);
      };
      append(bytes(1000, 1));
      append(bytes(store.CHUNK_BYTES - 1000, 2)); // exactly one chunk's worth, still inline
      expect(rowCount(state, "t3flare_file_chunks")).toBe(0);
      append(bytes(10, 3)); // inline becomes two chunks
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);
      append(bytes(store.CHUNK_BYTES - 10, 4)); // fills the second exactly
      append(bytes(store.CHUNK_BYTES * 2 + 7, 5)); // starts a third, fills it, starts a fifth
      expect(rowCount(state, "t3flare_file_chunks")).toBe(5);
      // An append reads and writes the last chunk and what it adds, never the whole 16 MiB.
      expect(metering(() => append(bytes(100, 8)))).toEqual({ bound: 107, read: 7 });

      const total = expected.reduce((sum, part) => sum + part.byteLength, 0);
      const whole = new Uint8Array(total);
      let at = 0;
      for (const part of expected) {
        whole.set(part, at);
        at += part.byteLength;
      }
      expect(store.get(file)?.size).toBe(total);
      expect(same(store.readFile(file), whole)).toBe(true);
      expect(store.usage()).toEqual({ files: 1, bytes: total, chunked: 1 });
      for (const [from, length] of [
        [0, 10],
        [store.CHUNK_BYTES - 3, 64 * 1024],
        [store.CHUNK_BYTES * 3 + 5, store.CHUNK_BYTES + 10],
        [total - 5, 100],
      ] as const) {
        let range: Uint8Array = new Uint8Array(0);
        expect(metering(() => (range = store.readRange(file, from, length)))).toEqual({
          bound: 0,
          read: Math.min(length, total - from),
        });
        expect(same(range, whole.slice(from, from + length))).toBe(true);
      }

      // An inline file's range, and a truncate after the appends, as before.
      store.writeFile("/t3/logs/small.log", bytes(5000, 6));
      expect(same(store.readRange("/t3/logs/small.log", 4990, 64), bytes(5000, 6).slice(4990))).toBe(true);
      store.truncate(file, store.CHUNK_BYTES + 1);
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);
      expect(same(store.readFile(file), whole.slice(0, store.CHUNK_BYTES + 1))).toBe(true);
    });
  });

  // rename's transaction runs remove's own for the path it replaces: DO SQLite's transactionSync nests.
  it("renames onto an existing file or folder, replacing it and its chunks", async () => {
    await inObject("rename-over", (state) => {
      store.mkdir("/t3/d", { recursive: true });
      const kept = bytes(store.CHUNK_BYTES + 3, 4);
      store.writeFile("/t3/d/new.bin", kept);
      store.writeFile("/t3/d/old.bin", bytes(store.CHUNK_BYTES * 2 + 1, 5));
      expect(rowCount(state, "t3flare_file_chunks")).toBe(5);
      store.rename("/t3/d/new.bin", "/t3/d/old.bin");
      expect(same(store.readFile("/t3/d/old.bin"), kept)).toBe(true);
      expect(store.get("/t3/d/new.bin")).toBeUndefined();
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);

      store.mkdir("/t3/from/sub", { recursive: true });
      store.writeFile("/t3/from/sub/x", bytes(10, 6));
      store.mkdir("/t3/to/stale", { recursive: true });
      store.writeFile("/t3/to/stale/big.bin", bytes(store.CHUNK_BYTES + 1, 7));
      store.rename("/t3/from", "/t3/to");
      expect(store.readFile("/t3/to/sub/x")).toEqual(bytes(10, 6));
      expect(store.get("/t3/to/stale")).toBeUndefined();
      expect(store.get("/t3/from")).toBeUndefined();
      expect(rowCount(state, "t3flare_file_chunks")).toBe(2);
    });
  });

  it("reports Node-style errors", async () => {
    await inObject("errors", () => {
      expect(() => store.readFile("/missing")).toThrow(expect.objectContaining({ code: "ENOENT" }));
      store.mkdir("/d");
      expect(() => store.mkdir("/d")).toThrow(expect.objectContaining({ code: "EEXIST" }));
      store.writeFile("/d/x", bytes(1));
      expect(() => store.remove("/d")).toThrow(expect.objectContaining({ code: "ENOTEMPTY" }));
      expect(() => store.writeFile("/nope/x", bytes(1))).toThrow(expect.objectContaining({ code: "ENOENT" }));
      store.symlink("/d/x", "/link");
      expect(store.resolve("/link")?.path).toBe("/d/x");
    });
  });

  it("migrates a spike-era table, keeping its files and backfilling their sizes", async () => {
    await runInDurableObject(env.TEST_OBJECTS.getByName("spike"), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE t3flare_files (path TEXT PRIMARY KEY, parent TEXT NOT NULL, kind TEXT NOT NULL, data BLOB,
        target TEXT, mode INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, birthtime_ms INTEGER NOT NULL)`);
      sql.exec(
        `INSERT INTO t3flare_files VALUES ('/', '/', 'dir', NULL, NULL, 493, 0, 0), ('/old.txt', '/', 'file', ?, NULL, 420, 0, 0)`,
        new TextEncoder().encode("hello"),
      );
      store.bindStateStorage({ sql, transactionSync: (f) => state.storage.transactionSync(f) });
      expect(store.get("/old.txt")?.size).toBe(5);
      expect(new TextDecoder().decode(store.readFile("/old.txt"))).toBe("hello");
      // Binding again (a new object instance) does not migrate twice.
      store.bindStateStorage({ sql, transactionSync: (f) => state.storage.transactionSync(f) });
      expect(store.readFile("/old.txt").byteLength).toBe(5);
    });
  });
});
