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
}

const omissionMarker = (omitted: number) => `[… ${omitted} characters omitted]`;

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
    };
  }
  if (message?.role !== "user") return undefined;
  const text = userText(message.content);
  if (text === "") return undefined;
  // The Advisor's corrective continuation is placed as a user message, but the Advisor wrote it (pi-guardian: Advisor messages are never trusted).
  if (entry.kind === "pi.user" && text === ADVISOR_CONTINUATION)
    return { trusted: false, origin: "advisor", message: { role: "user", content: text } };
  if (entry.kind === "pi.user")
    return { trusted: trustUser, origin: trustUser ? "user" : "linkedWork", message: { role: "user", content: text } };
  // Writes and steers of extensions (an Advisor's finding, a Terminal's exit, a context continuation): never the user's.
  return { trusted: false, origin: "extension", message: { role: "user", content: text } };
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

/** An entry's evidence as the index holds it: its id, and the size it takes. */
interface Indexed {
  readonly id: EntryId;
  readonly trusted: boolean;
  /** Trusted: its JSON's length, which it is fitted from; untrusted: its shown form's, cut to a quarter of the budget. */
  readonly size: number;
}

/** An entry's evidence text: a trusted message's JSON (its first `budget` characters, all a review can show), or an untrusted one's shown form. */
interface Text {
  readonly origin: string;
  readonly text: string;
}

const evidenceOf = (
  entry: EntryRecord,
  trustUser: boolean,
  budget: number,
): { readonly indexed: Indexed; readonly text: Text } | undefined => {
  const evidence = entryEvidence(entry, trustUser);
  if (evidence === undefined) return undefined;
  const json = JSON.stringify(evidence.message);
  const text = evidence.trusted ? json.slice(0, budget) : shorten(json, json.length, Math.floor(budget / 4));
  return {
    indexed: { id: entry.id, trusted: evidence.trusted, size: evidence.trusted ? json.length : text.length },
    text: { origin: evidence.origin, text },
  };
};

interface Options {
  readonly trustUser: boolean;
  /** The Reviewed Call's own response, which the Reviewed Call shows. */
  readonly skipEntry: EntryId | undefined;
  readonly budget: number;
}

/**
 * One review's selection, fed the History's evidence newest first: trusted entries first, newest first, each shortened
 * to the room left (so the newest always goes in); then the newest untrusted ones in what is left, each shortened only
 * when it alone exceeds a quarter of the budget. An older trusted message (the owner's authorization) still takes the
 * place of newer untrusted ones. An untrusted entry past the budget is counted, never held.
 *
 * It holds the texts of what it keeps: those it is fed, and the rest from `load` once it is decided.
 */
class Selection {
  readonly #options: Options;
  readonly #load: (id: EntryId) => Promise<Text>;
  #trustedUsed = 0;
  #untrustedUsed = 0;
  #omitted = 0;
  /** Newest first; untrusted ones are dropped from the end (the oldest kept) when a trusted one needs their room. */
  readonly #kept: Array<{ readonly entry: Indexed; readonly size: number; readonly shown?: string }> = [];
  /** The texts the selection needs: of what it keeps, and of the trusted message that filled the budget. */
  readonly texts = new Map<EntryId, Text>();
  /** The entry that filled the budget: nothing older can take a place in it. */
  stop: EntryId | undefined;

  constructor(options: Options, load: (id: EntryId) => Promise<Text>) {
    this.#options = options;
    this.#load = load;
  }

