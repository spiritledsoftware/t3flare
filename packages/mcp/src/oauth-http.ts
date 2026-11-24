/**
 * The small HTTP helpers the OAuth additions share: the fetch type, a body
 * read to a limit, and HTTP Basic client authentication. Re-exported by `./oauth`; no SDK import.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off preferEffectArray:off
const encoder = new TextEncoder();

/**
 * Each OAuth fetch's bound when its caller names none: the default of the Environment's Outside request time limit
 * (`outsideRequestSeconds`), which the Environment passes as each request's own.
 */
export const OAUTH_FETCH_TIMEOUT_MS = 15_000;

/**
 * The most bytes of a remote-controlled body read whole for a sign-in: authorization server metadata, discovery and a
 * token response. It is read into the Worker's 128 MB isolate and may be kept on a row, an 8 MB Durable Object value;
 * 1 MiB, the tap's bound on any other MCP answer, keeps it far under both.
 */
export const MAX_METADATA_BYTES = 1024 * 1024;

/** An error kept on a row, or an owner-facing reason, is cut to this many characters. */
export const MAX_SIGN_IN_ERROR_LENGTH = 300;

/** `text` with each of `secrets` (four characters or more) replaced, then cut to `limit` characters (none: not cut). */
export const scrubbed = (
  text: string,
  secrets: ReadonlyArray<string>,
  limit: number = Number.POSITIVE_INFINITY,
): string => {
  let result = text;

  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }

  const points = Array.from(result);

  return points.length <= limit ? result : points.slice(0, limit).join("");
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
