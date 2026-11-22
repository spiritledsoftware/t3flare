// Secret Variables (ADR-0046): a Variable's value may be secret, as stock t3's provider environment variables are. Its
// value is sealed with the Stage's credentials key before anything else sees it (`variableSeal.ts`); no read returns it
// (the Settings page and its API, the Settings server, the audit log, the Change page, an Open change, the Workers Logs);
// a redacted round trip keeps it, a new value replaces it, and turning Secret off asks for it again; the Environment DO's
// answer to a Workspace DO opens it (`openVariables`), so a command still gets it.
import { EMPTY_ENVIRONMENT, type StoredEnvironment } from "@t3flare/harness-registry";
import { afterEach, describe, expect, it } from "vitest";

import { valueSealer } from "../src/credentials/sealed.ts";
import { renderChangePage } from "../src/harness/changePage.ts";
import { csrfToken } from "../src/harness/csrf.ts";
import { CSRF_HEADER, handleHarness, type HarnessDeps } from "../src/harness/panel.ts";
import { openVariables, readVariables, sealVariablesIn } from "../src/harness/variableSeal.ts";
import { settingsCall } from "../src/settings/server.ts";
import { CREDENTIALS_KEY, HOST, NOW, settingsFixture, type SettingsFixture, structured, textOf } from "./settingsFixture.ts";

const SECRET = "npm_l1ve_s3cret_value";
const OTHER = "npm_0ther_s3cret_value";
const sealer = valueSealer(CREDENTIALS_KEY);
const plain = (name: string, value: string) => ({ name, value, secret: false });
const secret = (name: string, value: string) => ({ name, value, secret: true });
const kept = (name: string) => ({ name, value: "", secret: true, valueRedacted: true });

let fixture: SettingsFixture | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

/** Every value the Environment keeps, as text: the leak scan. */
const everything = (run: SettingsFixture): string => JSON.stringify(run.kv.entries()) + JSON.stringify(run.logs);

const opened = async (stored: StoredEnvironment) => (await openVariables(stored, sealer)).variables;

