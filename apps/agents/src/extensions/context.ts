// The `context` extension (SPI-1056; parity row pi-context-management):
// pi-context-management's `context_notes`, `context_history` and `context_rollover` on pi-durable.
// Notes are a conversation document in the Session DO's storage (bounded, `./context/notes.ts`), History reads the
// Session's stored entries, and Rollover hands off with `control: { handoff }`. With `rolloverOnCompaction` (the
// default), a `beforeCompact` hook turns a background threshold compaction into a Rollover request and a compaction that
// cannot wait into an Emergency Rollover (`./context/rollover.ts` says how it sits with pi-durable's and t3's
// compaction). In code mode the notes and history tools are the `context` namespace; `context_rollover` is the model's.
import { defineExtension, type Extension, type Harness, section } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

import { contextRolloverTool, prepareRollover } from "./context/rollover.ts";
import { CONTEXT_GUIDELINES, contextHistoryTool, contextNotesTool, DEFAULT_PREVIEW_LIMITS } from "./context/tools.ts";
import { DEFAULT_TOOL_OUTPUT_LIMITS, type ToolOutputLimits } from "./toolOutput.ts";

export const CONTEXT_EXTENSION = "context";

export { ContextDoc, type ContextState, MAX_TOTAL_NOTE_CHARACTERS } from "./context/notes.ts";

export const CONTEXT_NAMESPACE: CodemodeNamespace = {
  name: "context",
  description: "This thread's Notes and stored History",
  prefix: "context_",
};

export interface ContextOptions {
  /** Turn automatic compaction into a Rollover (the harness setting); off: pi-durable summarizes as before. */
  readonly rolloverOnCompaction: boolean;
  /** How long a History list line or a search preview is (the `previewCharacters` setting); absent: its default. */
  readonly previewCharacters?: number;
  /** The Tool output limit, which a History read's page is sized to; absent: its default. */
  readonly output?: ToolOutputLimits;
}

const previews = (options: ContextOptions) =>
  options.previewCharacters === undefined ? DEFAULT_PREVIEW_LIMITS : { preview: options.previewCharacters };

/** The `context` extension; `harness` finds the conversation a compaction belongs to. */
export const contextExtension = (harness: () => Promise<Harness>, options: ContextOptions): Extension =>
  defineExtension({
    name: CONTEXT_EXTENSION,
    tools: [
      contextNotesTool(previews(options)),
      contextHistoryTool(previews(options), options.output ?? DEFAULT_TOOL_OUTPUT_LIMITS),
      contextRolloverTool(),
    ],
    hooks: options.rolloverOnCompaction ? [prepareRollover(harness)] : [],
    // The guideline of each context tool the request offers, as pi-context-management adds them to the prompt.
    sections: [
      section("context_management", (input) => {
        const lines = Object.entries(CONTEXT_GUIDELINES).flatMap(([tool, line]) =>
          input.agent.tools.some((offered) => offered.name === tool) ? [`- ${line}`] : [],
        );
        return lines.length === 0 ? undefined : lines.join("\n");
      }),
    ],
  });
