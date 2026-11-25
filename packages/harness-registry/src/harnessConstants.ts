// The Harness's fixed values (SPI-1388, ADR-0049 §3): what was a Harness setting but only guards t3flare's own machinery,
// or is pi's own default, is a named constant here, with why it holds its value. Each names itself and its value where
// it is hit (the tool's result, the Review's record, the log). The values are the Owner's (2026-11-24).
import { STOP_GRACE_SECONDS } from "./environment.ts";

/**
 * The Guardian's evidence budget, in characters of evidence a Review carries: pi-guardian's 32,000-token ceiling at
 * about 3 characters a token (no token count here: t3flare measures evidence in characters).
 */
export const GUARDIAN_EVIDENCE_CHARACTERS = 96_000;

/**
 * The most lines of one tool result the model reads, beside the Tool output limit's KiB: pi-durable's own
 * `DEFAULT_MAX_LINES`, its stock value. The KiB setting bounds the Session row; the lines only shape the cut.
 */
export const TOOL_OUTPUT_LINES = 2000;

/**
 * How many entries, paths and matches one `ls`, `find` and `grep` call returns when the call names no `limit`: pi's own
 * `DEFAULT_LIMIT` of each tool (pi-coding-agent `core/tools/ls.ts`, `find.ts`, `grep.ts`), as pi behaves locally. A call
 * may name a larger `limit`, as in pi; the Tool output limit still bounds what the model reads.
 */
export const LS_DEFAULT_LIMIT = 500;
export const FIND_DEFAULT_LIMIT = 1000;
export const GREP_DEFAULT_LIMIT = 100;

/** How long a `web_fetch` call that names no `timeout` may take in all. A call may name a longer one. */
export const FETCH_TIMEOUT_SECONDS = 30;

/**
 * The largest response body web_fetch reads, in KiB; a larger one is refused. A named constraint: a Worker isolate's
 * 128 MB, which also holds the Session's own state. Conversion costs about 7 times the body: measured in workerd
 * (apps/agents/test/webFetchMemory.workerd.test.ts), 5 MiB of two-byte HTML takes 24 MB of heap to convert, plus 10 MB
 * of body buffers outside it, about 34 MB of the 128, which leaves the Session most of the isolate. Every body it reads,
 * it converts. web_search reads its search model's answer within the same bound.
 */
export const FETCH_MAX_KIB = 5120;

/**
 * How many redirects one web_fetch call follows; one more fails the call. The Fetch standard's limit, which browsers
 * follow. Each redirect takes up to three of the turn invocation's subrequests (two address lookups and the request), so
 * a chain of 20 takes about 60 of Cloudflare's 10,000.
 */
export const FETCH_REDIRECTS = 20;

/**
 * How many characters of a fetched page's first heading t3's web item shows as its title. Display only: the model never
 * reads it, and it is kept with the tool result's `details`, so a heading line of megabytes stays out.
 */
export const FETCH_TITLE_CHARACTERS = 200;

/** The most tokens web_search's search model may write for one call's summary (the request's `max_tokens`). */
export const SEARCH_SUMMARY_TOKENS = 1500;

/** How long one web_search call may take in all, reading the search model's answer included. */
export const SEARCH_TIMEOUT_SECONDS = 90;

/** The characters of result text one web_search call shares across its results when the call names no budget. */
export const SEARCH_CONTEXT_CHARACTERS = 6000;

/** How many characters each line of a context_history list shows, and each match of a History or Notes search: one line. */
export const CONTEXT_PREVIEW_CHARACTERS = 120;

/**
 * An agent Terminal's size in columns and rows: pi-termctrl's `defaultViewport`. Fixed: its headless xterm keeps its
 * screen and scrollback in the Workspace DO's 128 MB isolate, so a larger one costs that memory per Terminal.
 */
export const TERMINAL_COLS = 120;
export const TERMINAL_ROWS = 40;

/**
 * terminal_start's wait for a new Terminal's screen to settle when the call names none, and how long bash with
 * `background: true` runs before the command becomes a Background job. A call may name its own wait.
 */
export const TERMINAL_START_WAIT_MS = 2000;
/** terminal_send's wait for the screen to settle after typing when the call names none. A call may name its own. */
export const TERMINAL_INPUT_WAIT_MS = 500;
/** terminal_send's wait for new output with nothing to type when the call names none. A call may name its own. */
export const TERMINAL_POLL_WAIT_MS = 30_000;

/** termctrl's settle constant (pi-termctrl's `terminal-tools.ts`): a Terminal's quiet before a wait answers, in ms. */
export const TERMINAL_QUIET_MS = 250;

/**
 * How many lines that scrolled off a Terminal since the agent last looked its next result shows, the first and last
 * kept and the middle dropped, which the result says: pi-termctrl's `scrollback.maxLines`.
 */
export const TERMINAL_SCROLLED_LINES = 100;

/**
 * The most bytes of those lines a result shows: half the Tool output limit (`outputKiB`), so the current screen always
 * fits beside them. Derived, not fixed: 25 KiB at the Tool output limit's default 50.
 */
export const terminalScrolledBytes = (outputMaxBytes: number): number => Math.floor(outputMaxBytes / 2);

/** How long terminal_stop waits for a Terminal or Background job to end after closing it: the one stop grace. */
export const TERMINAL_STOP_GRACE_MS = STOP_GRACE_SECONDS * 1000;

/**
 * When the model makes several calls at once, how many characters of each other call's arguments (beyond its path and
 * command, always whole) the Guardian reads beside the one it reviews: pi-guardian's `batchCallCharacterLimit`. Tied to
 * `GUARDIAN_EVIDENCE_CHARACTERS`: well under it, so one batch call never outweighs the evidence a Review reads.
 */
export const GUARDIAN_BATCH_ARGUMENT_CHARACTERS = 2000;

/** The most findings one Review delivers, and asks the Advisor for: pi-advisor's `maxFindingsPerReview`. */
export const ADVISOR_MAX_FINDINGS = 4;
/** The most Nits the Advisor delivers while the agent answers one request: pi-advisor's `maxNitsPerRequest`. */
export const ADVISOR_MAX_NITS = 3;
/**
 * After a Concern, turns before another Concern steers the running agent; one found meanwhile waits for the next Review.
 * t3flare's value: pi-advisor has no count of its own for it.
 */
export const ADVISOR_CONCERN_COOLDOWN_TURNS = 3;
/**
 * When this many turns wait unreviewed, the agent pauses for the Review under way (pi-advisor's `catchUpThreshold`), for
 * up to `ADVISOR_CATCH_UP_WAIT_SECONDS`, t3flare's own bound on that pause.
 */
export const ADVISOR_CATCH_UP_BACKLOG = 3;
export const ADVISOR_CATCH_UP_WAIT_SECONDS = 30;

/**
 * The most characters of a turn's request and of its answer the small model reads to suggest the next message, the last
 * of each. More costs more tokens per suggestion.
 */
export const SUGGESTION_EXCERPT_CHARACTERS = 4000;
/** How long a prompt suggestion may take; a late one is simply not shown. */
export const SUGGESTION_TIMEOUT_SECONDS = 20;