describe("sealing (variableSeal.ts)", () => {
  it("seals a secret's value: the stored change holds its sealed value and fingerprint, never the value", async () => {
    const sealed = await sealVariablesIn({ variables: [plain("A", "1"), secret("NPM_TOKEN", SECRET)] }, EMPTY_ENVIRONMENT, sealer);
    if (!sealed.ok) throw new Error(sealed.error);
    expect(JSON.stringify(sealed.settings)).not.toContain(SECRET);
    expect(sealed.settings.variables).toEqual([plain("A", "1"), { name: "NPM_TOKEN", value: "", secret: true, sealed: { iv: expect.any(String), data: expect.any(String), fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) } }]);
  });

  it("keeps a redacted secret's stored value, refuses one with nothing stored, and leaves the rest as given", async () => {
    const first = await sealVariablesIn({ variables: [secret("T", SECRET)] }, EMPTY_ENVIRONMENT, sealer);
    if (!first.ok) throw new Error(first.error);
    const stored: StoredEnvironment = { revision: 1, settings: first.settings as StoredEnvironment["settings"] };
    const again = await sealVariablesIn({ variables: [kept("T"), plain("B", "2")] }, stored, sealer);
    expect(again).toEqual({ ok: true, settings: first.ok ? { variables: [...(first.settings.variables as Array<unknown>), plain("B", "2")] } : {} });
    expect(await sealVariablesIn({ variables: [kept("U")] }, stored, sealer)).toEqual({ ok: false, error: 'variables: "U" keeps a secret value, and none is stored under that name: give its value' });
    expect(await sealVariablesIn({ containerBudget: 4 }, stored, sealer)).toEqual({ ok: true, settings: { containerBudget: 4 } });
  });

  it("refuses a sealed value from outside; the door's own replay keeps one only if it opens under its name", async () => {
    const first = await sealVariablesIn({ variables: [secret("T", SECRET)] }, EMPTY_ENVIRONMENT, sealer);
    if (!first.ok) throw new Error(first.error);
    const entry = (first.settings.variables as Array<{ sealed: unknown }>)[0]!;
    const given = { variables: [{ name: "T", value: "", secret: true, sealed: entry.sealed }] };
    // ADR-0046 §1: a change gives a value or valueRedacted; a sealed value seen once could bring back an old value.
    expect(await sealVariablesIn(given, EMPTY_ENVIRONMENT, sealer)).toEqual({ ok: false, error: 'variables: "T" gives a sealed value: give its value, or valueRedacted to keep the one stored' });
    expect(await sealVariablesIn(given, EMPTY_ENVIRONMENT, sealer, { sealedAtDoor: true })).toMatchObject({ ok: true });
    expect(await sealVariablesIn({ variables: [{ name: "MOVED", value: "", secret: true, sealed: entry.sealed }] }, EMPTY_ENVIRONMENT, sealer, { sealedAtDoor: true })).toEqual({
      ok: false,
      error: 'variables: "MOVED"\'s sealed value does not open here: give its value',
    });
  });

  it("refuses a secret with an empty value and no redacted mark: it would blank the stored secret", async () => {
    expect(await sealVariablesIn({ variables: [secret("T", "")] }, EMPTY_ENVIRONMENT, sealer)).toEqual({ ok: false, error: 'variables: "T" is secret and has no value: give its value' });
  });

  it("reads a secret this key does not open as unreadable, never with a value", async () => {
    const first = await sealVariablesIn({ variables: [plain("A", "1"), secret("T", SECRET)] }, EMPTY_ENVIRONMENT, sealer);
    if (!first.ok) throw new Error(first.error);
    const stored: StoredEnvironment = { revision: 1, settings: first.settings as StoredEnvironment["settings"] };
    const set = { name: "T", value: "", secret: true, valueRedacted: true, fingerprint: expect.any(String) };
    expect(await readVariables(stored, sealer)).toEqual([plain("A", "1"), set]);
    expect(await readVariables(stored, valueSealer("d".repeat(64)))).toEqual([plain("A", "1"), { ...set, unreadable: true }]);
    expect(await readVariables(stored, undefined)).toEqual([plain("A", "1"), { ...set, unreadable: true }]);
  });

  it("refuses a secret to seal without a credentials key, and a value with a NUL before sealing it", async () => {
    expect(await sealVariablesIn({ variables: [secret("T", SECRET)] }, EMPTY_ENVIRONMENT, valueSealer(undefined))).toEqual({
      ok: false,
      error: "variables: this Environment has no credentials key (T3FLARE_CREDENTIALS_KEY), so it stores no secret Variable",
    });
    expect(await sealVariablesIn({ variables: [secret("T", "a\u0000b")] }, EMPTY_ENVIRONMENT, sealer)).toEqual({ ok: false, error: 'variables: "T"\'s value holds a NUL character, which no environment can' });
  });

  it("opens each secret for a Container start, and leaves out one this key does not open, by name", async () => {
    const first = await sealVariablesIn({ variables: [plain("A", "1"), secret("T", SECRET)] }, EMPTY_ENVIRONMENT, sealer);
    if (!first.ok) throw new Error(first.error);
    const stored: StoredEnvironment = { revision: 1, settings: first.settings as StoredEnvironment["settings"] };
    expect(await openVariables(stored, sealer)).toEqual({ variables: [plain("A", "1"), secret("T", SECRET)], unreadable: [] });
    expect(await openVariables(stored, valueSealer("d".repeat(64)))).toEqual({ variables: [plain("A", "1")], unreadable: ["T"] });
  });
});