  /** Takes the next older entry's evidence; false once the budget is full. */
  async add(entry: Indexed, text?: Text): Promise<boolean> {
    if (this.stop !== undefined) return false;
    if (entry.id === this.#options.skipEntry) return true;
    return entry.trusted ? this.#addTrusted(entry, text) : this.#addUntrusted(entry, text);
  }

  async #addTrusted(entry: Indexed, given: Text | undefined): Promise<boolean> {
    const room = this.#options.budget - this.#trustedUsed;
    if (entry.size <= room) {
      this.#keep(entry, entry.size, given);
    } else {
      // Shortened to the room trusted evidence has left, so the newest trusted message always goes in.
      const text = given ?? (await this.#text(entry.id));
      this.texts.set(entry.id, text);
      const shown = fitTo(text.text, entry.size, room);
      if (shown === undefined) {
        this.stop = entry.id;
        this.#omitted++;
        return false;
      }
      this.#kept.push({ entry, size: shown.length, shown });
    }
    this.#trustedUsed += this.#kept.at(-1)!.size;
    while (this.#trustedUsed + this.#untrustedUsed > this.#options.budget && this.#dropOldestUntrusted());
    return true;
  }

  #addUntrusted(entry: Indexed, given: Text | undefined): boolean {
    if (this.#trustedUsed + this.#untrustedUsed + entry.size > this.#options.budget) {
      this.#omitted++;
      // With no trusted evidence to come, a full budget is final.
      if (!this.#options.trustUser) this.stop = entry.id;
      return this.#options.trustUser;
    }
    this.#keep(entry, entry.size, given);
    this.#untrustedUsed += entry.size;
    return true;
  }

  #keep(entry: Indexed, size: number, given: Text | undefined) {
    this.#kept.push({ entry, size });
    if (given !== undefined) this.texts.set(entry.id, given);
  }

  #dropOldestUntrusted(): boolean {
    for (let index = this.#kept.length - 1; index >= 0; index--) {
      const { entry, size } = this.#kept[index]!;
      if (entry.trusted) continue;
      this.#untrustedUsed -= size;
      this.#kept.splice(index, 1);
      this.texts.delete(entry.id);
      this.#omitted++;
      return true;
    }
    return false;
  }

  async #text(id: EntryId): Promise<Text> {
    return this.texts.get(id) ?? (await this.#load(id));
  }

  /** The evidence blocks, in conversation order; `older`: whether History older than the stop exists. */
  async blocks(older: () => Promise<boolean>): Promise<ReadonlyArray<string>> {
    const blocks: Array<string> = [];
    for (const { entry, shown } of this.#kept.toReversed()) {
      const text = await this.#text(entry.id);
      this.texts.set(entry.id, text);
      blocks.push(
        `Evidence (${entry.trusted ? "TRUSTED" : "UNTRUSTED"}, origin: ${text.origin}):\n${shown ?? text.text}`,
      );
    }
    if (this.#omitted === 0 && this.stop === undefined) return blocks;
    const unread = this.stop !== undefined && (await older());
    return [
      `[${this.#omitted} evidence entries omitted to fit the evidence budget${unread ? ", and the older History not read" : ""}; trusted ones kept first, newest first]`,
      ...blocks,
    ];
  }
}

/**
 * The evidence index of a run of History: every entry's id and size, newest first, and what the run covers. Entries
 * never change and ids are never reused, so an index read once stands for its run in every later review.
 */
class Run {
  readonly entries: Array<Indexed> = [];
  /** The newest and the oldest entry read, of any kind. */
  newest: EntryId | undefined;
  oldest: EntryId | undefined;
  /** Whether the run reached the History's first entry. */
  first = false;
}

/**
 * Reads History newest first, a page at a time, into `run`, and feeds `selection` its evidence until it is full: the
 * one page loop of every read. `until`: the entry where the read ends, not read again (a cached watermark); `after`:
 * an entry the query returns first that was already read.
 */
const read = async (
  api: Api,
  context: ChordContext,
  options: Options,
  selection: Selection,
  run: Run,
  query: { readonly minEntryId?: EntryId; readonly maxEntryId?: EntryId },
  bounds: { readonly until?: EntryId; readonly after?: EntryId } = {},
): Promise<"reached" | "full" | "end"> => {
  let open = true;
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries({ ...query, order: "descending" }, PAGE, cursor, context);
    for (const entry of page.items) {
      if (entry.id === bounds.until) return "reached";
      if (entry.id === bounds.after) continue;
      run.newest ??= entry.id;
      run.oldest = entry.id;
      const evidence = evidenceOf(entry, options.trustUser, options.budget);
      if (evidence === undefined) continue;
      run.entries.push(evidence.indexed);
      if (open) open = await selection.add(evidence.indexed, evidence.text);
    }
    cursor = page.next;
    if (cursor === undefined && query.minEntryId === undefined) run.first = true;
  } while (cursor !== undefined && open);
  return open ? "end" : "full";
};

