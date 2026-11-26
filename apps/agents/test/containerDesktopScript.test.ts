// The Container desktop's command and shim (SPI-1447, ADR-0050): the image's `container-desktop` and `agent-desktop`
// name the values `@t3flare/sandbox-image/desktop` names, every command carries its display and bus, and no preview is
// refused its port. Then `container-desktop` runs for real, on another display, ports and state directory, where the
// desktop's packages are installed (the image's apt list: Xvfb, openbox, dbus, at-spi2-core, x11vnc, websockify);
// skipped elsewhere, as in CI, whose runner has none of them.
// @effect-diagnostics nodeBuiltinImport:off
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RESERVED_CONTAINER_PORTS } from "@t3flare/harness-registry";
import {
  AGENT_DESKTOP,
  DESKTOP_BIN,
  DESKTOP_BUS_ADDRESS,
  DESKTOP_DISPLAY,
  DESKTOP_ENV,
  DESKTOP_GEOMETRY,
  DESKTOP_SCREENSHOTS,
  DESKTOP_STATE_DIR,
  DESKTOP_VIEW_PORT,
  DESKTOP_VIEW_URL,
  DESKTOP_VNC_PORT,
  NOVNC,
} from "@t3flare/sandbox-image/desktop";
import { COMMAND_ENV } from "@t3flare/sandbox-image/env";
import { afterAll, describe, expect, it } from "vitest";

const image = path.resolve(import.meta.dirname, "../../sandbox-image/image");
const read = (name: string) => fs.readFileSync(path.join(image, name), "utf8");
const SCRIPT = path.join(image, "container-desktop");

describe("the Container desktop's values", () => {
  it("are the ones container-desktop starts and prints", () => {
    const script = read("container-desktop");
    expect(script).toContain(`display=\${CONTAINER_DESKTOP_DISPLAY:-${DESKTOP_DISPLAY}}`);
    expect(script).toContain(`geometry=${DESKTOP_GEOMETRY}\n`);
    expect(script).toContain(`state=\${CONTAINER_DESKTOP_STATE:-${DESKTOP_STATE_DIR}}`);
    expect(DESKTOP_BUS_ADDRESS).toBe(`unix:path=${DESKTOP_STATE_DIR}/bus`);
    expect(script).toContain('bus="unix:path=$state/bus"');
    expect(script).toContain(`vnc_port=\${CONTAINER_DESKTOP_VNC_PORT:-${DESKTOP_VNC_PORT}}`);
    expect(script).toContain(`view_port=\${CONTAINER_DESKTOP_VIEW_PORT:-${DESKTOP_VIEW_PORT}}`);
    expect(DESKTOP_VIEW_URL).toBe(`http://${DESKTOP_VIEW_PORT}.t3flare.internal/vnc.html?autoconnect=1&resize=scale`);
    expect(script).toContain('view_url="http://$view_port.t3flare.internal/vnc.html?autoconnect=1&resize=scale"');
    expect(script).toContain(`screenshots=\${CONTAINER_DESKTOP_SCREENSHOTS:-${DESKTOP_SCREENSHOTS}}`);
    expect(script).toContain(`novnc=${NOVNC.dir}\n`);
  });

  it("are the Dockerfile's pins, paths and environment", () => {
    const dockerfile = read("Dockerfile");
    expect(/^ARG AGENT_DESKTOP_VERSION=(.+)$/m.exec(dockerfile)?.[1]).toBe(AGENT_DESKTOP.version);
    expect(/^ARG AGENT_DESKTOP_SHA256=(.+)$/m.exec(dockerfile)?.[1]).toBe(AGENT_DESKTOP.sha256);
    expect(/^ARG NOVNC_VERSION=(.+)$/m.exec(dockerfile)?.[1]).toBe(NOVNC.version);
    expect(/^ARG NOVNC_SHA256=(.+)$/m.exec(dockerfile)?.[1]).toBe(NOVNC.sha256);
    expect(dockerfile).toContain(`/agent-desktop ${path.dirname(AGENT_DESKTOP.path)}\n`);
    expect(dockerfile).toContain(`/novnc ${NOVNC.dir}\n`);
    expect(dockerfile).toContain(`COPY --chmod=755 container-desktop agent-desktop ${DESKTOP_BIN}/\n`);
    // First on PATH, before mise's shims: a Toolchain's own agent-desktop cannot skip the desktop's start.
    expect(/^ {4}PATH=([^:]+):/m.exec(dockerfile)?.[1]).toBe(DESKTOP_BIN);
    expect(dockerfile).toContain(`DISPLAY=${DESKTOP_DISPLAY} \\`);
    expect(dockerfile).toContain(`DBUS_SESSION_BUS_ADDRESS=${DESKTOP_BUS_ADDRESS} \\`);
  });

  it("has the shim run the image's agent-desktop when PATH has no other", () => {
    expect(read("agent-desktop")).toContain(`real=${AGENT_DESKTOP.path}\n`);
  });

  it("are in every command's environment, and so in every Terminal's and CLI agent's", () => {
    expect(COMMAND_ENV).toMatchObject(DESKTOP_ENV);
    expect(DESKTOP_ENV).toEqual({ DISPLAY: DESKTOP_DISPLAY, DBUS_SESSION_BUS_ADDRESS: DESKTOP_BUS_ADDRESS });
  });

  it("leave the view's port to Container previews: it is not one of t3flare's own", () => {
    expect(RESERVED_CONTAINER_PORTS).not.toContain(DESKTOP_VIEW_PORT);
  });

  it("start nothing with the Container: only container-desktop and the shim start it", () => {
    expect(read("supervise")).not.toContain("container-desktop");
    expect(read("Dockerfile")).not.toMatch(/ENTRYPOINT.*desktop/);
  });
});

