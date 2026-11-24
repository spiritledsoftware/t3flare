// The Guardian's evidence selection as it was before SPI-1378 (origin/main at cb78280c,
// apps/agents/src/extensions/guardian/evidence.ts), kept as the oracle a cached selection must equal. One change: the
// "older History not read" note names any entry older than where the read stopped (`olderInPage`), not only a next page.
import type { Context as ChordContext } from "@earendil-works/chord";
import type { Cursor, EntryRecord, HookApi } from "@earendil-works/pi-durable";
import { GUARDIAN_EVIDENCE_CHARACTERS } from "@t3flare/harness-registry";

import { ADVISOR_CONTINUATION } from "../src/extensions/advisor.ts";

/** History read back for evidence, newest first, a page at a time. */
const PAGE = 200;

interface EvidenceEntry {
  readonly trusted: boolean;
  readonly origin: string;
  readonly message: unknown;
}

const omissionMarker = (omitted: number) => `[… ${omitted} characters omitted]`;

const render = (entry: EvidenceEntry): string =>
  `Evidence (${entry.trusted ? "TRUSTED" : "UNTRUSTED"}, origin: ${entry.origin}):\n${JSON.stringify(entry.message)}`;

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
const toolCallsOf = (
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
const entryEvidence = (
  entry: EntryRecord,
  trustUser: boolean,
  skipCalls: ReadonlySet<string>,
): EvidenceEntry | undefined => {
  const message = entry.model?.[0] as ModelMessage | undefined;
  if (entry.kind === "pi.assistant") {
    const calls = toolCallsOf(entry);
    if (calls.length === 0 || calls.some((call) => skipCalls.has(call.id))) return undefined;
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

const shorten = (entry: EvidenceEntry, limit: number): EvidenceEntry => {
  const json = JSON.stringify(entry.message);
  return json.length <= limit
    ? entry
    : { ...entry, message: { shortenedJson: `${json.slice(0, limit)}${omissionMarker(json.length - limit)}` } };
};

/**
 * `entry` shortened so its message takes at most `room` characters as JSON, the shortened form's wrapper, marker and
 * escapes counted; undefined when not even the marker fits.
 */
const fitTo = (
  entry: EvidenceEntry,
  room: number,
): { readonly shown: EvidenceEntry; readonly size: number } | undefined => {
  let limit = room;
  for (;;) {
    const shown = shorten(entry, limit);
    const size = JSON.stringify(shown.message).length;
    if (size <= room) return { shown, size };
    if (limit === 0) return undefined;
    // The cut text grows by its escapes and the wrapper once written again: cut it in that proportion, and a little more.
    limit = Math.max(0, Math.floor((limit * room) / size) - 1);
  }
};

/**
 * The evidence blocks of a review, in conversation order, within `budget` characters: trusted entries first, newest
 * first, each shortened to the room left (so the newest always goes in); then the newest untrusted ones in what is left, each shortened only when it alone
 * exceeds a quarter of the budget. An omission note says what was left out. `skipCalls`: the Reviewed Call's own
 * response, which the Reviewed Call shows.
 *
 * The History is read newest first, a page at a time: an older trusted message (the owner's authorization) still takes
 * the place of newer untrusted ones, so the read goes on until trusted evidence fills the budget, or, with no trusted
 * evidence (`trustUser` off), until untrusted evidence does. An untrusted entry past the budget is counted, never held.
 */
export const selectEvidenceBefore = async (
  api: Pick<HookApi, "entries">,
  context: ChordContext,
  options: { readonly trustUser: boolean; readonly skipCalls: ReadonlySet<string>; readonly budget?: number },
): Promise<ReadonlyArray<string>> => {
  const budget = options.budget ?? GUARDIAN_EVIDENCE_CHARACTERS;
  let trustedUsed = 0;
  let untrustedUsed = 0;
  let omitted = 0;
  /** Newest first; untrusted ones are dropped from the end (the oldest kept) when a trusted one needs their room. */
  const kept: Array<{ readonly evidence: EvidenceEntry; readonly size: number }> = [];
  const dropOldestUntrusted = () => {
    for (let index = kept.length - 1; index >= 0; index--) {
      if (kept[index]!.evidence.trusted) continue;
      untrustedUsed -= kept[index]!.size;
      kept.splice(index, 1);
      omitted++;
      return true;
    }
    return false;
  };
  let full = false;
  let olderInPage = false;
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries({ order: "descending" }, PAGE, cursor, context);
    for (const [at, entry] of page.items.entries()) {
      olderInPage = at < page.items.length - 1;
      const evidence = entryEvidence(entry, options.trustUser, options.skipCalls);
      if (evidence === undefined) continue;
      if (evidence.trusted) {
        // Shortened to the room trusted evidence has left, so the newest trusted message always goes in.
        const fitted = fitTo(evidence, budget - trustedUsed);
        if (fitted === undefined) {
          // Trusted evidence fills the budget: nothing older can take a place in it.
          full = true;
          omitted++;
          break;
        }
        trustedUsed += fitted.size;
        kept.push({ evidence: fitted.shown, size: fitted.size });
        while (trustedUsed + untrustedUsed > budget && dropOldestUntrusted());
        continue;
      }
      const shown = shorten(evidence, Math.floor(budget / 4));
      const size = JSON.stringify(shown.message).length;
      if (trustedUsed + untrustedUsed + size > budget) {
        omitted++;
        // With no trusted evidence to come, a full budget is final.
        if (!options.trustUser) {
          full = true;
          break;
        }
        continue;
      }
      untrustedUsed += size;
      kept.push({ evidence: shown, size });
    }
    cursor = page.next;
  } while (cursor !== undefined && !full);
  const blocks = kept.toReversed().map((each) => render(each.evidence));
  return omitted === 0 && !full
    ? blocks
    : [
        `[${omitted} evidence entries omitted to fit the evidence budget${full && (olderInPage || cursor !== undefined) ? ", and the older History not read" : ""}; trusted ones kept first, newest first]`,
        ...blocks,
      ];
};