/** What a conversation's reviews have read: its evidence index, oldest first, and the texts of its last selection. */
interface Cached {
  readonly conversationId: ConversationId;
  readonly trustUser: boolean;
  readonly budget: number;
  /** Oldest first, so newer entries append. */
  readonly ids: ReadonlyArray<EntryId>;
  readonly sizes: ReadonlyArray<number>;
  readonly trusted: ReadonlySet<EntryId>;
  /** The newest entry read: the next review reads only the History newer than it. */
  readonly watermark: EntryId;
  /** The oldest entry read; `first`: it is the History's first entry. */
  readonly oldest: EntryId;
  readonly first: boolean;
  readonly texts: ReadonlyMap<EntryId, Text>;
}

/**
 * The Guardian's evidence index of the conversation it last reviewed, so its next review reads only the entries since.
 * In memory and for one conversation, the current one: a new isolate, the Guardian installed again (its settings
 * changed), or a review of another conversation starts it over, and that review reads the History as an uncached one.
 */
export interface EvidenceCache {
  current: Cached | undefined;
}

export const evidenceCache = (): EvidenceCache => ({ current: undefined });

type Api = Pick<HookApi, "entries" | "entry" | "conversationId">;

/** The text of an indexed entry the selection keeps but this review did not read: from the last review, or the store. */
const loader =
  (api: Api, context: ChordContext, options: Options, cached: Cached | undefined) =>
  async (id: EntryId): Promise<Text> => {
    const known = cached?.texts.get(id);
    if (known !== undefined) return known;
    const entry = await api.entry(id, context);
    const evidence = entry === undefined ? undefined : evidenceOf(entry, options.trustUser, options.budget);
    if (evidence === undefined)
      throw new Error(`The Guardian's evidence index names entry ${id}, which has no evidence.`);
    return evidence.text;
  };

/**
 * The selection from `cached`: the entries newer than its watermark, then its index, then, when the selection reaches
 * past what was read, the older History. Undefined when the History no longer holds the watermark entry (the head
 * moved behind it, or it is gone): the caller reads it all again.
 */
const selectSince = async (
  api: Api,
  context: ChordContext,
  options: Options,
  cached: Cached,
): Promise<{ readonly selection: Selection; readonly cache: Cached } | undefined> => {
  const selection = new Selection(options, loader(api, context, options, cached));
  const fresh = new Run();
  const ended = await read(
    api,
    context,
    options,
    selection,
    fresh,
    { minEntryId: cached.watermark },
    {
      until: cached.watermark,
    },
  );
  if (ended === "end") return undefined;
  const indexed = (index: number): Indexed => ({
    id: cached.ids[index]!,
    trusted: cached.trusted.has(cached.ids[index]!),
    size: cached.sizes[index]!,
  });
  if (ended === "full") return { selection, cache: cacheOf(options, api.conversationId, fresh, undefined, selection) };
  for (let index = cached.ids.length - 1; index >= 0; index--) if (!(await selection.add(indexed(index)))) break;
  const older = new Run();
  // The selection reaches past the oldest entry read.
  if (selection.stop === undefined && !cached.first)
    await read(api, context, options, selection, older, { maxEntryId: cached.oldest }, { after: cached.oldest });
  const ids = [...older.entries.map((entry) => entry.id).toReversed(), ...cached.ids];
  const sizes = [...older.entries.map((entry) => entry.size).toReversed(), ...cached.sizes];
  const trusted = new Set([...cached.trusted, ...older.entries.flatMap((entry) => (entry.trusted ? [entry.id] : []))]);
  return {
    selection,
    cache: cacheOf(
      options,
      api.conversationId,
      fresh,
      {
        ids,
        sizes,
        trusted,
        watermark: cached.watermark,
        oldest: older.oldest ?? cached.oldest,
        first: older.oldest === undefined ? cached.first : older.first,
      },
      selection,
    ),
  };
};

