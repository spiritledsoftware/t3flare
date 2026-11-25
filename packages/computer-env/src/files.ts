// `ComputerFiles`: the file search `ls`, `find`, and `grep` run on. Each search is one of the Workspace DO's file
// operations (`host.ts`), answered as plain data. Without `reachContainer` it sees only the Workspace's files and can
// never start a Container; the model's own tools ask for `reachContainer`, which runs a search of a Container-only path
// on the Container. pi-durable's tools are Promise-native and stay so; this adapter follows them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Call, caller } from "./client.ts";
import type { ComputerWorkspaceStub } from "./env.ts";
import type { DirectoryEntry, FindOptions, FoundEntry, GrepMatch, GrepOptions, Listed } from "./wire.ts";

export type { DirectoryEntry, FindOptions, FoundEntry, GrepLine, GrepMatch, GrepOptions, Listed } from "./wire.ts";

export type ComputerFilesOptions = {
  /** Whether a search of a Container-only path runs on the Container, starting it if it is stopped. */
  readonly reachContainer?: boolean;
};

/**
 * An answer as `Listed`: a Workspace DO deployed before SPI-1388 answers a bare array, which the Session, deployed
 * first or after, takes as it is.
 */
const listedOf = <T>(value: Listed<T> | readonly T[]): Listed<T> =>
  Array.isArray(value) ? { items: value } : (value as Listed<T>);

/** File search over a Workspace DO stub. */
export class ComputerFiles {
  readonly #call: Call;

  constructor(workspace: Pick<ComputerWorkspaceStub, "fileOperation">, options: ComputerFilesOptions = {}) {
    this.#call = caller(workspace, options.reachContainer === true);
  }

  /** Each answer within its byte bound; a cut one says so (`Listed.cut`). */
  async readdir(path: string): Promise<Listed<DirectoryEntry>> {
    const listed = await this.#call(BACKGROUND_CONTEXT, "readdir", path);

    if (!listed.ok) throw listed.error;

    return listedOf(listed.value);
  }

  async find(directory: string, pattern: string, options: FindOptions): Promise<Listed<FoundEntry>> {
    const found = await this.#call(BACKGROUND_CONTEXT, "find", directory, pattern, options);

    if (!found.ok) throw found.error;

    return listedOf(found.value);
  }

  async grep(pattern: string, path: string, options: GrepOptions): Promise<Listed<GrepMatch>> {
    const matched = await this.#call(BACKGROUND_CONTEXT, "grep", pattern, path, options);

    if (!matched.ok) throw matched.error;

    return listedOf(matched.value);
  }
}
