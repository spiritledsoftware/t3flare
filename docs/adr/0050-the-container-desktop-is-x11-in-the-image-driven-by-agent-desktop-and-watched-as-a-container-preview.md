# The Container desktop is X11 in the image, driven by agent-desktop and watched as a Container preview

Status: proposed (Owner decisions, 2026-11-26). Refines
[ADR-0021](0021-terminals-run-through-the-platforms-pty-exec-beside-computer-and-end-with-their-environment.md) and
[ADR-0031](0031-previews-run-in-browser-run-with-localhost-routed-to-the-threads-container.md) on what counts as input.

Agents need a screen to build and test native GUI apps (Electron, Tauri, GTK, Qt) in their Workspace, as they have on
the Owner's machine. Web previews stay on the Preview browser. The Owner chose:

1. **In the Workspace image, started on first use, never a setting.** It gives agents no reach that bash doesn't
   already give them, so local parity (ADR-0049) gives it to every Owner. Its only standing cost is image size.
2. **X11 on Xvfb, with an AT-SPI bus, a light window manager and x11vnc + noVNC.** Not Wayland: `agent-desktop`
   refuses coordinate clicks on Wayland, and its scroll needs X11.
3. **Agents drive it with the `agent-desktop` CLI** through their own bash, and learn of it from the Owner's
   `agent-desktop` Environment skill. t3flare adds nothing to any prompt, and no MCP tools. `DISPLAY` is set in every
   process; the desktop starts when `agent-desktop` or `container-desktop` is first run. Screenshots are in v1 for
   every agent, the Durable agent included: they are written to `/workspace/.container-desktop/screenshots/`, a
   Container-only path outside the repo, which the Durable agent's own `read` already routes to the Container and
   returns as an image.
4. **The Owner watches it as a Container preview** of the noVNC page, which an agent opens with `preview_open` when it
   starts the desktop. No new route from the Container to the Owner's browser. The cost is latency: VNC frames are
   drawn on a canvas, then screencast again, and the page's WebSocket is carried over HTTP (ADR-0031).
5. **It never holds the Container.** The desktop's processes are not input, so the Container stops on the usual
   schedule and takes the desktop with it; the next use starts a fresh, empty one. Nothing is saved or restored.
6. **The Owner's input in any preview tab is Workspace input**, as typing in a Terminal is. An open tab that is never
   touched still holds nothing.

## Considered Options

- **A streaming route** (WebSocket or WebRTC from the Container through the Environment): smooth, but a new external
  contract behind Access. Kept as the fallback if the Container-preview view proves too laggy to use.
- **MCP tools, or the model's native computer-use tool:** one surface for every agent, or the best accuracy on Claude
  models, but new plumbing, and the native tool cannot reach CLI agents, which bring their own tools.
- **t3's device toolkit with a `linux` platform:** its Device panel for free, but a Patch to t3's contracts
  (ADR-0001's last resort), and the toolkit is refused as host-bound (ADR-0024).
- **An Environment setting to turn it on**, or an Image setup recipe: a guardrail with nothing to guard, against
  local parity.
