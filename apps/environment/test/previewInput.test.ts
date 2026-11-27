// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// SPI-1448: our Layer over t3's `ServerBrowser` notes the Owner's preview input on the tab's Workspace DO (module header
// of `src/preview/previewInput.ts`; fragility U113).
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as ServerBrowser from "t3/src/preview/ServerBrowser.ts";
import { describe, expect, it } from "vitest";

import {
  PREVIEW_INPUT_NOTE_EVERY_MS,
  isOwnerInput,
  makePreviewInputNoter,
  type PreviewInputNoterDeps,
  withPreviewInputNotes,
} from "../src/preview/previewInput.ts";

type Service = ServerBrowser.ServerBrowser["Service"];

const WORKSPACES: Readonly<Record<string, string>> = { "thread-a": "ws-a", "thread-a2": "ws-a", "thread-b": "ws-b" };

/**
 * A noter over a fake clock and Workspace DOs. `answer` is each DO's `noteOwnerPreviewInput`: true when noted on its
 * running Container, false when none runs (it starts nothing), or a failure.
 */
const setup = (answer: (workspace: string) => Promise<boolean> | boolean = () => true) => {
  let now = 1_000_000;
  const notes: Array<string> = [];
  const noter = makePreviewInputNoter({
    now: () => now,
    workspaceOf: (threadId) => WORKSPACES[threadId],
    note: async (workspace) => {
      notes.push(workspace);
      return answer(workspace);
    },
  });
  return { noter, notes, advance: (ms: number) => void (now += ms) };
};

/** t3's service stand-in: its viewers record what reaches them, and nothing else does anything. */
const fakeBrowser = () => {
  const reached: Array<unknown> = [];
  const service: Service = {
    attachViewer: Effect.fn("attachViewer")(function* () {
      const output = yield* Queue.unbounded<ServerBrowser.ServerBrowserViewerOutput>();
      return { output, input: (message: unknown) => Effect.sync(() => void reached.push(message)) };
    }),
    answerFileChooser: () => Effect.succeed(true),
    openDownload: () => Effect.succeedNone,
    clearProfile: () => Effect.void,
    profileReporter: Effect.succeed(() => Effect.void),
  };
  return { service, reached };
};

const attach = (service: Service, threadId: string) =>
  service.attachViewer({ threadId, tabId: "tab", maxWidth: 1280, maxHeight: 800, quality: 80, canOperate: true });

/** Each message through a viewer of the wrapped service, as t3's stream gives it an Owner client's. */
const send = (service: Service, threadId: string, messages: ReadonlyArray<unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(attach(service, threadId), (viewer) =>
        Effect.forEach(messages, (message) => viewer.input(message), { discard: true }),
      ),
    ),
  );

