# t3flare's Container image (step 2a; ADR-0015: one image for Durable agents and, later, CLI agents).
#
# The Workspace Container's image: Ubuntu 26.04 LTS with fuse3, the everyday command-line tools, a C toolchain,
# computerd under its supervisor with a memory guard, and mise with its installs of the base mise.toml's Toolchains.
# Every program a project uses is a mise Toolchain; the image's installs are only found by mise for a Workspace that
# asks for those versions. The image is glibc-based because computerd is a glibc Node SEA, and linux/amd64 because
# that is what Cloudflare Containers run.

# Keep in step with the version of @cloudflare/computer the Workspace DO runs (apps/environment/test/cliManifest.test.ts
# fails when they differ): the Workspace and computerd speak a sync protocol that is not stable across releases.
ARG COMPUTERD_VERSION=0.11.2
# On a mise bump, run apps/environment/test/docker/mise.docker.test.ts (the nightly test:docker does): the Global mise
# config leans on its layering, its token sources and how it reads an empty variable, which move between versions.
ARG MISE_VERSION=v2026.11.2
ARG MISE_SHA256=62cad463c1413f05398ca339168a8f655120b6f0b0b8adce3bc6758bafaf0602
# The CLI agents (step 4a; apps/sandbox-image/src/clis.ts holds the same values, apps/environment/test/cliManifest.test.ts keeps them equal).
ARG CODEX_VERSION=0.167.2
ARG CODEX_SHA256=8246e846c550ea21197fcc4067bc270dca895e94ea42ed6a282e6f4e0125b15f
# Step 4b: OpenCode's release binary (one per platform; npm's package installs the musl build beside it, M0 P7).
ARG OPENCODE_VERSION=2.2.7
ARG OPENCODE_SHA256=89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7
# The Container desktop (SPI-1447, ADR-0050): agent-desktop's release binary and noVNC's page
# (apps/sandbox-image/src/desktop.ts holds the same values, apps/agents/test/containerDesktopScript.test.ts keeps them
# equal).
ARG AGENT_DESKTOP_VERSION=1.3.1
ARG AGENT_DESKTOP_SHA256=ca77b6b75034eeb12e537dd8c0a4f2a3424119253f38b7e6bd79ba0d2fef1264
ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6

# Every base image is pinned by digest as well as by tag, so a rebuild cannot move to another computerd build or Ubuntu
# point release. Refresh a digest together with its tag: computerd's is the manifest of
# `ghcr.io/cloudflare/computer-computerd-linux-x64:<COMPUTERD_VERSION>`, Ubuntu's the index of `ubuntu:26.04`.

# A single layer over scratch whose only content is the computerd binary at /usr/local/bin/computerd.
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:${COMPUTERD_VERSION}@sha256:783f3760367d25ca1555f88e8409d89d9f224737afcda3caa0af3ad0f20524ae AS computerd

# mise is fetched and checked against its digest in a stage of its own, so the final image holds only the binary.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS mise
ARG MISE_VERSION
ARG MISE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /mise https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64 \
 && echo "${MISE_SHA256}  /mise" | sha256sum -c - \
 && chmod 755 /mise

# Codex, the same way: the release's static binary, checked against its digest, in a stage of its own.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS codex
ARG CODEX_VERSION
ARG CODEX_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /codex.tgz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz \
 && echo "${CODEX_SHA256}  /codex.tgz" | sha256sum -c - \
 && tar -xzf /codex.tgz -C / \
 && mv /codex-x86_64-unknown-linux-musl /codex \
 && chmod 755 /codex

# OpenCode (step 4b), the same way: the release's binary, checked against its digest.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS opencode
ARG OPENCODE_VERSION
ARG OPENCODE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /opencode.tgz https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz \
 && echo "${OPENCODE_SHA256}  /opencode.tgz" | sha256sum -c - \
 && mkdir /out && tar -xzf /opencode.tgz -C /out \
 && mv /out/opencode /opencode \
 && chmod 755 /opencode

# The Container desktop's two downloads, the same way: agent-desktop's release (the binary and the clipboard helper it
# looks for beside itself), and noVNC's tagged source, of which only the page and its scripts are kept. noVNC is not
# Ubuntu's package, which would bring an apt Node beside the image's.
FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS desktop
ARG AGENT_DESKTOP_VERSION
ARG AGENT_DESKTOP_SHA256
ARG NOVNC_VERSION
ARG NOVNC_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /agent-desktop.tgz https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/agent-desktop-v${AGENT_DESKTOP_VERSION}-x86_64-unknown-linux-gnu.tar.gz \
 && echo "${AGENT_DESKTOP_SHA256}  /agent-desktop.tgz" | sha256sum -c - \
 && mkdir /agent-desktop && tar -xzf /agent-desktop.tgz -C /agent-desktop \
 && test -x /agent-desktop/agent-desktop && test -x /agent-desktop/agent-desktop-linux-clipboard-owner \
 && curl -fsSL -o /novnc.tgz https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz \
 && echo "${NOVNC_SHA256}  /novnc.tgz" | sha256sum -c - \
 && mkdir /novnc && tar -xzf /novnc.tgz -C /novnc --strip-components=1 \
      noVNC-${NOVNC_VERSION}/app noVNC-${NOVNC_VERSION}/core noVNC-${NOVNC_VERSION}/vendor \
      noVNC-${NOVNC_VERSION}/vnc.html noVNC-${NOVNC_VERSION}/defaults.json noVNC-${NOVNC_VERSION}/mandatory.json \
      noVNC-${NOVNC_VERSION}/package.json noVNC-${NOVNC_VERSION}/LICENSE.txt

