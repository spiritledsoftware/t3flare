// test:docker's stand-in for `computer.internal` (the egress host), in a sidecar container, from step 4a M0's probe:
// - a CONNECT proxy on :3128, the CLI network's only way out, logging every host it tunnels to;
// - a resolver on :53 that logs every name asked and answers NXDOMAIN (the CLI network has no route out).
// - with KEYHOST_MODEL_HANDLE (SPI-1168), a stand-in model relay and endpoint under /t3flare/model/: Anthropic Messages,
//   and OpenAI Chat Completions and Responses (SPI-1169), Google Generative AI and Mistral's chat (SPI-1170, pi's
//   APIs). KEYHOST_MODEL_HANDLE may name several handles (comma-separated): a process each (SPI-1170's resume).
// - with KEYHOST_MCP_UPSTREAM (SPI-1389), the MCP relay at /t3flare/mcp/<server>: each request forwarded to the test's own
//   relay (the Environment's `relayMessage`, in the test process), its tool handle with it.
// - with KEYHOST_CALL_TOOL (SPI-1389), the stand-in model calls the relayed tool of that upstream name (found through
//   `tool_search` or `ToolSearch` where the CLI defers it) with KEYHOST_CALL_ARGS, before any shell tool, until a result of it came back.
// Every event is one JSON line on stdout, never a handle. (A request to `/t3flare/model-key` is logged as any other
// path, `http`, and answered 404, as computer's proxy answers it.)
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

const log = (entry) => console.log(JSON.stringify({ at: Date.now(), ...entry }));
/**
 * SPI-1168: the model handles the stand-in model relay expects (claudeRelay, opencodeRelay and piRelay docker tests), in
 * order; never logged (a request's handle is logged by its index).
 */
const HANDLES = (process.env.KEYHOST_MODEL_HANDLE ?? "").split(",").filter((handle) => handle !== "");
/** The index of the handle `value` is (`prefix` before it, as `Bearer `), or -1. */
const handleIndex = (value, prefix = "") =>
  typeof value === "string" && value.startsWith(prefix) ? HANDLES.indexOf(value.slice(prefix.length)) : -1;
/** What each key header of a request holds: a handle (by index), or not. */
const keysOf = (req) => {
  const apiKey = handleIndex(req.headers["x-api-key"]);
  const bearer = handleIndex(req.headers.authorization, "Bearer ");
  const goog = handleIndex(req.headers["x-goog-api-key"]);
  return {
    apiKeyIsHandle: apiKey !== -1,
    bearerIsHandle: bearer !== -1,
    googKeyIsHandle: goog !== -1,
    handle: Math.max(apiKey, bearer, goog),
  };
};

/** The shell tool each CLI offers: Claude Code's `Bash`, OpenCode's `shell`, pi's `bash`. */
const SHELL_TOOLS = new Set(["Bash", "shell", "bash"]);
// SPI-1389: with KEYHOST_CODEX_SHELL, Codex's `exec_command` is its shell tool too (its own approval's test).
if (process.env.KEYHOST_CODEX_SHELL === "1") SHELL_TOOLS.add("exec_command");
const SHELL_COMMAND = "env > /workspace/shell-env.txt";
/** The shell tool's input: pi's takes the command alone, Codex's `exec_command` as `cmd`. */
const shellInput = (tool) =>
  tool === "bash"
    ? { command: SHELL_COMMAND }
    : tool === "exec_command"
      ? { cmd: SHELL_COMMAND }
      : { command: SHELL_COMMAND, description: "Write the environment" };

/**
 * The API a relayed request speaks, by its path: Anthropic Messages, OpenAI (or Mistral's) Chat Completions, OpenAI
 * Responses, or Google Generative AI (`…/models/<model>:streamGenerateContent`).
 */
const apiOf = (pathname) =>
  /:(stream)?[gG]enerateContent$/.test(pathname)
    ? "google"
    : pathname.endsWith("/chat/completions")
      ? "completions"
      : pathname.endsWith("/responses")
        ? "responses"
        : "messages";

