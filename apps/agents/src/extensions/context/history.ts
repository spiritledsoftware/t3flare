// History: a conversation's stored entries, which a Handoff or a compaction takes out of the model's context but never
// out of storage. Ported from pi-context-management's `context-tools.ts` and `entry-preview.ts`: Context Windows, one-line
// entry previews, references, and literal search over the decoded strings of an entry's JSON.
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";

import { conversationIdOf, entryIdOf } from "../../durableIds.ts";

/** Lists and searches return at most this many items per page. */
export const PAGE_SIZE = 20;

/**
 * The most bytes of UTF-8 one character of a History `read`'s page takes in its result: the page is a slice of entry
 * JSON, written again as a JSON string. A UTF-16 unit is at most 3 bytes of UTF-8, and JSON's escapes (`\"`, `\\`, the
 * `\n` already in the entry's JSON) take 2; a control character is already escaped in the entry's JSON. A surrogate pair
 * cut at the page's edge is written as a 6-byte escape, which `READ_ROOM_BYTES` covers.
 */
const READ_BYTES_PER_CHARACTER = 3;

/** Room in a `read`'s result for what is around the page: its ref, offsets and keys, and a cut surrogate at each edge. */
const READ_ROOM_BYTES = 1024;

/**
 * The most characters of entry JSON a History `read` returns per call: as many as fit the tool's `maxBytes` (the Tool
 * output limit) with the result around them, so the Harness never cuts the result and its `next_offset` stays readable.
 * The result is one line, so the line limit never cuts it.
 */
export const readCharacters = (maxBytes: number): number =>
  Math.max(1, Math.floor((maxBytes - READ_ROOM_BYTES) / READ_BYTES_PER_CHARACTER));

/** How long list lines and search previews are: the `context` extension's `previewCharacters` setting. */
export interface PreviewLimits {
  /** An entry's whole preview line. */
  readonly preview: number;
}

/** A tool call's argument in a preview line: half the line. */
const argumentLimit = (limits: PreviewLimits) => Math.max(1, Math.floor(limits.preview / 2));

/** The reference of entry `id` of conversation `conversationId`. */
export const entryRef = (conversationId: ConversationId, id: EntryId): string => `context:${conversationId}:${id}`;

export type ParsedRef =
  | { readonly type: "entry"; readonly conversationId: ConversationId; readonly entryId: EntryId }
  | { readonly type: "note"; readonly conversationId: ConversationId; readonly name: string };

const REF = /^context:(\d+):(?:note:(.+)|(\d+))$/;

/** What a reference names, or `undefined` when it is not one. */
export const parseRef = (ref: string): ParsedRef | undefined => {
  const match = REF.exec(ref);

  if (match === null) return undefined;

  const conversationId = conversationIdOf(match[1]!);

  return match[2] !== undefined
    ? { type: "note", conversationId, name: match[2] }
    : { type: "entry", conversationId, entryId: entryIdOf(match[3]!) };
};

/** A Context Window: the entries from one head marker (a Handoff or a compaction) to the next. */
export type ContextWindow = { readonly start: number; readonly end: number };

/** The Context Windows of `entries`, oldest first; a new one starts at every entry that sets the context's head. */
export const windowsOf = (entries: ReadonlyArray<EntryRecord>): ContextWindow[] => {
  const starts: number[] = [];

  entries.forEach((entry, index) => {
    if (index === 0 || entry.head !== undefined) starts.push(index);
  });

  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? entries.length }));
};

const clip = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
};

const textOf = (content: Message["content"]): string =>
  Predicate.isString(content) ? content : content.map((block) => (block.type === "text" ? block.text : "")).join(" ");

const describeCall = (call: ToolCall, limits: PreviewLimits): string => {
  const first = Record.values(call.arguments).find(Predicate.isString);

  return `${call.name}(${clip(first ?? JSON.stringify(call.arguments), argumentLimit(limits))})`;
};

const labelled = (label: string, text: string, limits: PreviewLimits): string => {
  const body = clip(text, limits.preview);

  return body === "" ? label : `${label}: ${body}`;
};

const describeMessage = (entry: EntryRecord, message: Message, limits: PreviewLimits): string => {
  switch (message.role) {
    case "user":
      return labelled(entry.kind === "pi.user" ? "user" : `user(${entry.kind})`, textOf(message.content), limits);
    case "assistant": {
      const text = clip(
        textOf(message.content) ||
          message.errorMessage ||
          (message.content.some((block) => block.type === "thinking") ? "[thinking]" : ""),
        limits.preview,
      );

      const calls = message.content
        .flatMap((block) => (block.type === "toolCall" ? [describeCall(block, limits)] : []))
        .join(", ");

      return `assistant${text === "" ? "" : `: ${text}`}${calls === "" ? "" : ` → ${calls}`}`;
    }

    case "toolResult":
      return labelled(
        `toolResult(${message.toolName}${message.isError ? ", error" : ""})`,
        textOf(message.content),
        limits,
      );
    case "system":
      return "system";
  }
};