describe("secret Variables on the Settings page", () => {
  const headers = async (deps: HarnessDeps) => ({
    "content-type": "application/json",
    origin: `https://${HOST}`,
    "sec-fetch-site": "same-origin",
    [CSRF_HEADER]: await csrfToken(deps.store.csrfKey(), "owner-sub", NOW),
  });
  const save = async (deps: HarnessDeps, variables: unknown) =>
    handleHarness(new Request(`https://${HOST}/_t3flare/settings/api/environment`, { method: "POST", headers: await headers(deps), body: JSON.stringify({ settings: { variables } }) }), deps);
  const read = async (deps: HarnessDeps, path = "/api/environment") => (await handleHarness(new Request(`https://${HOST}/_t3flare/settings${path}`), deps)).text();

  it("stores a secret sealed, and no read shows its value: the page, its API, the audit log", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const deps = run.panel();
    expect((await save(deps, [plain("NODE_ENV", "test"), secret("NPM_TOKEN", SECRET)])).status).toBe(200);
    expect(everything(run)).not.toContain(SECRET);
    const api = JSON.parse(await read(deps));
    const shown = { name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) };
    expect(api.resolved.variables).toEqual([plain("NODE_ENV", "test"), shown]);
    expect(api.stored.settings.variables).toEqual([plain("NODE_ENV", "test"), shown]);
    const page = await read(deps, "");
    expect(page).not.toContain(SECRET);
    expect(page).toContain('<div class="variable is-secret" data-variable data-variable-stored="NPM_TOKEN"><input type="text" data-variable-name aria-label="Name" value="NPM_TOKEN"');
    expect(page).toContain('placeholder="Set, not shown. Type to replace it" spellcheck="false" autocomplete="off"></textarea><label class="variable-secret"><input type="checkbox" data-variable-secret checked>Secret</label>');
    const audit = JSON.stringify(run.store.auditLog(5));
    expect(audit).not.toContain(SECRET);
    expect(audit).toContain("NPM_TOKEN");
    // The Workspace DO's answer opens it.
    expect(await opened(run.store.loadEnvironment())).toEqual([plain("NODE_ENV", "test"), secret("NPM_TOKEN", SECRET)]);
  });

  it("a redacted round trip keeps the value and moves nothing; a new value replaces it; turning Secret off needs the value again", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const deps = run.panel();
    await save(deps, [secret("NPM_TOKEN", SECRET)]);
    const revision = run.store.loadEnvironment().revision;
    // What the page posts for an untouched secret row.
    const round = await save(deps, [kept("NPM_TOKEN")]);
    expect(round.status).toBe(200);
    expect(await round.json()).toMatchObject({ unchanged: true, revision });
    expect(await opened(run.store.loadEnvironment())).toEqual([secret("NPM_TOKEN", SECRET)]);
    // The same value typed again is no change either (its fingerprint is the same).
    expect(await (await save(deps, [secret("NPM_TOKEN", SECRET)])).json()).toMatchObject({ unchanged: true });
    // A new value replaces it, audited as changed without either value.
    expect((await save(deps, [secret("NPM_TOKEN", OTHER)])).status).toBe(200);
    expect(await opened(run.store.loadEnvironment())).toEqual([secret("NPM_TOKEN", OTHER)]);
    const [entry] = run.store.auditLog(1);
    expect(entry).toMatchObject({ target: "variables" });
    expect(JSON.stringify(entry)).not.toContain(OTHER);
    expect(JSON.stringify(entry?.before)).not.toEqual(JSON.stringify(entry?.after));
    // Turning Secret off keeps nothing: the value is given again, or refused.
    const off = await save(deps, [{ name: "NPM_TOKEN", value: "", secret: false, valueRedacted: true }]);
    expect(off.status).toBe(400);
    expect(await off.text()).toBe('variables: "NPM_TOKEN" is not secret: give its value\n');
    expect((await save(deps, [plain("NPM_TOKEN", "public")])).status).toBe(200);
    expect(await opened(run.store.loadEnvironment())).toEqual([plain("NPM_TOKEN", "public")]);
  });

  it("refuses a sealed value from the page's API, and an empty secret with no redacted mark", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const deps = run.panel();
    await save(deps, [secret("NPM_TOKEN", SECRET)]);
    const sealed = JSON.parse(JSON.stringify(run.store.loadEnvironment().settings.variables))[0].sealed;
    const replayed = await save(deps, [{ name: "OLD", value: "", secret: true, sealed }]);
    expect(replayed.status).toBe(400);
    expect(await replayed.text()).toBe('variables: "OLD" gives a sealed value: give its value, or valueRedacted to keep the one stored\n');
    const blank = await save(deps, [secret("NPM_TOKEN", "")]);
    expect(blank.status).toBe(400);
    expect(await blank.text()).toBe('variables: "NPM_TOKEN" is secret and has no value: give its value\n');
    expect(await opened(run.store.loadEnvironment())).toEqual([secret("NPM_TOKEN", SECRET)]);
  });

  it("says on the row and in its API that a secret this credentials key does not open must be typed again", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await save(run.panel(), [secret("NPM_TOKEN", SECRET)]);
    // The key changed since: the Container start leaves it out, and the page says so.
    const rotated: HarnessDeps = { ...run.panel(), variableSealer: valueSealer("d".repeat(64)) };
    const page = await read(rotated, "");
    expect(page).toContain('data-variable data-variable-unreadable><input type="text" data-variable-name aria-label="Name" value="NPM_TOKEN"');
    expect(page).toContain("This secret cannot be opened (the credentials key changed or is missing), so no Container gets it: type its value again.");
    expect(page).not.toContain('data-variable-stored="NPM_TOKEN"');
    expect(JSON.parse(await read(rotated)).resolved.variables).toEqual([{ name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true, fingerprint: expect.any(String), unreadable: true }]);
    // Typing it again under the new key opens.
    const typed = await save(rotated, [secret("NPM_TOKEN", OTHER)]);
    expect(typed.status).toBe(200);
    expect((await openVariables(run.store.loadEnvironment(), valueSealer("d".repeat(64)))).variables).toEqual([secret("NPM_TOKEN", OTHER)]);
  });

  it("notes beside a Variable whose name t3flare sets itself, and only there", async () => {
    fixture = settingsFixture();
    const deps = fixture.panel();
    await save(deps, [plain("PATH", "/opt/bin"), plain("NODE_ENV", "test"), plain("T3FLARE_PASSIVE_READ", "1")]);
    const page = await read(deps, "");
    const rowOf = (name: string) => page.slice(page.indexOf(`value="${name}"`), page.indexOf("</div>", page.indexOf(`value="${name}"`)));
    expect(rowOf("PATH")).toContain('<p class="hint variable-note" data-variable-note>t3flare sets or keeps this name itself');
    expect(rowOf("NODE_ENV")).toContain("data-variable-note hidden>");
    // A reserved prefix (t3flare's internal markers) is noted too, and the page's script gets the prefixes.
    expect(rowOf("T3FLARE_PASSIVE_READ")).toContain('<p class="hint variable-note" data-variable-note>t3flare sets or keeps this name itself');
    expect(page).toContain('data-reserved-prefixes="T3FLARE_ T3CODE_"');
    expect(page).toContain('data-set-by-t3flare="');
  });
});

