// Step 3's leak check (plan section 4.6, review C8): every secret this Environment knows, looked for in a Workspace's
// Container and in Sessions' state. Run from the admin route `POST /_t3flare/check/peer-leak`; answers names only.
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "t3/src/auth/ServerSecretStore.ts";

import { byName } from "../agents/rpc.ts";
import { workspaceRpc } from "../agents/workspaceClient.ts";
import { MAX_TIMED_MINUTES } from "@t3flare/harness-registry";
import type { EnvironmentDO } from "../environmentDO.ts";

/**
 * How much of the dump one read brings back, in bytes: 4 MiB. A named constraint: the Workspace DO's 128 MB isolate. A
 * slice is read whole, and a binary file decodes to U+FFFD, past Latin-1, so its text is held as UTF-16: computer's
 * chunks and their joined copy, the string and its DO RPC copy take up to about 6 times its bytes, about 24 MiB, which
 * leaves room for a large checkpoint diff read at the same time. The dump itself is not cut: it is read a slice at a time.
 */
export const DUMP_SLICE_BYTES = 4 * 1024 * 1024;
/** The dump's last line: its presence shows the dump was written to its end. */
export const DUMP_END = "== t3flare: end of dump";

/**
 * How long the dump may run. Not the Owner's command time limit (`commandMinutes`, 2 minutes by default): the dump copies
 * every file a command could read, `node_modules` included, and this is an admin check that must not pass by scanning
 * nothing. The shared sanity maximum (ADR-0048 §2): computerd times the exec with its own timer and no maximum.
 */
export const DUMP_TIMEOUT_MS = MAX_TIMED_MINUTES * 60_000;

/** Every check's dump file starts so; a dump leaves them all out, another check's running at the same time included. */
export const DUMP_PREFIX = "/tmp/t3flare-leak-dump-";

/** Where one check's dump is kept in the Container while it is read: its own file, removed after. */
export const dumpPath = (id: string): string => `${DUMP_PREFIX}${id.replace(/[^A-Za-z0-9-]/g, "")}`;

/**
 * What the Container shows a process: its environment, every process's, and the files a command could read, written to
 * `path` (the dump leaves out every check's dump file, its own and a concurrent check's). No secret goes into the Container: the scan runs in the Environment.
 */
export const containerDump = (path: string): string =>
  [
    "{",
    'echo "== env"; env;',
    'for f in /proc/[0-9]*/environ; do echo "== $f"; tr "\\0" "\\n" < "$f"; done;',
    // Tools step: command lines too (a key on argv), and the CLIs' managed configuration (MCP entries).
    'for f in /proc/[0-9]*/cmdline; do echo "== $f"; tr "\\0" " " < "$f"; echo; done;',
    `find /workspace /tmp /root /home /etc/claude-code /etc/opencode /etc/codex -xdev -type f -not -path '*/.git/objects/*' -not -path '${DUMP_PREFIX}*' 2>/dev/null |`,
    // Each header on a line of its own, after a file whose last line has no newline too.
    '  while read -r f; do echo; echo "== $f"; cat "$f"; done;',
    `echo; echo "${DUMP_END}";`,
    `} 2>/dev/null > ${path}`,
  ].join(" ");

/** The script that answers the dump's size in bytes, whatever the dump's own exec answered (a timeout included). */
export const dumpSize = (path: string): string => `stat -c %s ${path} 2>/dev/null || echo 0`;

/** The script that answers `length` bytes of the dump at `path` from byte `offset`. */
export const dumpSlice = (path: string, offset: number, length: number): string =>
  `tail -c +${offset + 1} ${path} | head -c ${length}`;

/**
 * The slices that read `size` bytes, `slice` at a time, each but the first starting `overlap` bytes back so a secret
 * split by a slice's edge is whole in the next one.
 */
export const dumpSlices = (
  size: number,
  slice: number,
  overlap: number,
): ReadonlyArray<{ readonly offset: number; readonly length: number }> => {
  const slices: Array<{ offset: number; length: number }> = [];
  const step = Math.max(1, slice - overlap);
  for (let offset = 0; offset < size; offset += step) {
    slices.push({ offset, length: Math.min(slice, size - offset) });
    if (offset + slice >= size) break;
  }
  return slices;
};

/**
 * The paths whose contents a slice of the dump holds (`/proc` entries aside): whole header lines only, so a header a
 * slice's edge cuts is counted from the next slice, which starts back by the overlap.
 */
