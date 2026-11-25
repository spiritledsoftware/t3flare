// t3's secret files (`request_secret` with `delivery: "file"`, or a pasted `value`), in the Workspace whose Container runs
// the thread's commands (patch 0011): t3's own place, beside its secret store, is the Environment DO's, which no command
// can read. In the harness's directory, synced to the Container and never in the repo. Pure, deps injected.
import { HARNESS_ROOT } from "@t3flare/workspace-client";

/** Where they are, on the Workspace DO's side and in the Container alike. */
export const SECRET_FILES_DIR = `${HARNESS_ROOT}/secrets`;

/** As t3's own secret files: a file is swept a day after it was written (t3's `SECRET_REF_TTL_MS`). */
export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/** t3's file names: the first 32 hex digits of the request's HMAC. Nothing else is written or swept. */
const NAME = /^[0-9a-f]{32}$/;

export interface SecretFileDeps {
  readonly now: () => number;
  /** The directory's entries, or none when it is missing. */
  readonly list: (dir: string) => Promise<ReadonlyArray<{ readonly name: string; readonly mtimeMs: number }>>;
  readonly exists: (path: string) => Promise<boolean>;
  /** Writes the file owner-only, its directory with it. */
  readonly write: (path: string, text: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  /** Brings the write into a running Container now; one that starts later gets it as it starts. */
  readonly push: () => Promise<void>;
}

/** The file's path, `missing` when it is not there and no `text` was given, or the refusal of a name t3 never makes. */
export type SecretFileAnswer = { readonly path: string } | { readonly missing: true } | { readonly refused: string };

/**
 * Removes the secret files past their day; how many. The Workspace DO runs it at each wake, before any command, and at
 * each alarm while its Container runs, so no command reads one past its day.
 */
export const sweepSecretFiles = async (deps: Pick<SecretFileDeps, "now" | "list" | "remove">): Promise<number> => {
  const now = deps.now();
  let removed = 0;
  for (const entry of await deps.list(SECRET_FILES_DIR)) {
    if (!NAME.test(entry.name) || now - entry.mtimeMs <= SECRET_FILE_TTL_MS) continue;
    await deps.remove(`${SECRET_FILES_DIR}/${entry.name}`);
    removed += 1;
  }
  return removed;
};

/**
 * Secret file `name`: answered as it is when there, so a retry of the same request gets the file the first wrote,
 * unchanged; else written from `text`. Pushed to a running Container either way: a retry after a failed push finishes it.
 */
export const placeSecretFile = async (
  deps: SecretFileDeps,
  input: { readonly name: string; readonly text?: string },
): Promise<SecretFileAnswer> => {
  if (!NAME.test(input.name)) return { refused: `t3flare: not a secret file name: ${input.name}` };
  await sweepSecretFiles(deps);
  const path = `${SECRET_FILES_DIR}/${input.name}`;
  if (!(await deps.exists(path))) {
    if (input.text === undefined) return { missing: true };
    await deps.write(path, input.text);
  }
  await deps.push();
  return { path };
};
