// The Model endpoints stored so full that only `room` bytes (to within two) are left of their one Durable Object value: the state in
// which a save past the value is refused (SPI-1365: no count of endpoints or models, one bound on their bytes).
import { DO_VALUE_BYTES, storedBytes } from "@t3flare/harness-registry";
import type { ModelEndpoints } from "@t3flare/models";

import { ENDPOINTS_KEY } from "../src/endpoints/store.ts";

export const fillEndpoints = (kv: { put<T>(key: string, value: T): void }, room: number): ModelEndpoints => {
  const endpoint = {
    id: "full",
    label: "Full",
    api: "openai-completions",
    baseUrl: "https://llm.example/v1",
    auth: "none",
    headers: {},
    models: [{ id: "big", name: "" }],
  };
  const value = { revision: 1, endpoints: [endpoint] };
  // Each character of the name counts three bytes.
  endpoint.models[0]!.name = "n".repeat(Math.floor((DO_VALUE_BYTES - room - storedBytes(value)) / 3));
  kv.put(ENDPOINTS_KEY, value);
  return value as unknown as ModelEndpoints;
};