FROM --platform=linux/amd64 ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c

# The everyday tools agents and scripts expect (some from exe.dev's exeuntu list), build-essential and the
# headers native npm and pip packages build against, and earlyoom, the memory guard
# the supervisor runs. Versioned Toolchains
# (Node, pnpm, Bun, Python, git, gh) are mise's, never apt's: mise's shims come first on PATH anyway, so a git an apt
# package pulled in would not shadow mise's. fd's binary is fdfind here; it gets its own name too.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fuse3 ca-certificates \
      curl wget jq ripgrep fd-find unzip zip xz-utils \
      procps psmisc lsof iproute2 dnsutils netcat-openbsd \
      less file tree openssh-client gnupg sudo sqlite3 tzdata \
      rsync socat net-tools iputils-ping bubblewrap locales time \
      build-essential pkg-config libssl-dev zlib1g-dev libffi-dev \
      earlyoom \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=mise /mise /usr/local/bin/mise

# The base mise.toml's Toolchains (`mise.toml`, which commands read as mise's system config), installed into mise's
# system directory, /usr/local/share/mise/installs, where mise looks for a version a config asks for before it
# downloads one. Its lockfile is made here too, next to it, since `mise lock` downloads aqua and Python artifacts to
# checksum them. A Workspace asking for other versions installs them under /root.
COPY mise.toml /usr/local/share/t3flare/mise.toml
RUN cd /usr/local/share/t3flare \
 && export MISE_GLOBAL_CONFIG_FILE=/usr/local/share/t3flare/mise.toml MISE_TRUSTED_CONFIG_PATHS=/usr/local/share/t3flare \
 && mise install --system \
 && mise lock --global --platform linux-x64 \
 && mise reshim --system \
 && rm -rf /root/.cache /root/.local /tmp/*

# SPI-992 (review M5): the system gitconfig of every git the image installs (conda git reads $PREFIX/etc/gitconfig, not
# /etc) and /etc/gitconfig: the credential helper, which gives the Workspace's one-repo token for https://github.com
# only (no push gateway since the back-to-stock cut, owner 2026-11-12). Nothing is written per Container start; each
# git here must read it back, or the build fails.
COPY gitconfig /usr/local/share/t3flare/gitconfig
RUN set -e; found=0; \
 for git in /usr/local/share/mise/installs/*/*/bin/git; do \
   [ -x "$git" ] || continue; \
   prefix="$(cd "$("$git" --exec-path)/../.." && pwd)"; \
   mkdir -p "$prefix/etc" && cp /usr/local/share/t3flare/gitconfig "$prefix/etc/gitconfig"; \
   "$git" config --system --get credential.helper | grep -q t3flare/git-credential; \
   found=1; \
 done; \
 test "$found" = 1; \
 cp /usr/local/share/t3flare/gitconfig /etc/gitconfig

# The CLI agents (step 4a, plan §6), at fixed paths the CLI profiles name absolutely, after the mise layer so a CLI bump
# rebuilds only this: Codex's checked binary, pi from a committed lock with the image's Node (`npm ci`, no scripts), and
# pi's handle command on the model relay (SPI-1170). Not mise: a project's toolchains must never shadow them.
COPY --from=codex --chown=0:0 /codex /opt/t3flare/bin/codex
COPY cli/package.json cli/package-lock.json /opt/t3flare/pi/
RUN cd /opt/t3flare/pi \
 && PATH=/usr/local/share/mise/installs/node/26.13.0/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm
COPY --chmod=755 t3flare-pi /opt/t3flare/bin/pi
COPY --chmod=755 t3flare-pi-handle /opt/t3flare/bin/t3flare-pi-handle

# Step 4b, plan §6: Claude Code over ACP (claude-agent-acp and the Claude Agent SDK, whose platform package holds the
# claude binary) from its own committed lock, and OpenCode's checked binary, each in its own layers so a bump rebuilds
# one; their launchers (which install the managed settings and the system configuration) and OpenCode's key plugin.
COPY claude/package.json claude/package-lock.json /opt/t3flare/claude/
RUN cd /opt/t3flare/claude \
 && PATH=/usr/local/share/mise/installs/node/26.13.0/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm \
 && test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
