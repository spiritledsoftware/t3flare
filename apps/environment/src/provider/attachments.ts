// A t3 message's attachments as an agent receives them (SPI-993; t3's Pi provider does the same in
// `resolvePromptPayload`, `t3code/packages/provider-pi/src/server/adapter.ts`). A Durable agent runs in a Session DO
// that cannot read t3's attachment store, and an ACP agent's Container does not hold it either, so nothing here is a
// path: images go inline, readable files go into the text, and every other attachment is named with the reason it is
// not shown. The model always learns what was attached.
//
// The bound is the one that holds on the agent's path (SPI-1358), the caller's `budgetBytes`, counted as the prompt is
// carried: its text in a JSON string's UTF-8 bytes, its images as base64. Pi Durable's prompt is stored as one Session
// row (PI_DURABLE_PROMPT_BYTES); an ACP agent's is held in the Environment isolate on its way to the CLI's stdin
// (ACP_PROMPT_BYTES). A Pi Durable model's own limit on one image (`perImageBase64Of`) holds too: an image past it
// would fail every request of the conversation it is stored in.
import { type ChatAttachment, isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  type ImageInput,
  jsonPartBytes,
  jsonTextBytes,
  jsonTextPrefix,
  mebibytes,
  MIB,
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
export const ACP_PROMPT_BYTES = 16 * MIB;

/** No budget: OpenCode's expanded Skill mentions, which go to its stdin and are small beside the isolate. */
export const NO_BUDGET = Number.POSITIVE_INFINITY;

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

/** The bytes a note takes in the prompt's text, with the blank line that joins it to what is before it. */
const noteBytes = (note: string) => jsonPartBytes(note, "\n\n");

/** The base64 an image of `bytes` takes. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * A size wider in `mebibytes` than any attachment's (t3 takes none near 999 MiB): the size written in a note when the
 * note's bound is reckoned, so the bound holds whatever size the note ends up naming.
 */
const WIDEST_SIZE_BYTES = 999 * MIB;

/** An attachment's notes, each the text around it (a readable file's content goes between `open` and `close`). */
const notesOf = (attachment: ChatAttachment, budgetBytes: number, perImageBase64: number | undefined) => {
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
    imagePastModel: (bytes: number) =>
      `[Attached ${label} (${mebibytes(bytes)}, ${mebibytes(base64Length(bytes))} as base64) is not shown: this model takes at most ${mebibytes(perImageBase64 ?? 0)} of base64 in one image. Ask the user for a smaller image.]`,
    shown: `[Attached ${label} is shown inline.]`,
    fileTooLarge: `[Attached ${label} (${attachment.mimeType}, ${mebibytes(attachment.sizeBytes)}) is too large for this agent to read.]`,
    unreadable: `[Attached ${label} (${attachment.mimeType}) is not readable as text by this agent.]`,
    whole: file(""),
    extracted: file(", as extracted text"),
    cut: file(", cut to fit the prompt"),
  };
};
type Notes = ReturnType<typeof notesOf>;

/**
 * The most an attachment's note can take, its content aside: kept back for each attachment not yet placed, so what
 * comes before it never leaves it no room for its note.
 */
