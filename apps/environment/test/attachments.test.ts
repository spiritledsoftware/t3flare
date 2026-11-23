// What an agent receives of a message's attachments (SPI-993): images inline, readable files as text, and a note for
// everything else, so the model always knows what was attached. SPI-1358: within the bound that holds on the agent's
// path, the Session's row for Pi Durable, the Environment isolate for an ACP agent, counted in JSON's UTF-8 bytes.
import { jsonTextBytes, jsonTextPrefix, SESSION_ROW_BYTES } from "@t3flare/session-protocol";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  ACP_PROMPT_BYTES,
  type AttachmentReader,
  PI_DURABLE_PROMPT_BYTES,
  type TurnPrompt,
  turnPrompt,
} from "../src/provider/attachments.ts";

const image = (id: string, mimeType = "image/png"): ChatAttachment =>
  ({ type: "image", id, name: `${id}.png`, mimeType, sizeBytes: 3 }) as ChatAttachment;
const file = (id: string, name: string, mimeType: string, extra: object = {}): ChatAttachment =>
  ({ type: "file", id, name, mimeType, sizeBytes: 10, ...extra }) as ChatAttachment;

const reader = (files: Record<string, Uint8Array>, extracted: Record<string, string> = {}): AttachmentReader => ({
  bytes: (attachment) => Effect.succeed(files[attachment.id] ?? null),
  extractedText: (attachment) => Effect.succeed(extracted[attachment.id] ?? null),
});
const utf8 = (text: string) => new TextEncoder().encode(text);
const prompt = (
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
  files: AttachmentReader,
  acceptsImages = true,
  budgetBytes = PI_DURABLE_PROMPT_BYTES,
) => Effect.runPromise(turnPrompt({ text, attachments }, { acceptsImages, reader: files, budgetBytes }));
/** What the prompt takes of its budget: its text as JSON holds it, and its images' base64. */
const promptBytes = (result: TurnPrompt) =>
  jsonTextBytes(result.text) + result.images.reduce((total, image) => total + image.data.length, 0);
const MiB = 1024 * 1024;

