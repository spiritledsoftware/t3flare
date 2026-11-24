// The Durable agent's retries of a failed model request (SPI-1367): `DURABLE_RETRIES` (SPI-1387), pi-durable's own count,
// and the span they wait, which the Session's rate-limit pause leans on (fragility U105).
import { DEFAULT_RETRY_POLICY } from "@earendil-works/pi-durable";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import { DURABLE_RETRIES, retriedSpanMs } from "@t3flare/harness-registry";
import { SHORT_RESET_MS } from "@t3flare/models/failures";
import { describe, expect, it } from "vitest";

describe("the Durable agent's retries", () => {
  // Fragility U105: `retriedSpanMs` mirrors pi-durable's private backoff; this pins it to pi-durable's own policy and
  // pi-ai's own wait, so a bump that changes either fails here.
  it("span as long as pi-durable's own retries wait, and its default 3 are models' SHORT_RESET_MS", () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(DURABLE_RETRIES);
    for (const retries of [0, 1, 2, 3, 5, 6, 7, 10, 100]) {
      let span = 0;
      for (let attempt = 1; attempt <= retries; attempt++) span += retryDelayMs(DEFAULT_RETRY_POLICY, attempt);
      expect(retriedSpanMs(retries), String(retries)).toBe(span);
    }
    expect(SHORT_RESET_MS).toBe(retriedSpanMs(DURABLE_RETRIES));
  });
});