/** SPI-1389: the relayed tool the stand-in model calls, and its arguments. */
const CALL_TOOL = process.env.KEYHOST_CALL_TOOL ?? "";
const CALL_ARGS = JSON.parse(process.env.KEYHOST_CALL_ARGS ?? "{}");

/**
 * A request's last message, past any system notes after it (Claude Code sends a `system` message after a tool's result).
 */
const lastMessageOf = (api, parsed) =>
  api === "responses"
    ? (Array.isArray(parsed.input) ? parsed.input : []).at(-1)
    : api === "google"
      ? (parsed.contents ?? []).at(-1)
      : (parsed.messages ?? []).filter((message) => message?.role !== "system").at(-1);

/** The text of every tool result in a request's last message, joined (to tell the relayed tool's result apart). */
const lastResultText = (api, parsed) => {
  const last = lastMessageOf(api, parsed);
  return JSON.stringify(last ?? null);
};

/**
 * SPI-1389: the tool call the stand-in model makes for a request: the relayed tool (by its upstream name, however the
 * CLI prefixes it) while its own result has not come back, or `tool_search` for it where the CLI defers it. Undefined:
 * the shell tool or text, as before.
 */
const relayedCallOf = (api, parsed) => {
  if (CALL_TOOL === "") return undefined;
  const names =
    api === "google"
      ? (parsed.tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name))
      : (parsed.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
  const last = lastResultText(api, parsed);
  // The relay's answers: the call ran ("noted"), was refused, or parked. The turn then ends with text.
  if (/noted:|Not run:|Parked:/.test(last)) return undefined;
  const direct = names.find((name) => typeof name === "string" && name.endsWith(CALL_TOOL));
  if (direct !== undefined) return { name: direct, input: CALL_ARGS };
  // OpenCode's Code Mode: the relayed tool is in the `execute` tool's catalog, called from JavaScript by its path.
  if (names.includes("execute")) {
    const path = new RegExp(`tools\\.([\\w$]+)\\.${CALL_TOOL}\\(`).exec(JSON.stringify(parsed))?.[0];
    if (path !== undefined)
      return { name: "execute", input: { code: `return await ${path}${JSON.stringify(CALL_ARGS)});` } };
  }
  // Codex (Responses) nests a server's tools in a `namespace` tool: the call names the tool and its namespace.
  for (const tool of parsed.tools ?? [])
    if (tool.type === "namespace")
      for (const nested of tool.tools ?? [])
        if (nested.name === CALL_TOOL) return { name: CALL_TOOL, namespace: tool.name, input: CALL_ARGS };
  // A CLI that defers MCP tools behind a search (pi's `tool_search`, Claude Code's `ToolSearch`): search once for it.
  const search = names.find((name) => name === "tool_search" || name === "ToolSearch");
  // Only at a new turn (its last message is no tool result): a search's own result never asks again.
  if (search !== undefined && !answeredOf(api, parsed))
    return {
      name: search,
      input: search === "ToolSearch" ? { query: CALL_TOOL, max_results: 5 } : { query: CALL_TOOL },
    };
  return undefined;
};

/** Whether a request's last message is a tool's result (so not a new turn). */
const answeredOf = (api, parsed) => {
  const last = lastMessageOf(api, parsed);
  return api === "messages"
    ? Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")
    : api === "completions"
      ? last?.role === "tool"
      : api === "google"
        ? (last?.parts ?? []).some((part) => part.functionResponse !== undefined)
        : last?.type === "function_call_output";
};

/**
 * The shell tool's name a request offers, if it offers one and its last message (past Claude Code's system notes) is not a
 * tool result (a new turn).
 */
const shellToolOf = (api, parsed) => {
  const names =
    api === "google"
      ? (parsed.tools ?? []).flatMap((tool) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name))
      : (parsed.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
  const answered = answeredOf(api, parsed);
  return answered ? undefined : names.find((name) => SHELL_TOOLS.has(name));
};

