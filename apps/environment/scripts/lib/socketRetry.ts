// @effect-diagnostics globalConsole:off globalTimers:off
// The stage scripts' /ws calls, sent again when Cloudflare's edge drops the socket. Each call opens its own socket
// (scripts/lib/client.ts), and the edge now and then ends the stream mid-call: a bump's acceptance test died of a
// `SocketReadError` 5 s into a clone that the Worker logged as `responseStreamDisconnected`, with no exception. A
// method on the allowlist below is sent once more, after 1 s, when its call fails with the socket read or closed; any
// other failure, a second drop, and every other method (a dispatch, a settings write, a project mutation) fail as they
// are. resetRetry.ts covers the scripts' fetch the same way.
type WsCall = (cookie: string, method: string, payload: unknown) => Promise<unknown>;

const CLONE = "sourceControl.cloneRepository";

/** The methods the scripts send over /ws that answer the same however often they are sent: reads, subscriptions, and
 * a clone, whose resend to the destination the first attempt filled answers as that clone's success (below). */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
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

const DROPS = new Set(["SocketReadError", "SocketCloseError"]);

/** A /ws call's failure that is the socket dropping under it (an `RpcClientError` reading or closing), not an answer. */
export const isSocketDrop = (error: unknown): boolean => {
  const tagged = error as { _tag?: unknown; reason?: { _tag?: unknown } } | null | undefined;
  return (
    tagged?._tag === "RpcClientError" &&
    typeof tagged.reason?._tag === "string" &&
    DROPS.has(tagged.reason._tag)
  );
};

/** t3's clone refuses a destination that is not empty (SourceControlRepositoryService.prepareDestination): after a
 * drop, that is the first attempt's clone, which the resend did not see finish. */
const alreadyCloned = (error: unknown): boolean => {
  const tagged = error as { _tag?: unknown; detail?: unknown } | null | undefined;
  return (
    tagged?._tag === "SourceControlRepositoryError" &&
    typeof tagged.detail === "string" &&
    tagged.detail.startsWith("Destination path already exists and is not empty")
  );
};

export const withSocketRetry =
  (inner: WsCall): WsCall =>
  async (cookie, method, payload) => {
    try {
      return await inner(cookie, method, payload);
    } catch (error) {
      if (!isSocketDrop(error) || !IDEMPOTENT_METHODS.has(method)) throw error;
      console.error(`ws ${method}: socket dropped, attempt 2 of 2`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    try {
      return await inner(cookie, method, payload);
    } catch (error) {
      if (method !== CLONE || !alreadyCloned(error)) throw error;
      // The clone answers `cwd` as the destination resolved to an absolute path; the scripts send absolute ones.
      const { destinationPath, remoteUrl } = payload as {
        destinationPath: string;
        remoteUrl?: string;
      };
      return { cwd: destinationPath, remoteUrl: remoteUrl ?? null, repository: null };
    }
  };
