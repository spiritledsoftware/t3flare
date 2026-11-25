// SPI-1389: the park of one CLI session (`park.ts`) over fakes: what a park keeps and shows, what it does when its
// records cannot be kept, a card raised while the park ends the turn, and an allowance's life across a steered answer.
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";

import type { LiveTurn } from "../src/provider/cli/cardEvents.ts";
import type { CliAnswer, CliAsk } from "../src/provider/cli/cliAsk.ts";
import { parkedCallText, parker, type ParkableCard } from "../src/provider/cli/park.ts";
import { type ParkedCards, parkedCards } from "../src/provider/cli/parked.ts";
import { nodeSqlStorage } from "./nodeSqlStorage.ts";

const THREAD = "thread-park";
const askOf = (title: string, argsHash: string): CliAsk => ({
  askId: title,
  summary: title,
  detail: "",
  options: [],
  title,
  park: { kind: "tool", call: { tool: "fixture/fixture_note", argsHash } },
});

/** One session's parker over fakes: its cards, what it showed and answered, and its turn's interrupt held open. */
const fixture = Effect.fn("fixture")(function* (store: ParkedCards | undefined) {
  const cards = new Map<string, ParkableCard>();
  const answers = new Map<string, CliAnswer>();
  const shown: Array<ProviderAdapterV2Event> = [];
  const interrupted = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let kills = 0;
  let live: LiveTurn | undefined = {
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
      respondToRuntimeRequest: () => Effect.void,
      // The CLI takes a while to end its interrupted turn: the park's window.
      interruptTurn: () => Deferred.succeed(interrupted, undefined).pipe(Effect.andThen(Deferred.await(release))),
    },
    parkAfterMs: () => 0,
    parked: () => store,
    answerParkedChange: async () => "",
    nativeCallOf: () => undefined,
    kill: () => void kills++,
    processKey: () => "proc-1",
    now: () => 1000,
    ours: (id) => id.includes(":t3flare-"),
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
    questions,
    open,
    interrupted,
    release,
    kills: () => kills,
    endTurn: () => {
      live = undefined;
      park.turnEnded();
    },
  };
});

const run = <A>(body: Effect.Effect<A>) => Effect.runPromise(body);
const cause = { by: "park", minutes: 10 } as const;

describe("the park (SPI-1389)", () => {
  it("keeps every card's record first, then shows its question, answers its held call, and ends the process", () =>
    run(
      Effect.gen(function* () {
        const store = parkedCards(nodeSqlStorage());
        const f = yield* fixture(store);
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
        const store = parkedCards(nodeSqlStorage());
        const f = yield* fixture(store);
        f.open("card-1", askOf("note one", "h1"));
        const parking = yield* f.park.park(cause).pipe(Effect.forkChild);
        yield* Deferred.await(f.interrupted);
        // The CLI raises another card before its interrupted turn ends.
        f.open("card-2", askOf("note two", "h2"));
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(f.answers.get("card-2")).toEqual({ approved: false, parked: parkedCallText(cause, "tool") });
        expect(f.questions()).toHaveLength(2);
        expect(f.questions().map((id) => store.get(id)?.call?.argsHash)).toEqual(["h1", "h2"]);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(parking);
        expect(f.kills()).toBe(1);
      }),
    ));

  it("parks nothing when a record cannot be kept: every card stays live and the process runs on", () =>
    run(
      Effect.gen(function* () {
        const real = parkedCards(nodeSqlStorage());
        let writes = 0;
        // The second record's write fails: the first is dropped again, and nothing is shown.
        const failing: ParkedCards = {
          ...real,
          park: (card) => {
            writes += 1;
            if (writes === 2) throw new Error("storage reset");
            real.park(card);
          },
        };
        const f = yield* fixture(failing);
        f.open("card-1", askOf("note one", "h1"));
        f.open("card-2", askOf("note two", "h2"));
        yield* f.park.park(cause);
        expect(f.questions()).toEqual([]);
        expect(f.answers.size).toBe(0);
        expect([...f.cards.keys()]).toEqual(["card-1", "card-2"]);
        expect(f.kills()).toBe(0);
        expect(real.nativeSessions()).toEqual([]);
        // With no store at all, the same.
        const none = yield* fixture(undefined);
        none.open("card-1", askOf("note one", "h1"));
        yield* none.park.park(cause);
        expect([none.questions(), none.kills()]).toEqual([[], 0]);
      }),
    ));

  it("keeps a steered answer's allowance past the interrupted turn's end, for the restarted turn; an answer turn's goes at its end", () =>
    run(
      Effect.gen(function* () {
        const store = parkedCards(nodeSqlStorage());
        const f = yield* fixture(store);
        const call = { tool: "fixture/fixture_note", argsHash: "h1" };
        const parkCard = (id: string) =>
          store.park({ id, thread: THREAD, kind: "tool", title: "note", call, parkedAt: 1 });
        const answer = (id: string, steered: boolean) =>
          f.park.answerText({ messageId: `async-answer:${id}`, text: "Parked\nAllow" }, steered);
        parkCard("runtime-request:claudeAgent:t3flare-park:1");
        yield* answer("runtime-request:claudeAgent:t3flare-park:1", true);
        // Claude Code and OpenCode take a steer as an interrupt and a restart: the interrupted turn ends first.
        f.park.turnEnded();
        expect(store.take(THREAD, "tool", call)).toEqual({ forSession: false });
        parkCard("runtime-request:claudeAgent:t3flare-park:2");
        yield* answer("runtime-request:claudeAgent:t3flare-park:2", true);
        f.park.turnEnded();
        f.park.turnEnded();
        expect(store.take(THREAD, "tool", call)).toBeUndefined();
        // An answer that starts its own turn: its allowance goes when that turn ends unused.
        parkCard("runtime-request:claudeAgent:t3flare-park:3");
        yield* answer("runtime-request:claudeAgent:t3flare-park:3", false);
        f.park.turnEnded();
        expect(store.take(THREAD, "tool", call)).toBeUndefined();
      }),
    ));
});