/** The cache after a review: the entries it read newest, on top of the older index it read through (if any). */
const cacheOf = (
  options: Options,
  conversationId: ConversationId,
  fresh: Run,
  below: Omit<Cached, "conversationId" | "trustUser" | "budget" | "texts"> | undefined,
  selection: Selection,
): Cached => ({
  conversationId,
  trustUser: options.trustUser,
  budget: options.budget,
  ids: [...(below?.ids ?? []), ...fresh.entries.map((entry) => entry.id).toReversed()],
  sizes: [...(below?.sizes ?? []), ...fresh.entries.map((entry) => entry.size).toReversed()],
  trusted: new Set([...(below?.trusted ?? []), ...fresh.entries.flatMap((entry) => (entry.trusted ? [entry.id] : []))]),
  watermark: fresh.newest ?? below!.watermark,
  oldest: below?.oldest ?? fresh.oldest!,
  first: below?.first ?? fresh.first,
  texts: selection.texts,
});

/** Whether the History holds an entry older than `stop`, from what was read, or else from the store. */
const olderThan = async (api: Api, context: ChordContext, cache: Cached | undefined, stop: EntryId) => {
  if (cache !== undefined && Number(cache.oldest) < Number(stop)) return true;
  if (cache?.first === true) return false;
  const page = await api.entries({ maxEntryId: stop, order: "descending" }, 2, undefined, context);
  return page.items.some((entry) => Number(entry.id) < Number(stop));
};

/**
 * The evidence blocks of a review, in conversation order, within `budget` characters (`Selection` says which). An
 * omission note says what was left out, and when a full budget left older History unread. `skipEntry`: the Reviewed
 * Call's own response, which the Reviewed Call shows.
 *
 * The History is read newest first, a page at a time: an older trusted message still takes the place of newer untrusted
 * ones, so the read goes on until trusted evidence fills the budget, or, with no trusted evidence (`trustUser` off),
 * until untrusted evidence does.
 *
 * With `cache`, a review keeps its conversation's evidence index, each entry's id and size, and the texts of what it
 * selected. The next review reads only the entries newer than the newest it read, selects over them and the index as a
 * whole read would, and reads by id the text of an older entry it newly selects. It reads the whole History again with
 * no index for the conversation (or one for another `trustUser` or budget) and when the History no longer holds the
 * newest entry read.
 */
export const selectEvidence = async (
  api: Api,
  context: ChordContext,
  selection: {
    readonly trustUser: boolean;
    readonly skipEntry?: EntryId | undefined;
    readonly budget?: number;
    readonly cache?: EvidenceCache | undefined;
  },
): Promise<ReadonlyArray<string>> => {
  const options: Options = {
    trustUser: selection.trustUser,
    skipEntry: selection.skipEntry,
    budget: selection.budget ?? EVIDENCE_CHARACTERS,
  };
  const { cache } = selection;
  const cached = cache?.current;
  const since =
    cached !== undefined &&
    cached.conversationId === api.conversationId &&
    cached.trustUser === options.trustUser &&
    cached.budget === options.budget
      ? await selectSince(api, context, options, cached)
      : undefined;
  let chosen: Selection;
  let next: Cached | undefined;
  if (since !== undefined) {
    chosen = since.selection;
    next = since.cache;
  } else {
    chosen = new Selection(options, loader(api, context, options, undefined));
    const run = new Run();
    await read(api, context, options, chosen, run, {});
    next = run.newest === undefined ? undefined : cacheOf(options, api.conversationId, run, undefined, chosen);
  }
  const blocks = await chosen.blocks(() => olderThan(api, context, next, chosen.stop!));
  if (cache !== undefined) cache.current = next;
  return blocks;
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
