/**
 * The small HTTP helpers the OAuth additions share: the fetch type, a body
 * read to a limit, and HTTP Basic client authentication. Re-exported by `./oauth`; no SDK import, so a package that
 * does not build the OAuth client (the Environment's tests) can import it as `./oauth-http`.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off
const encoder = new TextEncoder();

/**
 * Each OAuth fetch's bound when its caller names none, as from a caller older than the field: a fallback only. The
 * Environment passes its fixed outside request time limit (`OUTSIDE_REQUEST_SECONDS`, 30 s since SPI-1387) as each
 * request's own.
 */
export const OAUTH_FETCH_TIMEOUT_MS = 15_000;

/**
 * How many links of an error's `cause` chain `isTimeoutError` follows: a guard against a chain that loops back on
 * itself, far past any chain the SDK builds (a wrapper or two over the fetch's error).
 */
const CAUSE_CHAIN_MAX = 8;

/**
 * Whether `error`, or an error in its `cause` chain, is a request's own time limit (`AbortSignal.timeout`'s
 * `TimeoutError`). By `name` alone, as the harness registry's `isTimeout` reads it: workerd's `DOMException` need not
 * pass `instanceof Error`.
 */
export const isTimeoutError = (error: unknown): boolean => {
  let link = error;
  for (let depth = 0; depth < CAUSE_CHAIN_MAX && typeof link === "object" && link !== null; depth += 1) {
    if ((link as { readonly name?: unknown }).name === "TimeoutError") return true;
    link = (link as { readonly cause?: unknown }).cause;
  }
  return false;
};

/**
 * An OAuth fetch's time limit, hit (ADR-0049 §4, SPI-1432): "did not answer in 30 s, t3flare's fixed outside request
 * time limit", for a request bounded at `ms`. The harness registry's `outsideRequestTimedOut` words it the same; this
 * package does not import the registry, so the shape is kept here once for its OAuth and public reads, and
 * `outsideRequests.test.ts` holds the two equal.
 */
export const outsideRequestTimedOut = (ms: number): string =>
  `did not answer in ${(ms / 1000).toLocaleString("en-US")} s, t3flare's fixed outside request time limit`;

/**
 * The most bytes of a remote-controlled body read whole for a sign-in: authorization server metadata, discovery and a
 * token response. It is read into the Worker's 128 MB isolate and may be kept on a row, an 8 MB Durable Object value;
 * 1 MiB, the tap's bound on any other MCP answer, keeps it far under both.
 */
export const MAX_METADATA_BYTES = 1024 * 1024;

/** `text` with each of `secrets` (four characters or more) replaced. */
export const scrubbed = (text: string, secrets: ReadonlyArray<string>): string => {
  let result = text;

  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }

  return result;
};

/** How an OAuth request is sent: `guardedFetch` in the Worker, a fake in a test. */
export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * `response`'s body as text, read until `limit` bytes and no further; undefined when it is longer (the rest is not
 * read). A token response's bound is the limit its reader passes (the Client Credentials grant's token request,
 * `./oauth-client-credentials.ts`).
 */
export const boundedText = async (response: Response, limit: number): Promise<string | undefined> => {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();

    return undefined;
  }

  const reader = response.body?.getReader();

  if (reader === undefined) return "";

  const chunks: Array<Uint8Array> = [];
  let length = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    length += value.byteLength;

    if (length > limit) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

/** RFC 6749 §2.3.1: the id and secret are form-encoded before they are joined and Base64-encoded. */
export const basicAuthorization = (id: string, secret: string): string => {
  const form = (value: string) => encodeURIComponent(value).replaceAll("%20", "+");
  const bytes = encoder.encode(`${form(id)}:${form(secret)}`);

  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
};
