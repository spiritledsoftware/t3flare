// The `web` extension (SPI-1054; parity row pi-web-tools):
// `web_fetch` (the Worker's own `fetch`, through the SSRF guard) and, when the harness setting turns it on,
// `web_search` (a search-capable model on a Model endpoint; `web/search.ts` says why). Both are reads: no mode asks
// for them, and linked threads may use them. In code mode they are the `web` namespace.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

import { webFetchTool } from "./web/fetch.ts";
import { DEFAULT_WEB_LIMITS, WEB_EXTENSION, type WebLimits } from "./web/limits.ts";
import { type WebTransport, workerTransport } from "./web/net.ts";
import { type SearchEndpoint, webSearchTool } from "./web/search.ts";

export { DEFAULT_WEB_LIMITS, WEB_EXTENSION, type WebLimits, webLimits } from "./web/limits.ts";

/** The web tools in a code mode script (`tools.web_fetch`, `tools.web_search`). */
export const WEB_NAMESPACE: CodemodeNamespace = {
  name: "web",
  description: "The public web: fetch a page, search",
  prefix: "web_",
};

export interface WebOptions {
  /** Where `web_search` searches; absent: `web_search` is not offered. */
  readonly search?: SearchEndpoint;
  readonly transport?: WebTransport;
  /** The `web` extension's settings; absent: the registry's defaults. */
  readonly limits?: WebLimits;
}

export const webExtension = (options: WebOptions = {}): Extension => {
  const transport = options.transport ?? workerTransport;
  const limits = options.limits ?? DEFAULT_WEB_LIMITS;
  return defineExtension({
    name: WEB_EXTENSION,
    tools: [
      webFetchTool(transport, limits),
      ...(options.search === undefined ? [] : [webSearchTool(transport, options.search, limits)]),
    ],
  });
};
