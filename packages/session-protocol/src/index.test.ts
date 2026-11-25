import { describe, expect, it } from "vitest";

import { jsonTextBytes, jsonTextPrefix } from "./index.ts";

describe("JSON text bytes (SPI-1394)", () => {
  const stringified = (text: string) => new TextEncoder().encode(JSON.stringify(text)).byteLength - 2;
  const samples = ['"'.repeat(50), "\t".repeat(50), "\u0001".repeat(50), "é".repeat(50), "😀".repeat(50), "a\ud800b"];

  it("counts what JSON.stringify writes, escapes and all", () => {
    for (const text of samples) expect(jsonTextBytes(text)).toBe(stringified(text));
  });

  it("keeps the longest start within the room, exactly, never splitting a surrogate pair", () => {
    // 90% escapes: every room keeps all it can, never less.
    const mixed = Array.from({ length: 1_000 }, (_, at) => (at % 10 === 0 ? "a" : '"')).join("");
    for (const text of [...samples, mixed])
      for (const room of [0, 1, 5, 6, 7, 99, 100, 101, jsonTextBytes(text)]) {
        const end = jsonTextPrefix(text, room);
        expect(jsonTextBytes(text.slice(0, end))).toBeLessThanOrEqual(room);
        if (end < text.length)
          expect(jsonTextBytes(text.slice(0, end + (text.codePointAt(end)! > 0xffff ? 2 : 1)))).toBeGreaterThan(room);
        // A pair split would leave a high surrogate at the end and its low one after it.
        expect(/[\ud800-\udbff]$/.test(text.slice(0, end)) && /^[\udc00-\udfff]/.test(text.slice(end))).toBe(false);
      }
    expect(jsonTextPrefix(mixed, 100_000)).toBe(mixed.length);
  });
});
