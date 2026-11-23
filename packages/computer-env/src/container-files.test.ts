// The Container's file operations run their real scripts here, in bash on this machine, which stands in for the
// Container; the "Workspace DO" side of the stage is the same disk.
// @effect-diagnostics nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ContainerAccess, ContainerFiles, GREP_OUTPUT_BYTES, LISTING_BYTES } from "./container-files.ts";
import { HostFailure } from "./failure.ts";

const hasRg = spawnSync("rg", ["--version"]).status === 0;

// The Container's GNU coreutils and findutils (`stat --printf`, `realpath -e`, `find -printf`), which a macOS host
// lacks; CI runs Linux and never skips.
const hasGnuTools =
  process.env["CI"] !== undefined ||
  (spawnSync("stat", ["--version"]).status === 0 && spawnSync("find", ["--version"]).status === 0);

let root: string;
let running: boolean;

/** Whether each script run was said to write. */
let writes: boolean[];

const access: ContainerAccess = {
  patterns: async () => ["**/node_modules"],
  running: () => running,
  run: async (script, env, options) => {
    writes.push(options?.writes === true);

    const ran = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      // Above node's 1 MiB default, so a grep's whole bounded output arrives.
      maxBuffer: 64 * 1024 * 1024,
    });

    return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  },
};

const files = (over: ContainerAccess = access) =>
  new ContainerFiles(
    over,
    {
      read: async (path) => new Uint8Array(readFileSync(path)),
      write: async (path, bytes) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, bytes);
      },
      remove: async (path) => rmSync(path, { force: true }),
    },
    join(root, ".stage"),
  );

