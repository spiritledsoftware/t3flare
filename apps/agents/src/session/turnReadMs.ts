// A turn's settings read wait (SPI-1314): how long the Session waits at the turn's start for the Harness settings, the
// Model endpoints and the MCP view, as the turn's start carried it.
import { DEFAULT_SETTINGS_READ_MS } from "@t3flare/harness-registry";
import type { SubmitTurnInput } from "@t3flare/session-protocol";

/** A turn's settings read wait: what its start carried, else the default (an Environment before SPI-1314). */
export const turnReadMs = (input: Pick<SubmitTurnInput, "settingsReadMs">): number =>
  input.settingsReadMs ?? DEFAULT_SETTINGS_READ_MS;
