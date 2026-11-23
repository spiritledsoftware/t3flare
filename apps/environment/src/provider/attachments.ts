// A t3 message's attachments as an agent receives them (SPI-993; t3's Pi provider does the same in
// `resolvePromptPayload`, `t3code/packages/provider-pi/src/server/adapter.ts`). A Durable agent runs in a Session DO
// that cannot read t3's attachment store, and an ACP agent's Container does not hold it either, so nothing here is a
// path: images go inline, readable files go into the text, and every other attachment is named with the reason it is
// not shown. The model always learns what was attached.
//
// SPI-1358: the bound is the one that holds on the agent's path, the caller's `budgetBytes`, counted as the prompt is
// carried: its text in a JSON string's UTF-8 bytes, its images as base64. Pi Durable's prompt is stored as one Session
// row (PI_DURABLE_PROMPT_BYTES); an ACP agent's is held in the Environment isolate on its way to the CLI's stdin
// (ACP_PROMPT_BYTES).
import { type ChatAttachment, isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  type ImageInput,
  jsonTextBytes,
  jsonTextPrefix,
  mebibytes,
  SESSION_ROW_BYTES,
  SESSION_ROW_ENVELOPE_BYTES,
} from "@t3flare/session-protocol";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { expandMessage, hasCommandOrSigil, type MessageSkills } from "./skills.ts";

/**
 * A Pi Durable message's text and images: pi-durable keeps each submission and the user message it becomes as one
 * Session row of JSON (SESSION_ROW_BYTES, 8 MB), which also holds the record around them.
 */
export const PI_DURABLE_PROMPT_BYTES = SESSION_ROW_BYTES - SESSION_ROW_ENVELOPE_BYTES;

/**
 * An ACP agent's attachments (Claude Code, OpenCode): no row holds them, so the bound is the Environment DO's 128 MB
 * isolate. t3 lets a message carry 80 MiB of images, about 107 MiB as base64, and the prompt is held up to four times on
 * its way to the CLI's stdin (the content blocks, t3's JSON-RPC line, two bytes a character once it holds any non-Latin-1
 * text, and that line's UTF-8 bytes), beside the rest of the Environment: 16 MiB keeps those copies to half the isolate.
 */
export const ACP_PROMPT_BYTES = 16 * 1024 * 1024;

/** The largest file read to look for text (an attachment may be 50 MB; the Environment DO has 128 MB). */
export const FILE_READ_CAP_BYTES = 2_000_000;

/** How the adapter reads t3's attachment store. */
export interface AttachmentReader {
  /** The attachment's bytes, or null when t3 has no saved file for it. */
  readonly bytes: (attachment: ChatAttachment) => Effect.Effect<Uint8Array | null>;
  /** The text t3 extracted from a document attachment (a PDF), or null. */
  readonly extractedText: (attachment: ChatAttachment) => Effect.Effect<string | null>;
}

/** t3's attachment store, through its own path resolution (the Environment's state directory). */
export const attachmentReader = (
  host: ProviderHost.ProviderHost["Service"],
  fileSystem: FileSystem.FileSystem,
): AttachmentReader => ({
  bytes: (attachment) => {
    const path = host.resolveAttachmentPath(attachment);
    return path === null ? Effect.succeed(null) : fileSystem.readFile(path).pipe(Effect.orElseSucceed(() => null));
  },
  extractedText: (attachment) => {
    const path = host.resolveAttachmentPath(attachment);
    if (path === null || host.resolveExtractedTextPath === undefined) return Effect.succeed(null);
    return host
      .resolveExtractedTextPath(path)
      .pipe(
        Effect.flatMap((extracted) =>
          extracted === undefined
            ? Effect.succeed(null)
            : fileSystem.readFileString(extracted).pipe(Effect.orElseSucceed(() => null)),
        ),
      );
  },
});

export interface TurnPrompt {
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
}

/** The bytes a note takes in the prompt's text: its own, and the blank line that joins it to what is before it. */
const noteBytes = (note: string) => jsonTextBytes(note) + jsonTextBytes("\n\n");

/** An attachment's notes, each the text around it (a readable file's content goes between `open` and `close`). */
const notesOf = (attachment: ChatAttachment, budgetBytes: number) => {
  const label = `${attachment.type} "${attachment.name}"`;
  const file = (how: string) => ({
    open: `[Attached ${label} (${attachment.mimeType})${how}:]\n`,
    close: (cut: boolean) => `\n[End of "${attachment.name}"${cut ? ": cut" : ""}.]`,
  });
  return {
    noImages: `[Attached ${label} is not shown: this model does not take images.]`,
    unavailable: `[Attached ${label} is unavailable: t3 has no saved file for it.]`,
    imageTooLarge: (bytes: number) =>
      `[Attached ${label} (${mebibytes(bytes)}) is not shown: a message takes at most ${mebibytes(budgetBytes)} of text and images. Ask the user for a smaller image.]`,
    shown: `[Attached ${label} is shown inline.]`,
    fileTooLarge: `[Attached ${label} (${attachment.mimeType}, ${mebibytes(attachment.sizeBytes)}) is too large for this agent to read.]`,
    unreadable: `[Attached ${label} (${attachment.mimeType}) is not readable as text by this agent.]`,
    whole: file(""),
    extracted: file(", as extracted text"),
    cut: file(", cut to fit the prompt"),
  };
};