COPY --from=opencode --chown=0:0 /opencode /opt/t3flare/opencode/opencode
COPY --chmod=755 t3flare-claude-agent-acp /opt/t3flare/bin/claude-agent-acp
COPY --chmod=755 t3flare-claude-handle /opt/t3flare/bin/t3flare-claude-handle
COPY claude-handle-unset.cjs /opt/t3flare/share/claude-handle-unset.cjs
COPY --chmod=755 t3flare-opencode /opt/t3flare/bin/opencode
COPY opencode-key-plugin /opt/t3flare/share/opencode-key-plugin

# The Container desktop (SPI-1447, ADR-0050), after the CLI layers so a pin bump rebuilds only this: an X11 display on
# Xvfb with openbox, a D-Bus session bus with the AT-SPI bus agent-desktop reads, x11vnc and websockify for noVNC's page,
# and fonts. Nothing starts it with the Container: `container-desktop ensure` does, or the `agent-desktop` shim's first
# run. The shim and container-desktop stand in a directory of their own, first on PATH (below).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11-utils openbox dbus dbus-x11 at-spi2-core libatk-bridge2.0-0t64 x11vnc websockify \
      fonts-dejavu-core fonts-liberation2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=desktop --chown=0:0 /agent-desktop /opt/t3flare/agent-desktop
COPY --from=desktop --chown=0:0 /novnc /opt/t3flare/novnc
COPY --chmod=755 container-desktop agent-desktop /opt/t3flare/desktop/bin/

COPY --chmod=755 supervise /usr/local/bin/t3flare-supervise

# The memory guard, which the supervisor runs: earlyoom (an apt package above), and a note for the commands that run
# when it stops a process, which the file every command's bash reads first (BASH_ENV) prints when the command ends.
COPY --chmod=755 t3flare-memory-guard /usr/local/bin/t3flare-memory-guard
COPY command.bash /usr/local/share/t3flare/command.bash

# Ubuntu's stock /root/.bashrc goes (ADR-0047 §9): a Terminal sources ~/.bashrc unless the Owner turns that off, so the
# only one there is the Owner's own, from their Image setup or Container setup; without one a Terminal keeps t3flare's
# prompt. No other shell reads it: commands run under BASH_ENV, never interactive.
RUN rm -f /root/.bashrc

# A copy at the directory's earlier path, for one release: a Workspace Container started on the previous image keeps
# running after a deploy (Containers run by Durable Objects take no rollout), so the commands' environment
# (apps/sandbox-image/src/env.ts) names this path until every Container runs this image. Then env.ts moves to
# /usr/local/share/t3flare and the copy goes. A copy, not a link, so mise sees the same paths as before.
RUN cp -a /usr/local/share/t3flare /usr/local/share/cloudpid

# computerd mounts its file system at MOUNT_POINT, so commands see the Workspace's files at /workspace. FUSE_MOUNT=auto
# mounts through /dev/fuse where the platform exposes it (Cloudflare Containers) and falls back to a userspace shim
# where it does not. mise keeps the Toolchains it installs on the Container's own disk, in its default place under
# /root, and its shims put them on PATH, before the shims of the image's own installs. PATH is the one variable
# computerd passes on to a command, so it is the one set here: mise's other settings reach a command in its exec
# environment (`COMMAND_ENV`, apps/sandbox-image/src/env.ts).
# computerd keeps its copy of the Workspace in COMPUTERD_DB, on the Container's disk, so a snapshot holds it with its
# sync positions: a Container restored from one is sent only what changed since, not every file. In memory, the
# default, it is rebuilt from the Workspace DO at each start.
# The Container desktop's directory (`DESKTOP_BIN`) comes before mise's shims, so a Toolchain's own agent-desktop never
# skips the desktop's start; its display and session bus are named here for the image's own processes, and reach a
# command, a Terminal and a CLI agent through `COMMAND_ENV`, since computerd passes on only PATH. So do the two switches
# that make Electron (ACCESSIBILITY_ENABLED) and Qt (QT_LINUX_ACCESSIBILITY_ALWAYS_ON) apps show their accessibility
# trees to agent-desktop: without them they do only when a screen reader runs.
ENV PORT=8080 \
    MOUNT_POINT=/workspace \
    FUSE_MOUNT=auto \
    COMPUTERD_DB=/var/lib/computerd/state.db \
    DISPLAY=:99 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/container-desktop/bus \
    ACCESSIBILITY_ENABLED=1 \
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
    PATH=/opt/t3flare/desktop/bin:/root/.local/share/mise/shims:/usr/local/share/mise/shims:${PATH}
RUN mkdir -p /var/lib/computerd
EXPOSE 8080

# computerd runs under a supervisor (`supervise`) that runs the memory guard beside it and reports why it stopped,
# when it stops on its own.
ENTRYPOINT ["/usr/local/bin/t3flare-supervise"]
