// The codemode sandbox Worker (ADR-0027): pi-codemode's QuickJS sandbox
// Durable Object, one object per Session (`RemoteCodemodeSandbox` in the Session DO picks it by the Session's name). A
// Worker of its own so a script that computes holds this isolate's thread, not the Session's. No public URL and no
// routes: the agents Worker's Durable Object binding (by this Worker's script name) is the only way in.
//
// Bundled by alchemy, not by our Rolldown build (ADR-0020's refinement): pi-codemode imports `quickjs-wasi/quickjs.wasm`,
// which alchemy's bundler uploads as a compiled module by its default rule; this Worker imports nothing of t3.
import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

/**
 * The sandbox with t3flare's limits. Interrupt budget: each Session asks for the Owner's `codemode.interruptBudget`
 * (SPI-1364); this allows up to its maximum, harness-registry's MAX_CODEMODE_INTERRUPT_BUDGET (300,000 polls: this
 * Worker's 30 s CPU limit at about 10,000 polls a second; apps/agents/test/codemodeSandbox.test.ts keeps them equal).
 * Memory: 16 MiB per VM, not 32 (review M6): every VM in an isolate shares its 128 MB, so a few Sessions' scripts at
 * 32 MiB could reset the isolate and fail every script in it.
 */
export class CodemodeSandbox extends CodemodeSandboxDurableObject {
  protected override maxInterruptBudget = 300_000;
  protected override maxMemoryLimitBytes = 16 * 1024 * 1024;
}

/** Reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
