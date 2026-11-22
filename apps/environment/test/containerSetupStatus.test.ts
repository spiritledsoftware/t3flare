// The Container setup's output as the Environment shows it (ADR-0047 §7, ADR-0046 §1): a Workspace DO blanks every
// secret Variable's value before it reports (`apps/agents/test/containerSetup.test.ts`); the Environment DO, which never
// holds an opened value, keeps the blanked report and shows it as it came, in Status, on the Settings page and in the
// Settings server's `get_status`.
import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER_SETUP_OUTPUT_STATUS } from "@t3flare/harness-registry";

import { handleHarness } from "../src/harness/panel.ts";
import { HOST, settingsFixture, type SettingsFixture, structured } from "./settingsFixture.ts";

let fixture: SettingsFixture | undefined;
afterEach(() => fixture?.dispose());

/** A report as the Workspace DO sends it: the token it cloned with already blanked. */
const REPORT = {
  workspace: "web-app",
  runtime: "r1",
  revision: 2,
  sha256: "c".repeat(64),
  bytes: 64,
  source: "environment",
  outcome: "ok",
  exitCode: 0,
  timedOut: false,
  output: "+ git clone https://***@github.com/me/dotfiles\nCloning into '/root/.dotfiles'...\n",
  failure: "carryOn",
  ms: 900,
  at: Date.UTC(2026, 10, 22, 12),
};

describe("a secret Variable in the Container setup's output", () => {
  it("shows as *** in the Status row, on the Settings page and in get_status", async () => {
    fixture = settingsFixture({ panelStatus: true });
    const run = fixture;
    expect(run.store.noteContainerSetup(REPORT)).toBe(true);
    const status = structured(await run.call(run.durable(), "get_status"));
    expect(status.status[CONTAINER_SETUP_OUTPUT_STATUS]).toBe(REPORT.output);
    expect(status.status["last Container setup"]).toBe("web-app at revision 2: ran, exit 0 after 0.9 s, 2026-11-22T12:00:00.000Z");
    const html = await (await handleHarness(new Request(`https://${HOST}/_t3flare/settings`), run.panel())).text();
    expect(html).toContain("+ git clone https://***@github.com/me/dotfiles");
  });
});
