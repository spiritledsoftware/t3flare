// Adapted from ian-pascoe/pi-extensions@a5e15d1:packages/pi-guardian/src/guardian-evidence.ts (SPI-1058): the Guardian's
// reasoning-blind evidence and the Reviewed Call. Kept: user messages as Trusted Evidence, the agent's tool calls (names
// and arguments, origin `agentToolCalls`) as untrusted, everything else (the agent's text and reasoning, tool results,
// other extensions' messages) left out; each entry labeled and carried as JSON; the Reviewed Call rendered whole with its
// arguments' SHA-256, the issuing call of a nested call, and the other calls of its batch. Changed: evidence comes from
// the conversation's stored entries (pi-durable's History), t3's user messages are trusted unless the thread is linked
// work (another agent's message, as pi-guardian treats a Child Agent's), the Advisor's and the Terminals' notes are
// untrusted, and the untrusted window is the newest that fits a character budget, not pi-guardian's anchored window
// (no token calibration here). There are no Skills, delegations or User Overrides to carry.
import type { Context as ChordContext } from "@earendil-works/chord";
import type { ConversationId, Cursor, EntryId, EntryRecord, HookApi } from "@earendil-works/pi-durable";
import { defaultSettings, GUARDIAN_EVIDENCE_CHARACTERS } from "@t3flare/harness-registry";

import { ADVISOR_CONTINUATION } from "../advisor.ts";

/** Characters of untrusted evidence a review carries at most (about pi-guardian's 32,000-token ceiling). */
export const EVIDENCE_CHARACTERS = GUARDIAN_EVIDENCE_CHARACTERS;
/** History read back for evidence, newest first, a page at a time. */
const PAGE = 200;

interface EvidenceEntry {
  readonly trusted: boolean;
  readonly origin: string;
  readonly message: unknown;
  /** The ids of an agent's tool calls: a review leaves out the response holding the Reviewed Call. */
  readonly callIds: ReadonlyArray<string>;
}

const omissionMarker = (omitted: number) => `[… ${omitted} characters omitted]`;

const render = (trusted: boolean, origin: string, json: string): string =>
  `Evidence (${trusted ? "TRUSTED" : "UNTRUSTED"}, origin: ${origin}):\n${json}`;

type ModelMessage = { readonly role?: string; readonly content?: unknown };

const userText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block: { type?: string; text?: string }) =>
            block.type === "text" && typeof block.text === "string" ? [block.text] : [],
          )
          .join("\n")
      : "";

/** The tool calls of an assistant entry, as they were sent. */
export const toolCallsOf = (
  entry: EntryRecord,
): ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments: unknown }> => {
  const message = entry.model?.[0] as ModelMessage | undefined;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return (message.content as ReadonlyArray<{ type?: string; id?: string; name?: string; arguments?: unknown }>).flatMap(
    (block) =>
      block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string"
        ? [{ id: block.id, name: block.name, arguments: block.arguments }]
        : [],
  );
};

/** One stored entry's evidence: what pi-guardian's `messageEntries` takes of a session message. */
const entryEvidence = (entry: EntryRecord, trustUser: boolean): EvidenceEntry | undefined => {
  const message = entry.model?.[0] as ModelMessage | undefined;
  if (entry.kind === "pi.assistant") {
    const calls = toolCallsOf(entry);
    if (calls.length === 0) return undefined;
    return {
      trusted: false,
      origin: "agentToolCalls",
      message: {
        role: "assistant",
        content: calls.map((call) => ({ type: "toolCall", name: call.name, arguments: call.arguments })),
      },
      callIds: calls.map((call) => call.id),
    };
  }
  if (message?.role !== "user") return undefined;
  const text = userText(message.content);
  if (text === "") return undefined;
  const user = (trusted: boolean, origin: string): EvidenceEntry => ({
    trusted,
    origin,
    message: { role: "user", content: text },
    callIds: [],
  });
  // The Advisor's corrective continuation is placed as a user message, but the Advisor wrote it (pi-guardian: Advisor messages are never trusted).
  if (entry.kind === "pi.user" && text === ADVISOR_CONTINUATION) return user(false, "advisor");
  if (entry.kind === "pi.user") return user(trustUser, trustUser ? "user" : "linkedWork");
  // Writes and steers of extensions (an Advisor's finding, a Terminal's exit, a context continuation): never the user's.
  return user(false, "extension");
};

