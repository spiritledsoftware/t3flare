import { describe, expect, it } from "vitest";

import {
  placeSecretFile,
  SECRET_FILE_TTL_MS,
  SECRET_FILES_DIR,
  type SecretFileDeps,
  sweepSecretFiles,
} from "../src/workspace/secretFiles.ts";

const NAME = "0123456789abcdef0123456789abcdef";

const fakeWorkspace = (now: number) => {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  let pushes = 0;
  const deps: SecretFileDeps = {
    now: () => now,
    list: async (dir) =>
      [...files.entries()]
        .filter(([path]) => path.startsWith(`${dir}/`))
        .map(([path, file]) => ({ name: path.slice(dir.length + 1), mtimeMs: file.mtimeMs })),
    exists: async (path) => files.has(path),
    write: async (path, text) => void files.set(path, { text, mtimeMs: now }),
    remove: async (path) => void files.delete(path),
    push: async () => void (pushes += 1),
  };
  return { files, deps, pushes: () => pushes };
};

describe("placeSecretFile", () => {
  it("writes the file in the harness's directory once, and a retry gets it unchanged", async () => {
    const workspace = fakeWorkspace(1_000);
    expect(await placeSecretFile(workspace.deps, { name: NAME })).toEqual({ missing: true });
    const path = `${SECRET_FILES_DIR}/${NAME}`;
    expect(await placeSecretFile(workspace.deps, { name: NAME, text: "s3cret'$(id)" })).toEqual({ path });
    expect(workspace.files.get(path)?.text).toBe("s3cret'$(id)");
    expect(workspace.pushes()).toBe(1);
    expect(await placeSecretFile(workspace.deps, { name: NAME, text: "other" })).toEqual({ path });
    expect(await placeSecretFile(workspace.deps, { name: NAME })).toEqual({ path });
    expect(workspace.files.get(path)?.text).toBe("s3cret'$(id)");
    // Each answer with the path pushes again, so a retry after a failed push still reaches the Container.
    expect(workspace.pushes()).toBe(3);
  });

  it("sweeps t3's files past their day, and nothing else, on its own and before a write", async () => {
    const workspace = fakeWorkspace(10 * SECRET_FILE_TTL_MS);
    const old = `${SECRET_FILES_DIR}/${"f".repeat(32)}`;
    const fresh = `${SECRET_FILES_DIR}/${"e".repeat(32)}`;
    const other = `${SECRET_FILES_DIR}/notes.txt`;
    const seed = () => {
      workspace.files.set(old, { text: "a", mtimeMs: 9 * SECRET_FILE_TTL_MS - 1 });
      workspace.files.set(fresh, { text: "b", mtimeMs: 9 * SECRET_FILE_TTL_MS });
      workspace.files.set(other, { text: "c", mtimeMs: 0 });
    };
    seed();
    expect(await sweepSecretFiles(workspace.deps)).toBe(1);
    expect([...workspace.files.keys()].sort()).toEqual([fresh, other].sort());
    seed();
    await placeSecretFile(workspace.deps, { name: NAME, text: "v" });
    expect([...workspace.files.keys()].sort()).toEqual([fresh, `${SECRET_FILES_DIR}/${NAME}`, other].sort());
  });

  it("refuses a name t3 never makes", async () => {
    const workspace = fakeWorkspace(0);
    for (const name of ["../repo/.env", "ABC", `${NAME}/x`])
      expect(await placeSecretFile(workspace.deps, { name, text: "v" })).toHaveProperty("refused");
    expect(workspace.files.size).toBe(0);
  });
});
