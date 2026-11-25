// The Session ↔ Environment contract (ADR-0005; step 2a plan, section 2). Plain types and constants only: both Workers
// import them, and neither imports the other's code. The Session DO (agents Worker) pushes its committed state to the
// Environment DO; the Environment DO's provider adapter calls the Session's commands and diffs what it pushes into t3's
// provider events. Structural copies of the pi-durable shapes the adapter reads, so the environment Worker needs no
// pi-durable.

/** The Session DO's name for t3 thread `threadId`: one Session per thread. Also the provider thread's native id. */
export const sessionNameOf = (threadId: string): string => `thread:${threadId}`;

/** The Environment DO's name (ADR-0002: one per deploy). */
export const ENVIRONMENT_NAME = "environment";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The t3 runtime modes the Session enforces (step 2a plan, section 3). */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

/**
 * The mode the Session enforces for t3's runtime mode. It fails closed: an unknown or missing mode asks for approval.
 * t3's `auto` runs as approval-required, as t3's own Pi provider runs it
 * (t3code/packages/provider-pi/src/server/mcpInjection.ts); we have no automatic reviewer to approve for the owner.
 */
export const runtimeModeOf = (mode: string | null | undefined): RuntimeMode =>
  mode === "auto-accept-edits" || mode === "full-access" ? mode : "approval-required";

/** t3's interaction mode as the Session enforces it (step 3, F-plan): `plan` is read-only work. */
export type InteractionMode = "default" | "plan";

/**
 * The interaction mode the Session enforces. It fails closed: any mode t3 sends other than `default` (`plan`, or one
 * added later) runs as plan. A missing one (a Session stored before step 3) is the default.
 */
export const interactionModeOf = (mode: string | null | undefined): InteractionMode =>
  mode === undefined || mode === null || mode === "default" ? "default" : "plan";

/**
 * t3's MCP credential for the thread's provider session (step 3, plan section 4.1; ADR-0022): issued by t3, read by the
 * adapter, and kept by the Session in its DO storage only. Never in a Container, a push, a snapshot or a log.
 */
export interface T3McpCredential {
  /** `Bearer <token>`, as t3 issues it (`McpProviderSessionConfig.authorizationHeader`). */
  readonly authorization: string;
  /** t3's provider-session id the credential is scoped to; t3 namespaces `clientRequestId` by it. */
  readonly providerSessionId: string;
  /** t3's orchestration instructions (`T3_CODE_ORCHESTRATION_INSTRUCTIONS`), shown while the tools are installed. */
  readonly instructions: string;
}

/**
 * The link a thread's work came from (t3's `linkOrigin`), when it came over a Peer link (step 3). The Session asks
 * a fresh approval for every `git push` such a thread makes (owner decision D1, option 2).
 */
export interface LinkedWork {
  readonly label: string;
  readonly access: string | null;
}

/** One `/mcp` request from a Session to the Environment DO (`EnvironmentDO.mcp`, plan section 4.2). */
export interface McpRpcRequest {
  readonly authorization: string;
  readonly body: string;
  readonly sessionId?: string;
  readonly protocolVersion?: string;
}

export interface McpRpcAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly sessionId?: string;
  readonly body: string;
}

/** A model as the Session runs it: pi-ai's provider and model id. */
export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export interface ImageInput {
  readonly data: string;
  readonly mimeType: string;
}

/**
 * The bytes one Session row holds. pi-durable keeps each submission and each conversation entry (a user
 * message, a tool result with its images) as one DO SQLite row of JSON, and Cloudflare refuses a row over 8 MB: read as
 * 8,000,000 bytes, the lower of 8 MB and 8 MiB.
 */
export const SESSION_ROW_BYTES = 8_000_000;
/** What a Session row keeps for the record around a message's content: its ids, status, times and JSON structure. */
export const SESSION_ROW_ENVELOPE_BYTES = 64 * 1024;
/** The most bytes one byte of text takes in a JSON string: a control character, written `\u001f`. */
export const JSON_ESCAPE_MAX_BYTES = 6;

