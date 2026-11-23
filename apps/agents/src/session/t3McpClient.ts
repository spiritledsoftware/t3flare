// The Session's MCP client of t3's `/mcp` (step 3, plan section 4.2; ADR-0022), over the Environment DO's `mcp` RPC
// rather than HTTP: one MCP session per credential, kept in memory, initialised again when t3 answers 404 (the
// Environment restarted), as t3's `PeerMcpClient` does. A 401 means the credential is gone (an Environment restart, the
// provider session released): t3's tools are unavailable until the next turn brings a fresh one.
// @effect-diagnostics globalConsole:off
import {
  jsonPartBytes,
  jsonTextBytes,
  type McpRpcAnswer,
  type McpRpcRequest,
  mebibytes,
  SESSION_ROW_BYTES,
  SESSION_ROW_ENVELOPE_BYTES,
  type T3McpCredential,
} from "@t3flare/session-protocol";

import type { CatalogTool, McpCallAnswer } from "../extensions/t3-mcp.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const UNAVAILABLE =
  "T3's tools are unavailable until the next turn (T3 restarted or ended this provider session). Do not retry now.";

interface JsonRpcMessage {
  readonly result?: {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly isError?: boolean;
    readonly tools?: ReadonlyArray<CatalogTool>;
    readonly structuredContent?: unknown;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

/** The JSON-RPC message of an answer: its JSON body, or its SSE stream's last `data:` event. */
export const messageOf = (answer: McpRpcAnswer): JsonRpcMessage | undefined => {
  const text = answer.contentType.includes("text/event-stream")
    ? answer.body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== "")
        .at(-1)
    : answer.body;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    return undefined;
  }
};

/** G11 (R6): the image types a model reads. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * A tool result's text and images: pi-durable keeps the result as one Session row (SESSION_ROW_BYTES), which
 * also holds the record around it.
 */
export const RESULT_BYTES = SESSION_ROW_BYTES - SESSION_ROW_ENVELOPE_BYTES;

type ContentPart = {
  readonly type?: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
};

/**
 * The MCP `image` parts of a tool result a model can see (t3's `html_preview` and `preview_snapshot` screenshots), in
 * order while they fit the result's row beside its text, and a note for each one left out. `perImageBase64`: the model's
 * API's own limit on one image (`perImageBase64Of`).
 */
export const imagesOf = (
  content: ReadonlyArray<ContentPart>,
  perImageBase64?: number,
): {
  readonly images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
  readonly notes: ReadonlyArray<string>;
} => {
  const candidates = content.filter(
    (part): part is ContentPart & { readonly data: string; readonly mimeType: string } =>
      part.type === "image" && typeof part.data === "string" && IMAGE_TYPES.has(part.mimeType ?? ""),
  );
  const tooLarge = (index: number, part: { readonly data: string }) =>
    `[Image ${index + 1} of this result (${mebibytes(part.data.length)} of base64) is not shown: this model's API takes at most ${mebibytes(perImageBase64 ?? 0)} in one image.]`;
  const noRoom = (index: number, part: { readonly data: string }) =>
    `[Image ${index + 1} of this result (${mebibytes(part.data.length)} of base64) is not shown: a tool result holds at most ${mebibytes(RESULT_BYTES)} of text and images.]`;
  // A note goes on its own line after the result's text.
  const noteBytes = (note: string) => jsonPartBytes(note, "\n");
  // Each image's note, should it be left out, is kept back until the image is placed.
  const bounds = candidates.map((part, index) =>
    Math.max(noteBytes(tooLarge(index, part)), noteBytes(noRoom(index, part))),
  );
  let held = bounds.reduce((total, bound) => total + bound, 0);
  let used = jsonTextBytes(content.map((part) => part.text ?? "").join(""));
  const images: Array<{ readonly data: string; readonly mimeType: string }> = [];
  const notes: Array<string> = [];
  for (const [index, part] of candidates.entries()) {
    held -= bounds[index]!;
    const note =
      perImageBase64 !== undefined && part.data.length > perImageBase64
        ? tooLarge(index, part)
        : used + held + part.data.length > RESULT_BYTES
          ? noRoom(index, part)
          : undefined;
    if (note === undefined) {
      used += part.data.length;
      images.push({ data: part.data, mimeType: part.mimeType });
    } else {
      used += noteBytes(note);
      notes.push(note);
    }
  }
  return { images, notes };
};

