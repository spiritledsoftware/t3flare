// @effect-diagnostics globalDate:off
// t3's passive git reads, answered without the Container while the repo has not changed (step 2a plan, section 2,
// revised in M2): every passive read the Container answers is kept with the repo's revision in computer's change log
// (`vfs_changes`) at the time it ran; the same argv, cwd, env and stdin at the same revision gets the same bytes back.
// Anything that changes the repo (an edit through the Workspace's files, a sync from the Container) moves the revision:
// the next read runs for real if the Container is running, and otherwise gets the last answer (`last`, any revision)
// patched with the write journal (`./staleReads.ts`, M3), never starting the Container.
import { REPO_ROOT } from "@t3flare/workspace-client";

import type { GitAnswerStreams } from "./gitOutput.ts";

/** A kept answer (`gitOutput.ts`); `put` keeps one given without a `cut` as whole. */
export type CachedAnswer = GitAnswerStreams;

/** REPO_ROOT's two segments, as computer's VFS keeps them (`vfs_dirents` under the root inode, 1). */
const [ROOT_NAME, REPO_NAME] = REPO_ROOT.split("/").filter(Boolean) as [string, string];

const SCHEMA = `CREATE TABLE IF NOT EXISTS t3flare_git_reads (
  key TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  answer TEXT NOT NULL,
  used_at INTEGER NOT NULL
)`;

/**
 * The largest answer kept, in UTF-8 bytes of its JSON. A named constraint: a Durable Object SQLite row holds 8 MiB
 * (8,388,608 bytes: Cloudflare's "Maximum string, BLOB or table row size", past which an insert throws `SQLITE_TOOBIG`);
 * 1 KiB is left for the row's key, revision and time.
 * A larger answer (a big `git log` or `git status`) is answered, just not cached.
 */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024 - 1024;

/** Whether `text` fits MAX_ANSWER_BYTES; encoded only when its length leaves it in doubt (a UTF-16 unit is at most 3 UTF-8 bytes). */
/**
 * The UTF-8 bytes `text` takes inside `JSON.stringify`'s output, counted without making it (SPI-1375): a quote or
 * backslash, and `\b \f \n \r \t`, take 2; another control character, or a lone surrogate, 6 (`\u00XX`); a surrogate
 * pair 4; any other unit its UTF-8 length. So an answer of control characters, up to 6 times its length in JSON, is
 * measured, never serialized only to be dropped. Stops counting once past `limit`.
 */
