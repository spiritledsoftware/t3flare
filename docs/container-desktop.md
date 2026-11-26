# The Container desktop

Every Workspace's Container has a **Container desktop**: an X11 display that agents drive for computer use, to build
and test native GUI apps (Electron, Tauri, GTK, Qt), and that you watch and use in a preview tab
([ADR-0050](adr/0050-the-container-desktop-is-x11-in-the-image-driven-by-agent-desktop-and-watched-as-a-container-preview.md)).
Web pages stay on the Preview browser. There is no setting: it is in the Workspace image, and nothing of it runs until
something uses it.

## Starting it

Nothing starts it with the Container. It starts on first use: the first `agent-desktop` command, or
`container-desktop ensure`. `container-desktop ensure` says where to watch it and where screenshots go, and
`agent-desktop` does too on the run that starts it. Its parts are an Xvfb display, `:99` at 1280×800×24, with openbox,
a D-Bus session bus with AT-SPI, x11vnc and noVNC. `DISPLAY=:99` is set in every command, Terminal and CLI agent, but
a GUI app started on its own does not start the desktop: run `container-desktop ensure` first.

`container-desktop status` says which parts run, and `container-desktop stop` stops them.

A Container stop wipes it. Nothing is saved or restored: the next use starts a fresh, empty desktop, and any app on it
must be started again.

## Driving it

Agents drive it with the `agent-desktop` CLI through their own bash; an `agent-desktop` Environment skill, if you add
one, tells them how. t3flare adds nothing to any prompt.

Screenshots go to a file in `/workspace/.container-desktop/screenshots/`, one `<timestamp>.png` each:

```sh
agent-desktop screenshot --screen 0 /workspace/.container-desktop/screenshots/$(date +%s).png
```

The agent then reads the file as an image; the Durable agent's own `read` returns it as one. The directory is on the
Container's disk, outside the repo: it is never synced and never in git, and goes with the Container.

## Watching it

The view is noVNC's page, served from the Container as a Container preview:

```
http://6080.t3flare.internal/vnc.html?autoconnect=1&resize=scale
```

An agent opens it with `preview_open` when it starts the desktop; you can open that address in a preview tab
yourself at any time. It has no password: port 6080 is reachable only through that Workspace's own Preview browser,
behind Access. You can click and type in it.

## It never holds the Container

The desktop's processes are not input, so the Container stops on its usual schedule (**Idle time** in the Settings
page's Environment section) with the desktop running, and takes it with it.

Your input in a preview tab does hold it, as typing in a Terminal does: a click, a key, the wheel or inserted text
keeps the Container running for **Terminal hold while a command runs** (under Advanced) after the last one, 30 minutes
by default. Loading or resizing the page is not input, and an open tab you never touch holds nothing.

## Container size

The desktop and its daemons are small, but the apps on it are not: `standard-1` (½ vCPU, 4 GiB) is too small for
Electron. Pick a larger size, such as the default `standard-3`, with **Container size** in the Settings page's
Environment section. It applies at each Workspace's next Container start.

## When `agent-desktop` does not start it

`agent-desktop` starts the desktop through a shim first on the image's PATH, which then runs the next `agent-desktop`
on PATH: a Toolchain's own if your Global mise config installs one, else the image's. A shell that runs
`mise activate`, as every Terminal does, puts mise's Toolchains before the shim, so its `agent-desktop` runs without
starting the desktop and finds no display. Run `container-desktop ensure` first in such a shell, once per Container.
