# tools/demo-video

t3flare's launch video: a Remotion project with its own pnpm workspace and lock, outside the root workspace.

## Rules

- Run pnpm here only as `mise exec -- pnpm …` from this directory, after `mise trust`. A shell can carry an
  `NPM_CONFIG_WORKSPACE_DIR` naming the repo root, and a bare `pnpm add` would then edit the root `package.json` and lock.
- No CI job checks this folder, and the root `check` does not cover it. Before a pull request that touches it, run its
  own `mise exec -- pnpm run check` here: this one package's typecheck, lint and composition list, a targeted check.
- Footage (`public/footage/`) and `public/music.mp3` are never committed: `pnpm capture` re-records the footage, and
  a track carries its own licence.
- The capture never reads or prints a credential: pairing codes go through a 0600 file and are deleted once typed.
- Every claim on screen has a source in README.md's claims table; change the two together.