/** Lets the notes already asked for reach the fake DO. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const MOUSE = { type: "mouse", action: "down", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1 };

describe("isOwnerInput", () => {
  it("counts mouse, keys, wheel and inserted text; nothing else a viewer sends", () => {
    for (const type of ["mouse", "key", "wheel", "text", "selectMenu"]) expect(isOwnerInput({ type })).toBe(true);
    for (const type of ["ack", "resize", "viewport", "navigate", "reload", "back", "forward", "probe", "dialog"])
      expect(isOwnerInput({ type })).toBe(false);
    expect(isOwnerInput(null)).toBe(false);
    expect(isOwnerInput("mouse")).toBe(false);
  });
});

describe("t3's viewer messages (fragility U113)", () => {
  // Every message type t3's `dispatchViewerInput` handles is sorted here as input or not: a type a bump adds or renames
  // fails this test, so what counts as the Owner's input is decided, never drifted into.
  const NOT_INPUT = ["history", "navigate", "probe", "reload", "resize", "stopLoading", "viewport"];

  it("are each counted as input or not", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../../../t3code/apps/server/src/preview/ServerBrowser.ts"),
      "utf8",
    );
    const start = source.indexOf("const dispatchViewerInput = async");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  };\n", start));
    const byName = (a: string, b: string) => a.localeCompare(b);
    const types = [...new Set([...body.matchAll(/case "(\w+)":/g)].map((match) => String(match[1])))].toSorted(byName);
    expect(types).toEqual(["key", "mouse", "selectMenu", "text", "wheel", ...NOT_INPUT].toSorted(byName));
    for (const type of NOT_INPUT) expect(isOwnerInput({ type })).toBe(false);
  });
});

describe("the preview input noter", () => {
  it("notes a Workspace at most once every 30 s once its DO has noted it, each Workspace on its own", async () => {
    const { noter, notes, advance } = setup();
    noter.noteInput("thread-a", MOUSE);
    noter.noteInput("thread-b", { type: "wheel" });
    await noter.settled();
    noter.noteInput("thread-a2", { type: "key" });
    advance(PREVIEW_INPUT_NOTE_EVERY_MS - 1);
    noter.noteInput("thread-a", { type: "text", text: "x" });
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-b"]);
    advance(1);
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-b", "ws-a"]);
  });

  it("notes nothing for a message that is not input, or a thread in no Workspace", async () => {
    const { noter, notes } = setup();
    noter.noteInput("thread-a", { type: "ack" });
    noter.noteInput("thread-a", { type: "resize", width: 800, height: 600 });
    noter.noteInput("thread-x", MOUSE);
    await noter.settled();
    expect(notes).toEqual([]);
  });

  it("a note the DO did not take (no Container runs) keeps no window: the next input tries again", async () => {
    let running = false;
    const { noter, notes } = setup(() => running);
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-a"]);
    running = true;
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-a", "ws-a"]);
  });

  it("a failed note keeps no window either, and is swallowed", async () => {
    let fail = true;
    const { noter, notes } = setup(() => (fail ? Promise.reject(new Error("unreachable")) : true));
    noter.noteInput("thread-a", MOUSE);
    await expect(noter.settled()).resolves.toBeUndefined();
    fail = false;
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    noter.noteInput("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-a"]);
  });

  it("asks a Workspace's DO once at a time: input while a note is in flight waits on its answer", async () => {
    let release: (value: boolean) => void = () => undefined;
    const { noter, notes } = setup(() => new Promise<boolean>((resolve) => (release = resolve)));
    noter.noteInput("thread-a", MOUSE);
    noter.noteInput("thread-a", MOUSE);
    noter.noteInput("thread-a2", MOUSE);
    await flush();
    expect(notes).toEqual(["ws-a"]);
    release(false);
    await noter.settled();
    noter.noteInput("thread-a", MOUSE);
    await flush();
    expect(notes).toEqual(["ws-a", "ws-a"]);
    release(true);
    await noter.settled();
  });

  it("a note that throws at once (no Workspace stub) is swallowed, and keeps no window", async () => {
    const deps: PreviewInputNoterDeps = {
      now: () => 0,
      workspaceOf: () => "ws-a",
      note: () => {
        throw new Error("no binding");
      },
    };
    const noter = makePreviewInputNoter(deps);
    expect(() => noter.noteInput("thread-a", MOUSE)).not.toThrow();
    await expect(noter.settled()).resolves.toBeUndefined();
  });
});

describe("withPreviewInputNotes (the Layer over t3's ServerBrowser)", () => {
  it("the Owner's input in a tab reaches t3's viewer and is noted on its Workspace", async () => {
    const { noter, notes } = setup();
    const { service, reached } = fakeBrowser();
    await send(withPreviewInputNotes(service, noter), "thread-a", [MOUSE]);
    await noter.settled();
    expect(reached).toEqual([MOUSE]);
    expect(notes).toEqual(["ws-a"]);
  });

  it("an open, untouched tab notes nothing, nor do its acks, resizes and navigation", async () => {
    const { noter, notes } = setup();
    const { service, reached } = fakeBrowser();
    const others = [{ type: "resize", width: 900, height: 700 }, { type: "viewport" }, { type: "navigate" }];
    await send(withPreviewInputNotes(service, noter), "thread-a", others);
    await noter.settled();
    expect(reached).toEqual(others);
    expect(notes).toEqual([]);
  });

  it("nothing in noting stops the Owner's input reaching t3: a throwing Workspace lookup or note", async () => {
    const { service, reached } = fakeBrowser();
    const throwing = (what: "workspaceOf" | "note") =>
      makePreviewInputNoter({
        now: () => 0,
        workspaceOf: (threadId) => {
          if (what === "workspaceOf") throw new Error("projection unreadable");
          return WORKSPACES[threadId];
        },
        note: () => {
          throw new Error("no binding");
        },
      });
    await send(withPreviewInputNotes(service, throwing("workspaceOf")), "thread-a", [MOUSE]);
    await send(withPreviewInputNotes(service, throwing("note")), "thread-a", [MOUSE]);
    expect(reached).toEqual([MOUSE, MOUSE]);
  });

  it("an agent's preview calls note nothing: only a viewer's input is noted, and the rest is t3's own", async () => {
    const { noter, notes } = setup();
    const { service } = fakeBrowser();
    const wrapped = withPreviewInputNotes(service, noter);
    expect(wrapped.answerFileChooser).toBe(service.answerFileChooser);
    expect(wrapped.openDownload).toBe(service.openDownload);
    expect(wrapped.clearProfile).toBe(service.clearProfile);
    expect(wrapped.profileReporter).toBe(service.profileReporter);
    await Effect.runPromise(wrapped.clearProfile("profile"));
    await noter.settled();
    expect(notes).toEqual([]);
  });
});