export const dumpedFiles = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/^== (\/[^\n]*)\n/gm)].map((match) => match[1]!).filter((path) => !path.startsWith("/proc/"));

/**
 * The Container's part of the check: the dump written to a file of its own, its size measured apart (so a dump its exec
 * timed out on is still scanned as far as it got), scanned a slice at a time, and the file removed whatever happened.
 * `complete` is false unless the dump's exec ended well and its end marker was read: a caller treats that as a failure.
 */
export const containerScan = async (
  exec: (input: { readonly script: string; readonly timeoutMs?: number; readonly wholeOutput?: boolean }) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>,
  secrets: ReadonlyArray<Secret>,
  id: string,
): Promise<{
  readonly exitCode: number;
  readonly bytes: number;
  readonly files: number;
  readonly complete: boolean;
  readonly leaked: Array<string>;
}> => {
  const path = dumpPath(id);
  try {
    const dumped = await exec({ script: containerDump(path), timeoutMs: DUMP_TIMEOUT_MS }).catch(() => ({
      exitCode: -1,
      stdout: "",
    }));
    const size = Number((await exec({ script: dumpSize(path) })).stdout.trim());
    const scanned = await scanDump(
      Number.isSafeInteger(size) && size > 0 ? size : 0,
      // Whole: computer otherwise keeps only an answer's last 64 KiB, and saves the whole, secrets and all, in the
      // Workspace's own files. The slice bounds itself (`head -c`).
      async (offset, length) => (await exec({ script: dumpSlice(path, offset, length), wholeOutput: true })).stdout,
      secrets,
    );
    return { exitCode: dumped.exitCode, ...scanned, complete: dumped.exitCode === 0 && scanned.complete };
  } finally {
    await exec({ script: `rm -f ${path}` }).catch(() => undefined);
  }
};

/**
 * Scans the dump a slice at a time (`read`), holding one slice: the secrets leaked in any, the files it covered, the
 * bytes, and whether it was read to its end (`DUMP_END`).
 */
export const scanDump = async (
  size: number,
  read: (offset: number, length: number) => Promise<string>,
  secrets: ReadonlyArray<Secret>,
): Promise<{
  readonly bytes: number;
  readonly files: number;
  readonly complete: boolean;
  readonly leaked: Array<string>;
}> => {
  // A secret across a seam is whole in the next slice, which starts back by the longest one in UTF-8 (4 bytes a unit),
  // and at least a header line's worth (PATH_MAX, 4096 bytes), so each file's header is whole in some slice.
  const overlap = Math.max(4096, ...secrets.map((secret) => secret.value.length * 4));
  const leaked = new Set<string>();
  const files = new Set<string>();
  let tail = "";
  for (const { offset, length } of dumpSlices(size, DUMP_SLICE_BYTES, overlap)) {
    const text = await read(offset, length);
    for (const name of leakedIn(text, secrets)) leaked.add(name);
    for (const path of dumpedFiles(text)) files.add(path);
    tail = text;
  }
  return { bytes: size, files: files.size, complete: tail.endsWith(`${DUMP_END}\n`), leaked: [...leaked].toSorted() };
};

export interface Secret {
  readonly name: string;
  readonly value: string;
}

/**
 * Step 3+: the T3 Connect secrets t3 keeps in its secret store: the publish credential, and the account token's access
 * and refresh tokens while held (stages; prod discards it after the link).
 */
const CONNECT_SECRETS = ["cloud-relay-environment-credential", "cloud-cli-oauth-token"];

/** The account token's stored JSON, as its two secrets. */
const tokenParts = (text: string): Array<Secret> => {
  try {
    const token = JSON.parse(text) as { accessToken?: string; refreshToken?: string };
    return [
      ...(token.accessToken ? [{ name: "access", value: token.accessToken }] : []),
      ...(token.refreshToken ? [{ name: "refresh", value: token.refreshToken }] : []),
    ];
  } catch {
    return [];
  }
};

export const connectSecrets = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const found: Array<Secret> = [];
  for (const name of CONNECT_SECRETS) {
    const value = yield* store.get(name).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(value)) continue;
    const text = new TextDecoder().decode(value.value);
    if (name !== "cloud-cli-oauth-token") {
      found.push({ name, value: text });
      continue;
    }
    const token = tokenParts(text);
    if (token.length === 0) found.push({ name, value: text });
    for (const part of token) found.push({ name: `${name}:${part.name}`, value: part.value });
  }
  return found;
});

