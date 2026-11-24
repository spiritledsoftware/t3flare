// SPI-1376: an image is held to the model's API's limit on one image (`perImageBase64Of`) as it enters, by the model the
// turn then ran on. A conversation that moves to a model with a lower limit (an Anthropic one, after an image taken
// under another) still holds the image, and every request would fail on it. Before each model request, an image past the
// current turn's limit, in user or tool-result content, is replaced by the intake's note, for that request only: the
// stored entries keep it, so a model that takes it sees it again.
//
// pi-durable's compaction needs no such hook: its summarizer is sent the conversation as plain text, without images
// (1.5.0 `harness/compaction.js`, `serializeConversation`).
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { mebibytes } from "@t3flare/session-protocol";

/**
 * The note for an image left out because the model's API takes at most `perImageBase64` of base64 in one image; shared
 * by the tool-result intake (`imagesOf`) and the history hook. `subject` names the image, with a capital.
 */
export const imageTooLargeNote = (subject: string, base64Length: number, perImageBase64: number): string =>
  `[${subject} (${mebibytes(base64Length)} of base64) is not shown: this model's API takes at most ${mebibytes(perImageBase64)} in one image.]`;

type Block = TextContent | ImageContent | { readonly type: string };

/** `content` with each image past `perImageBase64` replaced by its note, or `content` itself when none is. */
const capped = <T extends Block>(content: ReadonlyArray<T>, perImageBase64: number): ReadonlyArray<T | TextContent> => {
  const over = (block: Block): block is ImageContent =>
    block.type === "image" && (block as ImageContent).data.length > perImageBase64;
  if (!content.some(over)) return content;
  return content.map((block) =>
    over(block)
      ? { type: "text" as const, text: imageTooLargeNote("An earlier image", block.data.length, perImageBase64) }
      : block,
  );
};

/**
 * `messages` with every user and tool-result image past `perImageBase64` replaced by the intake's note. The messages are
 * not changed: one that needs no change is returned as it is, and `messages` itself when none does.
 */
export const dropOversizeHistoryImages = (
  messages: ReadonlyArray<Message>,
  perImageBase64: number | undefined,
): ReadonlyArray<Message> => {
  if (perImageBase64 === undefined) return messages;
  let changed = false;
  const out = messages.map((message): Message => {
    if (message.role === "assistant" || typeof message.content === "string") return message;
    const content = capped(message.content, perImageBase64);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content: [...content] } as Message;
  });
  return changed ? out : messages;
};

/** The hook, with `perImageBase64`: the limit of the API the turn runs on, read at each request. */
export const historyImages = (perImageBase64: () => number | undefined): Extension =>
  defineExtension({
    name: "history-images",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          const out = dropOversizeHistoryImages(messages, perImageBase64());
          return out === messages ? undefined : { messages: out };
        },
      }),
    ],
  });
