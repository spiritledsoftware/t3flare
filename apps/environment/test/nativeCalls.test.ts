// SPI-1389: a CLI's own approval request's whole call, read off its stdout by the native id t3 gives the request, which a
// parked request's allowance matches by: never by the title or the model-written reason t3's approval item shows.
import { describe, expect, it } from "vitest";

import { argsHashOf } from "../src/mcp/canonical.ts";
import { NATIVE_CALLS_KEPT, nativeCallRecorder, nativeProtocolOf } from "../src/provider/cli/nativeCalls.ts";

const line = (message: unknown) => JSON.stringify({ jsonrpc: "2.0", ...(message as object) });

/** ACP's permission request for one tool call, as Claude Code and OpenCode send it. */
const permission = (id: number, toolCallId: string, title: string, rawInput?: unknown) =>
  line({
    id,
    method: "session/request_permission",
    params: {
      sessionId: "s",
      toolCall: { toolCallId, title, kind: "execute", ...(rawInput === undefined ? {} : { rawInput }) },
      options: [],
    },
  });

/** Codex's approval request for a command, and a file change's. */
const commandApproval = (id: number, itemId: string, command: string, reason: string) =>
  line({
    id,
    method: "item/commandExecution/requestApproval",
    // As Codex 0.167 sends it: a timestamp and the decisions offered, which differ or say nothing about the call.
    params: {
      threadId: "t",
      turnId: "u",
      itemId,
      command,
      cwd: "/w/fixture",
      reason,
      startedAtMs: 1_795_566_338_801 + id,
      environmentId: "local",
      availableDecisions: ["accept", "cancel"],
    },
  });

const callHash = async (recorder: ReturnType<typeof nativeCallRecorder>, id: string) => {
  const call = recorder.callOf(id);
  return call === undefined ? undefined : argsHashOf(call);
};