/**
 * A message's JSON of `length` characters, of which `json` holds at least the first `limit`, cut to `limit` characters
 * with an omission marker when it is longer.
 */
const shorten = (json: string, length: number, limit: number): string =>
  length <= limit
    ? json
    : JSON.stringify({ shortenedJson: `${json.slice(0, limit)}${omissionMarker(length - limit)}` });

/**
 * The JSON shortened so it takes at most `room` characters, the shortened form's wrapper, marker and escapes counted;
 * undefined when not even the marker fits. `json` holds at least the first `min(room, length)` characters.
 */
const fitTo = (json: string, length: number, room: number): string | undefined => {
  let limit = room;
  for (;;) {
    const shown = shorten(json, length, limit);
    if (shown.length <= room) return shown;
    if (limit === 0) return undefined;
    // The cut text grows by its escapes and the wrapper once written again: cut it in that proportion, and a little more.
    limit = Math.max(0, Math.floor((limit * room) / shown.length) - 1);
  }
};

/**
 * One piece of a review's History, newest first. A trusted message is held as its JSON, or as the first characters of
 * it a review with newer entries can show; an untrusted one as shown, already cut to a quarter of the budget; `omitted`
 * counts untrusted messages past the window, which a later selection needs only if its window reaches them.
 */
type Item =
  | { readonly kind: "trusted"; readonly origin: string; readonly json: string; readonly length: number }
  | {
      readonly kind: "untrusted";
      readonly origin: string;
      readonly shown: string;
      readonly callIds: ReadonlyArray<string>;
    }
  | { readonly kind: "omitted"; readonly count: number };

/** A run of History, newest first; `older`: History older than the items exists and is not in them. */
interface Scan {
  readonly items: ReadonlyArray<Item>;
  readonly older: boolean;
}

const itemOf = (entry: EntryRecord, trustUser: boolean, budget: number): Item | undefined => {
  const evidence = entryEvidence(entry, trustUser);
  if (evidence === undefined) return undefined;
  const json = JSON.stringify(evidence.message);
  return evidence.trusted
    ? { kind: "trusted", origin: evidence.origin, json, length: json.length }
    : {
        kind: "untrusted",
        origin: evidence.origin,
        shown: shorten(json, json.length, Math.floor(budget / 4)),
        callIds: evidence.callIds,
      };
};

interface Options {
  readonly trustUser: boolean;
  readonly skipCalls: ReadonlySet<string>;
  readonly budget: number;
}

const skipped = (item: Item, skipCalls: ReadonlySet<string>): boolean =>
  item.kind === "untrusted" && item.callIds.some((id) => skipCalls.has(id));

type Choice =
  /** The selection: its blocks, and the items any later review of this History (with newer entries) can need. */
  | { readonly needs: "nothing"; readonly blocks: ReadonlyArray<string>; readonly kept: Scan }
  /** The selection reaches past the items into the older History; `kept` holds what it needs of these. */
  | { readonly needs: "older"; readonly kept: Scan }
  /** The items no longer hold what the selection needs: read the History again. */
  | { readonly needs: "rescan" };

/**
 * The evidence of `scan`: trusted messages newest first, each fitted to the room the newer ones leave, until one does
 * not fit (the budget is full: nothing older is read); then the untrusted ones, newest first, until the first that does
 * not fit beside all the trusted ones. With `trustUser` off there are none trusted, and that first one ends the read.
 */
