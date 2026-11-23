// @effect-diagnostics globalConsole:off globalTimers:off
// The stage scripts' /ws calls, sent again when Cloudflare's edge drops the socket. Each call opens its own socket
// (scripts/lib/client.ts), and the edge now and then ends the stream mid-call: a bump's acceptance test died of a
// `SocketReadError` 5 s into a clone that the Worker logged as `responseStreamDisconnected`, with no exception. A method
// on the allowlist below is sent once more, after 1 s, when its call fails with the socket read or closed; any other
// failure, a second drop, and every other method (a dispatch, a settings write, a project mutation) fail as they are.
// resetRetry.ts covers the scripts' fetch the same way. What this leans on in t3 and effect: fragility U98.
import type { SourceControlRepositoryError } from "@t3tools/contracts";
import type { RpcClientError } from "effect/rpc/RpcClientError";

type WsCall = (cookie: string, method: string, payload: unknown) => Promise<unknown>;

const ATTEMPTS = 2;
const CLONE = "sourceControl.cloneRepository";

/** The methods the scripts send over /ws that answer the same however often they are sent: reads, subscriptions, and
 * a clone, whose resend to the destination the first attempt is filling waits for that clone (`finishedClone`). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "orchestration.getTurnDiff",
  "orchestration.subscribeCommandOutput",
  "orchestration.subscribeShell",
  "peerLinks.list",
  "preview.list",
  "projects.readFile",
  "pullRequests.activity",
  "pullRequests.checks",
  "pullRequests.detail",
  "pullRequests.list",
  "pullRequests.reviewGuide",
  "scheduledTasks.listWebhookDeliveries",
  "scheduledTasks.subscribe",
  "server.discoverSourceControl",
  "server.getConfig",
  "server.getDatabaseStorage",
  "server.getStorageCleanupReport",
  "server.getUsageSummary",
  "server.searchAcpRegistry",
  "subscribeAuthAccess",
  "subscribeWorktreeSetup",
  "vcs.listRefs",
  CLONE,
]);

// Typed against effect's union, so a renamed reason fails the typecheck.
const DROPS: ReadonlySet<string> = new Set(["SocketReadError", "SocketCloseError"] satisfies ReadonlyArray<RpcClientError["reason"]["_tag"]>);

/** A /ws call's failure that is the socket dropping under it (an `RpcClientError` reading or closing), not an answer. */
const isSocketDrop = (error: unknown): boolean => {
  const tagged = error as { _tag?: unknown; reason?: { _tag?: unknown } } | null | undefined;
  return tagged?._tag === ("RpcClientError" satisfies RpcClientError["_tag"]) && typeof tagged.reason?._tag === "string" && DROPS.has(tagged.reason._tag);
};

/** A clone refused because its destination is taken: t3's own "Destination path already exists and is not empty."
 * (SourceControlRepositoryService.prepareDestination), or git's "destination path '<name>' already exists and is not an
 * empty directory." that the process router answers for a Workspace already cloning (src/agents/processRouter.ts). */
const isDestinationTaken = (error: unknown): boolean => {
  const tagged = error as { _tag?: unknown; detail?: unknown } | null | undefined;
  return tagged?._tag === ("SourceControlRepositoryError" satisfies SourceControlRepositoryError["_tag"]) && typeof tagged.detail === "string" && /already exists and is not (an )?empty/i.test(tagged.detail);
};

// How long a resent clone waits for the first attempt's clone: t3's own clone time limit (CLONE_TIMEOUT_MS).
const CLONE_WAIT_MS = 120_000;
const CLONE_POLL_MS = 2_000;

/**
 * The first attempt's clone, once it has finished. A dropped socket does not stop it: the process router's clone runs
 * on in the Environment DO (its `kill` is a no-op), so the resend finds the destination taken, by a clone that may
 * still be running. It has finished when the destination has a checked-out branch (`vcs.listRefs`); a clone that
 * failed leaves none, and after `CLONE_WAIT_MS` the drop is thrown. The answer is t3's for that clone, built from the
 * payload: only for an absolute, normal destination (t3 answers it resolved) and a credential-free `remoteUrl` (t3
 * answers it redacted), sent without a `repository` lookup; any other clone throws the drop.
 */
const finishedClone = async (inner: WsCall, cookie: string, payload: unknown, drop: unknown): Promise<unknown> => {
  const { destinationPath, remoteUrl, repository } = (payload ?? {}) as { destinationPath?: unknown; remoteUrl?: unknown; repository?: unknown };
  const answerable =
    typeof destinationPath === "string" &&
    /^(\/[^/]+)+$/.test(destinationPath) &&
    !/\/\.{1,2}(\/|$)/.test(destinationPath) &&
    typeof remoteUrl === "string" &&
    remoteUrl.trim() === remoteUrl &&
    remoteUrl !== "" &&
    !/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(remoteUrl) &&
    repository === undefined;
  if (!answerable) throw drop;
  for (let waited = 0; waited <= CLONE_WAIT_MS; waited += CLONE_POLL_MS) {
    const refs = await inner(cookie, "vcs.listRefs", { cwd: destinationPath, refKind: "local", refresh: true, limit: 200 }).catch(() => undefined);
    if ((refs as { refs?: ReadonlyArray<{ current?: unknown }> } | undefined)?.refs?.some((ref) => ref.current === true) === true) {
      return { cwd: destinationPath, remoteUrl, repository: null };
    }
    await new Promise((resolve) => setTimeout(resolve, CLONE_POLL_MS));
  }
  throw drop;
};

export const withSocketRetry =
  (inner: WsCall): WsCall =>
  async (cookie, method, payload) => {
    let drop: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        return await inner(cookie, method, payload);
      } catch (error) {
        if (drop !== undefined && method === CLONE && isDestinationTaken(error)) return finishedClone(inner, cookie, payload, drop);
        if (attempt >= ATTEMPTS || !isSocketDrop(error) || !IDEMPOTENT_METHODS.has(method)) throw error;
        drop = error;
        console.error(`ws ${method}: socket dropped, attempt ${attempt + 1} of ${ATTEMPTS}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  };