const jsonBytes = (text: string, limit: number): number => {
  let bytes = 0;
  for (let at = 0; at < text.length && bytes <= limit; at++) {
    const unit = text.charCodeAt(at);
    if (unit === 0x22 || unit === 0x5c || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13)
      bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        at++;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
};

/** The UTF-8 bytes of `answer`'s row (its JSON, as `put` writes it), counted without making it; past `limit`, more. */
const rowBytes = (answer: CachedAnswer & { readonly cut: number | null }, limit: number): number => {
  const frame = JSON.stringify({ ...answer, stdout: "", stderr: "" }).length;
  const stdout = jsonBytes(answer.stdout, limit - frame);
  return frame + stdout + jsonBytes(answer.stderr, limit - frame - stdout);
};

export const readKey = async (input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: string | undefined;
}): Promise<string> => {
  const env = Object.entries(input.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
  const text = JSON.stringify([input.argv, input.cwd, env, input.stdin ?? null]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Whether a read's answer is kept, by computer's exec status: one that ran to its end, whatever git's exit, never one
 * that was killed (`cancelled`: computer's name for an exit of 129, 130, 137 or 143, which a timeout's or a cancel's kill
 * gives; SPI-1364). A git that exits 129 by itself (a usage error) is not kept either, and only runs again.
 */
export const keepsAnswer = (status: string): boolean => status === "completed" || status === "failed";

/**
 * `maxRows`: how many answers are kept (`GIT_READS_KEPT`, SPI-1364), read at each `put`; the least recently used past it
 * is deleted.
 */
export const readCache = (sql: SqlStorage, maxRows: () => number) => {
  let ready = false;
  const memo = new Map<"git-dir" | "repo", { readonly global: number; readonly rev: number }>();
  const ensure = () => {
    if (!ready) sql.exec(SCHEMA);
    ready = true;
  };
  return {
    /**
     * The repo's revision (or its `.git`'s, for `git-dir`): the newest revision of any file, folder or deletion under it in computer's VFS
     * (`vfs_nodes.rev`, and `vfs_changes` for deletions). Recomputed only when the Workspace's global revision
     * (`vfs_meta.rev`, bumped by every write anywhere) moved, so a status poll between changes costs one row.
     */
    revision(scope: "git-dir" | "repo" = "repo"): number {
      try {
        const global = sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'").toArray()[0]?.v ?? 0;
        const known = memo.get(scope);
        if (known !== undefined && known.global === global) return known.rev;
        const segments = scope === "git-dir" ? [ROOT_NAME, REPO_NAME, ".git"] : [ROOT_NAME, REPO_NAME];
        const prefix = `/${segments.join("/")}`;
        // The subtree's root inode: one dirent hop per segment from the VFS root (inode 1).
        let inode: number | undefined = 1;
        for (const name of segments) {
          inode = sql
            .exec<{ child_inode: number }>(
              "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
              inode,
              name,
            )
            .toArray()[0]?.child_inode;
          if (inode === undefined) break;
        }
        const nodes =
          inode === undefined
            ? 0
            : (sql
                .exec<{ rev: number | null }>(
                  `WITH RECURSIVE sub(inode) AS (
                     SELECT ?
                     UNION ALL
                     SELECT d.child_inode FROM sub JOIN vfs_dirents d ON d.parent_inode = sub.inode
                   )
                   SELECT MAX(n.rev) AS rev FROM sub JOIN vfs_nodes n ON n.inode = sub.inode`,
                  inode,
                )
                .toArray()[0]?.rev ?? 0);
        const deletions =
          sql
            .exec<{ rev: number | null }>(
              "SELECT MAX(rev) AS rev FROM vfs_changes WHERE path >= ? AND path < ?",
              `${prefix}/`,
              `${prefix}0`,
            )
            .toArray()[0]?.rev ?? 0;
        const rev = Math.max(nodes, deletions);
        memo.set(scope, { global, rev });
        return rev;
      } catch {
        return -1;
      }
    },
    get(key: string, rev: number): CachedAnswer | undefined {
      ensure();
      if (rev < 0) return undefined;
      const row = sql
        .exec<{ rev: number; answer: string }>("SELECT rev, answer FROM t3flare_git_reads WHERE key = ?", key)
        .toArray()[0];
      if (row === undefined || row.rev !== rev) return undefined;
      sql.exec("UPDATE t3flare_git_reads SET used_at = ? WHERE key = ?", Date.now(), key);
      return JSON.parse(row.answer) as CachedAnswer;
    },
    /** The last real answer for `key` at any revision, and the revision it was made at (the stale reads' base). */
    last(key: string): { readonly rev: number; readonly answer: CachedAnswer } | undefined {
      ensure();
      const row = sql
        .exec<{ rev: number; answer: string }>("SELECT rev, answer FROM t3flare_git_reads WHERE key = ?", key)
        .toArray()[0];
      return row === undefined ? undefined : { rev: row.rev, answer: JSON.parse(row.answer) as CachedAnswer };
    },
    /**
     * Keeps `answer` for `key` at `rev`, whole unless it says where it was cut; an answer too large for a row
     * (MAX_ANSWER_BYTES) is not kept.
     */
    put(key: string, rev: number, answer: CachedAnswer): void {
      ensure();
      if (rev < 0) return;
      // Measured before it is serialized (SPI-1375): an answer past a row is never copied into JSON only to be dropped.
      const row = { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr, cut: answer.cut ?? null };
      if (rowBytes(row, MAX_ANSWER_BYTES) > MAX_ANSWER_BYTES) return;
      const json = JSON.stringify(row);
      sql.exec(
        "INSERT INTO t3flare_git_reads (key, rev, answer, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev, answer = excluded.answer, used_at = excluded.used_at",
        key,
        rev,
        json,
        Date.now(),
      );
      sql.exec(
        "DELETE FROM t3flare_git_reads WHERE key IN (SELECT key FROM t3flare_git_reads ORDER BY used_at DESC LIMIT -1 OFFSET ?)",
        maxRows(),
      );
    },
    stats(): { readonly rows: number } {
      ensure();
      return { rows: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM t3flare_git_reads").one().n };
    },
  };
};
