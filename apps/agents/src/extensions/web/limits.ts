// The web tools' limits (SPI-1321): the `web` extension's settings in the harness registry, read at each turn's
// install. The defaults are the registry's, so a tool built without settings (a test) behaves as an untouched harness.
import { defaultSettings, type SettingValue } from "@t3flare/harness-registry";

export const WEB_EXTENSION = "web";

export interface WebLimits {
  /** A `web_fetch` call's time limit when it names none. */
  readonly fetchTimeoutSeconds: number;
  /** The longest `timeout` a `web_fetch` call may name (the default is always allowed, even above it). */
  readonly fetchMaxTimeoutSeconds: number;
  /** The largest response body `web_fetch` reads. */
  readonly fetchMaxKiB: number;
  /** `web_search`'s results when a call names no `numResults`. */
  readonly searchResults: number;
  /** The server tool's `max_uses`: searches the search model may run for one call. */
  readonly searchesPerCall: number;
  /** The search request's `max_tokens`. */
  readonly searchSummaryTokens: number;
  /** A `web_search` call's time limit, reading the answer included. */
  readonly searchTimeoutSeconds: number;
  /** The characters of result text a `web_search` call that names no `contextMaxCharacters` shares across results. */
  readonly searchContextCharacters: number;
}

/** The `web` extension's resolved settings as limits. */
export const webLimits = (values: Readonly<Record<string, SettingValue>>): WebLimits => ({
  fetchTimeoutSeconds: Number(values.fetchTimeoutSeconds),
  fetchMaxTimeoutSeconds: Number(values.fetchMaxTimeoutSeconds),
  fetchMaxKiB: Number(values.fetchMaxKiB),
  searchResults: Number(values.searchResults),
  searchesPerCall: Number(values.searchesPerCall),
  searchSummaryTokens: Number(values.searchSummaryTokens),
  searchTimeoutSeconds: Number(values.searchTimeoutSeconds),
  searchContextCharacters: Number(values.searchContextCharacters),
});

export const DEFAULT_WEB_LIMITS: WebLimits = webLimits(defaultSettings(WEB_EXTENSION));