const noteBound = (notes: Notes) =>
  Math.max(
    ...[
      notes.noImages,
      notes.unavailable,
      notes.imageTooLarge(WIDEST_SIZE_BYTES),
      notes.imagePastModel(WIDEST_SIZE_BYTES),
      notes.shown,
      notes.fileTooLarge,
      notes.unreadable,
      notes.cut.open + notes.cut.close(true),
      notes.extracted.open + notes.extracted.close(false),
    ].map(noteBytes),
  );

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
 * on the caller's path (PI_DURABLE_PROMPT_BYTES, ACP_PROMPT_BYTES, NO_BUDGET). `perImageBase64`: the model's own limit
 * on one image, if it has one. With `skills` (the Pi Durable adapter's; SPI-1147), its Skill mentions and a leading
 * Slash command expand first, within the same budget; the ACP flavors pass none, so their agents get the message as
 * typed. `reservedBytes`: input text sent beside this one (t3's ACP adapter writes the message's own block), taken from
 * the budget. Images are placed first, each whole or not at all, then each file's text, as much as is left; each kind in
 * message order, and the notes in message order. Every note is counted, so the prompt never passes the budget.
 */
export const turnPrompt = Effect.fn("PiDurable.turnPrompt")(function* (
  message: { readonly text: string; readonly attachments: ReadonlyArray<ChatAttachment> },
  options: {
    readonly acceptsImages: boolean;
    readonly reader: AttachmentReader;
    readonly budgetBytes: number;
    readonly perImageBase64?: number;
    readonly skills?: MessageSkills;
    readonly reservedBytes?: number;
  },
) {
  const { budgetBytes, perImageBase64 } = options;
  const notesFor = message.attachments.map((attachment) => notesOf(attachment, budgetBytes, perImageBase64));
  // Kept back for the notes of the attachments not yet placed.
  const bounds = notesFor.map(noteBound);
  let heldForNotes = bounds.reduce((total, bound) => total + bound, 0);
  const catalog =
    options.skills !== undefined && hasCommandOrSigil(message.text) ? yield* options.skills.load() : undefined;
  const messageText =
    catalog === undefined
      ? message.text
      : yield* expandMessage(message.text, catalog, budgetBytes - (options.reservedBytes ?? 0) - heldForNotes);
  const placed: Array<string | undefined> = message.attachments.map(() => undefined);
  const images: Array<ImageInput> = [];
  let used = (options.reservedBytes ?? 0) + jsonTextBytes(messageText);
  const isInlineImage = (attachment: ChatAttachment) =>
    attachment.type === "image" && isProviderSendTurnSupportedImageMimeType(attachment.mimeType);
  /** Takes attachment `index` off what is held back: the room it may use, its note's bound included. */
  const roomFor = (index: number) => {
    heldForNotes -= bounds[index]!;
    return budgetBytes - used - heldForNotes;
  };
  const place = (index: number, note: string) => {
    used += noteBytes(note);
    placed[index] = note;
  };
  for (const [index, attachment] of message.attachments.entries()) {
    if (!isInlineImage(attachment)) continue;
    const note = notesFor[index]!;
    const imageRoom = roomFor(index) - noteBytes(note.shown);
    if (!options.acceptsImages) {
      place(index, note.noImages);
      continue;
    }
    // Too big to send: named without reading it.
    const pastModel = (base64: number) => perImageBase64 !== undefined && base64 > perImageBase64;
    if (pastModel(base64Length(attachment.sizeBytes))) {
      place(index, note.imagePastModel(attachment.sizeBytes));
      continue;
    }
    const overBudget = base64Length(attachment.sizeBytes) > imageRoom;
    const bytes = overBudget ? new Uint8Array(0) : yield* options.reader.bytes(attachment);
    if (bytes === null) {
      place(index, note.unavailable);
      continue;
    }
    const data = overBudget ? "" : Buffer.from(bytes).toString("base64");
    if (pastModel(data.length)) {
      place(index, note.imagePastModel(bytes.length));
      continue;
    }
    if (overBudget || data.length > imageRoom) {
      place(index, note.imageTooLarge(Math.max(bytes.length, attachment.sizeBytes)));
      continue;
    }
    used += data.length;
    images.push({ data, mimeType: attachment.mimeType });
    place(index, note.shown);
  }
  for (const [index, attachment] of message.attachments.entries()) {
    if (isInlineImage(attachment)) continue;
    const note = notesFor[index]!;
    const room = roomFor(index);
    // Too big to scan for text: named without reading it (t3's extracted text, if any, still goes in).
    const overFileCap = attachment.sizeBytes > FILE_READ_CAP_BYTES;
    const bytes = overFileCap ? new Uint8Array(0) : yield* options.reader.bytes(attachment);
    if (bytes === null) {
      place(index, note.unavailable);
      continue;
    }
    const extracted = yield* options.reader.extractedText(attachment);
    const content = extracted ?? (overFileCap ? null : asText(bytes));
    if (content === null) {
      place(index, overFileCap ? note.fileTooLarge : note.unreadable);
      continue;
    }
    const whole = extracted === null ? note.whole : note.extracted;
    const wholeNote = whole.open + content + whole.close(false);
    if (noteBytes(wholeNote) <= room) {
      place(index, wholeNote);
      continue;
    }
    const frame = noteBytes(note.cut.open + note.cut.close(true));
    const kept = content.slice(0, jsonTextPrefix(content, Math.max(0, room - frame)));
    place(index, note.cut.open + kept + note.cut.close(true));
  }
  const text = [messageText, ...placed]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  return { text, images } satisfies TurnPrompt;
});