describe("a CLI's own approval request's whole call (SPI-1389)", () => {
  it("knows each CLI's protocol: ACP for Claude Code and OpenCode, Codex's, none for pi", () => {
    expect(["claude-agent-acp", "opencode", "codex", "pi"].map(nativeProtocolOf)).toEqual([
      "acp",
      "acp",
      "codex",
      "none",
    ]);
  });

  it("ACP: a command's call is its raw input, so the same title with another command is another call", async () => {
    const recorder = nativeCallRecorder("acp");
    recorder.observe(permission(1, "tc-1", "Run a command", { command: "ls" }));
    recorder.observe(permission(2, "tc-2", "Run a command", { command: "rm -rf /" }));
    recorder.observe(permission(3, "tc-3", "Run a command", { command: "ls" }));
    expect(recorder.callOf("tc-1")).toEqual({ name: "Run a command", kind: "execute", rawInput: { command: "ls" } });
    expect(await callHash(recorder, "tc-2")).not.toBe(await callHash(recorder, "tc-1"));
    expect(await callHash(recorder, "tc-3")).toBe(await callHash(recorder, "tc-1"));
  });

  it("ACP: an edit's call holds its file path and content, merged over the tool call's earlier updates", async () => {
    const recorder = nativeCallRecorder("acp");
    const edit = (toolCallId: string, content: string) => [
      line({
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Edit foo.ts",
            kind: "edit",
            rawInput: { file_path: "/w/fixture/foo.ts", new_string: content },
          },
        },
      }),
      // The request itself carries no raw input: the tool call's update gave it.
      line({
        id: 9,
        method: "session/request_permission",
        params: { sessionId: "s", toolCall: { toolCallId, title: "Edit foo.ts" }, options: [] },
      }),
    ];
    for (const message of [...edit("tc-a", "safe"), ...edit("tc-b", "evil"), ...edit("tc-c", "safe")])
      recorder.observe(message);
    expect(recorder.callOf("tc-a")).toEqual({
      name: "Edit foo.ts",
      kind: "edit",
      rawInput: { file_path: "/w/fixture/foo.ts", new_string: "safe" },
    });
    expect(await callHash(recorder, "tc-b")).not.toBe(await callHash(recorder, "tc-a"));
    expect(await callHash(recorder, "tc-c")).toBe(await callHash(recorder, "tc-a"));
  });

  it("ACP: an MCP tool's call names the tool, so another tool with the same input is another call", async () => {
    const recorder = nativeCallRecorder("acp");
    // Claude Code: an MCP tool's kind is only `other`; its name is in `_meta.claudeCode.toolName`.
    const mcp = (id: number, toolCallId: string, toolName: string) =>
      line({
        id,
        method: "session/request_permission",
        params: {
          sessionId: "s",
          toolCall: {
            toolCallId,
            title: "t3",
            kind: "other",
            rawInput: { projectId: "p-1" },
            _meta: { claudeCode: { toolName } },
          },
          options: [],
        },
      });
    recorder.observe(mcp(1, "tc-read", "mcp__t3__t3_project_read"));
    recorder.observe(mcp(2, "tc-delete", "mcp__t3__t3_project_delete"));
    recorder.observe(mcp(3, "tc-read-again", "mcp__t3__t3_project_read"));
    expect(recorder.callOf("tc-read")).toMatchObject({ name: "mcp__t3__t3_project_read", kind: "other" });
    expect(await callHash(recorder, "tc-delete")).not.toBe(await callHash(recorder, "tc-read"));
    expect(await callHash(recorder, "tc-read-again")).toBe(await callHash(recorder, "tc-read"));
    // OpenCode names the tool only in the title: another title is another call.
    recorder.observe(permission(4, "tc-oc-1", "t3_project_read", { projectId: "p-1" }));
    recorder.observe(permission(5, "tc-oc-2", "t3_project_delete", { projectId: "p-1" }));
    expect(await callHash(recorder, "tc-oc-2")).not.toBe(await callHash(recorder, "tc-oc-1"));
    // A call that names no tool at all keeps no call.
    recorder.observe(permission(6, "tc-nameless", "", { projectId: "p-1" }));
    expect(recorder.callOf("tc-nameless")).toBeUndefined();
  });

  it("ACP: a request whose raw input was never given has no call (its repeat asks again)", () => {
    const recorder = nativeCallRecorder("acp");
    recorder.observe(permission(1, "tc-1", "Run a command"));
    expect(recorder.callOf("tc-1")).toBeUndefined();
  });

  it("Codex: a command's call is every param but its ids, times, offered decisions and reason", async () => {
    const recorder = nativeCallRecorder("codex");
    recorder.observe(commandApproval(1, "item-1", "ls", "List the files"));
    recorder.observe(commandApproval(2, "item-2", "rm -rf /", "List the files"));
    recorder.observe(commandApproval(3, "item-3", "ls", "Another reason"));
    expect(recorder.callOf("item-1")).toEqual({
      method: "item/commandExecution/requestApproval",
      command: "ls",
      cwd: "/w/fixture",
      environmentId: "local",
    });
    expect(await callHash(recorder, "item-2")).not.toBe(await callHash(recorder, "item-1"));
    expect(await callHash(recorder, "item-3")).toBe(await callHash(recorder, "item-1"));
  });

  it("Codex: the same command as another kind, in another environment, or to another host is another call", async () => {
    const recorder = nativeCallRecorder("codex");
    const approval = (id: number, itemId: string, extra: Record<string, unknown>) =>
      line({
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t", turnId: "u", itemId, command: "curl x", cwd: "/w/fixture", kind: "command", ...extra },
      });
    recorder.observe(approval(1, "base", { networkApprovalContext: { host: "example.com", protocol: "https" } }));
    recorder.observe(approval(2, "host", { networkApprovalContext: { host: "evil.example", protocol: "https" } }));
    recorder.observe(
      approval(3, "kind", { kind: "writeStdin", networkApprovalContext: { host: "example.com", protocol: "https" } }),
    );
    recorder.observe(
      approval(4, "env", {
        environmentId: "remote",
        networkApprovalContext: { host: "example.com", protocol: "https" },
      }),
    );
    recorder.observe(
      approval(5, "same", { startedAtMs: 9, networkApprovalContext: { host: "example.com", protocol: "https" } }),
    );
    const base = await callHash(recorder, "base");
    for (const other of ["host", "kind", "env"]) expect(await callHash(recorder, other), other).not.toBe(base);
    expect(await callHash(recorder, "same")).toBe(base);
  });

  it("Codex: a file change's call holds the item's changes, so another edit of the same file is another call", async () => {
    const recorder = nativeCallRecorder("codex");
    const change = (itemId: string, diff: string) => [
      line({
        method: "item/started",
        params: {
          item: { type: "fileChange", id: itemId, changes: [{ path: "/w/fixture/foo.ts", kind: "update", diff }] },
        },
      }),
      line({
        id: 4,
        method: "item/fileChange/requestApproval",
        params: { threadId: "t", turnId: "u", itemId, reason: "Fix" },
      }),
    ];
    for (const message of [...change("f-1", "+safe"), ...change("f-2", "+evil"), ...change("f-3", "+safe")])
      recorder.observe(message);
    expect(await callHash(recorder, "f-2")).not.toBe(await callHash(recorder, "f-1"));
    expect(await callHash(recorder, "f-3")).toBe(await callHash(recorder, "f-1"));
    // A file change whose item was never seen has no call.
    recorder.observe(line({ id: 5, method: "item/fileChange/requestApproval", params: { itemId: "f-9" } }));
    expect(recorder.callOf("f-9")).toBeUndefined();
  });

  it("keeps at most NATIVE_CALLS_KEPT requests, the oldest dropped first; pi's lines are not read", () => {
    const recorder = nativeCallRecorder("acp");
    for (let index = 0; index <= NATIVE_CALLS_KEPT; index++)
      recorder.observe(permission(index, `tc-${index}`, "t", { command: `c${index}` }));
    expect(recorder.callOf("tc-0")).toBeUndefined();
    expect(recorder.callOf(`tc-${NATIVE_CALLS_KEPT}`)).toBeDefined();
    const pi = nativeCallRecorder("none");
    pi.observe(permission(1, "tc-1", "t", { command: "ls" }));
    expect(pi.callOf("tc-1")).toBeUndefined();
  });
});
