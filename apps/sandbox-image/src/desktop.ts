// The Container desktop (SPI-1447, ADR-0050): the virtual X11 display in a Workspace's Container that agents drive with
// `agent-desktop`, and that the Owner watches as a Container preview of its noVNC page. No Node imports, so the agents
// Worker can import it. The image's `container-desktop` command starts it (image/container-desktop) and its
// `agent-desktop` shim runs that first (image/agent-desktop); apps/agents/test/containerDesktopScript.test.ts keeps
// both, and the Dockerfile, equal to these values.

/** The X display every process names (`DISPLAY`): Xvfb's, at `DESKTOP_GEOMETRY`. */
export const DESKTOP_DISPLAY = ":99";

/** Xvfb's screen: width x height x depth (SPI-1445 D2). */
export const DESKTOP_GEOMETRY = "1280x800x24";

/**
 * Where the desktop keeps its lock, its daemons' pid files and logs, and its session bus's socket: the Container's own
 * disk, gone with the Container (ADR-0050 §5).
 */
export const DESKTOP_STATE_DIR = "/run/container-desktop";

/**
 * The session bus's address (`DBUS_SESSION_BUS_ADDRESS`), fixed so every process can carry it before the bus starts: a
 * client before then finds no bus, as it would find no display.
 */
export const DESKTOP_BUS_ADDRESS = `unix:path=${DESKTOP_STATE_DIR}/bus`;

/** x11vnc's port, on loopback only: websockify is its one client. */
export const DESKTOP_VNC_PORT = 5900;

/**
 * websockify and noVNC's port, on every address: a Container preview cannot reach a loopback listener (SPI-1390). Not
 * one of `RESERVED_CONTAINER_PORTS`, so a preview reaches it.
 */
export const DESKTOP_VIEW_PORT = 6080;

/** The page the Owner watches the desktop on, as a Container preview (ADR-0031's `<port>.t3flare.internal`). */
export const DESKTOP_VIEW_URL = `http://${DESKTOP_VIEW_PORT}.t3flare.internal/vnc.html?autoconnect=1&resize=scale`;

/**
 * Where agents write screenshots, one `<timestamp>.png` each: a Container-only path outside the repo (SPI-1446's
 * `CONTAINER_IGNORE` entry), which the Durable agent's `read` returns as an image.
 */
export const DESKTOP_SCREENSHOTS = "/workspace/.container-desktop/screenshots";

/**
 * The directory first on the image's PATH: only the `agent-desktop` shim and `container-desktop`. First, so a
 * Toolchain's own `agent-desktop` (an Owner's mise config may install one) cannot skip the desktop's start; the shim
 * then runs that one.
 */
export const DESKTOP_BIN = "/opt/t3flare/desktop/bin";

/** The image's own agent-desktop, beside its clipboard helper: the shim runs it when PATH has no other. */
export const AGENT_DESKTOP = {
  version: "1.3.1",
  /** The release tarball `agent-desktop-v<version>-x86_64-unknown-linux-gnu.tar.gz` (vercel-labs/agent-desktop). */
  sha256: "ca77b6b75034eeb12e537dd8c0a4f2a3424119253f38b7e6bd79ba0d2fef1264",
  path: "/opt/t3flare/agent-desktop/agent-desktop",
} as const;

/** noVNC's static page, served by websockify: the GitHub tag's source archive (novnc/noVNC). */
export const NOVNC = {
  version: "1.7.0",
  sha256: "b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6",
  dir: "/opt/t3flare/novnc",
} as const;

/** What every process's environment carries for the desktop: its display and its session bus. */
export const DESKTOP_ENV: Readonly<Record<string, string>> = {
  DISPLAY: DESKTOP_DISPLAY,
  DBUS_SESSION_BUS_ADDRESS: DESKTOP_BUS_ADDRESS,
};
