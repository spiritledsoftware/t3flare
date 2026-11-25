// SPI-1392: the Workspace's file index (FsOp `index`). The walk over computer's VFS stops one entry past what the
// answer could ever carry, so no array larger than that bound is built, and a cut answer names its limit. The last index
// of each path in the repo is kept for the repo's revision (the read cache's `repo` scope) when it is small, and dropped
// when the revision moves.
import {
  type FoundEntry,
  type FoundIndex,
  type FsAnswer,
  fitFoundEntries,
  foundEntryBytes,
  REPO_ROOT,
} from "@t3flare/workspace-client";

/** The smallest an entry can count against an index's bytes (`foundEntryBytes`): a one-character path. */
export const MIN_FOUND_ENTRY_BYTES = foundEntryBytes({ path: "x", kind: "file" });

/**
 * The most entries an index of `maxBytes` can hold: `maxBytes` over the smallest entry (Owner-approved, 2026-11-24;
 * about 500k for `INDEX_MAX_BYTES`). The walk goes one past it, which `fitFoundEntries` can never keep, so the cut shows.
 */
export const indexWalkLimit = (maxBytes: number): number => Math.floor(maxBytes / MIN_FOUND_ENTRY_BYTES);

/**
 * The largest index kept between calls, in `foundEntryBytes` (Owner-approved, 2026-11-24): a larger one is answered,
 * walked again each time, and never held in the Workspace DO's 128 MB isolate between calls.
 */
export const INDEX_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface FileIndexDeps {
  /** Every entry under `path`, the walk stopping after `limit` (computer's `find`, as `fileOps.find`). */
  readonly find: (path: string, limit: number) => Promise<FsAnswer<ReadonlyArray<FoundEntry>>>;
  /** The repo's revision (`readCache`'s `repo` scope): it moves on any change under `REPO_ROOT`. */
  readonly revision: () => number;
}

const inRepo = (path: string) => path === REPO_ROOT || path.startsWith(`${REPO_ROOT}/`);

const bytesOf = (entries: ReadonlyArray<FoundEntry>) => {
  let bytes = 0;
  for (const entry of entries) bytes += foundEntryBytes(entry);
  return bytes;
};

export class FileIndex {
  readonly #deps: FileIndexDeps;
  /** The revision `#kept` was made at; every entry goes when it moves. */
  #keptAt: number | undefined;
  /** By path and `maxBytes`. */
  readonly #kept = new Map<string, FoundIndex>();

  constructor(deps: FileIndexDeps) {
    this.#deps = deps;
  }

  /** Every entry under `path` that fits `maxBytes` of a DO RPC answer, a cut named (`FoundIndex.cut`). */
  async index(path: string, maxBytes: number): Promise<FsAnswer<FoundIndex>> {
    // Only the repo's revision is known: an index outside it is never kept.
    const rev = inRepo(path) ? this.#deps.revision() : undefined;
    if (rev !== undefined && rev !== this.#keptAt) {
      this.#kept.clear();
      this.#keptAt = rev;
    }
    const key = `${maxBytes}:${path}`;
    const hit = rev === undefined ? undefined : this.#kept.get(key);
    if (hit !== undefined) return { ok: hit };
    const limit = indexWalkLimit(maxBytes);
    const found = await this.#deps.find(path, limit + 1);
    if (!("ok" in found)) return found;
    const fit = fitFoundEntries(found.ok, maxBytes);
    const index: FoundIndex = fit.truncated
      ? {
          ...fit,
          cut:
            `t3flare: the file index of ${path} is cut to ${fit.entries.length} entries: an index answer holds ` +
            `${maxBytes} bytes (a DO RPC message's 32 MiB), at most ${limit} entries`,
        }
      : fit;
    // Kept at the revision from before the walk: a change while it ran makes the next call walk again.
    if (rev !== undefined && rev === this.#keptAt && bytesOf(index.entries) <= INDEX_CACHE_MAX_BYTES)
      this.#kept.set(key, index);
    return { ok: index };
  }
}
