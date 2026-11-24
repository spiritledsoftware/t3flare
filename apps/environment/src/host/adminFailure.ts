// @effect-diagnostics globalConsole:off
// What a failed admin route (`/_t3flare/*`, admin.ts) answers and logs. The answer carries the error and the chain of
// causes under it, never a stack trace; the stack goes to Workers Logs only, redacted like t3's own lines.
import { redact } from "./redactingConsole.ts";

/**
 * The chain of `cause`s under an error, as text: t3's tagged errors wrap the SQL or schema error that matters. Each cause
 * is followed once, so a chain that loops back on itself ends.
 */
export const causesOf = (error: unknown): Array<string> => {
  const out: Array<string> = [];
  const seen = new Set<unknown>([error]);
  let current = (error as { cause?: unknown })?.cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    let text: string;
    try {
      text = typeof message === "string" ? message : (JSON.stringify(current) ?? "");
    } catch {
      text = "unprintable cause";
    }
    out.push(text);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
};

/** The body a failed admin route answers with: the error and its causes, no stack. */
export const adminFailureBody = (error: unknown): { readonly error: string; readonly causes: Array<string> } => ({
  error: String(error),
  causes: causesOf(error),
});

/** Logs a failed admin route's error with its stack, redacted, for Workers Logs. */
export const logAdminFailure = (route: string, error: unknown): void => {
  const stack = error instanceof Error ? error.stack?.split("\n") : undefined;
  console.error(redact(JSON.stringify({ t3flare: "admin-route-failed", route, error: String(error), stack })));
};