export class T3McpClient {
  readonly #post: (input: McpRpcRequest) => Promise<McpRpcAnswer>;
  readonly #credential: () => T3McpCredential | undefined;
  readonly #perImageBase64: () => number | undefined;
  /** MCP session ids by credential (the authorization header): memory only. */
  readonly #sessions = new Map<string, string>();
  #id = 1;

  /** `perImageBase64`: the Session model's API's limit on one image (`perImageBase64Of`), read at each call. */
  constructor(
    post: (input: McpRpcRequest) => Promise<McpRpcAnswer>,
    credential: () => T3McpCredential | undefined,
    perImageBase64: () => number | undefined = () => undefined,
  ) {
    this.#post = post;
    this.#credential = credential;
    this.#perImageBase64 = perImageBase64;
  }

  async #initialize(authorization: string): Promise<McpRpcAnswer> {
    const answer = await this.#post({
      authorization,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3flare-session", version: "1" },
        },
      }),
    });
    if (answer.status === 200 && answer.sessionId !== undefined) {
      this.#sessions.set(authorization, answer.sessionId);
      await this.#post({
        authorization,
        sessionId: answer.sessionId,
        protocolVersion: MCP_PROTOCOL_VERSION,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    }
    return answer;
  }

  /** One request with the current credential; a 404 initialises again once. Undefined without a credential. */
  async request(method: string, params: unknown): Promise<McpRpcAnswer | undefined> {
    const credential = this.#credential();
    if (credential === undefined) return undefined;
    const { authorization } = credential;
    const send = async (): Promise<McpRpcAnswer> => {
      let sessionId = this.#sessions.get(authorization);
      if (sessionId === undefined) {
        const init = await this.#initialize(authorization);
        if (init.status !== 200) return init;
        sessionId = this.#sessions.get(authorization);
      }
      return this.#post({
        authorization,
        protocolVersion: MCP_PROTOCOL_VERSION,
        ...(sessionId === undefined ? {} : { sessionId }),
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#id++, method, params }),
      });
    };
    let answer = await send();
    if (answer.status === 404) {
      this.#sessions.delete(authorization);
      answer = await send();
    }
    return answer;
  }

  /** t3's tools for this credential (`tools/list`), or undefined when t3 did not answer with them. */
  async listTools(): Promise<ReadonlyArray<CatalogTool> | undefined> {
    const answer = await this.request("tools/list", {});
    if (answer === undefined || answer.status !== 200) return undefined;
    return messageOf(answer)?.result?.tools;
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<McpCallAnswer> {
    const answer = await this.request("tools/call", { name, arguments: args }).catch((error: unknown) => {
      console.warn(JSON.stringify({ t3flare: "t3-mcp-call-failed", tool: name, error: String(error).slice(0, 300) }));
      return undefined;
    });
    if (answer === undefined || answer.status === 401) return { kind: "unavailable", message: UNAVAILABLE };
    if (answer.status !== 200) return { kind: "result", text: `T3 answered HTTP ${answer.status}.`, isError: true };
    const message = messageOf(answer);
    if (message?.error !== undefined) return { kind: "result", text: message.error.message, isError: true };
    const content = message?.result?.content ?? [];
    const { images, notes } = imagesOf(content, this.#perImageBase64());
    const text = [content.map((part) => part.text ?? "").join(""), ...notes].join("\n");
    return {
      kind: "result",
      text,
      isError: message?.result?.isError === true,
      ...(images.length === 0 ? {} : { images }),
    };
  }
}