/**
 * SPI-1061 (plan §5.4): each Outbound link's bearer, which t3 keeps in its secret store under the name its row in
 * `peer_environment_links` gives (`peer-link-*`). Only t3's peer services read it; this is the canary that keeps it so.
 */
export const peerLinkSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const rows = yield* sql<{ environment_id: string; secret_name: string }>`
    SELECT environment_id, secret_name FROM peer_environment_links
  `.pipe(Effect.orElseSucceed(() => []));
  const found: Array<Secret> = [];
  for (const row of rows) {
    const value = yield* store.get(row.secret_name).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isSome(value))
      found.push({ name: `peer-link:${row.environment_id}`, value: new TextDecoder().decode(value.value) });
  }
  return found;
});

export const leakedIn = (text: string, secrets: ReadonlyArray<Secret>): Array<string> =>
  secrets
    .filter(
      ({ value }) => text.includes(value) || value.split("\n").some((line) => line.length >= 16 && text.includes(line)),
    )
    .map(({ name }) => name);

/**
 * Bindings that are public by design: the Worker's name and its hostname are in every URL the scan reads (the page, the
 * logs, the transcript), so counting them would flag every run. They are names, not secrets.
 */
const PUBLIC_BINDINGS: ReadonlySet<string> = new Set(["ALCHEMY_WORKER_NAME", "T3FLARE_HOST"]);

export const peerLeakCheck = async (
  environment: EnvironmentDO,
  input: {
    readonly workspace: string;
    readonly threads: ReadonlyArray<string>;
    readonly extra?: ReadonlyArray<Secret>;
    readonly text?: string;
  },
) => {
  const env = (environment as unknown as { readonly env: Record<string, unknown> }).env;
  const secrets: Array<Secret> = [];
  const notScanned: Array<string> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (PUBLIC_BINDINGS.has(name)) notScanned.push(name);
    else secrets.push({ name, value });
  }
  environment.github.live().forEach((value, at) => secrets.push({ name: `github-token-${at}`, value }));
  const runtime = await environment.boot("check-peer-leak");
  secrets.push(...(await runtime.run(connectSecrets)));
  secrets.push(...(await runtime.run(peerLinkSecrets)));
  const credentials: Array<string> = [];
  for (const threadId of input.threads) {
    const config = await runtime.run(
      Effect.flatMap(McpProviderSessions.McpProviderSessions, (sessions) => sessions.read(threadId as ThreadId)),
    );
    if (config === undefined) continue;
    credentials.push(threadId);
    secrets.push({
      name: `t3-mcp-credential:${threadId}`,
      value: config.authorizationHeader.replace(/^Bearer\s+/i, ""),
    });
  }
  // Tools step (ADR-0028): the direct servers' header values, OAuth tokens and client secrets.
  secrets.push(...environment.mcpLeakSecrets());
  for (const extra of input.extra ?? []) if (extra.value.length >= 8) secrets.push(extra);
  const rpc = workspaceRpc(input.workspace);
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- a plain async function: the dump file's name, not a secret
  const container = await containerScan((exec) => rpc.exec(exec), secrets, crypto.randomUUID());
  const sessions: Array<{ readonly thread: string; readonly bytes: number; readonly leaked: Array<string> }> = [];
  for (const threadId of input.threads) {
    const session = byName(environment.agents.SESSIONS, `thread:${threadId}`, "SESSIONS");
    const text =
      JSON.stringify(await session.snapshot({})) +
      JSON.stringify(await session.diagnostics()) +
      JSON.stringify(await session.t3Tools());
    sessions.push({ thread: threadId, bytes: text.length, leaked: leakedIn(text, secrets) });
  }
  // Text the caller collected (Workers Logs from `wrangler tail`, a capture endpoint's log), compared here.
  const text =
    input.text === undefined ? undefined : { bytes: input.text.length, leaked: leakedIn(input.text, secrets) };
  return {
    checked: secrets.map(({ name }) => name).toSorted(),
    /** The public-by-design bindings left out of the scan (names, never values). */
    notScanned: notScanned.toSorted(),
    credentialsFound: credentials.length,
    container,
    sessions,
    ...(text === undefined ? {} : { text }),
    /** False when the Container's dump was not scanned to its end: the check failed, whatever `leaked` says. */
    complete: container.complete,
    leaked:
      container.leaked.length + sessions.reduce((sum, s) => sum + s.leaked.length, 0) + (text?.leaked.length ?? 0),
  };
};