/** The failure `operation` ends with: its code and message. */
const failure = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (cause) {
    if (cause instanceof HostFailure) return { code: cause.wire.code, message: cause.wire.message };

    throw cause;
  }

  throw new Error("it did not fail");
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "container-files-"));
  running = true;
  writes = [];
  mkdirSync(join(root, "pkg/node_modules/effect"), { recursive: true });
  writeFileSync(join(root, "pkg/node_modules/effect/package.json"), '{"name":"effect"}\n');
  writeFileSync(join(root, "pkg/index.ts"), "export const a = 1;\nexport const b = 2;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the Container's file operations", () => {
  it.skipIf(!hasGnuTools)(
    "give a file's or directory's metadata, and name the Container when there is nothing there",
    async () => {
      const info = await files().info(join(root, "pkg/index.ts"), true);

      expect(info).toMatchObject({ name: "index.ts", kind: "file", size: 40 });
      expect(Math.abs(info.mtimeMs - statSync(join(root, "pkg/index.ts")).mtimeMs)).toBeLessThan(2);
      expect((await files().info(join(root, "pkg"), true)).kind).toBe("directory");
      expect(await failure(files().info(join(root, "missing"), true))).toEqual({
        code: "not_found",
        message: "No such file or directory (on the Container)",
      });
    },
  );

  it.skipIf(!hasGnuTools)("read a file's bytes through the stage, and leave no stage behind", async () => {
    const read = await files().readFile(join(root, "pkg/node_modules/effect/package.json"));

    expect(text(read)).toBe('{"name":"effect"}\n');
    expect(spawnSync("ls", ["-A", join(root, ".stage")], { encoding: "utf8" }).stdout).toBe("");
    expect((await failure(files().readFile(join(root, "pkg")))).code).toBe("is_directory");
  });

  it("write a new file, making its parents, and append to it", async () => {
    const container = files();
    const path = join(root, "made/deep/out.txt");

    await container.writeFile(path, new TextEncoder().encode("one\n"), false);
    await container.writeFile(path, new TextEncoder().encode("two\n"), true);

    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
  });

  it.skipIf(!hasGnuTools)("say a write changes the Container's disk, and a read does not", async () => {
    const container = files();
    const path = join(root, "pkg/node_modules/new.txt");

    await container.writeFile(path, new TextEncoder().encode("one"), false);

    expect(writes).toEqual([true]);

    await container.readFile(path);
    await container.info(path, true);

    expect(writes).toEqual([true, false, false]);
  });

  it.skipIf(!hasGnuTools)("replace a file read before, keeping its mode", async () => {
    const container = files();
    const path = join(root, "run.sh");

    writeFileSync(path, "echo old\n");
    chmodSync(path, 0o755);

    await container.readFile(path);
    await container.writeFile(path, new TextEncoder().encode("echo new\n"), false);

    expect(readFileSync(path, "utf8")).toBe("echo new\n");
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!hasGnuTools)("refuse to replace a file that changed on the Container since it was read", async () => {
    const container = files();
    const path = join(root, "pkg/index.ts");

    await container.readFile(path);
    writeFileSync(path, "changed meanwhile\n");

    expect(await failure(container.writeFile(path, new TextEncoder().encode("edited\n"), false))).toEqual({
      code: "invalid",
      message: "The file changed on the Container since it was read: read it again (on the Container)",
    });
    expect(readFileSync(path, "utf8")).toBe("changed meanwhile\n");
  });

  it.skipIf(!hasGnuTools)("open a reader on a copy of the file, as it was, with the original's metadata", async () => {
    const path = join(root, "pkg/index.ts");

    const { opened, info } = await files().openReader(path, false, async (stage) => readFileSync(stage, "utf8"));

    expect(opened).toBe("export const a = 1;\nexport const b = 2;\n");
    expect(info).toMatchObject({ path, kind: "file", size: 40 });
  });

  it.skipIf(!hasGnuTools)(
    "list a directory, and a synced one's Container-only entries only while the Container runs",
    async () => {
      const container = files();

      expect(await container.readdir(join(root, "pkg/node_modules"))).toEqual([
        { name: "effect", isDirectory: true, isSymbolicLink: false },
      ]);

      // The temp directory stands outside the Workspace, so every entry there counts as the Container's.
      expect(await container.containerOnlyEntries(join(root, "pkg"))).toEqual(
        expect.arrayContaining([
          { name: "node_modules", isDirectory: true, isSymbolicLink: false, containerOnly: true },
        ]),
      );

      running = false;
      expect(await container.containerOnlyEntries(join(root, "pkg"))).toEqual([]);
    },
  );

  it.skipIf(!hasGnuTools)(
    "find the paths a glob matches below a directory, leaving out excluded directories, up to the limit",
    async () => {
      mkdirSync(join(root, "pkg/src/deep"), { recursive: true });
      writeFileSync(join(root, "pkg/src/deep/a.ts"), "");
      writeFileSync(join(root, "pkg/src/b.md"), "");

      const found = await files().find(join(root, "pkg"), "**/*.ts", {
        limit: 10,
        exclude: ["**/node_modules/**"],
      });

      expect(found.map((entry) => entry.path).sort()).toEqual([
        join(root, "pkg/index.ts"),
        join(root, "pkg/src/deep/a.ts"),
      ]);
      expect(
        await files().find(join(root, "pkg"), "**/*.ts", {
          limit: 1,
          exclude: ["**/node_modules/**"],
        }),
      ).toHaveLength(1);
    },
  );

  it.skipIf(!hasGnuTools)("list every entry of a directory, however many it has", async () => {
    mkdirSync(join(root, "many"));
    spawnSync("bash", ["-c", 'seq 1 20001 | sed "s/^/f/" | xargs touch'], { cwd: join(root, "many") });

    expect(await files().readdir(join(root, "many"))).toHaveLength(20_001);
  });

  it.skipIf(!hasGnuTools)(
    "find stops on the Container at the caller's limit, counting exact matches only",
    async () => {
      // find's `-path` is a superset of the glob: `*.ts` there matches `sub/x.ts` too, which the glob does not.
      mkdirSync(join(root, "tree/sub"), { recursive: true });
      mkdirSync(join(root, "tree/gen"), { recursive: true });

      for (const name of ["sub/x.ts", "sub/y.ts", "gen/a.ts", "gen/b.ts", "top.ts", "gen.ts"]) {
        writeFileSync(join(root, "tree", name), "");
      }

      const limits: string[] = [];
      const recording = files({
        ...access,
        run: async (script, env, options) => {
          if (env["LIMIT"] !== undefined) limits.push(env["LIMIT"]);

          return access.run(script, env, options);
        },
      });

      const top = await recording.find(join(root, "tree"), "*.ts", { limit: 2, exclude: [] });

      expect(top.map((entry) => entry.path).sort()).toEqual([join(root, "tree/gen.ts"), join(root, "tree/top.ts")]);
      expect(limits).toEqual(["2"]);

      // An exclude no directory name can prune is applied on the Container too, before the limit.
      const kept = await recording.find(join(root, "tree"), "**/*.ts", { limit: 4, exclude: ["gen/*.ts"] });

      expect(kept.map((entry) => entry.path).sort()).toEqual([
        join(root, "tree/gen.ts"),
        join(root, "tree/sub/x.ts"),
        join(root, "tree/sub/y.ts"),
        join(root, "tree/top.ts"),
      ]);
      expect(await recording.find(join(root, "tree"), "**/*.ts", { limit: 0, exclude: [] })).toEqual([]);
    },
  );

  it.skipIf(!hasGnuTools)(
    "find below a directory whose name has glob characters, and in a directory with spaces",
    async () => {
      mkdirSync(join(root, "app/[slug]/my dir"), { recursive: true });
      writeFileSync(join(root, "app/[slug]/my dir/page.tsx"), "");

      expect(
        await files().find(join(root, "app/[slug]"), "**/*.tsx", {
          limit: 10,
          exclude: ["**/node_modules/**", "**/my dir/**"],
        }),
      ).toEqual([]);
      expect(await files().find(join(root, "app/[slug]"), "**/*.tsx", { limit: 10, exclude: [] })).toEqual([
        { path: join(root, "app/[slug]/my dir/page.tsx"), type: "file" },
      ]);
    },
  );

  it.skipIf(!hasRg)(
    "grep inside an excluded directory, the excludes counting from the searched directory",
    async () => {
      mkdirSync(join(root, "pkg/node_modules/effect/node_modules/inner"), { recursive: true });
      writeFileSync(join(root, "pkg/node_modules/effect/node_modules/inner/x.json"), '"effect"');

      const directory = join(root, "pkg/node_modules/effect");

      expect(
        await files().grep("effect", directory, {
          ignoreCase: false,
          regex: false,
          context: 0,
          limit: 10,
          include: undefined,
          exclude: ["**/node_modules/**"],
        }),
      ).toEqual([{ path: join(directory, "package.json"), line: 1, text: '{"name":"effect"}' }]);
    },
  );

  it.skipIf(!hasRg)("grep lines with their context, as a literal or ignoring case", async () => {
    const path = join(root, "pkg/index.ts");

    expect(
      await files().grep("CONST B", path, {
        ignoreCase: true,
        regex: true,
        context: 1,
        limit: 10,
        include: undefined,
        exclude: [],
      }),
    ).toEqual([
      {
        path,
        line: 2,
        text: "export const b = 2;",
        context: [
          { line: 1, text: "export const a = 1;", isMatch: false },
          { line: 2, text: "export const b = 2;", isMatch: true },
        ],
      },
    ]);

    expect(
      await files().grep("a = 1.", join(root, "pkg"), {
        ignoreCase: false,
        regex: false,
        context: 0,
        limit: 10,
        include: undefined,
        exclude: [],
      }),
    ).toEqual([]);
  });
});

describe("grep's bounds (SPI-1361)", () => {
  it.skipIf(!hasRg)(
    "takes any context, showing the lines the file has",
    async () => {
      const path = join(root, "pkg/index.ts");
      const found = await files().grep("const b", path, {
        ignoreCase: false,
        regex: false,
        context: 1_000_000_000,
        limit: 10,
        include: undefined,
        exclude: [],
      });
      expect(found[0]?.context?.map((line) => line.line)).toEqual([1, 2]);
      // A walk over the whole range would take far longer than this.
    },
    5_000,
  );

  // A 200,000-line file with context 1,000 and limit 1,000,000 makes ripgrep emit more than GREP_OUTPUT_BYTES of events,
  // which the bound must cut, so it cannot shrink. It takes about 3 s alone but 30-40 s under the full check's load on
  // CI runners, past vitest's 30 s default, hence its own timeout.
  it.skipIf(!hasRg)(
    "reads at most GREP_OUTPUT_BYTES of ripgrep's events, whatever the limit and context",
    async () => {
      const path = join(root, "big.txt");
      writeFileSync(path, "match this line\n".repeat(200_000));
      const found = await files().grep("match", path, {
        ignoreCase: false,
        regex: false,
        context: 1_000,
        limit: 1_000_000,
        include: undefined,
        exclude: [],
      });
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThan(200_000);
      // Each event is a JSON object of well over 64 bytes, so the matches read fit the byte bound.
      expect(found.length * 64).toBeLessThan(GREP_OUTPUT_BYTES);
    },
    120_000,
  );
});

// ADR-0032 §7: a Container-only path's file operation whose Container start the budget refused shows the whole refusal,
// not computer's outer message, which it cuts at 240 characters (shorter after `priorExit=`, as met on stage).
describe("a refused Container start", () => {
  const REASON = "Container budget (1) reached: raise it at /_t3flare/settings#environment";
  const refused: ContainerAccess = {
    patterns: async () => ["**/node_modules"],
    running: () => false,
    run: async () => {
      const inner = new Error(`t3flare: the Container cannot start: ${REASON}`);
      const backend = new Error(
        `ContainerBackend(container-shell): connect failed at stage=start priorExit="Container exited with unexpected ex lastError=t3flare: the Container cannot start: Container budget (1`,
        { cause: inner },
      );
      throw new Error("WorkspaceTransportError: shell.exec failed after 1 reconnect retry", { cause: backend });
    },
  };

  it("is shown whole by a file tool on a Container-only path", async () => {
    const stage = { read: async () => new Uint8Array(), write: async () => undefined, remove: async () => undefined };
    const failed = await failure(
      new ContainerFiles(refused, stage, "/tmp/stage").readFile("/workspace/repo/node_modules/x/index.js"),
    );
    expect(failed).toEqual({
      code: "unknown",
      message: `The Container could not run the file operation: t3flare: the Container cannot start: ${REASON}`,
    });
  });
});

describe("a listing's byte bound (SPI-1364)", () => {
  /** A Container whose listing scripts answer `stdout`, recording the env each script ran with. */
  const answering = (stdout: string) => {
    const envs: Array<Readonly<Record<string, string>>> = [];
    const access: ContainerAccess = {
      patterns: async () => ["**/node_modules"],
      running: () => true,
      run: async (_script, env) => {
        envs.push(env);
        return { exitCode: 0, stdout, stderr: "" };
      },
    };
    return { envs, access };
  };

  it("reads one byte past LISTING_BYTES, which fits a DO RPC message as UTF-16", async () => {
    const run = answering("f\ta\n");
    await files(run.access).readdir("/workspace/repo/node_modules");
    await files(run.access).find("/workspace/repo/node_modules", "**", { limit: 10, exclude: [] });
    expect(run.envs.map((env) => env.BYTES)).toEqual([String(LISTING_BYTES + 1), String(LISTING_BYTES + 1)]);
    expect(LISTING_BYTES * 2).toBeLessThan(32 * 1024 * 1024);
  });

  it("fails a listing that reached the bound, saying so, rather than answering it cut", async () => {
    const line = "f\tsome-file-name.txt\n";
    const run = answering(line.repeat(Math.ceil((LISTING_BYTES + 1) / line.length)).slice(0, LISTING_BYTES + 1));
    for (const listing of [
      files(run.access).readdir("/workspace/repo/node_modules"),
      files(run.access).find("/workspace/repo/node_modules", "**", { limit: 1_000_000, exclude: [] }),
    ])
      expect(await failure(listing)).toMatchObject({
        message: expect.stringContaining(`The listing is more than ${LISTING_BYTES} bytes`),
      });
  });
});
