// @effect-diagnostics nodeBuiltinImport:off
// SPI-1448: the Owner's input in a preview tab is Workspace input. Our Layer over t3's `ServerBrowser` notes it on the
// tab's Workspace DO, at most every 30 s per Workspace: mouse, keys, wheel and inserted text an Owner client's viewer
// sends; never navigation, screencast acks, resize, or an agent's `preview_*` calls (they never reach a viewer).
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
  withPreviewInputNotes,
} from "../src/preview/previewInput.ts";

type Service = ServerBrowser.ServerBrowser["Service"];

const WORKSPACES: Readonly<Record<string, string>> = { "thread-a": "ws-a", "thread-a2": "ws-a", "thread-b": "ws-b" };

/** A noter over a fake clock and Workspace DO; `running` says whether the Workspace's Container runs. */
const setup = (running: (workspace: string) => boolean = () => true) => {
  let now = 1_000_000;
  const notes: Array<string> = [];
  const held: Array<string> = [];
  const noter = makePreviewInputNoter({
    now: () => now,
    workspaceOf: (threadId) => WORKSPACES[threadId],
    note: async (workspace) => {
      notes.push(workspace);
      // As the Workspace DO's `previewInput`: a stopped Container notes nothing and starts nothing.
      if (!running(workspace)) return false;
      held.push(workspace);
      return true;
    },
  });
  return { noter, notes, held, advance: (ms: number) => void (now += ms) };
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

const MOUSE = { type: "mouse", action: "down", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1 };

describe("isOwnerInput", () => {
  it("counts mouse, keys, wheel and inserted text; nothing else a viewer sends", () => {
    for (const type of ["mouse", "key", "wheel", "text"]) expect(isOwnerInput({ type })).toBe(true);
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
    expect(types).toEqual(["key", "mouse", "text", "wheel", ...NOT_INPUT].toSorted(byName));
    for (const type of NOT_INPUT) expect(isOwnerInput({ type })).toBe(false);
  });
});

describe("the preview input noter", () => {
  it("notes a Workspace at most once every 30 s, each Workspace on its own", async () => {
    const { noter, notes, advance } = setup();
    noter.input("thread-a", MOUSE);
    noter.input("thread-a2", { type: "key" });
    noter.input("thread-b", { type: "wheel" });
    advance(PREVIEW_INPUT_NOTE_EVERY_MS - 1);
    noter.input("thread-a", { type: "text", text: "x" });
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-b"]);
    advance(1);
    noter.input("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a", "ws-b", "ws-a"]);
  });

  it("notes nothing for a message that is not input, or a thread in no Workspace", async () => {
    const { noter, notes } = setup();
    noter.input("thread-a", { type: "ack" });
    noter.input("thread-a", { type: "resize", width: 800, height: 600 });
    noter.input("thread-x", MOUSE);
    await noter.settled();
    expect(notes).toEqual([]);
  });

  it("input on a stopped Container starts nothing: the DO notes nothing, and a failed note is swallowed", async () => {
    const { noter, notes, held } = setup(() => false);
    noter.input("thread-a", MOUSE);
    await noter.settled();
    expect(notes).toEqual(["ws-a"]);
    expect(held).toEqual([]);
    const failing = makePreviewInputNoter({
      now: () => 0,
      workspaceOf: () => "ws-a",
      note: () => Promise.reject(new Error("unreachable")),
    });
    failing.input("thread-a", MOUSE);
    await expect(failing.settled()).resolves.toBeUndefined();
  });
});

describe("withPreviewInputNotes (the Layer over t3's ServerBrowser)", () => {
  it("the Owner's input in a tab reaches t3's viewer and extends the hold", async () => {
    const { noter, held } = setup();
    const { service, reached } = fakeBrowser();
    const wrapped = withPreviewInputNotes(service, noter);
    await Effect.runPromise(
      Effect.scoped(Effect.flatMap(attach(wrapped, "thread-a"), (viewer) => viewer.input(MOUSE))),
    );
    await noter.settled();
    expect(reached).toEqual([MOUSE]);
    expect(held).toEqual(["ws-a"]);
  });

  it("an open, untouched tab holds nothing, nor do its acks, resizes and navigation", async () => {
    const { noter, notes } = setup();
    const { service, reached } = fakeBrowser();
    const wrapped = withPreviewInputNotes(service, noter);
    const others = [{ type: "resize", width: 900, height: 700 }, { type: "viewport" }, { type: "navigate" }];
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(attach(wrapped, "thread-a"), (viewer) =>
          Effect.forEach(others, (message) => viewer.input(message), { discard: true }),
        ),
      ),
    );
    await noter.settled();
    expect(reached).toEqual(others);
    expect(notes).toEqual([]);
  });

  it("an agent's preview calls hold nothing: only a viewer's input is noted, and the rest is t3's own", async () => {
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
