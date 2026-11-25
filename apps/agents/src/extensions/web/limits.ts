// The web tools' limits (SPI-1321): the `web` extension's settings in the harness registry, read at each turn's
// install. The defaults are the registry's, so a tool built without settings (a test) behaves as an untouched harness.
// Its fixed values (the fetch's time and size limits, its redirects and title, the search's summary, time and result
// text) are the registry's constants (SPI-1388), and each names itself where it is hit.
import { defaultSettings, type SettingValue } from "@t3flare/harness-registry";

export const WEB_EXTENSION = "web";

export interface WebLimits {
  /** `web_search`'s results when a call names no `numResults`. */
  readonly searchResults: number;
  /** The server tool's `max_uses`: searches the search model may run for one call. */
  readonly searchesPerCall: number;
}

/** The `web` extension's resolved settings as limits. */
export const webLimits = (values: Readonly<Record<string, SettingValue>>): WebLimits => ({
  searchResults: Number(values.searchResults),
  searchesPerCall: Number(values.searchesPerCall),
});

export const DEFAULT_WEB_LIMITS: WebLimits = webLimits(defaultSettings(WEB_EXTENSION));
