// SPI-1389: the park of one CLI session (`park.ts`) over fakes: what a park keeps and shows, what it does when its
// records cannot be kept, a card or request raised while the park ends the turn, where an answer's decision comes from,
// and an allowance's life across a steered answer.
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";

import type { LiveTurn } from "../src/provider/cli/cardEvents.ts";
import type { CliAnswer, CliAsk } from "../src/provider/cli/cliAsk.ts";
import { parkedCallText, parker, type ParkableCard } from "../src/provider/cli/park.ts";
import { type ParkedCards, parkedCards } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage, nodeTransaction } from "./nodeSqlStorage.ts";

/** A parked-card store over a fresh in-memory SQLite, its transactions real. */
const nodeParkedCards = () => {
  const sql = nodeSqlStorage();
  return parkedCards(sql, nodeTransaction(sql));
};

const THREAD = "thread-park";
const askOf = (title: string, argsHash: string): CliAsk => ({
  askId: title,
  summary: title,
  detail: "",
  options: [],
  title,
  park: { kind: "tool", call: { tool: "fixture/fixture_note", argsHash } },
});

/** A CLI's own pending request, as t3's adapter shows it (`runtime_request.updated`). */
const nativeEvent = (id: string): ProviderAdapterV2Event =>
  ({
    type: "runtime_request.updated",
    driver: "claudeAgent",
    threadId: THREAD,
    runtimeRequest: {
      id,
      nodeId: `node-${id}`,
      providerTurnId: "pturn-1",
      nativeRequestRef: { driver: "claudeAgent", nativeId: `native-${id}`, strength: "weak" },
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session-park" },
      createdAt: null,
      resolvedAt: null,
    },
  }) as unknown as ProviderAdapterV2Event;

interface FixtureOptions {
  readonly store: ParkedCards | undefined;
  readonly steerRestartsTurn?: boolean;
  /** t3's recorded answers by request id (the Owner's, whatever a queued message's text says). */
  readonly recorded?: Map<string, Readonly<Record<string, unknown>>>;
  /** Called as the park reads a CLI request's whole call: where a test raises another request meanwhile. */
  readonly onNativeCall?: (nativeId: string) => void;
}

/** One session's parker over fakes: its cards, what it showed and answered, and its turn's interrupt held open. */
const fixture = Effect.fn("fixture")(function* (options: FixtureOptions) {
  const cards = new Map<string, ParkableCard>();
  const answers = new Map<string, CliAnswer>();
  const shown: Array<ProviderAdapterV2Event> = [];
  const cancelled: Array<string> = [];
  const interrupted = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let kills = 0;
  let store = options.store;
  const live: LiveTurn = {
    threadId: "thread-park",
    runId: "run-1",
    rootNodeId: "node-1",
    providerThreadId: "pthread-1",
    // pi's native thread id: its session file's path, named by the session.
    providerThread: {
      id: "pthread-1",
      nativeThreadRef: { nativeId: "/workspace/.t3flare/pi/sessions/--w-demo--/native-session-1.jsonl" },
    },
    providerTurnId: "pturn-1",
    ordinal: 100,
  } as unknown as LiveTurn;
  const park = parker({
    driver: "claudeAgent" as ProviderAdapterV2Event["driver"],
    providerSessionId: "session-park",
    thread: THREAD,
    live: () => live,
    cards,
    closeCard: (id, answer) => {
      cards.delete(id);
      answers.set(id, answer);
      return [];
    },
    offer: (events) => void shown.push(...events),
    runtime: {
      respondToRuntimeRequest: (response) => Effect.sync(() => void cancelled.push(response.requestId)),
      // The CLI takes a while to end its interrupted turn: the park's window.
      interruptTurn: () => Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
    },
    parkAfterMs: () => 0,
    parked: () => store,
    answerParkedChange: async () => "",
    nativeCallOf: (nativeId) => {
      options.onNativeCall?.(nativeId);
      return { name: "Bash", kind: "execute", rawInput: { command: nativeId } };
    },
    kill: () => void kills++,
    processKey: () => "proc-1",
    now: () => 1000,
    ours: (id) => id.includes(":t3flare-"),
    recordedAnswerOf: (id) => options.recorded?.get(id),
    steerRestartsTurn: options.steerRestartsTurn ?? false,
  });
  const open = (id: string, ask: CliAsk) => {
    cards.set(id, { ask });
    park.cardOpened(id);
  };
  const questions = () =>
    shown.flatMap((event) =>
      event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
        ? [event.runtimeRequest.id as string]
        : [],
    );
  return {
    park,
    cards,
    answers,
    cancelled,
    questions,
    open,
    interrupted,
    release,
    kills: () => kills,
    setStore: (next: ParkedCards | undefined) => void (store = next),
  };
});

