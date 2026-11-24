// SPI-1376: an image the conversation holds past the current model's API limit on one image (`perImageBase64Of`, set
// when a thread moves to an Anthropic model after an image was taken under another) is left out of that request with the
// intake's note, so the thread keeps working; the stored entries keep it.
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { perImageBase64Of } from "@t3flare/models/endpoints";
import { describe, expect, it } from "vitest";

import { dropOversizeHistoryImages, historyImages } from "../src/session/historyImages.ts";
import { imagesOf } from "../src/session/t3McpClient.ts";
import { context } from "./harness.fixture.ts";

const MiB = 1024 * 1024;
const ANTHROPIC = perImageBase64Of("anthropic-messages")!;
const png = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const NOTE_6 =
  "[An earlier image (6.0 MiB of base64) is not shown: this model's API takes at most 5.0 MiB in one image.]";

describe("dropOversizeHistoryImages", () => {
  const big = png("x".repeat(6 * MiB));
  const small = png("A");
  const messages: ReadonlyArray<Message> = [
    { role: "user", content: [{ type: "text", text: "look" }, big, small], timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "shot",
      content: [big, { type: "text", text: "shot" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "plain", timestamp: 3 },
  ];

  it("replaces an image past the cap with the intake's note, in user and tool-result content, and keeps one under it", () => {
    const out = dropOversizeHistoryImages(messages, ANTHROPIC);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "look" }, { type: "text", text: NOTE_6 }, small],
      timestamp: 1,
    });
    expect(out[1]).toMatchObject({
      content: [
        { type: "text", text: NOTE_6 },
        { type: "text", text: "shot" },
      ],
    });
    expect(out[2]).toBe(messages[2]);
  });

  it("keeps every image when the model's API sets no cap, and changes nothing it is given", () => {
    const before = structuredClone(messages);
    expect(dropOversizeHistoryImages(messages, undefined)).toBe(messages);
    dropOversizeHistoryImages(messages, ANTHROPIC);
    expect(messages).toEqual(before);
  });

  it("keeps an image of exactly the cap", () => {
    const at: ReadonlyArray<Message> = [{ role: "user", content: [png("x".repeat(ANTHROPIC))], timestamp: 1 }];
    expect(dropOversizeHistoryImages(at, ANTHROPIC)).toBe(at);
  });

  it("words its note as the tool-result intake does", () => {
    const [intake] = imagesOf([big], ANTHROPIC).notes;
    expect(intake).toBe(NOTE_6.replace("An earlier image", "Image 1 of this result"));
  });
});

describe("the Session's history image hook", () => {
  it("sends a 6 MiB history image with the note once the turn's model is Anthropic's, keeping it in the entries", async () => {
    let cap: number | undefined;
    const seen: Array<ReadonlyArray<Message>> = [];
    const answer =
      (text: string) =>
      (request: { readonly messages: ReadonlyArray<Message> }): AssistantMessage => {
        seen.push(structuredClone(request.messages));
        return fauxAssistantMessage(text);
      };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([answer("one"), answer("two"), answer("three")]);
    const registry = createRegistry();
    registry.install(historyImages(() => cap));
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    harness.resume();
    const big = png("x".repeat(6 * MiB));
    const imageOf = (messages: ReadonlyArray<Message> | undefined) =>
      messages?.find((message) => message.role === "user")?.content;

    // Taken under a model with no cap: sent as it is.
    await root.submit({ type: "input", content: [{ type: "text", text: "see" }, big] }, context);
    await root.waitForIdle(context);
    expect(imageOf(seen[0])).toEqual([{ type: "text", text: "see" }, big]);

    // The thread moves to an Anthropic model: the image becomes the note, for that request.
    cap = ANTHROPIC;
    await root.submit({ type: "input", content: "again" }, context);
    await root.waitForIdle(context);
    expect(imageOf(seen[1])).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: NOTE_6 },
    ]);

    // The entries keep it, and a model with no cap sees it again.
    const page = await root.entries({ order: "ascending" }, 50, undefined, context);
    expect(
      page.items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "user")?.content,
    ).toEqual([{ type: "text", text: "see" }, big]);
    cap = undefined;
    await root.submit({ type: "input", content: "back" }, context);
    await root.waitForIdle(context);
    expect(imageOf(seen[2])).toEqual([{ type: "text", text: "see" }, big]);
  }, 60_000);
});
