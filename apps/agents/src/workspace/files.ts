// The Workspace DO's file operations for the Environment (step 2a plan, section 2): its own files only (computer's
// SQLite VFS), never the Container. Paths are inside the Workspace (`/workspace/…`); the Environment translates.
import type { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import type { DirEntry, FileKind, FileStat, FoundEntry, FsAnswer, FsError, GrepMatch } from "@t3flare/workspace-client";

const errorOf = (cause: unknown): FsError => {
  const code = (cause as { code?: unknown })?.code;
  const message = cause instanceof Error ? cause.message : String(cause);
  const known = ["ENOENT", "EEXIST", "ENOTDIR", "EISDIR", "ENOTEMPTY", "EINVAL"] as const;
  const fromCode = typeof code === "string" ? known.find((candidate) => candidate === code) : undefined;
  const fromMessage = known.find((candidate) => message.includes(candidate));
  return {
    error: fromCode ?? fromMessage ?? (/not found|no such/i.test(message) ? "ENOENT" : "EIO"),
    message: message.slice(0, 500),
  };
};

const run = async <A>(f: () => Promise<A>): Promise<FsAnswer<A>> => {
  try {
    return { ok: await f() };
  } catch (cause) {
    return errorOf(cause);
  }
};

const kindOf = (entry: { readonly isDirectory: boolean; readonly isSymbolicLink: boolean }): FileKind =>
  entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : "file";

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/** A slice of a file one Workspace DO reads for another's copy: its bytes, and whether it is the last; or the error. */
export type FileChunk = { readonly bytes: Uint8Array; readonly done: boolean } | { readonly error: string };

export const fileOps = (workspace: ComputerWorkspace) => {
  const fs = () => workspace.fs;
  return {
    stat: (path: string, follow = true): Promise<FsAnswer<FileStat>> =>
      run(async () => {
        const stat = follow ? await fs().stat(path) : await fs().lstat(path);
        return { kind: kindOf(stat), size: stat.size, mtimeMs: stat.mtime, mode: stat.mode };
      }),
    read: (path: string, range?: { readonly offset: number; readonly length: number }): Promise<FsAnswer<Uint8Array>> =>
      run(async () => {
        const stream = await fs().readFile(
          path,
          range === undefined ? {} : { byteOffset: range.offset, byteLength: range.length },
        );
        const chunks: Array<Uint8Array> = [];
        let total = 0;
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.byteLength;
        }
        return out;
      }),
    write: (
      path: string,
      data: Uint8Array | string,
      options: { readonly append?: boolean; readonly exclusive?: boolean } = {},
    ): Promise<FsAnswer<null>> =>
      run(async () => {
        await fs().mkdir(parentOf(path), { recursive: true });
        if (options.append === true) {
          // computer's file system has no append. Stream the file's bytes, then the new ones, back into it: computer
          // stages a streamed write's chunks and links them only once the stream ends, so the read finishes first, and
          // the file is never held whole in the isolate's memory. Bytes stay bytes, never decoded as text.
          const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
          const before = await fs()
            .readFile(path)
            .catch((cause: unknown) => {
              if (errorOf(cause).error === "ENOENT") return undefined;
              throw cause;
            });
          if (before === undefined) await fs().writeFile(path, bytes);
          else
            await fs().writeFile(
              path,
              before.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({ flush: (controller) => controller.enqueue(bytes) }),
              ),
            );
        } else {
          await fs().writeFile(path, data, options.exclusive === true ? { exclusive: true } : {});
        }
        return null;
      }),
    /**
     * Writes `to` from `readChunk`'s chunks, read in order and streamed into one write: the file is never held whole in
     * memory, and `to` is linked only once every chunk has arrived. The first error, if any.
     */
    copyIn: async (
      to: string,
      chunkBytes: number,
      readChunk: (offset: number, length: number) => Promise<FileChunk>,
    ): Promise<string | undefined> => {
      let offset = 0;
      let failed: string | undefined;
      const chunks = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const chunk = await readChunk(offset, chunkBytes);
          if ("error" in chunk) {
            failed = chunk.error;
            controller.error(new Error(chunk.error));
            return;
          }
          offset += chunk.bytes.byteLength;
          if (chunk.bytes.byteLength > 0) controller.enqueue(chunk.bytes);
          if (chunk.done) controller.close();
        },
      });
      const wrote = await run(async () => {
        await fs().mkdir(parentOf(to), { recursive: true });
        await fs().writeFile(to, chunks);
        return null;
      });
      return failed ?? ("ok" in wrote ? undefined : wrote.message);
    },
    readdir: (path: string): Promise<FsAnswer<ReadonlyArray<DirEntry>>> =>
      run(async () => (await fs().readdir(path)).map((entry) => ({ name: entry.name, kind: kindOf(entry) }))),
    mkdir: (path: string, recursive: boolean): Promise<FsAnswer<null>> =>
      run(async () => {
        await fs().mkdir(path, { recursive });
        return null;
      }),
    remove: (
      path: string,
      options: { readonly recursive?: boolean; readonly force?: boolean },
    ): Promise<FsAnswer<null>> =>
      run(async () => {
        await fs().rm(path, { recursive: options.recursive === true, force: options.force === true });
        return null;
      }),
    rename: (from: string, to: string): Promise<FsAnswer<null>> =>
      run(async () => {
        await fs().rename(from, to);
        return null;
      }),
    realPath: (path: string): Promise<FsAnswer<string>> =>
      run(async () => {
        // Resolve symlinks one segment at a time, inside the Workspace.
        let resolved = "";
        const parts = path.split("/").filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          const candidate = `${resolved}/${parts[i]}`;
          const stat = await fs().lstat(candidate);
          if (stat.isSymbolicLink) {
            const target = await fs().readlink(candidate);
            const absolute = target.startsWith("/") ? target : `${resolved}/${target}`;
            resolved = absolute.replace(/\/+$/, "");
          } else resolved = candidate;
        }
        return resolved === "" ? "/" : resolved;
      }),
    find: (
      directory: string,
      pattern: string | undefined,
      limit: number,
    ): Promise<FsAnswer<ReadonlyArray<FoundEntry>>> =>
      run(async () =>
        (await fs().find(directory, pattern, { limit, exclude: ["**/.git", "**/node_modules"] })).map((entry) => ({
          path: entry.path,
          kind: entry.type === "dir" ? "directory" : "file",
        })),
      ),
    grep: (
      pattern: string,
      directory: string,
      options: {
        readonly ignoreCase?: boolean;
        readonly regex?: boolean;
        readonly limit?: number;
        readonly include?: string;
      },
    ): Promise<FsAnswer<ReadonlyArray<GrepMatch>>> =>
      run(async () =>
        (await fs().grep(pattern, directory, options)).map((match) => ({
          path: match.path,
          line: match.line,
          text: match.text,
        })),
      ),
  };
};