const choose = (scan: Scan, options: Options): Choice => {
  const { budget, skipCalls } = options;
  const { items } = scan;
  const fitted = new Map<number, { readonly shown: string; readonly room: number }>();
  let trustedUsed = 0;
  let stop = -1;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== "trusted") continue;
    const room = budget - trustedUsed;
    // Held cut to the room it had: a later review's room is no larger, but for the few characters `fitTo` may leave unused.
    if (item.json.length < Math.min(room, item.length)) return { needs: "rescan" };
    const shown = fitTo(item.json, item.length, room);
    if (shown === undefined) {
      stop = index;
      break;
    }
    fitted.set(index, { shown, room });
    trustedUsed += shown.length;
  }
  const window = new Set<number>();
  let untrustedUsed = 0;
  let sentinel = -1;
  for (let index = 0; index < (stop === -1 ? items.length : stop); index++) {
    const item = items[index]!;
    if (item.kind === "trusted" || skipped(item, skipCalls) || sentinel !== -1) continue;
    // Untrusted messages no review showed, while the window is still open: the items cannot say whether they fit.
    if (item.kind === "omitted") return { needs: "rescan" };
    if (trustedUsed + untrustedUsed + item.shown.length <= budget) {
      window.add(index);
      untrustedUsed += item.shown.length;
      continue;
    }
    sentinel = index;
    // With no trusted evidence to come, a full budget is final.
    if (!options.trustUser) stop = index;
  }
  const end = stop === -1 ? items.length : stop + 1;
  const kept: Array<Item> = [];
  let omitted = 0;
  const omit = (count: number) => {
    omitted += count;
    const last = kept.at(-1);
    if (last?.kind === "omitted") kept[kept.length - 1] = { kind: "omitted", count: last.count + count };
    else kept.push({ kind: "omitted", count });
  };
  for (let index = 0; index < end; index++) {
    const item = items[index]!;
    if (item.kind === "trusted") {
      const room = fitted.get(index)?.room ?? budget - trustedUsed;
      kept.push({ ...item, json: item.json.slice(0, Math.min(room, item.length)) });
      if (index === stop) omitted++;
    } else if (item.kind === "omitted") omit(item.count);
    else if (skipped(item, skipCalls)) kept.push(item);
    else if (window.has(index) || index === sentinel) {
      kept.push(item);
      if (index === sentinel) omitted++;
    } else omit(1);
  }
  const older = scan.older || end < items.length;
  if (stop === -1 && scan.older) return { needs: "older", kept: { items: kept, older } };
  const blocks: Array<string> = [];
  for (let index = end - 1; index >= 0; index--) {
    const item = items[index]!;
    const shown =
      item.kind === "trusted"
        ? fitted.get(index)?.shown
        : item.kind === "untrusted" && window.has(index)
          ? item.shown
          : undefined;
    if (shown !== undefined && item.kind !== "omitted")
      blocks.push(render(item.kind === "trusted", item.origin, shown));
  }
  return {
    needs: "nothing",
    kept: { items: kept, older },
    blocks:
      omitted === 0 && stop === -1
        ? blocks
        : [
            `[${omitted} evidence entries omitted to fit the evidence budget${stop !== -1 && older ? ", and the older History not read" : ""}; trusted ones kept first, newest first]`,
            ...blocks,
          ],
  };
};

/** What a conversation's last review read: the newest entry it saw, and the History's items a later review needs. */
interface Cached {
  readonly watermark: EntryId;
  readonly trustUser: boolean;
  readonly budget: number;
  readonly scan: Scan;
}

/**
 * The Guardian's evidence of its last review, per conversation id, so the next reads only the entries newer than it.
 * In memory: a new isolate, or the Guardian installed again, starts empty, and its first review reads as an uncached one.
 */
export type EvidenceCache = Map<ConversationId, Cached>;

export const evidenceCache = (): EvidenceCache => new Map();

type Api = Pick<HookApi, "entries" | "conversationId">;

