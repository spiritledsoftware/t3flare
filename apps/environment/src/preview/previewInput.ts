// @effect-diagnostics globalConsole:off globalDate:off
// SPI-1448 (A7, refines ADR-0021 and ADR-0031; fragility U113): the Owner's input in a preview tab is Workspace input,
// as Terminal typing is. A Layer over t3's `ServerBrowser` (ADR-0001) wraps each viewer `attachViewer` hands out: the
// server browser stream (`ServerBrowserStream.ts`) gives a viewer only an Owner client's messages, and only while it may
// operate the tab. Mouse, keys, wheel and inserted text there are noted on the tab's Workspace DO
// (`noteOwnerPreviewInput`), where they hold the running Container as Terminal input does
// (`apps/agents/src/workspace/previewInput.ts`). Navigation, screencast acks, resize and the viewport are not input, and
// an agent's `preview_*` calls never reach a viewer (its turn already holds the Container). A Workspace is noted at most
// once every 30 s, counted from a note its DO took; one it did not (no Container runs: noting starts nothing) or that
// failed is asked again at the next input. Nothing in noting ever keeps the Owner's input from reaching t3.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerBrowser from "t3/src/preview/ServerBrowser.ts";

import { environmentServices } from "../agents/bindings.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import { threadWorkspaceFrom } from "./portDiscovery.ts";

/**
 * The most often one Workspace's preview input is noted on its DO (the ticket's value). Guards the Workspace DO from an
 * RPC per mouse move; the hold it gives can end this much early, which the Owner accepted.
 */
export const PREVIEW_INPUT_NOTE_EVERY_MS = 30_000;

/**
 * The viewer messages t3 dispatches as the Owner's input (`dispatchViewerInput`): mouse, keys, wheel, inserted text, and
 * an option picked from a page's select menu (`selectMenu`, since v0.1.13).
 */
const OWNER_INPUT_TYPES: ReadonlySet<unknown> = new Set(["mouse", "key", "wheel", "text", "selectMenu"]);

export const isOwnerInput = (message: unknown): boolean =>
  typeof message === "object" && message !== null && OWNER_INPUT_TYPES.has((message as { type?: unknown }).type);

export interface PreviewInputNoterDeps {
  readonly now: () => number;
  /** The tab's thread's Workspace, or undefined for a thread in none. */
  readonly workspaceOf: (threadId: string) => string | undefined;
  /** The Workspace DO's `noteOwnerPreviewInput`: true when noted on its running Container, false when none runs. */
  readonly note: (workspace: string) => Promise<boolean>;
}

export interface PreviewInputNoter {
  /** Notes a viewer's message on a tab of `threadId` when it is input and its Workspace's window allows; never throws. */
  readonly noteInput: (threadId: string, message: unknown) => void;
  /** Resolves once every note sent so far has settled (tests). */
  readonly settled: () => Promise<void>;
}

const warnFailed = (workspace: string | undefined, cause: unknown) =>
  console.warn(
    JSON.stringify({
      t3flare: "preview-input-note-failed",
      workspace: workspace ?? null,
      error: cause instanceof Error ? cause.name : "error",
    }),
  );

export const makePreviewInputNoter = (deps: PreviewInputNoterDeps): PreviewInputNoter => {
  /** By Workspace: when a note its DO took was asked. Bounded by the Environment's Workspaces. */
  const notedAt = new Map<string, number>();
  /** Workspaces whose DO is being asked now: one note in flight each. */
  const asking = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const ask = (workspace: string, now: number) => {
    asking.add(workspace);
    // Through `then`, so a note that throws at once (no Workspace stub) fails as a rejected one does.
    const sent: Promise<void> = Promise.resolve()
      .then(() => deps.note(workspace))
      .then(
        (noted) => {
          if (noted === true) notedAt.set(workspace, now);
        },
        (cause: unknown) => warnFailed(workspace, cause),
      )
      .finally(() => {
        asking.delete(workspace);
        inFlight.delete(sent);
      });
    inFlight.add(sent);
  };
  return {
    noteInput: (threadId, message) => {
      let workspace: string | undefined;
      try {
        if (!isOwnerInput(message)) return;
        workspace = deps.workspaceOf(threadId);
        if (workspace === undefined || asking.has(workspace)) return;
        const now = deps.now();
        const last = notedAt.get(workspace);
        if (last !== undefined && now - last < PREVIEW_INPUT_NOTE_EVERY_MS) return;
        ask(workspace, now);
      } catch (cause) {
        warnFailed(workspace, cause);
      }
    },
    settled: async () => {
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
};

type Service = ServerBrowser.ServerBrowser["Service"];

/** t3's `ServerBrowser`, every method as t3 has it, with each viewer's messages also given to `noter` (never throws). */
export const withPreviewInputNotes = (real: Service, noter: PreviewInputNoter): Service =>
  ServerBrowser.ServerBrowser.of({
    ...real,
    attachViewer: Effect.fn("t3flare.ServerBrowser.attachViewer")(function* (input) {
      const viewer = yield* real.attachViewer(input);
      return {
        output: viewer.output,
        input: (message: unknown) =>
          Effect.andThen(
            Effect.sync(() => noter.noteInput(input.threadId, message)),
            viewer.input(message),
          ),
      };
    }),
  });

/** The Environment's noter: a thread's Workspace from t3's projection, noted through its Workspace DO's RPC. */
const environmentNoter = (): PreviewInputNoter =>
  makePreviewInputNoter({
    now: () => Date.now(),
    workspaceOf: (threadId) => threadWorkspaceFrom(environmentServices().sql)(threadId),
    note: (workspace) => workspaceRpc(workspace).noteOwnerPreviewInput(),
  });

/** Our Layer over t3's `ServerBrowser` (provide t3's `ServerBrowser.layer` under it). */
export const layerServerBrowserNotesInput = Layer.effect(
  ServerBrowser.ServerBrowser,
  Effect.map(ServerBrowser.ServerBrowser, (real) => withPreviewInputNotes(real, environmentNoter())),
);
