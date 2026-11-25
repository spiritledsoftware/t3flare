// Which Container ports a Workspace's preview browser routes, and where a page's navigation goes (SPI-1390, ADR-0031).
// Browser Run routes at most `MAX_PREVIEW_PORTS` (8) hosts, `http://<port>.t3flare.internal/` on port 80 only, fixed
// when the browser is acquired (the SPI-1390 Stage probe: a ninth is refused, another port answers 403). So a browser
// that may open any port (the Owner's `previewPorts` off, the default) starts routing the ports a preview can use now,
// and is restarted with a port it does not route when a page asks for one. With the Owner's list, it routes that list.
import type { PortScan } from "@t3flare/sandbox-image/ports";
import {
  MAX_PREVIEW_PORTS,
  RESERVED_CONTAINER_PORTS,
  reservedPortMessage,
  settingPlace,
  USUAL_DEV_SERVER_PORTS,
} from "@t3flare/harness-registry";
import { containerPreviewHost } from "@t3flare/workspace-client";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[a-z0-9-]+\.localhost)$/i;

/** What a browser's page may open: the ports it routes, and the Owner's list (none: any port but t3flare's own). */
export interface PreviewBrowserPorts {
  readonly routed: ReadonlyArray<number>;
  readonly allowlist: ReadonlyArray<number>;
}

/**
 * Where a navigation goes: `go` to a URL (a routed port's preview host, or any other URL as it is); a `page` naming why
 * a port has no preview (t3flare's own, or off the Owner's list); or `relaunch` the browser so it routes `port`.
 */
export type PreviewNavigation =
  | { readonly kind: "go"; readonly url: string }
  | { readonly kind: "page"; readonly url: string }
  | { readonly kind: "relaunch"; readonly port: number };

const isPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

const notice = (title: string, text: string): PreviewNavigation => {
  const page = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;
  return { kind: "page", url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` };
};

/**
 * Where a navigation to `url` goes in a Workspace's preview browser: a loopback URL (Browser Run refuses loopback itself)
 * to its port's preview host (`http`, as Browser Run routes only HTTP) when the browser routes it; t3flare's own ports to
 * a page naming them; a port off the Owner's list to a page naming the list; any other port to a restart that routes it.
 * Any other URL as it is.
 */
export const previewNavigation = (url: string, browser: PreviewBrowserPorts): PreviewNavigation => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "go", url };
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK.test(parsed.hostname))
    return { kind: "go", url };
  const port = parsed.port === "" ? (parsed.protocol === "http:" ? 80 : 443) : Number(parsed.port);
  const reserved = reservedPortMessage(port);
  if (reserved !== undefined)
    return notice(
      `Port ${port} is reserved`,
      `${reserved.charAt(0).toUpperCase()}${reserved.slice(1)}. Start the dev server on another port, listening on 0.0.0.0, then open it again.`,
    );
  if (browser.routed.includes(port))
    return { kind: "go", url: `http://${containerPreviewHost(port)}${parsed.pathname}${parsed.search}${parsed.hash}` };
  if (browser.allowlist.length > 0 && !browser.allowlist.includes(port))
    return notice(
      `Port ${port} has no preview`,
      `The Cloud Environment previews a Workspace's dev server on ports ${browser.allowlist.join(", ")} (the Environment setting Container preview ports, under ${settingPlace({ environment: "previewPorts" })}). Start it on one of them, listening on 0.0.0.0, or add its port to the setting, or empty the setting to allow any port, then open it again.`,
    );
  return { kind: "relaunch", port };
};

/** What a navigation that restarted its browser fails with: the restart named, with the limit that forced it. */
export const relaunchMessage = (port: number): string =>
  `Port ${port} was not one of this Workspace's preview browser's ports: Browser Run fixes a browser's ports when it starts, at most ${MAX_PREVIEW_PORTS}. The preview browser restarted with port ${port} added, and its tabs closed. Open http://localhost:${port}/ again.`;

/**
 * The ports a Workspace's browser routes, at most `MAX_PREVIEW_PORTS`, never t3flare's own: the Owner's list alone when
 * there is one; else the port a page asked for, the ports listening in the Container now, the browser's last routes,
 * then the dev servers' usual ports in the slots left.
 */
export const previewRoutes = (input: {
  readonly allowlist: ReadonlyArray<number>;
  readonly wanted: number | undefined;
  readonly listening: ReadonlyArray<number>;
  readonly previous: ReadonlyArray<number>;
}): ReadonlyArray<number> => {
  const candidates =
    input.allowlist.length > 0
      ? input.allowlist
      : [
          ...(input.wanted === undefined ? [] : [input.wanted]),
          ...input.listening,
          ...input.previous,
          ...USUAL_DEV_SERVER_PORTS,
        ];
  return [...new Set(candidates)]
    .filter((port) => isPort(port) && !RESERVED_CONTAINER_PORTS.includes(port))
    .slice(0, MAX_PREVIEW_PORTS);
};

/** A listener bound to loopback alone: a Container preview cannot reach it (the SPI-1390 Stage probe: 502). */
const loopbackOnly = (host: string) =>
  host.startsWith("127.") || host === "0:0:0:0:0:0:0:1" || /^0:0:0:0:0:ffff:7f[0-9a-f]{2}:/i.test(host);

/** The ports in a Container's scan a preview can reach, ascending: not computerd's, not loopback-only, not reserved. */
export const reachablePorts = (scan: PortScan): ReadonlyArray<number> =>
  [
    ...new Set(
      scan.listeners
        .filter(
          (listener) =>
            listener.pid !== scan.computerd &&
            !loopbackOnly(listener.host) &&
            isPort(listener.port) &&
            !RESERVED_CONTAINER_PORTS.includes(listener.port),
        )
        .map((listener) => listener.port),
    ),
  ].sort((a, b) => a - b);