/**
 * The most an attachment's note can take, its content aside: kept back for each attachment not yet placed, so what
 * comes before it never leaves it no room for its note. Sizes are written at their widest in `imageTooLarge`.
 */
const noteBound = (attachment: ChatAttachment, budgetBytes: number) => {
  const notes = notesOf(attachment, budgetBytes);
  return Math.max(
    ...[
      notes.noImages,
      notes.unavailable,
      notes.imageTooLarge(Math.max(attachment.sizeBytes, 999 * 1024 * 1024)),
      notes.shown,
      notes.fileTooLarge,
      notes.unreadable,
      notes.cut.open + notes.cut.close(true),
      notes.extracted.open + notes.extracted.close(false),
    ].map(noteBytes),
  );
};

/** The file's text when it is UTF-8 without NUL bytes, else null. */
const asText = (bytes: Uint8Array): string | null => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

/**
 * The prompt text and inline images of one message (`startTurn`'s or `steerTurn`'s), within `budgetBytes`: the bound
 * on the caller's path (PI_DURABLE_PROMPT_BYTES, ACP_PROMPT_BYTES). With `skills` (the Pi Durable adapter's; SPI-1147),
 * its Skill mentions and a leading Slash command expand first, within the same budget; the ACP flavors pass none, so
 * their agents get the message as typed. `reservedBytes`: input text sent beside this one (t3's ACP adapter writes the
 * message's own block), taken from the budget. Attachments are placed in order, each image whole or not at all and each
 * file's text as much as is left; every note is counted, so the prompt never passes the budget.
 */
export const turnPrompt = Effect.fn("PiDurable.turnPrompt")(function* (
  message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
  options: {
    readonly acceptsImages: boolean;
    readonly reader: AttachmentReader;
    readonly budgetBytes: number;
    readonly skills?: MessageSkills;
    readonly reservedBytes?: number;
  },
) {
  const { budgetBytes } = options;
  // Kept back for the notes of the attachments not yet placed.
  const bounds = message.attachments.map((attachment) => noteBound(attachment, budgetBytes));
  let heldForNotes = bounds.reduce((total, bound) => total + bound, 0);
  const catalog =
    options.skills !== undefined && hasCommandOrSigil(message.text) ? yield* options.skills.load() : undefined;
  const messageText =
    catalog === undefined
      ? message.text
      : yield* expandMessage(message.text, catalog, budgetBytes - (options.reservedBytes ?? 0) - heldForNotes);
  const notes: Array<string> = [];
  const images: Array<ImageInput> = [];
  let used = (options.reservedBytes ?? 0) + jsonTextBytes(messageText);
  const add = (note: string) => {
    used += noteBytes(note);
    notes.push(note);
  };
  for (const [index, attachment] of message.attachments.entries()) {
    heldForNotes -= bounds[index]!;
    const room = budgetBytes - used - heldForNotes;
    const note = notesOf(attachment, budgetBytes);
    const inlineImage = attachment.type === "image" && isProviderSendTurnSupportedImageMimeType(attachment.mimeType);
    if (inlineImage && !options.acceptsImages) {
      add(note.noImages);
      continue;
    }
    // Too big to send or to scan for text: named without reading it (t3's extracted text, if any, still goes in).
    const imageRoom = room - noteBytes(note.shown);
    const overImageBudget = inlineImage && Math.ceil(attachment.sizeBytes / 3) * 4 > imageRoom;
    const overFileCap = !inlineImage && attachment.sizeBytes > FILE_READ_CAP_BYTES;
    const bytes = overImageBudget || overFileCap ? new Uint8Array(0) : yield* options.reader.bytes(attachment);
    if (bytes === null) {
      add(note.unavailable);
      continue;
    }
    if (inlineImage) {
      const data = overImageBudget ? "" : Buffer.from(bytes).toString("base64");
      if (overImageBudget || data.length > imageRoom) {
        add(note.imageTooLarge(Math.max(bytes.length, attachment.sizeBytes)));
        continue;
      }
      used += data.length;
      images.push({ data, mimeType: attachment.mimeType });
      add(note.shown);
      continue;
    }
    const extracted = yield* options.reader.extractedText(attachment);
    const content = extracted ?? (overFileCap ? null : asText(bytes));
    if (content === null) {
      add(overFileCap ? note.fileTooLarge : note.unreadable);
      continue;
    }
    const whole = extracted === null ? note.whole : note.extracted;
    const wholeNote = whole.open + content + whole.close(false);
    if (noteBytes(wholeNote) <= room) {
      add(wholeNote);
      continue;
    }
    const frame = noteBytes(note.cut.open + note.cut.close(true));
    const kept = content.slice(0, jsonTextPrefix(content, Math.max(0, room - frame)));
    add(note.cut.open + kept + note.cut.close(true));
  }
  const text = [messageText, ...notes].filter((part) => part.length > 0).join("\n\n");
  return { text, images } satisfies TurnPrompt;
});
