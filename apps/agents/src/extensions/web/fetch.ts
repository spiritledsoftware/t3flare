// `web_fetch` (SPI-1054; see ./NOTICE.md), one HTTP(S) URL as text, Markdown or HTML, with line paging, every request
// through the SSRF guard (`net.ts`). A plain pi-durable tool; the honest user agent names t3flare, and `details` carry
// what t3's web item shows. A fetch is a read: no mode asks for it, plan mode included, and linked threads may use it.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  FETCH_MAX_KIB,
  FETCH_TIMEOUT_SECONDS,
  FETCH_TITLE_CHARACTERS,
  MAX_TIMED_SECONDS,
} from "@t3flare/harness-registry";
import { jsonTextBytes, jsonTextPrefix } from "@t3flare/session-protocol";

import { convertContent, type WebFetchFormat } from "./content.ts";
import {
  discardBody,
  guardedFetch,
  readBoundedBody,
  statusCause,
  type WebTransport,
  WebToolError,
  withDeadline,
} from "./net.ts";
import { DEFAULT_TOOL_OUTPUT_LIMITS, outputSize, type ToolOutputLimits } from "../toolOutput.ts";
import { boundStructuredText, detailsRoomBytes, fitWindowedOutput, selectLines } from "./output.ts";

/** What `details`' `snippet` adds beside its text: its key, quotes, colon and comma. */
const SNIPPET_KEY_BYTES = 16;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const HONEST_USER_AGENT = "t3flare-web-tools";

const description = (output: ToolOutputLimits) =>
  `Fetch one HTTP or HTTPS URL as text, Markdown, or HTML. HTML pages are converted to their main content, with the page title, when text or Markdown is requested; HTML format returns the page unchanged. JSON responses are re-indented in text and Markdown formats so long documents can be paged. A response over ${FETCH_MAX_KIB / 1024} MiB is refused. Model-visible output is truncated to ${outputSize(output)}, and the result then says which lines remain and the offset to continue from. Use offset and limit (lines, like the read tool) to page through a long result. Private, loopback, link-local, and cloud-metadata addresses are refused, also after redirects.`;

/** What programs (code mode) receive instead of the model-facing text. */
const outputSchema = (output: ToolOutputLimits) => ({
  type: "object",
  properties: {
    url: { type: "string", description: "Final URL after redirects, without credentials" },
    content_type: { type: "string", description: "Response Content-Type header" },
    format: { type: "string", enum: ["text", "markdown", "html"] },
    content: {
      type: "string",
      description: "Fetched text in the requested format, limited to the offset/limit window",
    },
    truncated: { type: "boolean", description: `The model-visible output was cut at ${outputSize(output)}` },
    structured_truncated: { type: "boolean", description: "content itself was cut at 1 MiB of JSON" },
    total_lines: {
      type: "integer",
      description: "Lines in the whole converted text; present when offset or limit was passed",
    },
    next_offset: {
      type: "integer",
      description: "Offset of the first line after the offset/limit window; present when lines remain after it",
    },
  },
  required: ["url", "content_type", "format", "content", "truncated", "structured_truncated"],
});

/** Remove URL user information before a value reaches an error or a result. */
export const redactUserinfo = (input: string): string => {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return input.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1");
  }
};

const acceptHeader = (format: WebFetchFormat): string => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
};

const normalizedMime = (contentType: string): string => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const isTextualMime = (mime: string): boolean =>
  mime.length === 0 ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript";

interface Fetched {
  readonly content: string;
  readonly contentType: string;
  readonly finalUrl: string;
}

/** GET `url` through the guard and convert what comes back. */
const fetchText = async (
  transport: WebTransport,
  url: string,
  format: WebFetchFormat,
  signal: AbortSignal,
): Promise<Fetched> => {
  const send = (userAgent: string) =>
    guardedFetch(
      transport,
      { url, headers: { accept: acceptHeader(format), "accept-language": "en-US,en;q=0.9", "user-agent": userAgent } },
      signal,
    );
  let reply = await send(BROWSER_USER_AGENT);
  // A Cloudflare challenge is aimed at browsers; the honest agent is allowed through by sites that expect tools.
  if (reply.response.status === 403 && reply.response.headers.get("cf-mitigated") === "challenge") {
    await discardBody(reply.response);
    reply = await send(HONEST_USER_AGENT);
  }
  const { response } = reply;
  if (!response.ok) {
    await discardBody(response);
    throw new WebToolError(statusCause(response.status));
  }
  const contentType = response.headers.get("content-type") ?? "";
  const mime = normalizedMime(contentType);
  if (!isTextualMime(mime)) {
    await discardBody(response);
    throw new WebToolError(
      `unsupported content type ${mime} (Web Fetch returns text only; for a document such as a PDF, download it and convert it to text locally)`,
    );
  }
  // Every body within `FETCH_MAX_KIB` converts: the isolate holds its conversion (the constant says how much).
  const body = await readBoundedBody(
    response,
    FETCH_MAX_KIB * 1024,
    signal,
    (size) => `web_fetch's fixed ${size} size limit`,
  );
  const finalUrl = redactUserinfo(reply.url.toString());
  let content: string;
  try {
    content = convertContent(new TextDecoder().decode(body), mime, format);
  } catch {
    throw new WebToolError(
      "the page could not be converted (it is nested too deeply or is too large to convert); use format: html to read it as it came",
    );
  }
  return { content, contentType, finalUrl };
};