const sse = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  return (type, data) =>
    res.write(
      type === undefined
        ? `data: ${JSON.stringify(data)}\n\n`
        : `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
};

/** Anthropic Messages: the tool call, or the text PONG. */
const answerMessages = (res, parsed, call) => {
  const tool = call?.name;
  const id = `msg_${Date.now()}`;
  if (parsed.stream !== true) {
    // A request that does not stream (Claude Code's check of a model it is switched to): one text message.
    const message = {
      id,
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: "PONG" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
  }
  const block =
    tool !== undefined
      ? { type: "tool_use", id: `toolu_${Date.now()}`, name: tool, input: {} }
      : { type: "text", text: "" };
  const delta =
    tool !== undefined
      ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
      : { type: "text_delta", text: "PONG" };
  const event = sse(res);
  event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  });
  event("content_block_start", { index: 0, content_block: block });
  event("content_block_delta", { index: 0, delta });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: tool !== undefined ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  event("message_stop", {});
  res.end();
};

/** Google Generative AI (`streamGenerateContent?alt=sse`): the tool call, or the text PONG. */
const answerGoogle = (res, call) => {
  const part = call !== undefined ? { functionCall: { name: call.name, args: call.input } } : { text: "PONG" };
  const chunk = {
    candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
};

/** OpenAI Chat Completions: the tool call, or the text PONG. */
const answerCompletions = (res, parsed, call) => {
  const tool = call?.name;
  const base = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: parsed.model,
  };
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  if (parsed.stream !== true) {
    const message =
      tool !== undefined
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${Date.now()}`,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : { role: "assistant", content: "PONG" };
    return void res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: tool !== undefined ? "tool_calls" : "stop" }],
        usage,
      }),
    );
  }
  const event = sse(res);
  const delta =
    tool !== undefined
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(call.input) },
            },
          ],
        }
      : { role: "assistant", content: "PONG" };
  event(undefined, { ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  event(undefined, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: tool !== undefined ? "tool_calls" : "stop" }],
    usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
};