/** The selection over the whole History, newest first, read until it is decided. */
const scanHistory = async (
  api: Api,
  context: ChordContext,
  options: Options,
): Promise<{ readonly choice: Extract<Choice, { needs: "nothing" }>; readonly head: EntryId | undefined }> => {
  let items: Array<Item> = [];
  let head: EntryId | undefined;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await api.entries({ order: "descending" }, PAGE, cursor, context);
    if (cursor === undefined) head = page.items[0]?.id;
    items.push(...page.items.flatMap((entry) => itemOf(entry, options.trustUser, options.budget) ?? []));
    const choice = choose({ items, older: page.next !== undefined }, options);
    // The items kept between pages hold every message this read can still show, so a rescan cannot be needed.
    if (choice.needs === "rescan") throw new Error("The Guardian's evidence lost a message it needs while reading.");
    if (choice.needs === "nothing") return { choice, head };
    items = [...choice.kept.items];
    cursor = page.next;
  }
};

/**
 * The selection from `cached` and the entries newer than its watermark; undefined when the History was rolled back
 * (the watermark entry is gone, or the head moved behind it) or the cached items no longer hold what it needs.
 */
const scanSince = async (
  api: Api,
  context: ChordContext,
  options: Options,
  cached: Cached,
): Promise<{ readonly choice: Extract<Choice, { needs: "nothing" }>; readonly head: EntryId } | undefined> => {
  let items: Array<Item> = [];
  let head: EntryId | undefined;
  let cursor: Cursor | undefined;
  let skipSeen = false;
  for (;;) {
    const page = await api.entries({ order: "descending", minEntryId: cached.watermark }, PAGE, cursor, context);
    if (cursor === undefined) head = page.items[0]?.id;
    const at = page.items.findIndex((entry) => entry.id === cached.watermark);
    const fresh = (at === -1 ? page.items : page.items.slice(0, at)).flatMap(
      (entry) => itemOf(entry, options.trustUser, options.budget) ?? [],
    );
    skipSeen ||= fresh.some((item) => skipped(item, options.skipCalls));
    items.push(...fresh);
    if (at === -1) {
      // The watermark entry is gone.
      if (page.next === undefined || head === undefined) return undefined;
      const choice = choose({ items, older: true }, options);
      if (choice.needs === "nothing") return { choice, head };
      if (choice.needs === "rescan") return undefined;
      items = [...choice.kept.items];
      cursor = page.next;
      continue;
    }
    // The Reviewed Call's response is in an `omitted` count the cached review made under another Reviewed Call.
    if (
      options.skipCalls.size > 0 &&
      !skipSeen &&
      !cached.scan.items.some((item) => skipped(item, options.skipCalls)) &&
      cached.scan.items.some((item) => item.kind === "omitted")
    )
      return undefined;
    const choice = choose({ items: [...items, ...cached.scan.items], older: cached.scan.older }, options);
    return choice.needs === "nothing" ? { choice, head: head! } : undefined;
  }
};

/**
 * The evidence blocks of a review, in conversation order, within `budget` characters: trusted entries first, newest
 * first, each shortened to the room left (so the newest always goes in); then the newest untrusted ones in what is left,
 * each shortened only when it alone exceeds a quarter of the budget, up to the first that does not fit. An omission note
 * says what was left out. `skipCalls`: the Reviewed Call's own response, which the Reviewed Call shows.
 *
 * The History is read newest first, a page at a time: an older trusted message (the owner's authorization) still takes
 * the place of newer untrusted ones, so the read goes on until trusted evidence fills the budget, or, with no trusted
 * evidence (`trustUser` off), until untrusted evidence does.
 *
 * With `cache`, a review keeps per conversation the items its selection showed or could still show (within the budget,
 * plus the first untrusted message past the window and the Reviewed Call's response) and the newest entry id it read;
 * the next review reads only the entries since that id and selects over them and the kept items, which picks what a
 * whole read would. It reads the whole History again when the cache has none for the conversation (or another
 * `trustUser` or budget), when the History was rolled back (the watermark entry is gone, or the head moved behind it),
 * and when the kept items do not hold what the selection needs.
 */
