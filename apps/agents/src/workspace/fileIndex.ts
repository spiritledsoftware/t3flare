// SPI-1392: the Workspace's file index (FsOp `index`). The walk over computer's VFS stops one entry past what the
// answer could ever carry, so no array larger than that bound is built, and a cut answer names its limit. The last index
// of each path in the repo is kept for the repo's revision (the read cache's `repo` scope) when it is small, and dropped
// when the revision moves.
import {
  type FoundEntry,
  type FoundIndex,
  type FsAnswer,
  fitFoundEntriesSized,
  MIN_FOUND_ENTRY_BYTES,
  REPO_ROOT,
} from "@t3flare/workspace-client";

/**
 * The most entries an index of `maxBytes` can hold: `maxBytes` over the smallest entry (Owner-approved, 2026-11-24;
 * about 500k for `INDEX_MAX_BYTES`). The walk goes one past it, which `fitFoundEntries` can never keep, so the cut shows.
 */
export const indexWalkLimit = (maxBytes: number): number => Math.floor(maxBytes / MIN_FOUND_ENTRY_BYTES);

/**
 * The largest index kept between calls, in `foundEntryBytes`. Nothing forces 8 MiB: it is the Owner's chosen bound
 * (Owner-approved, 2026-11-24; ADR-0048's SPI-1368 refinement), so a cached index takes a small share of the Workspace
 * DO's 128 MB isolate. A larger index is answered, and walked again each time.
 */
export const INDEX_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface FileIndexDeps {
  /** Every entry under `path`, the walk stopping after `limit` (computer's `find`, as `fileOps.find`). */
  readonly find: (path: string, limit: number) => Promise<FsAnswer<ReadonlyArray<FoundEntry>>>;
  /** The repo's revision (`readCache`'s `repo` scope): it moves on any change under `REPO_ROOT`; below 0 when unknown. */
  readonly revision: () => number;
}

/**
 * The `index` op takes any path in the Workspace, while the `repo` revision covers only `REPO_ROOT`: an index outside
 * it is never kept, as nothing would say when it went stale. (The Environment asks only under the repo today.)
 */
const inRepo = (path: string) => path === REPO_ROOT || path.startsWith(`${REPO_ROOT}/`);

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
  async read(path: string, maxBytes: number): Promise<FsAnswer<FoundIndex>> {
    const known = inRepo(path) ? this.#deps.revision() : undefined;
    // `readCache.revision` answers below 0 when its query failed: as `readCache.get` does, nothing is kept or reused.
    const rev = known !== undefined && known >= 0 ? known : undefined;
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
    const { index: fit, bytes } = fitFoundEntriesSized(found.ok, maxBytes);
    const index: FoundIndex = {
      ...fit,
      ...(fit.truncated
        ? {
            cut:
              `t3flare: the file index of ${path} is cut to ${fit.entries.length} entries: an index answer holds ` +
              `${maxBytes} bytes (a DO RPC message's 32 MiB), at most ${limit} entries`,
          }
        : {}),
      ...(rev === undefined ? {} : { revision: rev }),
    };
    // Kept at the revision from before the walk: a change while it ran makes the next call walk again.
    if (rev !== undefined && rev === this.#keptAt && bytes <= INDEX_CACHE_MAX_BYTES) this.#kept.set(key, index);
    return { ok: index };
  }
}