/**
 * The page's first Markdown heading, for t3's item (never the model's text), cut at `FETCH_TITLE_CHARACTERS` and then
 * marked with "…": it is kept in the tool result's `details`, so a heading line of megabytes stays out.
 */
const titleOf = (content: string): string | undefined => {
  const heading = /^#{1,2} (.+)$/m.exec(content)?.[1]?.trim();
  if (heading === undefined || heading === "") return undefined;
  return heading.length <= FETCH_TITLE_CHARACTERS ? heading : `${heading.slice(0, FETCH_TITLE_CHARACTERS)}…`;
};

/** `web_fetch` over `transport`, its text within `output` (the Tool output limit). */
export const webFetchTool = (
  transport: WebTransport,
  output: ToolOutputLimits = DEFAULT_TOOL_OUTPUT_LIMITS,
): ToolRegistration =>
  defineTool({
    name: "web_fetch",
    description: description(output),
    parameters: obj({
      url: str({ description: "Absolute HTTP or HTTPS URL to fetch" }),
      format: opt(oneOf(["text", "markdown", "html"], { description: "Returned format (default: markdown)" })),
      timeout: opt(
        num({
          minimum: 0.001,
          // MAX_TIMED_SECONDS: t3flare times the fetch itself (ADR-0048 §2); a longer timer would overflow and fire at once.
          maximum: MAX_TIMED_SECONDS,
          description: `Total timeout in seconds (default: ${FETCH_TIMEOUT_SECONDS}); a call may set a longer one`,
        }),
      ),
      offset: opt(
        int({
          minimum: 1,
          description: "Line to start reading from (1-indexed), counted in the returned format after conversion",
        }),
      ),
      limit: opt(
        int({
          minimum: 1,
          description:
            "Maximum number of lines to return; the result says how many lines remain and the offset to continue from",
        }),
      ),
    }),
    structuredOutputSchema: outputSchema(output),
    outputLimits: output,
    replay: "safe",
    async execute(args, _api, context) {
      const safeUrl = redactUserinfo(args.url);
      const format: WebFetchFormat = args.format ?? "markdown";
      let fetched: Fetched;
      try {
        // A call's own timeout is its own; the default names itself when it runs out.
        fetched = await withDeadline(
          args.timeout ?? FETCH_TIMEOUT_SECONDS,
          context.abortSignal,
          (signal) => fetchText(transport, args.url, format, signal),
          args.timeout === undefined ? ", web_fetch's default time limit; pass timeout for longer" : "",
        );
      } catch (error) {
        throw new Error(
          `Unable to fetch ${safeUrl}: ${error instanceof WebToolError ? error.message : "network error"}`,
          { cause: error },
        );
      }
      const selected = selectLines(fetched.content, args.offset, args.limit);
      if (selected === undefined) {
        throw new Error(
          `Unable to fetch ${safeUrl}: Offset ${args.offset} is beyond end of content (${fetched.content.split("\n").length} lines total)`,
        );
      }
      const fitted = fitWindowedOutput(selected.text, selected.window, output);
      const structured = boundStructuredText(selected.text);
      const requested = args.offset !== undefined || args.limit !== undefined;
      const { totalLines } = selected.window;
      // A cut `content` ends inside the window, so the line after the window would skip lines.
      const paging = !requested
        ? {}
        : structured.truncated || selected.lastLine >= totalLines
          ? { total_lines: totalLines }
          : { total_lines: totalLines, next_offset: selected.lastLine + 1 };
      const title = titleOf(fetched.content);
      const shown = {
        url: fetched.finalUrl,
        contentType: fetched.contentType,
        format,
        ...(title === undefined ? {} : { title }),
      };
      // The snippet is the model's text, cut only where the result's row has no more room (`detailsRoomBytes`).
      const snippetRoom = detailsRoomBytes(output.maxBytes) - jsonTextBytes(JSON.stringify(shown)) - SNIPPET_KEY_BYTES;
      const snippet = fitted.content.slice(0, jsonTextPrefix(fitted.content, Math.max(0, snippetRoom)));
      return {
        output: [{ type: "text" as const, text: fitted.content }],
        structuredOutput: {
          url: fetched.finalUrl,
          content_type: fetched.contentType,
          format,
          content: structured.content,
          truncated: fitted.truncated,
          structured_truncated: structured.truncated,
          ...paging,
        },
        // What t3's web item shows (the differ): the final URL, its title and the page as the model reads it.
        details: { ...shown, snippet },
      };
    },
  });