/** One binary megabyte, the unit t3's client and t3's own limits ("80 MiB") write sizes in. */
export const MIB = 1024 * 1024;

/** A size as t3's client shows it. */
export const mebibytes = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

/**
 * The note for an image left out because the model's API takes at most `perImageBase64` of base64 in one image
 * (`perImageBase64Of`): the Session's tool-result intake and its history hook (SPI-1376) both say it. `subject` names
 * the image, with a capital.
 */
export const imageTooLargeNote = (subject: string, base64Length: number, perImageBase64: number): string =>
  `[${subject} (${mebibytes(base64Length)} of base64) is not shown: this model's API takes at most ${mebibytes(perImageBase64)} in one image.]`;

/**
 * The bytes the character at `at` of `text` takes inside a JSON string, as JSON.stringify writes it in UTF-8: 2 for an
 * escaped quote, backslash or named control character, 6 for any other control character or a lone surrogate
 * (`\u00xx`, `\udxxx`), 4 for a surrogate pair (two UTF-16 units), else its UTF-8 length.
 */
const jsonCharBytes = (text: string, at: number): number => {
  const code = text.charCodeAt(at);
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(at + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  return code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
};

/** The bytes `text` takes inside a JSON string, without its quotes: what JSON.stringify writes for it, in UTF-8. */
export const jsonTextBytes = (text: string): number => {
  let bytes = 0;
  for (let at = 0; at < text.length;) {
    const size = jsonCharBytes(text, at);
    bytes += size;
    at += size === 4 ? 2 : 1;
  }
  return bytes;
};

/** The bytes `part` adds to a JSON string when joined after what is before it with `separator`. */
export const jsonPartBytes = (part: string, separator: string): number =>
  jsonTextBytes(separator) + jsonTextBytes(part);

/**
 * The length, in UTF-16 units, of `text`'s longest start that takes at most `room` bytes inside a JSON string
 * (`jsonTextBytes`), never splitting a surrogate pair. Counted a character at a time, so it is exact.
 */
export const jsonTextPrefix = (text: string, room: number): number => {
  let bytes = 0;
  let at = 0;
  while (at < text.length) {
    const size = jsonCharBytes(text, at);
    if (bytes + size > room) break;
    bytes += size;
    at += size === 4 ? 2 : 1;
  }
  return at;
};

// ---------------------------------------------------------------------------------------------------------------------
// Commands: Environment → Session (RPC methods on SessionDO)

export interface OpenInput {
  readonly threadId: string;
  readonly workspaceId: string | null;
  /**
   * The agent's working directory inside the Workspace (`/workspace/repo[/…]`): a scratch thread's own folder in the No
   * project Workspace (parity G4). Absent: the repo's root.
   */
  readonly cwd?: string;
  readonly runtimeMode: RuntimeMode;
  /** Step 3: absent from an adapter before it (the default). */
  readonly interactionMode?: InteractionMode;
  readonly model: ModelRef;
  readonly thinking: ThinkingLevel | null;
  /** Step 3: t3's MCP credential for this provider session; absent when t3 issued none. */
  readonly t3Mcp?: T3McpCredential;
  /** Step 3: the thread's link origin, null for the owner's own work. */
  readonly linked?: LinkedWork | null;
}

export interface OpenAnswer {
  readonly epoch: string;
  readonly busy: boolean;
  readonly turns: Readonly<Record<string, TurnState>>;
}

export interface SubmitTurnInput {
  /** The key: a repeated call with the same providerTurnId submits nothing new. */
  readonly providerTurnId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
  readonly model: ModelRef;
  readonly thinking: ThinkingLevel | null;
  readonly runtimeMode: RuntimeMode;
  /** Step 3: absent from an adapter before it (the default). */
  readonly interactionMode?: InteractionMode;
  /** Step 3: as `OpenInput.t3Mcp`, read again at every turn. */
  readonly t3Mcp?: T3McpCredential;
  readonly linked?: LinkedWork | null;
  /**
   * SPI-1148: the Environment skill set's hash now; the Session has its Workspace take the set when it differs from the
   * one held. Absent from an adapter that carries none (the CLI adapters until SPI-1153).
   */
  readonly environmentSkillsHash?: string;
  /**
   * SPI-1315: the Turn limit (the Environment's `turnLimitMinutes`) in ms, as read at this turn's start; the Session
   * keeps it on the turn's record. Absent (an Environment before it): the Turn limit's
   * default (`DEFAULT_TURN_LIMIT_MS`, @t3flare/harness-registry).
   */
  readonly turnLimitMs?: number;
}

export interface SteerInput {
  readonly providerTurnId: string;
  readonly key: string;
  readonly text: string;
  readonly images: ReadonlyArray<ImageInput>;
}

export interface AbortInput {
  readonly providerTurnId?: string;
  readonly all?: boolean;
  readonly reason: string;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface AnswerInput {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly feedback?: string;
  /** Step 3: a question's answer (`ask_user`), as t3 hands it to a provider: by question id. */
  readonly answers?: Readonly<Record<string, unknown>>;
}

export interface SnapshotInput {
  /** Entries after this one; all of the Session's conversation's when absent (and `turns` is too). */
  readonly fromEntry?: string;
  /**
   * SPI-1377: the provider turns the adapter has open. The snapshot then reports the Session's live turns and those of
   * these it still has (one it lacks is gone), and its entries start at the oldest such turn's input entry, or at the
   * Session's last entry when none has one: its size follows the open turns, never the thread's length. Absent: every
   * turn, and the entries `fromEntry` names (the whole thread for `{}`, a diagnostic's read).
   */
  readonly turns?: ReadonlyArray<string>;
}

/**
 * G6 (SPI-987): t3's checkpoint rollback. The Session's conversation goes back to just before the first of these turns
 * it placed (a pi-durable fork at the entry before it, or a fresh conversation), and it forgets every turn from there.
 */
export interface RollbackInput {
  /** The provider turns t3 rolls back: those after the checkpoint's turn. */
  readonly dropTurns: ReadonlyArray<string>;
}

export interface RollbackAnswer {
  /** The pi-durable conversation the Session runs now. */
  readonly conversation: string;
  /** Whether the conversation changed (false: none of the turns was placed, or a repeated call). */
  readonly rewound: boolean;
  /** The turns the Session forgot. */
  readonly dropped: number;
}

/**
 * G6 (SPI-997): a new thread's Session seeded from another's conversation, as t3's native fork. The source's model
 * context through the end of `providerTurnId` becomes this Session's conversation; later turns are not in it.
 */
export interface ForkInput {
  /** The source thread's Session name (`sessionNameOf`). */
  readonly source: string;
  /** The source's turn the fork ends with; absent: nothing of the source's conversation. */
  readonly providerTurnId?: string;
}

export interface ForkAnswer {
  readonly conversation: string;
  /** The model messages the fork was seeded with. */
  readonly messages: number;
}

/** A Session asks the source Session for its conversation a page at a time (Session to Session). */
export interface ForkSourceInput {
  readonly providerTurnId: string;
  /** The fork point the first page answered; absent on the first call. */
  readonly at?: string;
  readonly offset: number;
}

export interface ForkSourcePage {
  /** The entry the fork ends at: the source's model context as of it. */
  readonly at: string;
  /** pi-ai messages, as pi-durable gives the model. */
  readonly messages: ReadonlyArray<unknown>;
  /** The offset of the next page; null after the last. */
  readonly next: number | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// State: Session → Environment (`sessionPush`) and the snapshot's answer

/** pi-ai's content blocks as committed entries and the live partial carry them (only what the differ reads). */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly redacted?: boolean }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "image"; readonly mimeType?: string }
  | { readonly type: string; readonly [key: string]: unknown };

export interface UsageSlim {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

/** One committed transcript entry, slimmed: its messages' content bounded, tool results cut to TOOL_OUTPUT_BYTES. */
export interface PushedEntry {
  readonly id: string;
  readonly kind: string;
  readonly byTaskId: string | null;
  /** The turn (providerTurnId) the Session was running when the entry was committed; null outside a turn. */
  readonly turn: string | null;
  readonly role: "user" | "assistant" | "toolResult" | "system" | "other";
  readonly content: ReadonlyArray<ContentBlock>;
  /** Assistant entries: why the response ended, and its error message (never shown raw). */
  readonly stopReason?: string;
  readonly errorMessage?: string;
  /** Tool results: the call they answer. */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly usage?: UsageSlim;
  readonly timestamp?: number;
}

/** The Durable agent's plan-mode tool (SPI-996): its call's `plan` argument is t3's proposed plan. */
export const PROPOSE_PLAN_TOOL = "propose_plan";

export interface ToolSlotSlim {
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
  /**
   * SPI-996: a running call's output so far (`pi.live`'s retained output), its last TOOL_LIVE_OUTPUT_BYTES characters;
   * the differ streams what is new as t3's `command_output.delta`. Absent once done, and in pushes from before it.
   */
  readonly output?: string;
}

/**
 * A code mode script's nested call while its run lives (`pi.live.nestedTools`, ADR-0027): the differ shows it as a child
 * item of the script's call. Arguments cut to NESTED_ARGS_BYTES, running output to its tail.
 */
export interface NestedToolSlim {
  readonly callId: string;
  readonly parentCallId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: "pending" | "running" | "done";
  readonly isError?: boolean;
  readonly output?: string;
}

/**
 * The most bytes of one detail string t3 sends its client with an item on the wire (a diff, a subagent's prompt): t3's
 * `MAX_DETAIL_STRING_BYTES` (t3code `apps/server/src/orchestration-v2/WireProjection.ts`). A nested call's arguments
 * are pushed again every few hundred ms while its script runs, so they take this wire size, not the on-demand one. A
 * t3 internal: docs/upstream-fragility.md.
 */
export const T3_DETAIL_STRING_BYTES = 32_768;
/**
 * The most of a running command's output t3 keeps as its live tail, in UTF-16 units: t3's `TERMINAL_OUTPUT_TAIL_CHARS`
 * (t3code `packages/shared/src/terminalOutput.ts`). A t3 internal: docs/upstream-fragility.md.
 */
export const T3_OUTPUT_TAIL_CHARS = 64 * 1024;
/**
 * The most of a tool result's output t3 serves its client on demand: t3's `MAX_ON_DEMAND_BYTES` (t3code
 * `apps/server/src/orchestration-v2/WireProjection.ts`), which cuts anything longer. A t3 internal:
 * docs/upstream-fragility.md.
 */
export const T3_ON_DEMAND_BYTES = 256 * 1024;

/** A nested call's arguments as pushed: whole up to t3's wire detail size (SPI-1362), else each string field cut. */
export const NESTED_ARGS_BYTES = T3_DETAIL_STRING_BYTES;
/** A running nested call's output, as pushed: its tail, as much as t3 keeps of a live output (SPI-1362). */
export const NESTED_OUTPUT_BYTES = T3_OUTPUT_TAIL_CHARS;
/** A running model-issued call's output, as pushed (SPI-996): its tail, as much as t3 keeps (SPI-1362). */
export const TOOL_LIVE_OUTPUT_BYTES = T3_OUTPUT_TAIL_CHARS;

export interface LiveSlim {
  /** The run in progress, if any: its generation task, and the turn it serves. */
  readonly run: { readonly taskId: string; readonly turn: string | null } | null;
  /** The in-flight response's committed partial: its generation task and its blocks. */
  readonly generation: {
    readonly taskId: string;
    readonly attempt: number;
    readonly content: ReadonlyArray<ContentBlock>;
  } | null;
  readonly tools: ReadonlyArray<ToolSlotSlim>;
  /** Code mode's nested calls (tools step); absent in pushes from before it. */
  readonly nestedTools?: ReadonlyArray<NestedToolSlim>;
  readonly runFailure: { readonly reason: string; readonly detail?: string; readonly taskId: string } | null;
}

export type TurnStatus = "queued" | "running" | "answered" | "failed" | "aborted";

export interface TurnState {
  readonly submissionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly status: TurnStatus;
  /** When the turn settled without an answer: pi-durable's reason (RunFailureReason, or ours: `turn_deadline`, the Turn limit's). */
  readonly reason?: string;
  /** Bounded detail for `failed` (a model error's text is classified, never shown raw). */
  readonly detail?: string;
  /** The entry the turn's input was placed as. */
  readonly inputEntry?: string;
  readonly startedAt: number;
  /**
   * SPI-1315: the Turn limit the turn started with, in ms; the Session ends it at `startedAt` plus this. Absent on a turn
   * recorded before it: the Turn limit's default.
   */
  readonly turnLimitMs?: number;
  readonly settledAt?: number;
  /**
   * SPI-1377: the turn's place in the Session's order of settles, one more than the turn settled before it. A push names
   * the turns settled since the last one the Environment took by it, not by `settledAt`: a clock can go back.
   */
  readonly settledSeq?: number;
  /**
   * Steers sent into the turn (their submissions). A steer that reaches the run as it gives its final answer starts the
   * next pi-durable run; it is still this turn's work, so the turn settles only when they have.
   */
  readonly steers?: ReadonlyArray<string>;
  /**
   * What the turn's model requests got (step 2a part 2); absent in pushes from before it. `proxy` is a kept wire name.
   */
  readonly proxy?: ProxyRecord;
}

/** A turn's model requests, and its last failure as the Session classified it when the answer came. */
export interface ProxyRecord {
  /** The Session's model requests while this turn ran (the fault route's answers included). */
  readonly requests: number;
  /**
   * SPI-1164: why the turn's last request got no credential from its Model endpoint (a sign-in signed out, a key gone),
   * typed, so the differ shows it without reading the error's text.
   */
  readonly credential?: EndpointCredentialFailure;
  /**
   * SPI-1172: the turn's last failed answer from a Model endpoint, classified by the endpoint's API and auth when it came.
   * Every failed answer replaces it: the last answer is the turn's. (An old record may also hold a `failure` nothing reads.)
   */
  readonly endpointFailure?: EndpointFailureRecord;
  /**
   * SPI-1305: the cause of the turn's last failed request where no answer came (a thrown fetch's message, redacted): the
   * runtime's or the platform's text, never a vendor's body. The differ appends it to the failure's text. Every failed
   * answer replaces it.
   */
  readonly cause?: string;
}

/**
 * `@t3flare/models/failures`' `ModelFailure`, restated here because this package depends on none (its `code` is that
 * module's `ModelFailureCode`; the Session's record assigns one to the other, so typecheck holds them together).
 */
export interface ModelFailureFields {
  readonly class: "usage_limit" | "permission_error" | "provider_error";
  readonly code: string;
  readonly resetAt?: number;
  readonly retryable: boolean;
  readonly stop: boolean;
}

/** A Model endpoint's classified failure (SPI-1172), with the endpoint, the Session's text naming it, and the answer's time. */
export type EndpointFailureRecord = ModelFailureFields & {
  readonly endpointId: string;
  /** The Session's fixed text, never the vendor's body. */
  readonly message: string;
  readonly at: number;
};

/**
 * Why a Session got no credential for a Model endpoint (SPI-1164), as it records it on the turn: `signed_out` (sign in
 * again), `changed` (retry), `unavailable` (a sign-in's passing failure: retry), `unreadable` and `no_key` (enter the key
 * again). `message` is the Session's own fixed text, never a vendor's.
 */
export interface EndpointCredentialFailure {
  readonly endpointId: string;
  readonly kind: "signed_out" | "changed" | "unavailable" | "unreadable" | "no_key";
  readonly message: string;
  readonly retryable: boolean;
}

export interface PendingApproval {
  readonly requestId: string;
  readonly turn: string | null;
  readonly callId: string;
  readonly tool: string;
  /**
   * `mcp-tool` (step 3, review C4): a t3 MCP tool, accepted for the session per tool name. `mcp-elicitation` (SPI-1079):
   * an MCP server's confirmation or page, shown as t3's own `mcp-elicitation` card; never accepted for the session.
   */
  readonly kind: "command" | "file-change" | "mcp-tool" | "mcp-elicitation";
  /** The card's title, instead of "Allow <tool>?" (SPI-1079). */
  readonly title?: string;
  readonly summary: string;
  readonly detail?: string;
  /** The card's own buttons (t3's `ProviderApprovalOption`s), instead of t3's defaults. */
  readonly options?: ReadonlyArray<{
    readonly decision: "accept" | "acceptForSession" | "decline" | "cancel";
    readonly label: string;
    readonly warning?: string;
  }>;
  /** A call a code mode script made (tools step, ADR-0027): the script's call and its code, as a card shows it. */
  readonly via?: { readonly parentCallId: string; readonly script: string };
  /** An MCP tool's definition hash (ADR-0028, review H3): an acceptance for the session covers that definition only. */
  readonly definition?: string;
  readonly createdAt: number;
}

/**
 * A question the agent asked the owner (`ask_user`, step 3): one question, optional choices, a free answer unless only
 * the choices are allowed. It waits durably as an approval does.
 */
export interface PendingQuestion {
  readonly requestId: string;
  readonly turn: string | null;
  readonly callId: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly allowFreeText: boolean;
  /** An MCP server's form (SPI-1079): its questions, by field, instead of the one `question`. */
  readonly questions?: ReadonlyArray<McpCardQuestion>;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// MCP servers' questions (SPI-1079, ADR-0028's elicitation refinement): the Environment's MCP host makes a card of each
// question a server asks during an agent's call, and the caller (the Session, or the CLI relay) only shows it and hands
// back the owner's answer. Never the agent's to answer.

/** The marker in every MCP question card's request id: the Environment refuses `t3_pending_request` on such ids. */
export const MCP_QUESTION_MARKER = "t3flare-elicit";

/**
 * The marker in every parked card's question id (SPI-1389): only the Owner answers one, as an MCP question's card; the
 * Environment refuses `t3_pending_request` on such ids, so no agent mints an allowance or approves an Open change.
 */
export const PARK_QUESTION_MARKER = "t3flare-park";

/** One question of a form card, in t3's `user_input` question shape. */
export interface McpCardQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string; readonly value?: string }>;
  readonly multiSelect?: boolean;
  readonly allowCustomAnswer?: boolean;
  readonly required?: boolean;
}

/** A card for an MCP server's question: an `mcp-elicitation` approval card, or a `user_input` form card. */
export interface McpQuestionCard {
  /** The card's id, `t3flare-elicit-…`: the Session's request id, and part of a CLI card's runtime request id. */
  readonly id: string;
  readonly kind: "approval" | "form";
  readonly server: string;
  readonly title: string;
  /** The whole text the owner reads, through `cardText`. */
  readonly prompt: string;
  readonly options?: ReadonlyArray<{ readonly decision: ApprovalDecision; readonly label: string }>;
  readonly questions?: ReadonlyArray<McpCardQuestion>;
  /** The Settings server's card for an Open change (SPI-1389): the change's id, which a parked card's record keeps. */
  readonly changeId?: string;
}

/**
 * The reason of a card's cancel when its CLI agent's turn parked (SPI-1389): the card stays up as a question, and the
 * Owner's answer comes to the thread as a message. An Open change stays open on its Change page.
 */
export const PARKED_REASON = "parked";

/** The owner's answer to a card: a decision, and a form's answers by question id. */
export interface McpQuestionAnswer {
  readonly decision: ApprovalDecision;
  readonly answers?: Readonly<Record<string, unknown>>;
  /** Why no owner answered (no live turn, withdrawn, parked: `PARKED_REASON`). */
  readonly reason?: string;
  /**
   * The card's CLI turn parked (SPI-1389): the complete tool result the held call is answered with, naming the limit,
   * in place of whatever the server answers the cancel with.
   */
  readonly parked?: string;
}

/** The caller's side of an MCP call's questions, passed with the call (Workers RPC carries the functions). */
export interface McpAsker {
  readonly ask: (card: McpQuestionCard) => Promise<McpQuestionAnswer>;
  /** The server stopped waiting: the card closes. */
  readonly withdraw: (cardId: string) => void | Promise<void>;
}

export interface SessionState {
  readonly sessionId: string;
  readonly epoch: string;
  readonly entries: ReadonlyArray<PushedEntry>;
  /**
   * Entries were cut at the bound (`PUSH_ENTRIES_BYTES`): pull a snapshot. The Session pushes the rest next too, but
   * this push's turns are already the newest.
   */
  readonly more: boolean;
  readonly live: LiveSlim;
  readonly agent: { readonly model: ModelRef | null; readonly thinking: string | null };
  readonly usage: UsageSlim | null;
  readonly inbox: { readonly pending: number };
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** Step 3: absent in a push from a Session before it. */
  readonly questions?: ReadonlyArray<PendingQuestion>;
  /**
   * SPI-1377: a push's are the live turns and those settled since the last push the Environment took; a snapshot's are
   * as its `SnapshotInput` asks. Never every turn of a long thread.
   */
  readonly turns: Readonly<Record<string, TurnState>>;
  /** SPI-1055: the root conversation's Todo List (its revision and Tasks); absent from a Session before it, or without one. */
  readonly todo?: TodoSlim | null;
}

/** The Todo List as pushed: what t3's todo list shows of each Task (as many as the `todo` tool's output limit holds). */
export interface TodoSlim {
  readonly rev: number;
  readonly tasks: ReadonlyArray<{
    readonly id: number;
    readonly title: string;
    readonly status: "pending" | "active" | "completed";
  }>;
}

export interface SessionPush extends SessionState {
  readonly seq: number;
  readonly prevSeq: number;
  /** A push with nothing new, sent every LIVENESS_PUSH_MS while a turn is live. */
  readonly liveness: boolean;
}

export interface SessionPushAnswer {
  readonly ok: true;
  readonly wantSnapshot?: true;
  /** Live turns t3 does not have open: the Session aborts them and withdraws their approvals. */
  readonly orphans?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounds and timings

/** How long the Session coalesces commits before a push while streaming. */
export const PUSH_COALESCE_MS = 300;
/** A tool result's text, as pushed: as much as t3 serves its client (SPI-1362); the model's copy is the Session's. */
export const TOOL_OUTPUT_BYTES = T3_ON_DEMAND_BYTES;
/** The largest message one Durable Object RPC carries: Cloudflare's 32 MiB. A push is one. */
export const RPC_MESSAGE_BYTES = 32 * MIB;
/**
 * Full-size tool results (`TOOL_OUTPUT_BYTES`) of plain text one push carries: a round of parallel calls, so a burst
 * of results settles in one push, not a page and a snapshot. A taste choice, bounded by `PUSH_ENTRIES_BYTES`'s constraint.
 */
export const PUSH_BURST_RESULTS = 16;
/** What a pushed entry holds beside its text: its ids, turn, tool name and JSON structure. */
const PUSHED_ENTRY_ROOM = 4 * 1024;
/**
 * The most JSON characters a push's entries may hold; past it, `more`, and the adapter pulls a snapshot (the push carries
 * its turns' newest status, which the differ must not apply before the turn's last entries). A burst of
 * `PUSH_BURST_RESULTS` full-size results fits when their text has no JSON escapes; an escape takes more characters in
 * the page's count (two for a newline or a quote, six for a control character), so fewer fit: about 15 of ordinary
 * output, as few as 2 of text that is all control characters. A named constraint: the page, the one entry that may pass it (a whole
 * Session row, `SESSION_ROW_BYTES`), and the push's live state go in one RPC (`RPC_MESSAGE_BYTES`), at most 2 bytes per
 * character as structured clone writes a string: about 24.5 MB of the 32 MiB, the rest for the live state.
 */
export const PUSH_ENTRIES_BYTES = PUSH_BURST_RESULTS * (TOOL_OUTPUT_BYTES + PUSHED_ENTRY_ROOM);
/** While a turn is live the Session pushes at least this often. */
export const LIVENESS_PUSH_MS = 60_000;
/** An open turn with no push for this long makes the adapter pull a snapshot (the inverse guard). */
export const SILENT_TURN_MS = 2 * 60_000;
