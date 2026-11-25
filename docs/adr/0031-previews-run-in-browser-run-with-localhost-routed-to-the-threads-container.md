# Previews run in Browser Run, with `localhost` routed to the thread's Container

Status: accepted (owner decisions O1–O5, 2026-11-13; built in G11, SPI-1002). Plan: [`docs-archive-1:docs/steps/previews-plan.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/previews-plan.md) with its review changelog; report: [`docs-archive-1:docs/steps/previews.md`](https://github.com/spiritledsoftware/t3flare/blob/docs-archive-1/docs/steps/previews.md).

Stock t3's previews stay stock above three seams: where Chrome comes from, where `localhost` goes, and how ports are listed.

- **Chrome is Cloudflare Browser Run.** It is bound on the Environment Worker (`BROWSER`) and driven by t3's own `ServerBrowser` through `@cloudflare/playwright`, behind a Shadow of `preview/ServerBrowserContexts.ts`. t3's HTML renders keep stock `htmlRender/headlessChrome.ts`: our process router answers `PreviewBrowser`'s constant executable with a CDP bridge to a route-less Browser Run browser, and `htmlRender/publicProxy.ts` is Shadowed to a no-op, since Browser Run's egress refuses loopback and private addresses itself.
- **`localhost` is the thread's Workspace Container.** Each Workspace with open tabs has one Browser Run browser, acquired with `outboundByHost` routing eight virtual hosts, `http://<port>.t3flare.internal/` (ports 3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787), to a `ContainerPreviews` entrypoint made with that Workspace in its props. It hands each request to the agents Worker's `WorkspaceContainerPreviews`, which calls one method of that Workspace DO; the DO fetches the Container port with `getTcpPort`. Browser Run refuses `localhost` by policy, so the Shadow translates `localhost:<port>` in every page's `goto`. A page's WebSockets are carried over HTTP by a script injected into each HTML page. Patch 0005 passes the tab's thread to `contextFor`.
- **Ports are listed by each running Container's own `/proc`** (`WorkspaceDO.listeners`), never starting one, by our `PortDiscovery` Layer. As stock, only attributed listeners are listed: a terminal's (its shell's key) or an agent's (a CLI process's key, or `T3CODE_THREAD_ID`), and only within the scanned Workspace.

The owner watches through t3's own screencast route (`/api/preview-stream/*`, t3's auth), so no dev-server byte reaches the owner's browser except as frames, and no new hostname, certificate or DNS record exists. HTML renders and MCP apps keep stock's opaque-origin sandbox on the t3 host. The tool denylist shrinks to `t3_attachment_*`, `t3_thread_send_attachments`, `device_*` and `t3_worktree_*`; `serverBrowser` and `localServerStop` are advertised; agent browser access is the owner's setting with stock's default.

Forced by the platform or by cost, and kept: the eight-port list (superseded by the SPI-1364 refinement); the `*.t3flare.internal` names; a preview never starts a Container; a preview's requests and carried sockets keep a running Container only within ADR-0021's 30 minutes from the Workspace's last input; profiles are `storageState` in the Environment DO's own table (8 MiB a profile; superseded by the SPI-1365 refinement below); Browser Run sessions are recorded and closed when a new Environment instance starts; nothing records a session or mints a Live View link.

## Considered options

- **Chrome in each Workspace Container** (O1, rejected; O3's fallback (a) for `localhost` tabs only, never with an owner profile). Native `localhost`, but every HTML screenshot and public tab would start a Container and take a budget slot, and Chrome would share the Container's 3 GiB.
- **An authenticated proxy on a preview host** (O2, rejected; O3's fallback (b)). It needs a new registrable domain or Advanced Certificate Manager, a session hand-off, and runs dev-server script in the owner's browser. Stock has none of it.
- **A Shadow of `headlessChrome.ts`** (the plan's Shadow 4). Replaced by the CDP bridge (review M3): stock's 638 lines of page guards keep tracking upstream; the Shadow is `publicProxy.ts` instead.
- **A separate-origin sandbox for MCP apps** (O4, rejected): stock frames apps in an opaque origin on its own host; so do we.

## Consequences

- **Not a secure context.** A dev server's page is `http://<port>.t3flare.internal`: no `crypto.subtle`, `crypto.randomUUID`, service workers or clipboard API, and OAuth redirects, CORS lists and cross-port calls pinned to `localhost` see another origin (R9, L7). HTML renders are `https://t3-page.t3flare.internal`, a secure context, so an `http:` resource in one is mixed content.
- **Eight ports.** A dev server elsewhere gets a page that names them (superseded by the SPI-1390 refinement: any port
  but t3flare's own).
- **Downloads** are fetched from the page that started them (the fork cannot copy an artifact off Browser Run's disk, cloudflare/playwright#93): a cross-origin download the page may not read fails.
- **A tab nobody watches ends.** Browser Run closes a session after 10 minutes without CDP traffic; t3 drops its tabs. Profiles survive.
- **Claude's MCP apps are ordinary tool rows** (O5): our Claude runs over ACP, and stock's app support is in its native-SDK adapter.
- **Cost.** Browser Run hours ($0.09/h after 10 a month) and concurrent browsers (10 included, shared across the Cloudflare account). A watched tab holds the Environment and its browser; nothing else does.
- **Fragility:** U59–U63 in `docs/upstream-fragility.md`.

## Refinement (SPI-1365, 2026-11-23): a profile of any size

A profile's 8 MiB is removed: the state is already whole in memory when it is saved, and it is kept in rows of at most
1.5 MB, under a DO SQLite row's 8 MB. A profile past 8 MiB was not saved, with only a log line, and its sign-ins were
lost; now every profile is kept.

## Refinement (SPI-1364, 2026-11-23): the preview ports are the Owner's

This supersedes "the eight-port list" as fixed. Browser Run's `outboundByHost` routes at most eight hosts, so at most
eight ports, but which eight is taste: the Environment setting `previewPorts`, by default the eight above (superseded
by the SPI-1390 refinement: off by default, any port). It refuses
computerd's 8080 and the MCP bridge's 17781 (`RESERVED_CONTAINER_PORTS`). The Environment reads it when a preview
browser is acquired, for its routes, and when it translates a `localhost` URL; a browser keeps the routes it was
acquired with. The `ContainerPreviews` entrypoint and the Workspace DO take any port but the reserved ones: the
browser's routes decide which ports it reaches.

## Refinement (SPI-1390, 2026-11-25): any Container port but t3flare's own

This supersedes the SPI-1364 refinement's default. As on the Owner's machine, where a browser opens any `localhost`
port, a preview browser opens a dev server on any Container port except `RESERVED_CONTAINER_PORTS`. Each reserved port
is named with what it is for, and a refusal says so: "port 8080 is reserved by t3flare for computerd, its server
that runs the Container's commands and serves its files", and port 17781 for the MCP bridge. `previewPorts` stays, as an opt-in
Advanced list: empty, the default, means any port. A list allows only its ports, at most eight.

**Browser Run's routing, probed on a throwaway Stage** (2026-11-25, `outboundByHost` from a Worker binding):

- A ninth host is refused at acquire: "at most 8 outbound hosts are allowed" (status 400, code 2000). The same goes for
  64 and 1024 hosts. Cloudflare's outbound-workers page no longer states this limit, but the binding enforces it.
- A routed hostname is routed on port 80 alone. With `t3flare.internal` routed, `http://t3flare.internal/` reached the
  outbound Worker, while `http://t3flare.internal:9999/`, `:3000` and `:65000` were answered 403 by Browser Run itself.
  So one hostname cannot carry the port, and a port is still a host, `http://<port>.t3flare.internal/`.
- Routes are fixed at acquire, as the docs say.

So a browser routes at most eight ports, fixed when it starts (`previewRoutes`, `apps/environment/src/preview/previewRoutes.ts`).
With the Owner's list, it routes that list. Otherwise, in order, it routes:

1. the port a page asked for, if a restart is starting it;
2. the ports listening in the Container now, as reachable (not bound to loopback alone, not reserved);
3. its last routes;
4. the dev servers' usual ports (3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787) in the slots left.

A `goto` to a port the browser does not route restarts the browser with that port added. Its contexts are saved and
closed, so t3 drops their tabs, and the `goto` fails naming the restart and the eight-port limit, so the page can be
opened again. A log line names the port, never the URL. A dev server running before its first tab opens, the usual case,
needs no restart.

**Listeners checked before the default changed.** In the Workspace image run as a Container, with each CLI agent started
as t3flare launches it, these listen:

- computerd on `0.0.0.0:8080`, whose HTTP API runs commands and reads the Workspace's files. Reserved.
- OpenCode's internal server (`opencode serve --stdio --port 0`, a child of `opencode acp`) on `127.0.0.1` at a random
  port. Every `/api/*` path answers 401 (Basic auth), and the rest is the static web app.

Nothing else listens: Codex's `app-server`, Claude ACP and pi speak stdio; the supervisor, the memory guard,
fusermount3 and mise open no socket; there is no UDP listener. The relays reach out to `computer.internal`; Terminals and
the process channel run through computerd. Browser Run is outside the Container. Port 17781 stays reserved for the MCP
bridge, which the image does not run yet; when it runs it takes a per-launch token.

**Loopback is unreachable**, as the code assumed but nothing had shown before. On the Stage, with listeners on
`0.0.0.0:9999`, `127.0.0.1:9998`, `[::1]:9997` and `0.0.0.0:9996` (each answering inside the Container), a preview page
got 200 from 9999 and 9996, and 502 "Nothing is listening on port 9998" and "…9997". `getTcpPort` connects on the
Container's interface. So a listener bound to loopback alone, OpenCode's random port included, is out of a preview's
reach, and it need not be reserved, which a random port could not be anyway.

Consequences:

- **Every `0.0.0.0` listener is reachable from the Workspace's preview browser.** Any page that browser opens, a dev
  server's or a public site's, can fetch `http://<port>.t3flare.internal/` for each port the browser routes, as a page
  on a laptop can reach every `localhost` port. Before, it reached only the eight listed ports. An Owner who wants the
  old bound sets the list.
- **A restart closes the Workspace browser's tabs.** It happens only for a port the browser does not route, so when a
  dev server starts after the browser did, on a port outside the usual ones.
- **Eight at a time.** When more than eight ports are candidates, those last in the order above are not routed, and
  opening one restarts the browser again. That is the Cloudflare-forced limit, named in the restart's message.
  Engineering it away (a CDP `Fetch` interception in place of `outboundByHost`) is a follow-up.
