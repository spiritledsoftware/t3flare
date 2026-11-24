// @effect-diagnostics nodeBuiltinImport:off
// Patch 0009 (SPI-1391): t3's terminal Manager keeps each Terminal's whole history in memory (`BoundedTerminalHistory`),
// which the Environment's one 128 MB isolate could not hold at stock t3's 8 MiB for every open and kept Terminal. The
// Patch keeps the history in the Terminal's log file: memory holds only output not yet written, and a snapshot (open,
// attach, observe) reads the log's tail (`readHistoryTail`) plus that output. Vitest runs t3 unpatched, so the Patch is
// applied here as build.ts applies it, and the copy's `makeWithOptions` runs beside stock t3's over the same fake shells.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as v8 from "node:v8";
import * as vm from "node:vm";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as ProcessRunner from "t3/src/processRunner.ts";
import * as StockManager from "t3/src/terminal/Manager.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { terminalManagerOptions } from "../src/terminal/layer.ts";
import { TerminalProcesses } from "../src/terminal/ptyAdapter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const T3 = path.resolve(here, "../../../t3code");
const TERMINAL = path.join(T3, "apps/server/src/terminal");
const PATCH = path.resolve(here, "../../../patches/0009-terminal-history-lives-in-its-log.patch");
const SOURCE = "apps/server/src/terminal/Manager.ts";
const MiB = 1024 * 1024;

type Manager = StockManager.TerminalManager["Service"];
type MakeWithOptions = typeof StockManager.makeWithOptions;

let patchedMake: MakeWithOptions;
/** The patched copy's tree: inside the package (gitignored), so `effect` and `@t3tools/*` resolve from its node_modules. */
let work: string;
/** Each manager's logs directory lives here. */
let root: string;
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);
afterAll(async () => {
  await runtime.dispose();
  if (work !== undefined) fs.rmSync(work, { recursive: true, force: true });
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

beforeAll(async () => {
  fs.mkdirSync(path.resolve(here, "../dist"), { recursive: true });
  work = fs.mkdtempSync(path.resolve(here, "../dist/patch-0009-"));
  root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "t3flare-terminal-history-")));
  fs.mkdirSync(path.join(work, path.dirname(SOURCE)), { recursive: true });
  fs.copyFileSync(path.join(T3, SOURCE), path.join(work, SOURCE));
  // A repo of its own: inside t3flare's checkout, `git apply` would take the Patch's paths from t3flare's root and skip them.
  execFileSync("git", ["init", "-q", work]);
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", PATCH], { cwd: work, encoding: "utf8" });
  expect(applied.stderr).toBe("");
  expect(applied.status).toBe(0);
  // The copy's relative imports point at the pinned tree, so it shares t3's services and contracts.
  const file = path.join(work, SOURCE);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(
      /from "(\.\.?\/[^"]+)"/g,
      (_, specifier: string) => `from ${JSON.stringify(path.resolve(TERMINAL, specifier))}`,
    );
  fs.writeFileSync(file, text);
  expect(text).toContain("class TerminalHistoryLog");
  patchedMake = ((await import(/* @vite-ignore */ file)) as { makeWithOptions: MakeWithOptions }).makeWithOptions;
});

/** A shell that prints what the test emits and exits when told. */
class FakeShell implements PtyAdapter.PtyProcess {
  private readonly data = new Set<(data: string) => void>();
  private readonly exits = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void) {
    this.data.add(callback);
    return () => this.data.delete(callback);
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void) {
    this.exits.add(callback);
    return () => this.exits.delete(callback);
  }
  emit(data: string): void {
    for (const listener of this.data) listener(data);
  }
  exit(): void {
    for (const listener of this.exits) listener({ exitCode: 0, signal: 0 });
  }
}

interface Fixture {
  readonly manager: Manager;
  readonly logsDir: string;
  readonly shells: Array<FakeShell>;
  /** Emits so far, which number their markers alike in both managers. */
  emits: number;
}