describe("a message's attachments, as a Durable agent receives them", () => {
  it("sends an image inline and names it in the text", async () => {
    const result = await prompt("What is this?", [image("shot")], reader({ shot: new Uint8Array([1, 2, 3]) }));
    expect(result.images).toEqual([{ data: "AQID", mimeType: "image/png" }]);
    expect(result.text).toBe('What is this?\n\n[Attached image "shot.png" is shown inline.]');
  });

  it("sends a 1.6 MiB screenshot, which Pi Durable's old 0.9 MB budget refused, on either path", async () => {
    const shot = new Uint8Array(Math.round(1.6 * MiB));
    for (const budget of [PI_DURABLE_PROMPT_BYTES, ACP_PROMPT_BYTES]) {
      const result = await prompt("What is this?", [image("shot")], reader({ shot }), true, budget);
      expect(result.images).toHaveLength(1);
      expect(result.text).toBe('What is this?\n\n[Attached image "shot.png" is shown inline.]');
    }
  });

  it("fits Pi Durable's prompt in one Session row with room for the record around it", () => {
    expect(PI_DURABLE_PROMPT_BYTES).toBeLessThan(SESSION_ROW_BYTES);
    expect(PI_DURABLE_PROMPT_BYTES).toBeGreaterThan(7 * MiB);
  });

  it("names, but does not send, an image past what is left of the budget, in MiB as t3's client says it", async () => {
    const big = new Uint8Array(5 * MiB);
    const result = await prompt(
      "",
      [image("small"), image("big"), image("big2")],
      reader({ small: new Uint8Array([1, 2, 3]), big, big2: big }),
    );
    expect(result.images.map((shown) => shown.data.length)).toEqual([4, Math.ceil((5 * MiB) / 3) * 4]);
    expect(result.text).toContain('[Attached image "small.png" is shown inline.]');
    expect(result.text).toContain(
      '[Attached image "big2.png" (5.0 MiB) is not shown: a message takes at most 7.6 MiB of text and images. Ask the user for a smaller image.]',
    );
    expect(promptBytes(result)).toBeLessThanOrEqual(PI_DURABLE_PROMPT_BYTES);
  });

  it("takes the message's text, counted in JSON's UTF-8 bytes, from the images' room", async () => {
    const shot = new Uint8Array(750); // 1,000 characters of base64
    const fits = await prompt("", [image("shot")], reader({ shot }), true, 1_100);
    expect(fits.images).toHaveLength(1);
    // 60 characters, but 150 bytes: with them, the image no longer fits.
    const crowded = await prompt("é".repeat(30) + "€".repeat(30), [image("shot")], reader({ shot }), true, 1_100);
    expect(crowded.images).toEqual([]);
    expect(promptBytes(crowded)).toBeLessThanOrEqual(1_100);
  });

  it("keeps text, images and every note within the budget", async () => {
    const shot = new Uint8Array(3_000);
    const result = await prompt(
      'Look "here"\n'.repeat(50),
      [image("a"), file("notes", "notes.md", "text/markdown"), image("b"), file("more", "more.md", "text/markdown")],
      reader({ a: shot, b: shot, notes: utf8("ü\n".repeat(5_000)), more: utf8("tab\t".repeat(5_000)) }),
      true,
      9_000,
    );
    expect(result.images).toHaveLength(1);
    expect(result.text).toContain('[Attached file "more.md" (text/markdown), cut to fit the prompt:]');
    expect(promptBytes(result)).toBeLessThanOrEqual(9_000);
    expect(promptBytes(result)).toBeGreaterThan(8_800);
  });

  it("sends no image to a model without image input", async () => {
    const result = await prompt("hi", [image("shot")], reader({ shot: new Uint8Array([1, 2, 3]) }), false);
    expect(result.images).toEqual([]);
    expect(result.text).toBe('hi\n\n[Attached image "shot.png" is not shown: this model does not take images.]');
  });

  it("inlines a text file and pasted text, and names a binary or missing one", async () => {
    const result = await prompt(
      "Review",
      [
        file("notes", "notes.md", "text/markdown"),
        file("paste", "Pasted text.txt", "text/plain", { source: { _tag: "pasted-text" } }),
        file("blob", "data.bin", "application/octet-stream"),
        file("gone", "gone.txt", "text/plain"),
      ],
      reader({ notes: utf8("# Notes\nhello"), paste: utf8("long paste"), blob: new Uint8Array([0, 159, 146, 150]) }),
    );
    expect(result.images).toEqual([]);
    expect(result.text).toBe(
      [
        "Review",
        '[Attached file "notes.md" (text/markdown):]\n# Notes\nhello\n[End of "notes.md".]',
        '[Attached file "Pasted text.txt" (text/plain):]\nlong paste\n[End of "Pasted text.txt".]',
        '[Attached file "data.bin" (application/octet-stream) is not readable as text by this agent.]',
        '[Attached file "gone.txt" is unavailable: t3 has no saved file for it.]',
      ].join("\n\n"),
    );
  });

  it("uses the text t3 extracted from a document", async () => {
    const result = await prompt(
      "",
      [file("doc", "spec.pdf", "application/pdf")],
      reader({ doc: utf8("%PDF-\u0000") }, { doc: "The spec." }),
    );
    expect(result.text).toBe(
      '[Attached file "spec.pdf" (application/pdf), as extracted text:]\nThe spec.\n[End of "spec.pdf".]',
    );
  });

  it("cuts file text to the budget and says so", async () => {
    const result = await prompt(
      "x",
      [file("huge", "huge.txt", "text/plain")],
      reader({ huge: utf8("a".repeat(200_000)) }),
      true,
      120_000,
    );
    expect(jsonTextBytes(result.text)).toBeLessThanOrEqual(120_000);
    expect(jsonTextBytes(result.text)).toBeGreaterThan(119_800);
    expect(result.text).toContain('[Attached file "huge.txt" (text/plain), cut to fit the prompt:]');
    expect(result.text.endsWith('[End of "huge.txt": cut.]')).toBe(true);
  });

  it("no longer cuts a file to t3's 120,000-character input limit, which is the typed message's", async () => {
    for (const budget of [PI_DURABLE_PROMPT_BYTES, ACP_PROMPT_BYTES]) {
      const result = await prompt(
        "x",
        [file("big", "big.txt", "text/plain")],
        reader({ big: utf8("a".repeat(200_000)) }),
        true,
        budget,
      );
      expect(result.text).toBe(
        `x\n\n[Attached file "big.txt" (text/plain):]\n${"a".repeat(200_000)}\n[End of "big.txt".]`,
      );
    }
  });

  it("takes the input text t3's ACP adapter sends beside it from the budget", async () => {
    const result = await Effect.runPromise(
      turnPrompt(
        { text: "", attachments: [file("big", "big.txt", "text/plain")] },
        {
          acceptsImages: true,
          reader: reader({ big: utf8("a".repeat(5_000)) }),
          budgetBytes: 3_000,
          reservedBytes: 2_000,
        },
      ),
    );
    expect(jsonTextBytes(result.text)).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("cut to fit the prompt");
  });

  it("does not read an image or a file whose recorded size is already past its bound", async () => {
    const read: Array<string> = [];
    const tracking: AttachmentReader = {
      bytes: (attachment) => Effect.sync(() => (read.push(attachment.id), new Uint8Array([1]))),
      extractedText: (attachment) => Effect.succeed(attachment.id === "pdf" ? "Extracted." : null),
    };
    const result = await prompt(
      "",
      [
        { ...image("photo"), sizeBytes: 9_000_000 } as ChatAttachment,
        file("log", "big.log", "text/plain", { sizeBytes: 30_000_000 }),
        file("pdf", "big.pdf", "application/pdf", { sizeBytes: 30_000_000 }),
      ],
      tracking,
    );
    expect(read).toEqual([]);
    expect(result.text).toContain('[Attached image "photo.png" (8.6 MiB) is not shown');
    expect(result.text).toContain(
      '[Attached file "big.log" (text/plain, 28.6 MiB) is too large for this agent to read.]',
    );
    expect(result.text).toContain('[Attached file "big.pdf" (application/pdf), as extracted text:]\nExtracted.');
  });

  it("treats an image type providers do not take inline as a file", async () => {
    const result = await prompt("", [image("vector", "image/svg+xml")], reader({ vector: utf8("<svg/>") }));
    expect(result.images).toEqual([]);
    expect(result.text).toContain('[Attached image "vector.png" (image/svg+xml):]\n<svg/>');
  });
});

describe("a text's size in a JSON string", () => {
  const samples = [
    "plain",
    'quote " and \\ slash',
    "line\nfeed\ttab\u0001",
    "é€",
    "emoji 😀",
    "lone \ud800 high",
    "lone \udc00 low",
  ];

  it("is the UTF-8 bytes JSON.stringify writes for it", () => {
    for (const text of samples) expect(jsonTextBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text)) - 2);
  });

  it("cuts at the longest prefix that fits, never inside a surrogate pair", () => {
    expect(jsonTextPrefix("ab😀c", 5)).toBe(2);
    expect(jsonTextPrefix("ab😀c", 6)).toBe(4);
    expect(jsonTextPrefix('a"b', 2)).toBe(1);
    expect(jsonTextPrefix("abc", 100)).toBe(3);
  });
});
