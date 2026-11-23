// G11 (R6): a t3 tool result's MCP `image` parts reach a Durable agent as pi image content (`html_preview`'s and
// `preview_snapshot`'s screenshots), of the types a model reads, bounded by what holds on their path: the
// Session row the result is stored in and the model's API's own per-image limit, not by a count; and the model is told
// of an image it does not get.
import { jsonTextBytes, SESSION_ROW_BYTES } from "@t3flare/session-protocol";
import { describe, expect, it } from "vitest";

import { perImageBase64Of } from "@t3flare/models/endpoints";

import { imagesOf, RESULT_BYTES } from "../src/session/t3McpClient.ts";

const MiB = 1024 * 1024;
const png = (data: string) => ({ type: "image", data, mimeType: "image/png" });

describe("a t3 tool result's images", () => {
  it("keeps png, jpeg, gif and webp parts and drops the rest", () => {
    expect(
      imagesOf([
        { type: "text", text: "shot" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "image", data: "BBB", mimeType: "image/svg+xml" },
        { type: "image", mimeType: "image/png" },
        { type: "image", data: "CCC", mimeType: "image/webp" },
      ]),
    ).toEqual({
      images: [
        { data: "AAA", mimeType: "image/png" },
        { data: "CCC", mimeType: "image/webp" },
      ],
      notes: [],
    });
  });

  it("keeps more than four images: no count bounds them", () => {
    expect(imagesOf(Array.from({ length: 12 }, () => png("A"))).images).toHaveLength(12);
  });

  it("keeps an image past 5 MiB when the model's API takes it, within the Session row", () => {
    const big = png("x".repeat(6 * MiB));
    expect(imagesOf([big]).images).toHaveLength(1);
    expect(RESULT_BYTES).toBeLessThan(SESSION_ROW_BYTES);
  });

  it("holds an image past Anthropic's 5 MiB of base64 back from an Anthropic model, and says so", () => {
    expect(perImageBase64Of("anthropic-messages")).toBe(5 * MiB);
    expect(perImageBase64Of("openai-responses")).toBeUndefined();
    const result = imagesOf([png("x".repeat(5 * MiB + 1)), png("A")], perImageBase64Of("anthropic-messages"));
    expect(result.images).toEqual([{ data: "A", mimeType: "image/png" }]);
    expect(result.notes).toEqual([
      "[Image 1 of this result (5.0 MiB of base64) is not shown: this model's API takes at most 5.0 MiB in one image.]",
    ]);
  });

  it("keeps the result's text and images within the Session row, naming the images left out", () => {
    const text = "é".repeat(500_000); // a million bytes
    const shot = png("x".repeat(3 * MiB));
    const result = imagesOf([{ type: "text", text }, shot, shot, shot]);
    expect(result.images).toHaveLength(2);
    expect(result.notes).toEqual([
      "[Image 3 of this result (3.0 MiB of base64) is not shown: a tool result holds at most 7.6 MiB of text and images.]",
    ]);
    const bytes =
      jsonTextBytes([text, ...result.notes].join("\n")) +
      result.images.reduce((total, image) => total + image.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(RESULT_BYTES);
  });
});