let pids = 7000;
/** A manager over fake shells, with this Environment's history size and kept exited Terminals. */
const makeManager = Effect.fn("makeManager")(function* (make: MakeWithOptions, scope: Scope.Scope) {
  const ours = terminalManagerOptions(new TerminalProcesses({ newKey: () => "k", place: () => undefined }), "");
  const logsDir = fs.mkdtempSync(path.join(root, "logs-"));
  const shells: Array<FakeShell> = [];
  const manager = yield* make({
    logsDir,
    env: ours.env,
    shellResolver: ours.shellResolver,
    historyByteLimit: ours.historyByteLimit,
    maxRetainedInactiveSessions: ours.maxRetainedInactiveSessions,
    ptyAdapter: {
      spawn: () =>
        Effect.sync(() => {
          const shell = new FakeShell(pids++);
          shells.push(shell);
          return shell;
        }),
    },
    subprocessInspector: (pid) =>
      Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [pid] }),
    foregroundProcessGroup: (pid) => Effect.succeed(pid),
    processKillGraceMs: 1,
  }).pipe(
    Effect.provideService(SpawnExecutableResolution, (command) => command),
    Scope.provide(scope),
  );
  const fixture: Fixture = { manager, logsDir, shells, emits: 0 };
  return fixture;
});

const input = (terminalId: string) => ({ threadId: "thread-1", terminalId, cwd: root, cols: 100, rows: 24 });

/** Emits `chunks` on the shell and waits until the manager has taken them all (its output event of a marker). */
const emitAll = Effect.fn("emitAll")(function* (fixture: Fixture, shell: FakeShell, chunks: Iterable<string>) {
  const marker = `\u001b]0;done-${fixture.emits++}\u0007`;
  const taken = yield* Deferred.make<void>();
  const unsubscribe = yield* fixture.manager.subscribe((event) =>
    event.type === "output" && event.data === marker ? Deferred.succeed(taken, undefined) : Effect.void,
  );
  for (const chunk of chunks) shell.emit(chunk);
  shell.emit(marker);
  yield* Deferred.await(taken);
  unsubscribe();
});

/** The first snapshot a resumed attach gets, as a reconnecting client sees the Terminal. */
const attachSnapshot = Effect.fn("attachSnapshot")(function* (manager: Manager, terminalId: string) {
  const first = yield* Deferred.make<TerminalSessionSnapshot>();
  const stop = yield* manager.attachStream(
    { ...input(terminalId), resume: true },
    (event: TerminalAttachStreamEvent) =>
      event.type === "snapshot" ? Deferred.succeed(first, event.snapshot).pipe(Effect.asVoid) : Effect.void,
  );
  const snapshot = yield* Deferred.await(first);
  stop();
  return snapshot;
});

/** The bytes in a manager's log files. */
const logBytes = (logsDir: string) =>
  fs.readdirSync(logsDir).reduce((total, name) => total + fs.statSync(path.join(logsDir, name)).size, 0);