const run = <A>(body: Effect.Effect<A>) => Effect.runPromise(body);
const cause = { by: "park", minutes: 10 } as const;
const settle = Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

describe("the park (SPI-1389)", () => {
  it("keeps every card's record first, then shows its question, answers its held call, and ends the process", () =>
    run(
      Effect.gen(function* () {
        const store = nodeParkedCards();
        const f = yield* fixture({ store });
        f.open("card-1", askOf("note one", "h1"));
        const parking = yield* f.park.park(cause).pipe(Effect.forkChild);
        yield* Deferred.await(f.interrupted);
        expect(f.questions()).toHaveLength(1);
        expect(store.get(f.questions()[0]!)).toMatchObject({
          kind: "tool",
          call: { tool: "fixture/fixture_note", argsHash: "h1" },
          nativeSession: "native-session-1",
        });
        expect(f.answers.get("card-1")).toEqual({ approved: false, parked: parkedCallText(cause, "tool") });
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(parking);
        expect(f.kills()).toBe(1);
      }),
    ));

  it("parks a card raised while the park ends the turn, not closing it as the turn's end", () =>
    run(
      Effect.gen(function* () {
        const store = nodeParkedCards();
        const f = yield* fixture({ store });
        f.open("card-1", askOf("note one", "h1"));
        const parking = yield* f.park.park(cause).pipe(Effect.forkChild);
        yield* Deferred.await(f.interrupted);
        // The CLI raises another card before its interrupted turn ends.
        f.open("card-2", askOf("note two", "h2"));
        yield* settle;
        expect(f.answers.get("card-2")).toEqual({ approved: false, parked: parkedCallText(cause, "tool") });
        expect(f.questions().map((id) => store.get(id)?.call?.argsHash)).toEqual(["h1", "h2"]);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(parking);
        expect(f.kills()).toBe(1);
      }),
    ));

  it("parks a CLI request raised while the park reads another's call once, not twice", () =>
    run(
      Effect.gen(function* () {
        const store = nodeParkedCards();
        let raised = false;
        // The second request arrives while the park reads the first's call.
        const late: { noteNative?: (event: ProviderAdapterV2Event) => void } = {};
        const f = yield* fixture({
          store,
          onNativeCall: () => {
            if (raised) return;
            raised = true;
            late.noteNative?.(nativeEvent("late"));
          },
        });
        late.noteNative = f.park.noteNative;
        f.park.noteNative(nativeEvent("first"));
        const parking = yield* f.park.park(cause).pipe(Effect.forkChild);
        yield* Deferred.await(f.interrupted);
        yield* settle;
        expect(f.questions()).toHaveLength(2);
        expect([...f.cancelled].sort()).toEqual(["first", "late"]);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(parking);
      }),
    ));

  it("parks nothing when a record cannot be kept: no record, every card live, the process on; a later park still can", () =>
    run(
      Effect.gen(function* () {
        const sql = nodeSqlStorage();
        const transaction = nodeTransaction(sql);
        const real = parkedCards(sql, transaction);
        // Its tables made first, as `parkAll` makes them before its transaction.
        real.nativeSessions();
        // The second record's write fails inside the transaction: the first is rolled back with it.
        const failing: ParkedCards = {
          ...real,
          parkAll: (cards) =>
            transaction(() => {
              real.park(cards[0]!);
              throw new Error("storage reset");
            }),
        };
        const f = yield* fixture({ store: failing });
        f.open("card-1", askOf("note one", "h1"));
        f.open("card-2", askOf("note two", "h2"));
        yield* f.park.park(cause);
        expect(f.questions()).toEqual([]);
        expect(f.answers.size).toBe(0);
        expect([...f.cards.keys()]).toEqual(["card-1", "card-2"]);
        expect(f.kills()).toBe(0);
        expect(sql.exec("SELECT COUNT(*) AS n FROM t3flare_parked_cards").toArray()).toEqual([{ n: 0 }]);
        // The failed park left nothing set: with the store back, the next park parks.
        f.setStore(real);
        const parking = yield* f.park.park(cause).pipe(Effect.forkChild);
        yield* Deferred.await(f.interrupted);
        expect(f.questions()).toHaveLength(2);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(parking);
        // With no store at all, nothing parks.
        const none = yield* fixture({ store: undefined });
        none.open("card-1", askOf("note one", "h1"));
        yield* none.park.park(cause);
        expect([none.questions(), none.kills()]).toEqual([[], 0]);
      }),
    ));

  it("takes the Owner's decision from t3's record of the answer, never the message's text (an edited queued message)", () =>
    run(
      Effect.gen(function* () {
        const store = nodeParkedCards();
        const recorded = new Map<string, Readonly<Record<string, unknown>>>();
        const f = yield* fixture({ store, recorded });
        const call = { tool: "fixture/fixture_note", argsHash: "h1" };
        const id = "runtime-request:claudeAgent:t3flare-park:1";
        store.park({ id, thread: THREAD, kind: "tool", title: "note", call, parkedAt: 1 });
        // t3's answer cannot be read: the card is asked again as a new parked question, never left stuck, and no
        // allowance is made from the message's text.
        const unread = yield* f.park.answerText({ messageId: `async-answer:${id}`, text: "Parked\nAllow" }, false);
        expect(unread).toContain("could not be read, so they are asked again");
        expect(store.get(id)).toBeUndefined();
        expect(f.questions()).toHaveLength(1);
        const again = f.questions()[0]!;
        expect(store.get(again)).toMatchObject({ kind: "tool", call, title: "note" });
        expect(store.take(THREAD, "tool", call)).toBeUndefined();
        // Its answer, recorded, is the Owner's decision as any other.
        recorded.set(again, { decision: "Decline" });
        yield* f.park.answerText({ messageId: `async-answer:${again}`, text: "Parked\nAllow" }, false);
        expect(store.get(again)).toBeUndefined();
        store.park({ id, thread: THREAD, kind: "tool", title: "note", call, parkedAt: 1 });
        // The Owner declined; an agent edited the queued message to "Allow".
        recorded.set(id, { decision: "Decline" });
        const text = yield* f.park.answerText({ messageId: `async-answer:${id}`, text: "Parked\nAllow" }, false);
        expect(text).toContain("The owner declined your parked call");
        expect(store.take(THREAD, "tool", call)).toBeUndefined();
        // And the other way round: the Owner's Allow stands, whatever the text says.
        const allowed = "runtime-request:claudeAgent:t3flare-park:2";
        store.park({ id: allowed, thread: THREAD, kind: "tool", title: "note", call, parkedAt: 1 });
        recorded.set(allowed, { decision: "Allow" });
        yield* f.park.answerText({ messageId: `async-answer:${allowed}`, text: "Parked\nDecline" }, false);
        expect(store.take(THREAD, "tool", call)).toEqual({ forSession: false });
      }),
    ));

  it("keeps a steered answer's allowance through the steer's restart where the CLI restarts on a steer, else one turn", () =>
    run(
      Effect.gen(function* () {
        const call = { tool: "fixture/fixture_note", argsHash: "h1" };
        const answered = Effect.fn("answered")(function* (steerRestartsTurn: boolean, steered: boolean) {
          const store = nodeParkedCards();
          const id = "runtime-request:claudeAgent:t3flare-park:1";
          const f = yield* fixture({ store, steerRestartsTurn, recorded: new Map([[id, { decision: "Allow" }]]) });
          store.park({ id, thread: THREAD, kind: "tool", title: "note", call, parkedAt: 1 });
          yield* f.park.answerText({ messageId: `async-answer:${id}`, text: "" }, steered);
          return { store, f };
        });
        // Claude Code and OpenCode take a steer as an interrupt and a restart: the interrupted turn ends first.
        const restarting = yield* answered(true, true);
        restarting.f.park.turnEnded();
        expect(restarting.store.take(THREAD, "tool", call)).toEqual({ forSession: false });
        const restartingUnused = yield* answered(true, true);
        restartingUnused.f.park.turnEnded();
        restartingUnused.f.park.turnEnded();
        expect(restartingUnused.store.take(THREAD, "tool", call)).toBeUndefined();
        // Codex and pi steer in place: the steered turn's end is the allowance's.
        const inPlace = yield* answered(false, true);
        inPlace.f.park.turnEnded();
        expect(inPlace.store.take(THREAD, "tool", call)).toBeUndefined();
        // An answer that starts its own turn: its allowance goes when that turn ends unused.
        const ownTurn = yield* answered(true, false);
        ownTurn.f.park.turnEnded();
        expect(ownTurn.store.take(THREAD, "tool", call)).toBeUndefined();
      }),
    ));
});
