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
import type { Cursor, EntryRecord, HookApi } from "@earendil-works/pi-durable";
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
 * The evidence blocks of a review, in conversation order, within `budget` characters: trusted entries first, newest
 * first, each shortened to the budget; then the newest untrusted ones in what is left, each shortened only when it alone
 * exceeds a quarter of the budget. An omission note says what was left out. `skipCalls`: the Reviewed Call's own
 * response, which the Reviewed Call shows.
 *
 * The History is read newest first, a page at a time: an older trusted message (the owner's authorization) still takes
 * the place of newer untrusted ones, so the read goes on until trusted evidence fills the budget, or, with no trusted
 * evidence (`trustUser` off), until untrusted evidence does. An untrusted entry past the budget is counted, never held.
 */
export const selectEvidence = async (
  api: Pick<HookApi, "entries">,
  context: ChordContext,
  options: { readonly trustUser: boolean; readonly skipCalls: ReadonlySet<string>; readonly budget?: number },
): Promise<ReadonlyArray<string>> => {
  const budget = options.budget ?? EVIDENCE_CHARACTERS;
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
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries({ order: "descending" }, PAGE, cursor, context);
    for (const entry of page.items) {
      const evidence = entryEvidence(entry, options.trustUser, options.skipCalls);
      if (evidence === undefined) continue;
      const shown = shorten(evidence, evidence.trusted ? budget : Math.floor(budget / 4));
      const size = JSON.stringify(shown.message).length;
      if (evidence.trusted) {
        if (trustedUsed + size > budget) {
          // Trusted evidence fills the budget: nothing older can take a place in it.
          full = true;
          omitted++;
          break;
        }
        trustedUsed += size;
        kept.push({ evidence: shown, size });
        while (trustedUsed + untrustedUsed > budget && dropOldestUntrusted());
        continue;
      }
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
        `[${omitted} evidence entries omitted to fit the evidence budget${full && cursor !== undefined ? ", and the older History not read" : ""}; trusted ones kept first, newest first]`,
        ...blocks,
      ];
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