const run = <A, E>(
  program: (scope: Scope.Scope) => Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* program(scope).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

/** Lines of `width` bytes, each numbered, with colour and a multibyte character so a cut can land inside either. */
function* lines(count: number, width: number, from = 0): Generator<string> {
  for (let line = from; line < from + count; line++) {
    const head = `\u001b[3${line % 8}m${line}\u001b[0m é `;
    yield `${head}${"x".repeat(width - Buffer.byteLength(head) - 1)}\n`;
  }
}

describe("Patch 0009: Owner Terminals keep their history in storage (SPI-1391)", () => {
  it("gives a live and an exited Terminal the history stock t3 gives, up to 8 MiB", async () => {
    await run((scope) =>
      Effect.gen(function* () {
        const stock = yield* makeManager(StockManager.makeWithOptions, scope);
        const patched = yield* makeManager(patchedMake, scope);
        const both = [stock, patched];
        for (const fixture of both) {
          for (const id of ["live", "exited", "lines", "cleared"]) yield* fixture.manager.open(input(id));
        }
        const shell = (fixture: Fixture, index: number) => fixture.shells[index]!;
        // Past 8 MiB in long lines (the byte cap), past 5,000 lines in short ones (the line cap), cut mid-sequence.
        for (const fixture of both) {
          yield* emitAll(fixture, shell(fixture, 0), lines(2_600, 4_000));
          yield* emitAll(fixture, shell(fixture, 1), lines(2_200, 4_000));
          yield* emitAll(fixture, shell(fixture, 2), lines(7_000, 80));
          yield* emitAll(fixture, shell(fixture, 3), [...lines(100, 80), "\u001b[31", "mred\n"]);
          yield* fixture.manager.clear({ threadId: "thread-1", terminalId: "cleared" });
          yield* emitAll(fixture, shell(fixture, 3), lines(10, 80, 100));
        }
        const snapshots = (fixture: Fixture) =>
          Effect.forEach(["live", "exited", "lines", "cleared"], (id) =>
            attachSnapshot(fixture.manager, id).pipe(Effect.map((snapshot) => snapshot.history)),
          );

        // Before any write: the patched manager's history is all unwritten output.
        const stockHistories = yield* snapshots(stock);
        expect(Buffer.byteLength(stockHistories[0]!)).toBeGreaterThan(8 * MiB - 4_000);
        expect(Buffer.byteLength(stockHistories[0]!)).toBeLessThanOrEqual(8 * MiB);
        expect(stockHistories[2]!.split("\n")).toHaveLength(5_000);
        expect(yield* snapshots(patched)).toEqual(stockHistories);

        // After the writes, from the log file.
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(logBytes(patched.logsDir)).toBeGreaterThan(16 * MiB), { timeout: 10_000 }),
        );
        expect(yield* snapshots(patched)).toEqual(stockHistories);

        // Appended to twice the history size the log grows; past it, it is rewritten as its capped tail.
        const liveLog = (line: number) =>
          fs
            .readdirSync(patched.logsDir)
            .map((name) => path.join(patched.logsDir, name))
            .find((file) => fs.readFileSync(file, "utf8").includes(`${line}\u001b[0m é ${"x".repeat(200)}`));
        let liveAgain = "";
        for (const [from, size] of [
          [2_600, 16 * MiB],
          [5_200, 8 * MiB],
        ] as const) {
          for (const fixture of both) yield* emitAll(fixture, shell(fixture, 0), lines(2_600, 4_000, from));
          liveAgain = (yield* attachSnapshot(stock.manager, "live")).history;
          expect(liveAgain).toContain(`${from + 2_599}\u001b[0m`);
          expect((yield* attachSnapshot(patched.manager, "live")).history).toBe(liveAgain);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(fs.statSync(liveLog(from + 2_599)!).size).toBeLessThanOrEqual(size), {
              timeout: 10_000,
            }),
          );
          expect((yield* attachSnapshot(patched.manager, "live")).history).toBe(liveAgain);
        }

        for (const fixture of both) {
          const exited = yield* Deferred.make<void>();
          const unsubscribe = yield* fixture.manager.subscribe((event) =>
            event.type === "exited" ? Deferred.succeed(exited, undefined) : Effect.void,
          );
          shell(fixture, 1).exit();
          yield* Deferred.await(exited);
          unsubscribe();
        }
        const exited = yield* attachSnapshot(stock.manager, "exited");
        expect(exited.status).toBe("exited");
        expect(yield* attachSnapshot(patched.manager, "exited")).toMatchObject({
          status: "exited",
          history: exited.history,
        });
      }),
    );
  });

  it("holds no live Terminal's history in the isolate's memory", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const heapAfterGc = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const TERMINALS = 4;
    /** The heap a manager keeps after its Terminals each printed 8 MiB, written to their log files. */
    const heldBy = (make: MakeWithOptions) =>
      run((scope) =>
        Effect.gen(function* () {
          const fixture = yield* makeManager(make, scope);
          const before = heapAfterGc();
          for (let index = 0; index < TERMINALS; index++) {
            yield* fixture.manager.open(input(`t${index}`));
            yield* emitAll(fixture, fixture.shells[index]!, lines(2_048, 4_096));
          }
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(logBytes(fixture.logsDir)).toBeGreaterThanOrEqual(TERMINALS * 8 * MiB), {
              timeout: 10_000,
            }),
          );
          return heapAfterGc() - before;
        }),
      );

    // Stock t3 keeps all 32 MiB; the patched manager keeps none of it.
    expect(await heldBy(StockManager.makeWithOptions)).toBeGreaterThan(TERMINALS * 6 * MiB);
    expect(await heldBy(patchedMake)).toBeLessThan(2 * MiB);
  });
});
