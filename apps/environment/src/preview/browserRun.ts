// The Browser Run binding (formerly Browser Rendering) as this Worker uses it (parity G11, ADR-0031): the Workers
// runtime's own type, re-exported so the rest of the package names one thing.
import type { BrowserRun, Fetcher } from "@cloudflare/workers-types/index.ts";

export type BrowserRunBinding = BrowserRun;
export type BrowserRunFetcher = Fetcher;

import { isPort, RESERVED_CONTAINER_PORTS } from "@t3flare/harness-registry";

export { CONTAINER_PREVIEW_DOMAIN, containerPreviewHost } from "@t3flare/workspace-client";

const CONTAINER_PREVIEW_HOST = /^(\d{1,5})\.t3flare\.internal$/;

/**
 * The Container port a Container preview's URL is for; undefined for any other host, an explicit port, or one of
 * t3flare's own. Which ports a browser reaches is its `outboundByHost`, made when it was acquired (`previewRoutes`,
 * SPI-1390), so a port the Owner removed from `previewPorts` since still serves that browser.
 */
export const containerPreviewPortOf = (url: URL): number | undefined => {
  const port = Number(CONTAINER_PREVIEW_HOST.exec(url.hostname)?.[1]);
  return isPort(port) && !RESERVED_CONTAINER_PORTS.includes(port) && url.port === "" && url.protocol === "http:"
    ? port
    : undefined;
};

/** Browser Run's keep-alive for every browser t3flare acquires: the most the binding allows (10 minutes). */
export const BROWSER_KEEP_ALIVE_MS = 600_000;