const has = (command: string) => spawnSync("bash", ["-c", `command -v ${command}`]).status === 0;
const installed = ["Xvfb", "openbox", "dbus-daemon", "dbus-send", "x11vnc", "websockify", "xdpyinfo", "ss"].every(has);

describe.skipIf(!installed)("container-desktop, run", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "container-desktop-"));
  const env = {
    ...process.env,
    CONTAINER_DESKTOP_DISPLAY: ":87",
    CONTAINER_DESKTOP_STATE: state,
    CONTAINER_DESKTOP_VNC_PORT: "15987",
    CONTAINER_DESKTOP_VIEW_PORT: "16087",
    CONTAINER_DESKTOP_SCREENSHOTS: path.join(state, "screenshots"),
    // As a command's, a Terminal's or a CLI agent's: the desktop's processes must not carry it.
    T3FLARE_EXEC: "proc-desktop-test",
  };
  const run = (...args: string[]) => spawnSync(SCRIPT, args, { env, encoding: "utf8", timeout: 60_000 });
  const pids = () =>
    Object.fromEntries(
      ["bus", "xvfb", "openbox", "x11vnc", "websockify"].map((part) => [
        part,
        fs.readFileSync(path.join(state, `${part}.pid`), "utf8").trim(),
      ]),
    );

  afterAll(() => {
    run("stop");
    fs.rmSync(state, { recursive: true, force: true });
  });

  it("starts every part once, however many ensures race, and says where to watch it once", async () => {
    const racing = await Promise.all(
      [1, 2, 3].map(
        () =>
          new Promise<string>((resolve) => {
            const child = spawn(SCRIPT, ["ensure", "--notice-if-started"], { env });
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => (out += chunk));
            child.on("close", (code: number) => resolve(`${code}:${out}`));
          }),
      ),
    );
    expect(racing.every((result) => result.startsWith("0:"))).toBe(true);
    expect(racing.filter((result) => result.includes("Watch it at http://16087.t3flare.internal/"))).toHaveLength(1);
    expect(run("status").status).toBe(0);
  });

  it("starts nothing twice: a second ensure keeps every pid, and says where to watch it", () => {
    const before = pids();
    const again = run("ensure");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Watch it at http://16087.t3flare.internal/vnc.html?autoconnect=1&resize=scale");
    expect(again.stdout).toContain(`agent-desktop screenshot --screen 0 ${state}/screenshots/<timestamp>.png`);
    expect(run("ensure", "--notice-if-started").stdout).toBe("");
    expect(pids()).toEqual(before);
  });

  it("runs each part in a session of its own, without the command's marker: nothing counts it or holds for it", () => {
    for (const pid of Object.values(pids())) {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      expect(environ).not.toContain("T3FLARE_EXEC=");
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const session = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3];
      expect(session).toBe(pid);
    }
  });

  it("restarts a part that died, and only that part", () => {
    const before = pids();
    process.kill(Number(before["openbox"]), "SIGKILL");
    spawnSync("sleep", ["0.3"]);
    expect(run("status").status).toBe(3);
    expect(run("ensure", "--notice-if-started").stdout).toContain("Watch it at");
    const after = pids();
    expect(after["openbox"]).not.toBe(before["openbox"]);
    expect({ ...after, openbox: "" }).toEqual({ ...before, openbox: "" });
  });

  it("stops every part", () => {
    const before = pids();
    expect(run("stop").status).toBe(0);
    expect(run("status").status).toBe(3);
    for (const pid of Object.values(before)) expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
  });
});