/** OpenAI Responses: the tool call, or the text PONG. */
const answerResponses = (res, parsed, call) => {
  const tool = call?.name;
  const id = `resp_${Date.now()}`;
  const item =
    tool !== undefined
      ? {
          type: "function_call",
          id: `fc_${Date.now()}`,
          call_id: `call_${Date.now()}`,
          name: tool,
          ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
          arguments: JSON.stringify(call.input),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${Date.now()}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "PONG", annotations: [] }],
        };
  const usage = {
    input_tokens: 5,
    output_tokens: 2,
    total_tokens: 7,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const response = (status, output) => ({
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: parsed.model,
    output,
    ...(status === "completed" ? { usage } : {}),
  });
  if (parsed.stream !== true)
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(response("completed", [item])));
  const event = sse(res);
  let sequence = 0;
  const send = (type, data) => event(type, { sequence_number: sequence++, ...data });
  send("response.created", { response: response("in_progress", []) });
  if (tool !== undefined) {
    send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
    send("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
    send("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
  } else {
    send("response.output_item.added", { output_index: 0, item: { ...item, content: [], status: "in_progress" } });
    send("response.content_part.added", {
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    send("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "PONG" });
    send("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: "PONG" });
    send("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] });
  }
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: response("completed", [item]) });
  res.end();
};

/**
 * A stand-in model relay and endpoint (Anthropic Messages, OpenAI Chat Completions or Responses, by the path): logs the
 * path, the body's model, the request's header names and whether each key header held the handle; answers a request
 * offering a shell tool (`Bash`, `shell`), with no tool result yet, by running `env > /workspace/shell-env.txt` in it,
 * and anything else with the text PONG.
 */
const relay = (req, res, url) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const api = apiOf(url.pathname);
    const relayed = relayedCallOf(api, parsed);
    // With a relayed tool to call (SPI-1389), never the shell tool: a CLI whose relay is missing answers PONG.
    const shell = relayed === undefined && CALL_TOOL === "" ? shellToolOf(api, parsed) : undefined;
    const call = relayed ?? (shell === undefined ? undefined : { name: shell, input: shellInput(shell) });
    // Google's model is in the path, not the body.
    const model = parsed.model ?? /\/models\/([^/:]+):/.exec(url.pathname)?.[1] ?? null;
    log({
      event: "model-relay",
      method: req.method,
      path: url.pathname,
      query: url.search,
      api,
      model,
      messages: (parsed.messages ?? parsed.input ?? parsed.contents ?? []).length,
      headers: Object.keys(req.headers).sort(),
      ...keysOf(req),
      bash: shell !== undefined,
      called: relayed?.name ?? null,
      // SPI-1389: where the request names the relayed tool outside its tools (a catalog in the instructions).
      mentions:
        CALL_TOOL === ""
          ? undefined
          : [
              ...JSON.stringify({
                system: parsed.system,
                messages: parsed.messages,
                instructions: parsed.instructions,
              }).matchAll(new RegExp(`.{0,300}${CALL_TOOL}.{0,200}`, "g")),
            ]
              .map((match) => match[0])
              .slice(0, 4),
      // SPI-1389: the relay's answer the CLI passed back to the model, if its last message holds one.
      relayResult: /Parked:/.test(lastResultText(api, parsed))
        ? "parked"
        : /noted:/.test(lastResultText(api, parsed))
          ? "noted"
          : /Not run:/.test(lastResultText(api, parsed))
            ? "refused"
            : null,
      tools: (parsed.tools ?? []).map(
        (t) => t.name ?? t.function?.name ?? (t.functionDeclarations ?? []).map((d) => d.name).join(","),
      ),
    });
    if (url.pathname.endsWith("/count_tokens"))
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
    if (api === "google") return answerGoogle(res, call);
    if (api === "completions") return answerCompletions(res, parsed, call);
    if (api === "responses") return answerResponses(res, parsed, call);
    answerMessages(res, parsed, call);
  });
};

/** SPI-1389: the test's relay, which each `/t3flare/mcp/` request is forwarded to. */
const MCP_UPSTREAM = process.env.KEYHOST_MCP_UPSTREAM ?? "";

/** Forwards one MCP relay request to the test's relay, with its body and the headers it reads; answers its answer. */
const forwardMcp = (req, res, url) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    log({ event: "mcp-relay", method: req.method, path: url.pathname, bytes: body.length });
    try {
      const upstream = await fetch(`${MCP_UPSTREAM}${url.pathname}`, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          authorization: req.headers.authorization ?? "",
          accept: req.headers.accept ?? "application/json, text/event-stream",
        },
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
    } catch (error) {
      log({ event: "mcp-relay-failed", error: String(error) });
      res.writeHead(502).end();
    }
  });
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://computer.internal");
    if (url.pathname.startsWith("/t3flare/model/") && HANDLES.length > 0) {
      relay(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/t3flare/mcp/") && MCP_UPSTREAM !== "") {
      forwardMcp(req, res, url);
      return;
    }
    log({ event: "http", method: req.method, path: url.pathname, ...keysOf(req) });
    res.writeHead(404).end();
  })
  .listen(80);

const proxy = http.createServer((req, res) => {
  log({ event: "proxy-http", method: req.method, url: req.url });
  res.writeHead(403).end();
});
proxy.on("connect", (req, socket, head) => {
  const [host, port] = req.url.split(":");
  log({ event: "connect", host, port: Number(port) });
  const upstream = net.connect(Number(port) || 443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
proxy.listen(3128);

const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  let at = 12;
  const labels = [];
  while (msg[at] !== 0 && at < msg.length) {
    labels.push(msg.subarray(at + 1, at + 1 + msg[at]).toString());
    at += msg[at] + 1;
  }
  log({ event: "dns", name: labels.join(".") });
  const reply = Buffer.from(msg);
  reply[2] = 0x81;
  reply[3] = 0x83;
  dns.send(reply, rinfo.port, rinfo.address);
});
dns.bind(53);
log({ event: "ready" });
