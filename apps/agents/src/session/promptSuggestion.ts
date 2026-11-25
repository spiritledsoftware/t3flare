// Prompt suggestions (SPI-996, parity G5): t3's labs flag `promptSuggestionsEnabled` asks a provider for the owner's
// likely next message after a completed turn (`prompt_suggestion.updated`). t3's Codex adapter samples its own thread
// with `CODEX_PROMPT_SUGGESTION_PROMPT` at low effort (t3code `CodexAdapterV2.ts`, `samplePromptSuggestion`); Claude
// Code makes its own. A Durable agent has neither, so the Session asks a small model of its Model endpoints (the
// endpoints' small model, text generation's default rule), with
// the turn's request and answer only (their last `SUGGESTION_EXCERPT_CHARACTERS`, SPI-1388), never the whole thread: one
// cheap request per completed turn, only while the owner has the labs flag on.
// @effect-diagnostics globalTimers:off globalConsole:off
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";
import { SUGGESTION_EXCERPT_CHARACTERS, SUGGESTION_TIMEOUT_SECONDS } from "@t3flare/harness-registry";
import { defaultSmallModel, type ModelEndpoints, parseEndpointSlug } from "@t3flare/models/endpoints";

/** t3's prompt (`CODEX_PROMPT_SUGGESTION_PROMPT`, t3code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`). */
export const PROMPT_SUGGESTION_PROMPT =
  "Predict the next message the user will send in this conversation. Reply with only that message, written as the user would type it, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.";

/** The model that predicts: small and fast, the Guardian's default (`defaultSmallModel`), as `{ provider, modelId }`; none without an endpoint. */
export const suggestionModelOf = (
  endpoints: ModelEndpoints,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const slug = defaultSmallModel(endpoints);
  const parsed = slug === undefined ? undefined : parseEndpointSlug(slug);
  return parsed === undefined ? undefined : { provider: parsed.endpointId, modelId: parsed.modelId };
};
/**
 * The newest item that `matches`, paging back with `page` (newest first; `next` names the following page) until one does
 * or none are left (SPI-1366): a turn's final answer is found after any number of tool entries, reading only the pages
 * before it.
 */
export const newestMatch = async <A, C>(
  page: (cursor: C | undefined) => Promise<{ readonly items: ReadonlyArray<A>; readonly next?: C | undefined }>,
  matches: (item: A) => boolean,
): Promise<A | undefined> => {
  let cursor: C | undefined;
  do {
    const read = await page(cursor);
    const found = read.items.find(matches);
    if (found !== undefined) return found;
    cursor = read.next;
  } while (cursor !== undefined);
  return undefined;
};

/** How much of the turn the model reads, how long it may take: fixed (SPI-1388); a test may name its own. */
export interface SuggestionLimits {
  /** Most characters of the request and of the answer the model reads, the last of each. */
  readonly excerptCharacters: number;
  readonly timeoutMs: number;
}

export const DEFAULT_SUGGESTION_LIMITS: SuggestionLimits = {
  excerptCharacters: SUGGESTION_EXCERPT_CHARACTERS,
  timeoutMs: SUGGESTION_TIMEOUT_SECONDS * 1000,
};

/** The last `characters` of `text`; a cut one is marked, and the log names the limit (ADR-0049 §4). */
const excerpt = (text: string, characters: number): string => {
  if (text.length <= characters) return text;
  console.log(
    JSON.stringify({
      t3flare: "prompt-suggestion-limit",
      limit: "SUGGESTION_EXCERPT_CHARACTERS",
      characters,
      dropped: text.length - characters,
    }),
  );
  return `…${text.slice(-characters)}`;
};

/** The request the model answers: the turn's user message and the agent's answer, then t3's prompt. */
export const suggestionContext = (
  user: string,
  answer: string,
  limits: SuggestionLimits = DEFAULT_SUGGESTION_LIMITS,
): Context => ({
  systemPrompt: "You predict what a developer will type next to their coding agent.",
  messages: [
    {
      role: "user",
      content: `The developer wrote:\n<message>\n${excerpt(user, limits.excerptCharacters)}\n</message>\n\nThe agent answered:\n<answer>\n${excerpt(answer, limits.excerptCharacters)}\n</answer>\n\n${PROMPT_SUGGESTION_PROMPT}`,
      timestamp: 0,
    },
  ],
});

/** The suggestion, or "" when the model has none or fails (best effort, as t3's adapters treat it). */
export const suggestPrompt = async (
  models: Pick<Models, "completeSimple">,
  model: Model<Api>,
  user: string,
  answer: string,
  limits: SuggestionLimits = DEFAULT_SUGGESTION_LIMITS,
): Promise<string> => {
  if (user.trim() === "" || answer.trim() === "") return "";
  const controller = new AbortController();
  // A late suggestion is simply not shown; the log names the limit (ADR-0049 §4).
  const timer = setTimeout(() => {
    console.log(
      JSON.stringify({ t3flare: "prompt-suggestion-limit", limit: "SUGGESTION_TIMEOUT_SECONDS", ms: limits.timeoutMs }),
    );
    controller.abort(new Error(`prompt suggestion timed out after ${limits.timeoutMs} ms, its fixed time limit`));
  }, limits.timeoutMs);
  try {
    const reply = await models.completeSimple(model, suggestionContext(user, answer, limits), {
      signal: controller.signal,
    });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") return "";
    const text = reply.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return text.replace(/^["']|["']$/g, "").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
};