describe("secret Variables through the Settings server", () => {
  it("an agent sets one as an asked change; the card, the Change page, the Open change and the logs never hold its value", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const answer = structured(await run.call(run.durable("thread-s"), "change_environment", { expectedRevision: 0, settings: { variables: [plain("A", "1"), secret("NPM_TOKEN", SECRET)] } }));
    expect(answer).toMatchObject({ status: "applied" });
    const prompt = run.cards[0]!.prompt;
    expect(prompt).toContain("added NPM_TOKEN, secret (set, not shown)");
    expect(prompt).toContain('added A="1"');
    expect(prompt).not.toContain(SECRET);
    const [record] = run.deps.changes.closedBy("own:thread-s", 0);
    // Variables' tier (ADR-0046 §4): every change to them is asked.
    expect(record).toMatchObject({ tier: "asked" });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    const page = renderChangePage(record!, { csrf: "", now: run.now(), environment: run.store.loadEnvironment() });
    expect(page).toContain("secret, set");
    expect(page).not.toContain(SECRET);
    // Neither the card nor the Change page prints the sealed value (its IV or ciphertext): the call shows the secret as set.
    const sealed = JSON.parse(JSON.stringify(run.store.loadEnvironment().settings.variables)).find((variable: { name: string }) => variable.name === "NPM_TOKEN").sealed;
    for (const shown of [prompt, page]) {
      expect(shown).not.toContain(sealed.data);
      expect(shown).not.toContain(sealed.iv);
    }
    expect(prompt).toContain('"value": "secret, set"');
    expect(everything(run)).not.toContain(SECRET);
    expect(await opened(run.store.loadEnvironment())).toEqual([plain("A", "1"), secret("NPM_TOKEN", SECRET)]);
  });

  it("get_settings redacts it, and writing back what was read is unchanged; a new value is asked and shown as changed", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable("thread-a"), "change_environment", { expectedRevision: 0, settings: { variables: [secret("NPM_TOKEN", SECRET)] } });
    const read = structured(await run.call(run.durable("thread-b"), "get_settings", { entity: "environment" }))!;
    const variables = read.settings.find((setting: { key: string }) => setting.key === "variables").value;
    expect(variables).toEqual([{ name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true, fingerprint: expect.any(String) }]);
    expect(textOf(await run.call(run.durable("thread-b"), "get_settings", { entity: "environment" }))).not.toContain(SECRET);
    const back = structured(await run.call(run.durable("thread-c"), "change_environment", { expectedRevision: read.revision, settings: { variables } }));
    expect(back).toEqual({ status: "unchanged", revision: read.revision });
    await run.call(run.durable("thread-d"), "change_environment", { expectedRevision: read.revision, settings: { variables: [secret("NPM_TOKEN", OTHER)] } });
    const prompt = run.cards.at(-1)!.prompt;
    expect(prompt).toContain("changed NPM_TOKEN: a new secret value (not shown)");
    expect(prompt).toContain('"value": "secret, changed"');
    expect(prompt).not.toContain(OTHER);
    expect(everything(run)).not.toContain(OTHER);
    expect(await opened(run.store.loadEnvironment())).toEqual([secret("NPM_TOKEN", OTHER)]);
  });

  it("refuses a kept secret with nothing stored under its name, logging no value", async () => {
    fixture = settingsFixture();
    const run = fixture;
    const answer = await run.call(run.durable(), "change_environment", { expectedRevision: 0, settings: { variables: [kept("NPM_TOKEN")] } });
    expect(textOf(answer)).toContain('"NPM_TOKEN" keeps a secret value, and none is stored under that name: give its value');
    expect(run.store.loadEnvironment().revision).toBe(0);
  });

  it("refuses a sealed value an agent gives", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable("thread-a"), "change_environment", { expectedRevision: 0, settings: { variables: [secret("NPM_TOKEN", SECRET)] } });
    const sealed = JSON.parse(JSON.stringify(run.store.loadEnvironment().settings.variables))[0].sealed;
    const answer = await run.call(run.durable("thread-b"), "change_environment", { expectedRevision: 1, settings: { variables: [{ name: "OLD", value: "", secret: true, sealed }] } });
    expect(textOf(answer)).toContain('"OLD" gives a sealed value: give its value, or valueRedacted to keep the one stored');
    expect(run.store.loadEnvironment().revision).toBe(1);
  });

  it("hashes a secret change by its fingerprint: the same secret asked again after a decline is refused as a repeat", async () => {
    fixture = settingsFixture({ answer: { decision: "decline" } });
    const run = fixture;
    const args = { expectedRevision: 0, settings: { variables: [secret("NPM_TOKEN", SECRET)] } };
    expect(structured(await run.call(run.durable("thread-a"), "change_environment", args))).toMatchObject({ status: "declined" });
    const again = await run.call(run.durable("thread-a"), "change_environment", args);
    expect(textOf(again)).toContain("the owner declined this same change");
    // Another value is another change.
    const other = await run.call(run.durable("thread-a"), "change_environment", { expectedRevision: 0, settings: { variables: [secret("NPM_TOKEN", OTHER)] } });
    expect(textOf(other)).not.toContain("declined this same change");
  });

  it("get_settings says a secret this key does not open must be typed again", async () => {
    fixture = settingsFixture();
    const run = fixture;
    await run.call(run.durable("thread-a"), "change_environment", { expectedRevision: 0, settings: { variables: [secret("NPM_TOKEN", SECRET)] } });
    const rotated = { ...run.deps, ops: { ...run.deps.ops, variableSealer: valueSealer("d".repeat(64)) } };
    const read = structured(await settingsCall(rotated, { tool: "get_settings", args: { entity: "environment" }, caller: run.durable("thread-b") }));
    expect(read.settings.find((setting: { key: string }) => setting.key === "variables").value).toEqual([
      { name: "NPM_TOKEN", value: "", secret: true, valueRedacted: true, fingerprint: expect.any(String), unreadable: true },
    ]);
  });
});