export const selectEvidence = async (
  api: Api,
  context: ChordContext,
  selection: {
    readonly trustUser: boolean;
    readonly skipCalls: ReadonlySet<string>;
    readonly budget?: number;
    readonly cache?: EvidenceCache;
  },
): Promise<ReadonlyArray<string>> => {
  const options: Options = {
    trustUser: selection.trustUser,
    skipCalls: selection.skipCalls,
    budget: selection.budget ?? EVIDENCE_CHARACTERS,
  };
  const { cache } = selection;
  const cached = cache?.get(api.conversationId);
  const usable =
    cached !== undefined && cached.trustUser === options.trustUser && cached.budget === options.budget
      ? await scanSince(api, context, options, cached)
      : undefined;
  const { choice, head } = usable ?? (await scanHistory(api, context, options));
  if (cache !== undefined) {
    if (head === undefined) cache.delete(api.conversationId);
    else
      cache.set(api.conversationId, {
        watermark: head,
        trustUser: options.trustUser,
        budget: options.budget,
        scan: choice.kept,
      });
  }
  return choice.blocks;
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const argumentsHash = (input: unknown): Promise<string> => sha256(JSON.stringify(input));

/** The `batchArgumentCharacters` setting's default, for a call rendered without settings (a test). */
const DEFAULT_BATCH_CHARACTERS = Number(defaultSettings("guardian").batchArgumentCharacters);

const batchCallLine = (call: { readonly name: string; readonly arguments: unknown }, limit: number): string => {
  const name = JSON.stringify(call.name);
  const json = JSON.stringify(call.arguments);
  if (json.length <= limit) return `${name} with arguments ${json}`;
  const fields = (typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {}) as Record<
    string,
    unknown
  >;
  const pinned = Object.fromEntries(Object.entries(fields).filter(([key]) => key === "path" || key === "command"));
  const rest = JSON.stringify(
    Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "path" && key !== "command")),
  );
  const shown = rest.length > limit ? `${rest.slice(0, limit)}${omissionMarker(rest.length - limit)}` : rest;
  return Object.keys(pinned).length > 0
    ? `${name} with arguments ${JSON.stringify(pinned)} in full, and other arguments ${shown}`
    : `${name} with arguments ${shown}`;
};

export interface ReviewedCall {
  readonly toolName: string;
  readonly input: unknown;
  readonly cwd: string;
  readonly reason?: string | undefined;
  readonly parent?: { readonly toolName: string; readonly input: unknown } | undefined;
  readonly batch?: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>;
  /** Characters of each other batch call's arguments shown beside its path and command (`batchArgumentCharacters`). */
  readonly batchCharacters?: number;
}

/** The final request block (`renderReviewedCall`): never shortened. */
export const renderReviewedCall = async (call: ReviewedCall): Promise<string> => {
  const lines = [
    "Reviewed Call (judge this exact action):",
    "Guarded Agent: the main agent (a Durable agent working in the Workspace's repo; t3 is its user interface)",
    `Working directory: ${call.cwd}`,
    `Tool: ${call.toolName}`,
    ...(call.reason === undefined ? [] : [`Reviewed because: ${call.reason}`]),
    `Arguments SHA-256: ${await argumentsHash(call.input)}`,
    `Arguments: ${JSON.stringify(call.input)}`,
  ];
  if (call.parent !== undefined) {
    lines.push(
      `Issued by tool call: ${call.parent.toolName}`,
      `Issuing call arguments: ${JSON.stringify(call.parent.input)}`,
      "The issuing call's other nested calls appear only in its arguments above.",
    );
  }
  if (call.batch !== undefined && call.batch.length > 0) {
    lines.push(
      call.parent !== undefined
        ? "Other calls in the issuing call's tool batch (each reviewed on its own; they bear on this call only where they change what it does, and Pi may run them before or alongside the issuing call):"
        : "Other calls in the same tool batch (each reviewed on its own; they bear on this call only where they change what it does, and Pi may run them before or alongside this call):",
    );
    for (const other of call.batch)
      lines.push(`- ${batchCallLine(other, call.batchCharacters ?? DEFAULT_BATCH_CHARACTERS)}`);
  }
  return lines.join("\n");
};
