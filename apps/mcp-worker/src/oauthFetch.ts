// The MCP Worker's fetch for OAuth (review M5): https only, no credentials in the URL, no redirect followed, bounded.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { OAUTH_FETCH_TIMEOUT_MS } from "@t3flare/mcp/oauth";

/**
 * A fetch for OAuth: https only, no credentials in the URL, no redirect followed, each request bounded by `timeoutMs`:
 * the Environment's Outside request time limit (`OUTSIDE_REQUEST_SECONDS`), which its calls pass, or that limit's default.
 * A Workers fetch has no deadline of its own, so this is what ends a hung authorization server.
 */
export const guardedFetch =
  (base: typeof fetch = fetch, timeoutMs: number = OAUTH_FETCH_TIMEOUT_MS) =>
  async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.protocol !== "https:") throw new Error(`OAuth requests go only to https URLs (not ${url.protocol})`);
    if (url.username !== "" || url.password !== "") throw new Error("OAuth URLs carry no credentials");
    return base(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  };