/**
 * One bounded line naming what a stored entry says: `user: …`, `assistant: … → read(…)`, `toolResult(read): …`,
 * `handoff: …`, `compaction: …`, or the entry's kind.
 */
export const describeEntry = (entry: EntryRecord, limits: PreviewLimits): string => {
  const message = entry.model?.[0];

  try {
    if (entry.kind === "pi.reset") {
      return clip(
        message === undefined ? "reset" : labelled("handoff", textOf(message.content), limits),
        limits.preview,
      );
    }

    if (entry.kind === "pi.compaction" && message !== undefined) {
      return clip(labelled("compaction", textOf(message.content), limits), limits.preview);
    }

    return clip(message === undefined ? entry.kind : describeMessage(entry, message, limits), limits.preview);
  } catch {
    // An unfamiliar stored shape must not make the whole page unreadable.
    return entry.kind;
  }
};

/** When an entry's message was made, as ISO 8601, or an empty string for entries without one. */
export const timestampOf = (entry: EntryRecord): string => {
  const at = entry.model?.[0]?.timestamp;

  return at === undefined || at === 0 ? "" : DateTime.formatIso(DateTime.makeUnsafe(at));
};

/** Whether `entry` passes the `type` (entry kind) and `role` (message role) filters. */
export const matchesFilter = (entry: EntryRecord, type: string | undefined, role: string | undefined): boolean =>
  (type === undefined || entry.kind === type) && (role === undefined || entry.model?.[0]?.role === role);

/** Something to search: a Note's text, or an entry's JSON, whose string values are searched decoded. */
export type SearchItem = {
  readonly ref: string;
  readonly content: string;
  readonly name?: string;
  readonly agent?: string;
  readonly session?: string;
  /** `content` is entry JSON. */
  readonly recorded?: true;
  /** A range of the JSON that must not match, such as the call running this search. */
  readonly skip?: { readonly start: number; readonly end: number } | undefined;
};

export type SearchMatch = {
  ref: string;
  name?: string;
  agent?: string;
  session?: string;
  /** In the Note text, or in the entry JSON `read` returns. */
  offset: number;
  preview: string;
};

/** One page of search matches; `next_offset` is null on the last page. */
export type SearchPage = { matches: SearchMatch[]; next_offset: number | null };

/** The JSON range of tool call `callId` in an entry's JSON, if the entry holds it. */
export const callRange = (entry: EntryRecord, json: string, callId: string) => {
  const message = entry.model?.[0];

  if (message?.role !== "assistant") return undefined;

  const call = message.content.find((block) => block.type === "toolCall" && block.id === callId);

  if (call === undefined) return undefined;

  const recorded = JSON.stringify(call);
  const start = json.indexOf(recorded);

  return start === -1 ? undefined : { start, end: start + recorded.length };
};

/** The searchable parts of `item`: a Note's text, or each decoded string value of entry JSON that is not a key. */
function* searchableText(item: SearchItem) {
  if (item.recorded !== true) {
    yield { content: item.content, start: 0, encoded: "" };

    return;
  }

  for (const token of item.content.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (item.content[token.index + token[0].length] === ":") continue;

    if (item.skip !== undefined && token.index >= item.skip.start && token.index < item.skip.end) {
      continue;
    }

    const decoded: unknown = JSON.parse(token[0]);

    if (Predicate.isString(decoded)) yield { content: decoded, start: token.index, encoded: token[0] };
  }
}

/** The offset in a JSON string literal of the character at `offset` of its decoded value. */
const encodedOffset = (encoded: string, offset: number): number => {
  let cursor = 1; // The opening quote.

  for (let index = 0; index < offset; index++) {
    cursor += encoded[cursor] === "\\" ? (encoded[cursor + 1] === "u" ? 6 : 2) : 1;
  }

  return cursor;
};

/**
 * One page of the case-sensitive literal matches of `query` in `items`, from match `offset`; each preview shows a sixth
 * of `limits.preview` before the match and half after it.
 */
export const search = (
  items: Iterable<SearchItem>,
  query: string,
  offset: number,
  limit: number,
  limits: PreviewLimits,
): SearchPage => {
  const before = Math.floor(limits.preview / 6);
  const after = Math.floor(limits.preview / 2);
  const matches: SearchMatch[] = [];
  let skipped = 0;

  for (const item of items) {
    for (const part of searchableText(item)) {
      let position = part.content.indexOf(query);

      while (position !== -1) {
        if (skipped < offset) skipped++;
        else if (matches.length === limit) return { matches, next_offset: offset + matches.length };
        else {
          const match: SearchMatch = {
            ref: item.ref,
            offset: part.encoded === "" ? position : part.start + encodedOffset(part.encoded, position),
            // The decoded text, so escapes read as characters, not as JSON.
            preview: part.content.slice(Math.max(0, position - before), position + after),
          };

          if (item.name !== undefined) match.name = item.name;

          if (item.agent !== undefined) match.agent = item.agent;

          if (item.session !== undefined) match.session = item.session;

          matches.push(match);
        }

        position = part.content.indexOf(query, position + 1);
      }
    }
  }

  return { matches, next_offset: null };
};
